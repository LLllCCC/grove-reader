import { Platform, ItemView, Menu, MenuItem, Notice, TFile, ViewStateResult, WorkspaceLeaf, setIcon } from 'obsidian'
import type GroveReaderPlugin from './main'
import {
	Annotation,
	BookData,
	BACKGROUND_PRESETS,
	DEFAULT_APPEARANCE,
	HIGHLIGHT_COLORS,
	ReaderAppearance,
	colorCss,
} from './types'
import { CommentModal, ConfirmModal } from './modals'
import { AiPanel } from './aiPanel'
import { Overlayer } from '../lib/foliate-js/overlayer.js'
import { basenameOf, contrastFg, formatAuthor, formatLanguageMap, isDarkColor, randomId, stripNumericTitlePrefix, truncate } from './util'
import '../lib/foliate-js/view.js'

/** 按 cfi 里的数字路径比较先后：纯字符串比较会把 /4,/104 排到 /4/56 之前 */
function cfiPathNumbers(cfi: string): number[] {
	return (cfi.match(/\d+/g) ?? []).map(Number)
}

function compareCfi(a: string, b: string): number {
	const ka = cfiPathNumbers(a)
	const kb = cfiPathNumbers(b)
	const n = Math.min(ka.length, kb.length)
	for (let i = 0; i < n; i++) {
		if (ka[i] !== kb[i]) return ka[i] - kb[i]
	}
	return ka.length - kb.length
}

export const VIEW_TYPE_GROVE_READER = 'grove-reader-view'

interface FoliateTOCItem {
	label?: string
	href?: string
	subitems?: FoliateTOCItem[]
}

interface FoliateBook {
	metadata?: { title?: unknown; author?: unknown }
	toc?: FoliateTOCItem[]
	sections?: Array<{ id?: string; href?: string }>
	/** href → { index: spine 索引, anchor: 文档内锚点 CFI } */
	resolveHref?: (href: string) => { index: number; anchor?: unknown } | null
	/** cfi → { index, label }，label 是 foliate 自己挑的最近目录项 */
	resolveNavigation?: (cfi: string) => { index: number; label?: string } | null
}

interface FoliateRenderer {
	setStyles?: (css: string) => void
	setAttribute(name: string, value: string): void
}

interface FoliateView extends HTMLElement {
	open(input: File): Promise<void>
	init(options: { lastLocation?: string; showTextStart?: boolean }): Promise<void>
	close(): void
	goTo(target: string | number): Promise<unknown>
	select(target: string): Promise<unknown>
	goToFraction(fraction: number): Promise<void>
	addAnnotation(annotation: { value: string } & Record<string, unknown>): Promise<{ index: number; label?: string } | undefined>
	deleteAnnotation(annotation: { value: string } & Record<string, unknown>): Promise<unknown>
	resolveNavigation(target: string): { index?: number; label?: string } | undefined
	getCFI(index: number, range: Range): string
	search(options: { query: string }): AsyncGenerator<FoliateSearchYield, void, unknown>
	clearSearch(): void
	deselect(): void
	goLeft(): void
	goRight(): void
	renderer?: FoliateRenderer
	book?: FoliateBook
}

interface FoliateSearchMatch {
	cfi: string
	excerpt: { pre: string; match: string; post: string }
}

type FoliateSearchYield =
	| { progress: number }
	| { label?: string; subitems: FoliateSearchMatch[] }
	| { cfi: string; excerpt: FoliateSearchMatch['excerpt'] }
	| 'done'

interface RelocateDetail {
	cfi?: string
	fraction?: number
	section?: { current: number; total: number }
	location?: { current: number; total: number }
	pageItem?: { label: string } | null
	tocItem?: { label?: string; href?: string } | null
}

interface PendingSelection {
	cfi: string
	text: string
	index: number
}

const PAGE_KEYS = new Set(['ArrowLeft', 'ArrowRight'])
const POPUP_WIDTH = 232

const FONT_PRESETS: Array<{ label: string; value: string }> = [
	{ label: '跟随书籍', value: '' },
	{ label: '系统衬线', value: 'serif' },
	{ label: '系统无衬线', value: 'sans-serif' },
	{ label: '宋体', value: '"Songti SC", "SimSun", "Noto Serif CJK SC", serif' },
	{ label: '黑体', value: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif' },
	{ label: '楷体', value: '"KaiTi", "STKaiti", "Kaiti SC", serif' },
	{ label: '仿宋', value: '"FangSong", "STFangsong", "Fang Song", serif' },
	{ label: '霞鹜文楷', value: '"LXGW WenKai", "LXGW WenKai GB", "LXGW WenKai Screen", KaiTi, serif' },
	{ label: '思源宋体', value: '"Source Han Serif SC", "Noto Serif CJK SC", "SimSun", serif' },
	{ label: '思源黑体', value: '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif' },
]

export class ReaderView extends ItemView {
	bookPath = ''
	bookTitle = ''

	private foliate: FoliateView | null = null
	private data: BookData | null = null
	private loadedPath: string | null = null
	private pendingCfi: string | null = null
	private pending: PendingSelection | null = null
	private saveTimer: number | null = null
	private lastSavedCfi: string | null = null
	private touchStart: { x: number; y: number } | null = null
	private sliderActive = false
	private popup: HTMLElement | null = null
	private popupTimer: number | null = null
	private popupCloser: ((e: MouseEvent) => void) | null = null
	/** 跳转后的「返回原位置」浮条 */
	private jumpReturnEl: HTMLElement | null = null
	private aiPanel = new AiPanel()
	/** spine 索引 → 该节里最具体的目录项（同文件下「第X章」优先于「第X部分」） */
	private tocBySection = new Map<number, { label: string; depth: number }>()

	private readerEl!: HTMLElement
	private readerInnerEl!: HTMLElement
	private sidebarEl!: HTMLElement
	private annListEl!: HTMLElement
	private annCountEl!: HTMLElement
	private sidebarHandleEl!: HTMLElement
	private tocSelect!: HTMLSelectElement
	private slider!: HTMLInputElement
	private progressLabel!: HTMLElement
	private appearPanelEl!: HTMLElement
	private mobileToolbarHandle: HTMLElement | null = null

	private sidebarQuery = ''
	private sidebarColor: string | null = null
	private annCollapsed: Set<string> | null = null
	private collapseAllBtnEl: HTMLButtonElement | null = null
	private searchInput!: HTMLInputElement
	private fullTextSearchEl!: HTMLDetailsElement
	private fullTextSearchInput!: HTMLInputElement
	private fullTextSearchStatus!: HTMLElement
	private fullTextSearchResults!: HTMLElement
	private fullTextSearchTaskId = 0
	private wheelAccum = 0
	private wheelLast = 0
	private wheelDocs = new Map<Document, number>()
	private clearBtnEl!: HTMLButtonElement
	private filterDotEls = new Map<string, HTMLElement>()
	private annItemEls = new Map<string, HTMLElement>()
	private revealTimer: number | null = null
	private lastStatsLoc: number | null = null

	// 批注管理
	private selectMode = false
	private selectedIds = new Set<string>()
	private sortMode: 'position' | 'recent' = 'position'
	private sortBtnEl!: HTMLButtonElement
	private selectBarEl!: HTMLElement
	private selectCountEl!: HTMLElement

	constructor(leaf: WorkspaceLeaf, private plugin: GroveReaderPlugin) {
		super(leaf)
		this.navigation = false
	}

	getViewType(): string {
		return VIEW_TYPE_GROVE_READER
	}

	getDisplayText(): string {
		return this.bookTitle || 'Grove Reader'
	}

	getIcon(): string {
		return 'book-open'
	}

	get ready(): boolean {
		return !!(this.foliate && this.data)
	}

	snapshot(): BookData | null {
		return this.data
	}

	// ------------------------------------------------------------------
	// 生命周期与状态
	// ------------------------------------------------------------------

	async onOpen(): Promise<void> {
		this.#buildDom()
		if (this.bookPath) await this.#openBook(this.pendingCfi ?? undefined)
		else this.#showEmpty('从左侧功能区的书本图标打开书架，或在文件列表中直接点击一本电子书。')
	}

	async onClose(): Promise<void> {
		this.#flushSave()
		this.#teardownBook()
	}

	getState(): Record<string, unknown> {
		const base = super.getState() as Record<string, unknown>
		return { ...base, bookPath: this.bookPath || undefined }
	}

	async setState(state: unknown, result?: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as { bookPath?: string; file?: string; cfi?: string }
		const newCfi = s.cfi ?? null
		// 点击文件列表中的电子书时，Obsidian 通过 state.file 传入路径
		const incoming = s.bookPath ?? (s.file ? String(s.file) : '')
		if (incoming) this.bookPath = incoming
		if (newCfi) this.pendingCfi = newCfi
		await super.setState(state, result ?? { history: false })
		if (!this.readerEl) return // onOpen 尚未执行，onOpen 会带上 pendingCfi
		if (!this.bookPath) return
		if (!this.foliate || this.loadedPath !== this.bookPath) {
			this.#teardownBook()
			await this.#openBook(this.pendingCfi ?? undefined)
			return
		}
		if (newCfi) void this.#jumpToCfi(newCfi)
	}

	// ------------------------------------------------------------------
	// DOM 结构
	// ------------------------------------------------------------------

	#buildDom(): void {
		const root = this.contentEl
		root.empty()
		root.addClass('grove-content')

		// 手机没有 hover：点正文只展开；收起交给顶边把手，避免阅读点击误收起
		this.registerDomEvent(root, 'click', (ev: MouseEvent) => {
			if (!this.plugin.isMobile) return
			const target = ev.target as HTMLElement | null
			if (!this.appearPanelEl?.classList.contains('grove-hidden') && !target?.closest('.grove-appear-panel') && !target?.closest('.grove-appear-button')) {
				this.appearPanelEl.addClass('grove-hidden')
				return
			}
			if (target?.closest('a, button, .grove-toolbar, .grove-annotation')) return
			const sel = document.getSelection()
			if (sel && !sel.isCollapsed) return
			this.#setMobileBarOpen(true)
		})

		const toolbar = root.createDiv('grove-toolbar')
		if (this.plugin.isMobile) {
			// 初始收起：工具栏只剩顶部一条窄条，窄条本身就是一个大的「展开」热区
			toolbar.dataset.barOpen = '0'
			const handle = toolbar.createEl('button', {
				cls: 'grove-mobile-toolbar-close',
				attr: { type: 'button', 'aria-label': '展开阅读工具栏', title: '展开 / 收起工具栏' },
			})
			handle.addEventListener('click', (event) => {
				event.preventDefault()
				event.stopPropagation()
				this.#setMobileBarOpen(toolbar.dataset.barOpen !== '1')
			})
			handle.setText('工具栏')
			this.mobileToolbarHandle = handle
		}

		const tocWrap = toolbar.createDiv('grove-toc')
		this.tocSelect = tocWrap.createEl('select', { cls: 'dropdown grove-toc-select' })
		this.tocSelect.createEl('option', { value: '', text: '目录' })
		this.tocSelect.addEventListener('change', () => {
			const href = this.tocSelect.value
			if (href && this.foliate) void this.foliate.goTo(href)
		})

		const progress = toolbar.createDiv('grove-progress')
		this.slider = progress.createEl('input', { attr: { type: 'range', min: '0', max: '1', step: '0.001' } })
		this.slider.addEventListener('pointerdown', () => {
			this.sliderActive = true
		})
		this.slider.addEventListener('pointerup', () => {
			this.sliderActive = false
		})
		this.slider.addEventListener('input', () => {
			const v = Number.parseFloat(this.slider.value)
			if (Number.isFinite(v) && this.foliate) void this.foliate.goToFraction(v)
		})
		this.progressLabel = progress.createSpan('grove-progress-label')
		this.progressLabel.setText('0%')

		toolbar.createDiv('grove-sep')

		for (const c of HIGHLIGHT_COLORS) {
			const dot = toolbar.createEl('button', { cls: 'clickable-icon grove-color-dot', attr: { 'aria-label': `高亮（${c.name}）` } })
			dot.style.backgroundColor = c.css
			dot.addEventListener('click', () => void this.#createHighlightFromPending(c.key))
		}

		const commentBtn = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': '为划选文字添加评论' } })
		setIcon(commentBtn, 'message-square-plus')
		commentBtn.addEventListener('click', () => void this.#commentOnPending())

		toolbar.createDiv('grove-flex-spacer')

		const appearBtn = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn grove-appear-button', attr: { 'aria-label': '阅读外观（字体 / 背景 / 行距）' } })
		setIcon(appearBtn, 'type')
		appearBtn.addEventListener('click', e => {
			e.stopPropagation()
			this.#toggleAppearancePanel()
		})

		const noteBtn = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': '生成 / 更新阅读笔记' } })
		setIcon(noteBtn, 'file-text')
		noteBtn.addEventListener('click', () => void this.plugin.generateNoteFor(this))

		const sideBtn = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': '批注列表' } })
		setIcon(sideBtn, 'list')
		sideBtn.addEventListener('click', () => this.sidebarEl.classList.toggle('grove-hidden'))

		// 外观面板（绝对定位于工具栏下方）
		this.appearPanelEl = root.createDiv('grove-appear-panel grove-hidden')
		this.registerDomEvent(this.contentEl, 'click', e => {
			const t = e.target
			if (this.appearPanelEl.classList.contains('grove-hidden')) return
			if (t instanceof Element && !t.closest('.grove-appear-panel') && !t.closest('.grove-appear-button')) this.appearPanelEl.addClass('grove-hidden')
		}, { capture: true })

		const body = root.createDiv('grove-body')
		this.readerEl = body.createDiv('grove-reader')
		this.readerInnerEl = this.readerEl.createDiv('grove-reader-inner')
		this.registerDomEvent(this.readerInnerEl, 'wheel', e => this.#onWheel(e), { passive: false })

		// 右下角悬浮翻页按钮
		const pageBtns = this.readerEl.createDiv('grove-page-btns')
		const prevBtn = pageBtns.createEl('button', { cls: 'clickable-icon grove-page-btn', attr: { 'aria-label': '上一页' } })
		setIcon(prevBtn, 'chevron-left')
		prevBtn.addEventListener('click', () => this.foliate?.goLeft())
		const nextBtn = pageBtns.createEl('button', { cls: 'clickable-icon grove-page-btn', attr: { 'aria-label': '下一页' } })
		setIcon(nextBtn, 'chevron-right')
		nextBtn.addEventListener('click', () => this.foliate?.goRight())

		this.sidebarEl = body.createDiv('grove-sidebar')
		const sideHead = this.sidebarEl.createDiv('grove-sidebar-head')
		this.annCountEl = sideHead.createSpan('grove-ann-count')
		this.annCountEl.setText('0 个批注')
		const closeSidebar = sideHead.createEl('button', { cls: 'clickable-icon grove-sidebar-close', attr: { 'aria-label': '关闭批注栏', title: '关闭批注栏' } })
		setIcon(closeSidebar, 'x')
		closeSidebar.addEventListener('click', () => this.sidebarEl.classList.add('grove-hidden'))


		const fullTextSearch = this.sidebarEl.createEl('details', { cls: 'grove-fulltext-search' })
		this.fullTextSearchEl = fullTextSearch
		fullTextSearch.createEl('summary', { text: '全文搜索' })
		const fullTextSearchControls = fullTextSearch.createDiv('grove-fulltext-search-controls')
		this.fullTextSearchInput = fullTextSearchControls.createEl('input', {
			cls: 'grove-ann-search',
			attr: { type: 'search', placeholder: '输入关键词，按 Enter 搜索本书…' },
		})
		this.fullTextSearchInput.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault()
				void this.#runFullTextSearch()
			} else if (e.key === 'Escape') {
				this.#clearFullTextSearch()
			}
		})
		const fullTextSearchMeta = fullTextSearch.createDiv('grove-fulltext-search-meta')
		this.fullTextSearchStatus = fullTextSearchMeta.createSpan('grove-fulltext-search-status')
		this.fullTextSearchStatus.setText('输入关键词后按 Enter 搜索全文')
		const clearFullTextSearch = fullTextSearchMeta.createEl('button', {
			cls: 'grove-manage-btn',
			text: '清除',
			attr: { 'aria-label': '清除全文搜索' },
		})
		clearFullTextSearch.addEventListener('click', () => this.#clearFullTextSearch())
		this.fullTextSearchResults = fullTextSearch.createDiv('grove-fulltext-search-results')

		const controls = this.sidebarEl.createDiv('grove-sidebar-controls')
		this.searchInput = controls.createEl('input', {
			cls: 'grove-ann-search',
			attr: { type: 'search', placeholder: '搜索批注（摘录 / 评论 / 章节）…' },
		})
		this.searchInput.addEventListener('input', () => {
			this.sidebarQuery = this.searchInput.value.trim()
			this.#saveFilterState()
			this.#renderSidebar()
		})
		const filterRow = controls.createDiv('grove-ann-filters')
		for (const c of HIGHLIGHT_COLORS) {
			const dot = filterRow.createEl('button', { cls: 'grove-filter-dot', attr: { 'aria-label': `只看${c.name}色批注`, title: `只看${c.name}色` } })
			dot.style.backgroundColor = c.css
			dot.addEventListener('click', () => {
				this.sidebarColor = this.sidebarColor === c.key ? null : c.key
				this.#saveFilterState()
				this.#renderSidebar()
			})
			this.filterDotEls.set(c.key, dot)
		}
		this.clearBtnEl = filterRow.createEl('button', { cls: 'grove-filter-clear grove-hidden', text: '清除筛选' })
		this.clearBtnEl.addEventListener('click', () => {
			this.sidebarQuery = ''
			this.sidebarColor = null
			this.searchInput.value = ''
			this.#saveFilterState()
			this.#renderSidebar()
		})
		const manageRow = controls.createDiv('grove-ann-filters')
		this.sortBtnEl = manageRow.createEl('button', { cls: 'grove-manage-btn', text: '排序：章节' })
		this.sortBtnEl.addEventListener('click', () => {
			this.sortMode = this.sortMode === 'position' ? 'recent' : 'position'
			this.sortBtnEl.setText(this.sortMode === 'position' ? '排序：章节' : '排序：最近')
			this.#saveFilterState()
			this.#renderSidebar()
		})
		this.collapseAllBtnEl = manageRow.createEl('button', { cls: 'grove-manage-btn', text: '折叠全部' })
		this.collapseAllBtnEl.addEventListener('click', () => this.#toggleAllGroups())
		const multiBtn = manageRow.createEl('button', { cls: 'grove-manage-btn', text: '多选' })
		multiBtn.addEventListener('click', () => this.#setSelectMode(!this.selectMode))

		this.selectBarEl = controls.createDiv('grove-select-bar grove-hidden')
		this.selectCountEl = this.selectBarEl.createSpan('grove-select-count')
		this.selectCountEl.setText('已选 0 条')
		const delBtn = this.selectBarEl.createEl('button', { text: '删除所选', cls: 'grove-select-delete' })
		delBtn.addEventListener('click', () => this.#deleteSelected())
		const cancelBtn = this.selectBarEl.createEl('button', { text: '取消', cls: 'grove-select-cancel' })
		cancelBtn.addEventListener('click', () => this.#setSelectMode(false))

		this.annListEl = this.sidebarEl.createDiv('grove-ann-list')

		this.registerDomEvent(this.contentEl, 'keydown', (e: KeyboardEvent) => {
			if (!PAGE_KEYS.has(e.key) || !this.foliate) return
			// 焦点在输入框/滑杆时方向键属于编辑操作，不能翻页
			const t = e.target
			if (t instanceof HTMLElement && t.closest('input, textarea, select, [contenteditable="true"]')) return
			if (e.key === 'ArrowLeft') this.foliate.goLeft()
			else this.foliate.goRight()
		})
	}

	#showEmpty(message: string): void {
		this.readerInnerEl.empty()
		this.readerInnerEl.createDiv('grove-empty').setText(message)
	}

	// ------------------------------------------------------------------
	// 打开 / 关闭书籍
	// ------------------------------------------------------------------

	async #openBook(cfi?: string): Promise<void> {
		this.#clearFullTextSearch()
		this.fullTextSearchEl.open = false
		const target = this.bookPath
		this.pendingCfi = cfi ?? null
		if (!target) return
		this.readerInnerEl.empty()
		this.readerInnerEl.createDiv('grove-empty').setText('正在打开…')
		try {
			const data = this.plugin.store.load(target)
			this.data = data

			const buf = await this.plugin.readBookBytes(target)
			const name = basenameOf(target)
			const foliate = document.createElement('foliate-view') as unknown as FoliateView
			this.foliate = foliate
			foliate.addEventListener('load', this.#onLoad as EventListener)
			foliate.addEventListener('relocate', this.#onRelocate as EventListener)
			foliate.addEventListener('draw-annotation', this.#onDrawAnnotation as EventListener)
			foliate.addEventListener('create-overlay', this.#onCreateOverlay as EventListener)
			foliate.addEventListener('show-annotation', this.#onShowAnnotation as EventListener)

			await foliate.open(new File([buf], name))
			// 手机端关掉「拖选到页边自动翻页」：会把跨页拖选手势当成 swipe，直接跳页并冲掉选区
			const renderer = (foliate as unknown as { renderer?: { selectionPaging?: boolean } }).renderer
			if (renderer) renderer.selectionPaging = !this.plugin.isMobile
			this.loadedPath = target
			this.readerInnerEl.empty()
			this.readerInnerEl.appendChild(foliate)

			const meta = foliate.book?.metadata
			const shelfEntry = this.plugin.shelfCache.get(target)
			// 书架上手动编辑过的书名/作者优先于内嵌元数据（笔记标题取 data.title）
			this.bookTitle = shelfEntry?.title || stripNumericTitlePrefix(formatLanguageMap(meta?.title)) || name.replace(/\.[^.]+$/, '')
			if (!data.title) {
				data.title = this.bookTitle
				data.author = shelfEntry?.author || formatAuthor(meta?.author)
				this.#scheduleSave(true)
			}
			this.#updateHeaderTitle()
			// 打开书即校正一次笔记标题/文件名（如数字 ID 前缀清洗），无变化时不会写盘
			if (data.notePath) this.plugin.scheduleNoteRefresh(this)
			this.#applyAppearance()
			this.#buildToc(foliate.book?.toc ?? [])
			await foliate.init({ lastLocation: data.lastLocation?.cfi || undefined })
			if (this.pendingCfi) {
				const c = this.pendingCfi
				this.pendingCfi = null
				await this.#jumpToCfi(c)
			}
			this.#resetSidebarFilters()
			this.#renderSidebar()
			this.sidebarEl.classList.toggle('grove-hidden', this.plugin.isMobile || !this.plugin.settings.openSidebarWithBook)
		} catch (e) {
			console.error('[Grove Reader] 打开书籍失败', e)
			this.#showEmpty(`打开失败：${e instanceof Error ? e.message : String(e)}`)
			this.foliate = null
		}
	}

	#teardownBook(): void {
		this.#clearFullTextSearch()
		this.#hidePopup()
		this.#hideJumpReturn()
		this.aiPanel.hide()
		if (this.saveTimer != null) {
			window.clearTimeout(this.saveTimer)
			this.saveTimer = null
		}
		const foliate = this.foliate
		this.foliate = null
		if (foliate) {
			try {
				foliate.clearSearch()
			} catch {
				// ignore
			}
			try {
				foliate.close()
			} catch {
				// ignore
			}
			foliate.remove()
		}
	}

	#clearFullTextSearch(): void {
		this.fullTextSearchTaskId++
		this.foliate?.clearSearch()
		if (this.fullTextSearchInput) this.fullTextSearchInput.value = ''
		this.fullTextSearchResults?.empty()
		this.fullTextSearchStatus?.setText('输入关键词后按 Enter 搜索全文')
	}

	/** 从命令面板/书架直接发起本书全文搜索，复用侧栏的全文搜索 */
	searchFullText(query: string): void {
		const q = query.trim()
		if (!q) return
		if (!this.foliate) {
			new Notice('Grove Reader：书籍还在加载，请稍后再试')
			return
		}
		this.fullTextSearchEl.open = true
		this.fullTextSearchInput.value = q
		void this.#runFullTextSearch()
	}

	async #runFullTextSearch(): Promise<void> {
		const query = this.fullTextSearchInput.value.trim()
		const foliate = this.foliate
		const taskId = ++this.fullTextSearchTaskId
		this.fullTextSearchResults.empty()
		foliate?.clearSearch()
		if (!query || !foliate) {
			this.fullTextSearchStatus.setText(query ? '书籍尚未准备好' : '输入关键词后按 Enter 搜索全文')
			return
		}

		this.fullTextSearchStatus.setText('正在搜索…')
		let count = 0
		try {
			for await (const result of foliate.search({ query })) {
				if (taskId !== this.fullTextSearchTaskId) break
				if (result === 'done') continue
				if ('progress' in result) {
					this.fullTextSearchStatus.setText(`正在搜索 ${Math.round(result.progress * 100)}%`)
					continue
				}
				const matches = 'subitems' in result ? result.subitems : [result]
				for (const match of matches) {
					const row = this.fullTextSearchResults.createEl('button', { cls: 'grove-fulltext-search-result' })
					row.createSpan('grove-fulltext-search-context').setText(match.excerpt.pre)
					row.createSpan('grove-fulltext-search-hit').setText(match.excerpt.match)
					row.createSpan('grove-fulltext-search-context').setText(match.excerpt.post)
					row.addEventListener('click', () => void this.#jumpToCfi(match.cfi))
					count++
				}
				this.fullTextSearchStatus.setText(`${count} 处命中${'label' in result && result.label ? ` · ${result.label}` : ''}`)
			}
			if (taskId === this.fullTextSearchTaskId && count === 0) {
				this.fullTextSearchStatus.setText('没有找到匹配内容')
			}
		} catch (e) {
			if (taskId === this.fullTextSearchTaskId) {
				console.error('[Grove Reader] 全文搜索失败', e)
				this.fullTextSearchStatus.setText('搜索失败，请重试')
			}
		}
	}

	#updateHeaderTitle(): void {
		const header = this.containerEl.children[0] as HTMLElement | undefined
		const el = header?.querySelector('.view-header-title')
		if (el) el.textContent = this.bookTitle || 'Grove Reader'
	}

	// ------------------------------------------------------------------
	// 阅读外观（背景 / 字体 / 排版）
	// ------------------------------------------------------------------

	applyAppearance(): void {
		this.#applyAppearance()
		this.#syncAppearanceControls()
	}

	#applyAppearance(): void {
		const a = this.plugin.settings.appearance
		const renderer = this.foliate?.renderer
		if (renderer) {
			try {
				// foliate 将属性值原样用作 CSS 长度，必须带 px 单位，否则整条布局声明失效
				renderer.setAttribute('margin', `${a.pageMargin}px`)
				renderer.setAttribute('max-inline-size', `${a.maxInlineSize}px`)
			} catch {
				// ignore
			}
		}
		if (!renderer?.setStyles) return
		const css = this.#appearanceCss(a)
		try {
			renderer.setStyles(css)
		} catch (e) {
			console.error('[Grove Reader] 应用外观失败', e)
		}
	}

	#appearanceCss(a: ReaderAppearance): string {
		let bg: string
		let fg: string
		let dark: boolean
		if (a.followTheme) {
			const style = getComputedStyle(document.body)
			dark = document.body.classList.contains('theme-dark')
			bg = style.getPropertyValue('--background-primary').trim() || (dark ? '#1e1e20' : '#ffffff')
			fg = style.getPropertyValue('--text-normal').trim() || (dark ? '#dcddde' : '#2b2b2b')
		} else {
			const preset = BACKGROUND_PRESETS.find(p => p.key === a.bgKey)
			bg = a.bgKey === 'custom' ? a.customBg : (preset?.bg ?? '#ffffff')
			fg = a.bgKey === 'custom' ? contrastFg(bg) : (preset?.fg ?? contrastFg(bg))
			dark = isDarkColor(bg)
		}
		const themeFont = getComputedStyle(document.body).getPropertyValue('--font-text').trim()
		const font = a.fontFamily || themeFont || 'serif'
		const rules = [
			`html { color-scheme: ${dark ? 'dark' : 'light'}; }`,
			`body { color: ${fg}; background-color: ${bg}; font-family: ${font}; font-size: ${a.fontSize}% !important; }`,
			`p, li, blockquote, dd { line-height: ${a.lineHeight} !important; }`,
		]
		if (dark) {
			// EPUB 常把标题颜色写在任意 class 或行内样式中，深色背景下统一覆盖文字色。
			rules.push(`html body * { color: ${fg} !important; }`)
		}
		if (a.paragraphSpacing > 0) {
			rules.push(`p { margin-top: ${a.paragraphSpacing}em !important; margin-bottom: ${a.paragraphSpacing}em !important; }`)
		}
		// 引文（原书的 blockquote）用楷体并加一条左侧竖线：
		// 原书 CSS 只写了 font-family:kaiti，字重字号与正文接近，几乎看不出区别
		// 引文：低分屏上强制楷体笔画发虚，改成「左侧竖线 + 极淡底色」，
		// 既不糊也能一眼看出这是引述段落
		rules.push(
			`blockquote { border-left: 3px solid color-mix(in srgb, ${fg} 32%, transparent); background: color-mix(in srgb, ${fg} 5%, transparent); padding: 0.15em 0.9em 0.15em 0.9em; margin-left: 0 !important; margin-right: 0 !important; border-radius: 2px; }`,
		)
		rules.push('pre, code { white-space: pre-wrap; }')
		return rules.join('\n')
	}

	#toggleAppearancePanel(): void {
		const hidden = this.appearPanelEl.classList.contains('grove-hidden')
		if (hidden) {
			this.#renderAppearancePanel()
			this.appearPanelEl.removeClass('grove-hidden')
		} else {
			this.appearPanelEl.addClass('grove-hidden')
		}
	}

	#renderAppearancePanel(): void {
		const a = this.plugin.settings.appearance
		const panel = this.appearPanelEl
		panel.empty()

		// —— 背景 ——
		const bgRow = panel.createDiv('grove-appear-row')
		bgRow.createSpan('grove-appear-label').setText('背景')
		const swatches = bgRow.createDiv('grove-appear-swatches')
		const themeChip = swatches.createEl('button', { cls: 'grove-appear-chip' })
		themeChip.setText('跟随主题')
		themeChip.addEventListener('click', () => this.#patchAppearance({ followTheme: true }))
		if (a.followTheme) themeChip.addClass('is-active')

		for (const p of BACKGROUND_PRESETS) {
			const sw = swatches.createEl('button', { cls: 'grove-appear-swatch', attr: { 'aria-label': p.name, title: p.name } })
			sw.style.backgroundColor = p.bg
			if (!a.followTheme && a.bgKey === p.key) sw.addClass('is-active')
			sw.addEventListener('click', () => this.#patchAppearance({ followTheme: false, bgKey: p.key }))
		}
		const customWrap = swatches.createDiv('grove-appear-swatch grove-appear-custom')
		customWrap.style.backgroundColor = a.customBg
		if (!a.followTheme && a.bgKey === 'custom') customWrap.addClass('is-active')
		const colorInput = customWrap.createEl('input', { attr: { type: 'color', title: '自定义背景色' } })
		colorInput.value = /^#[0-9a-fA-F]{6}$/.test(a.customBg) ? a.customBg : '#ffffff'
		colorInput.addEventListener('input', () => {
			this.#patchAppearance({ followTheme: false, bgKey: 'custom', customBg: colorInput.value })
			customWrap.style.backgroundColor = colorInput.value
		})

		// —— 字体 ——
		const fontRow = panel.createDiv('grove-appear-row')
		fontRow.createSpan('grove-appear-label').setText('字体')
		const fontCol = fontRow.createDiv('grove-appear-col')
		const fontSelect = fontCol.createEl('select', { cls: 'dropdown' })
		for (const f of FONT_PRESETS) fontSelect.createEl('option', { value: f.value, text: f.label })
		const presetValue = FONT_PRESETS.some(f => f.value === a.fontFamily) ? a.fontFamily : ''
		fontSelect.value = presetValue
		const customFont = fontCol.createEl('input', { attr: { type: 'text', placeholder: '自定义字体名（可留空），如 霞鹜文楷' } })
		if (!presetValue && a.fontFamily) customFont.value = a.fontFamily.replace(/["']/g, '')
		const themeFont = getComputedStyle(document.body).getPropertyValue('--font-text').trim()
		const preview = fontCol.createDiv('grove-font-preview')
		preview.setText('永 Aa 阅读字体预览 123')
		preview.style.fontFamily = a.fontFamily || themeFont || 'serif'
		const updatePreview = (family: string): void => {
			preview.style.fontFamily = family || themeFont || 'serif'
		}
		fontSelect.addEventListener('change', () => {
			updatePreview(fontSelect.value)
			this.#patchAppearance({ fontFamily: fontSelect.value })
		})
		customFont.addEventListener('change', () => {
			const raw = customFont.value.trim()
			// 字体名里的引号会破坏后面拼进 CSS 的 font-family 声明，直接剔除
			const family = raw ? raw.split(',').map(s => `"${s.trim().replace(/"/g, '')}"`).join(', ') : ''
			updatePreview(family)
			this.#patchAppearance({ fontFamily: family })
		})

		// —— 滑杆 ——
		const sliders: Array<{ label: string; key: keyof ReaderAppearance; min: number; max: number; step: number; fmt: (v: number) => string }> = [
			{ label: '字号', key: 'fontSize', min: 80, max: 180, step: 5, fmt: v => `${Math.round(v)}%` },
			{ label: '行距', key: 'lineHeight', min: 1.2, max: 2.4, step: 0.05, fmt: v => v.toFixed(2) },
			{ label: '上下留白', key: 'pageMargin', min: 0, max: 200, step: 4, fmt: v => `${Math.round(v)}px` },
			{ label: '段间距', key: 'paragraphSpacing', min: 0, max: 2, step: 0.1, fmt: v => (v <= 0 ? '跟随书籍' : `${v.toFixed(1)}em`) },
			{ label: '版心宽', key: 'maxInlineSize', min: 480, max: 1200, step: 20, fmt: v => `${Math.round(v)}px` },
		]
		for (const s of sliders) {
			const row = panel.createDiv('grove-appear-row')
			row.createSpan('grove-appear-label').setText(s.label)
			const wrap = row.createDiv('grove-appear-slider')
			const range = wrap.createEl('input', {
				attr: { type: 'range', min: String(s.min), max: String(s.max), step: String(s.step) },
			})
			const valueEl = wrap.createSpan('grove-appear-value')
			const current = Number(a[s.key]) || s.min
			range.value = String(current)
			valueEl.setText(s.fmt(current))
			range.addEventListener('input', () => {
				const v = Number.parseFloat(range.value)
				valueEl.setText(s.fmt(v))
				this.#patchAppearance({ [s.key]: v } as Partial<ReaderAppearance>)
			})
		}

		// —— 翻页 ——
		const pageRow = panel.createDiv('grove-appear-row')
		pageRow.createSpan('grove-appear-label').setText('翻页')
		const pageCol = pageRow.createDiv('grove-appear-col')
		const wheelLabel = pageCol.createEl('label', { cls: 'grove-appear-toggle' })
		const wheelBox = wheelLabel.createEl('input', { attr: { type: 'checkbox' } })
		wheelBox.checked = a.wheelPageTurn
		wheelLabel.createSpan({ text: '鼠标滚动切换（上下滚动翻页）' })
		wheelBox.addEventListener('change', () => this.#patchAppearance({ wheelPageTurn: wheelBox.checked }))

		const foot = panel.createDiv('grove-appear-foot')
		const reset = foot.createEl('button', { text: '恢复默认' })
		reset.addEventListener('click', () => {
			Object.assign(this.plugin.settings.appearance, DEFAULT_APPEARANCE)
			this.#applyAppearance()
			void this.plugin.persistSettingsNow()
			this.#renderAppearancePanel()
		})
	}

	#patchAppearance(patch: Partial<ReaderAppearance>): void {
		Object.assign(this.plugin.settings.appearance, patch)
		this.#applyAppearance()
		this.plugin.persistSettingsSoon()
		// 背景相关变化需要刷新选中态
		if ('followTheme' in patch || 'bgKey' in patch) this.#renderAppearancePanel()
	}

	#syncAppearanceControls(): void {
		if (!this.appearPanelEl.classList.contains('grove-hidden')) this.#renderAppearancePanel()
	}

	// ------------------------------------------------------------------
	// foliate 事件
	// ------------------------------------------------------------------

	#onLoad = (e: Event): void => {
		const { doc, index } = (e as CustomEvent<{ doc: Document; index: number }>).detail
		// EPUB 正文在 iframe 里，滚轮事件不会冒泡到外层阅读区
		if (!this.wheelDocs.has(doc)) {
			this.wheelDocs.set(doc, index)
			doc.addEventListener('wheel', (we: WheelEvent) => this.#onWheel(we), { passive: false })
			// 左右滑动翻页交给 foliate 自己的 swipe（带跟手拖动和阻尼，手感比我们自己算位移好）。
			// 这里曾经自己监听 touchend 再 nextPage()，会和 foliate 的 snap 叠加，出现一次滑动翻两页，
			// 而且拖选择手柄也会被当成 swipe。已移除，勿再加回。
		}
		// EPUB 正文在 iframe 里，点击不会冒泡到宿主，必须单独在 doc 上监听
		doc.addEventListener('click', (ev: MouseEvent) => {
			if (!this.plugin.isMobile) return
			const target = ev.target as HTMLElement | null
			if (target?.closest('a, button, .grove-annotation')) return
			if (!this.appearPanelEl.classList.contains('grove-hidden')) {
				this.appearPanelEl.addClass('grove-hidden')
				return
			}
			const sel = doc.getSelection()
			if (sel && !sel.isCollapsed) return
			this.#setMobileBarOpen(true)
		})
		if (this.plugin.isMobile) {
			doc.addEventListener('touchstart', (event: TouchEvent) => {
				const touch = event.changedTouches[0]
				if (touch) this.touchStart = { x: touch.clientX, y: touch.clientY }
			}, { passive: true })
			doc.addEventListener('touchend', (event: TouchEvent) => {
				const start = this.touchStart
				this.touchStart = null
				const touch = event.changedTouches[0]
				const bar = this.contentEl.querySelector('.grove-toolbar') as HTMLElement | null
				if (!start || !touch || bar?.dataset.barOpen !== '1') return
				const dy = touch.clientY - start.y
				if (dy < -44 && Math.abs(dy) > Math.abs(touch.clientX - start.x) * 1.2) this.#setMobileBarOpen(false)
			}, { passive: true })
		}

		doc.addEventListener('pointerup', (ev: PointerEvent) => {
			const t = ev.target
			if (t instanceof Element && t.closest('.grove-sel-popup')) return
			const point = { x: ev.clientX, y: ev.clientY }
			window.setTimeout(() => this.#captureSelection(doc, index, point), 0)
		})
		doc.addEventListener('keydown', (ke: KeyboardEvent) => {
			if (!PAGE_KEYS.has(ke.key)) return
			const sel = doc.defaultView?.getSelection()
			if (sel && !sel.isCollapsed) return // 正在用键盘选字时不翻页
			if (ke.key === 'ArrowLeft') this.foliate?.goLeft()
			else if (ke.key === 'ArrowRight') this.foliate?.goRight()
		})
	}

	#onRelocate = (e: Event): void => {
		const d = (e as CustomEvent<RelocateDetail>).detail
		// 阅读统计：位置变化计一次「翻页」（首次定位是基线，不计）
		const moved = !!d.location && d.location.current !== this.lastStatsLoc
		if (d.location) {
			if (moved && this.lastStatsLoc !== null) this.plugin.statsPageTurn(this.bookPath)
			this.lastStatsLoc = d.location.current
		}
		// 手机端：翻页或滚动换了位置就自动收起工具栏，别让它一直挡正文（拖进度条时不收）
		if (moved && this.plugin.isMobile && !this.sliderActive) {
			const bar = this.contentEl.querySelector('.grove-toolbar') as HTMLElement | null
			if (bar?.dataset.barOpen === '1') this.#setMobileBarOpen(false)
		}
		const percent = Math.round((d.fraction ?? 0) * 100)
		// 手机窄屏一行放不下「0% · Loc 0」，只留百分比，把颜色和评论按钮留在首屏
		this.progressLabel.setText(
			this.plugin.isMobile
				? `${percent}%`
				: `${percent}%${d.pageItem ? ` · 第 ${d.pageItem.label} 页` : d.location ? ` · Loc ${d.location.current}` : ''}`,
		)
		if (!this.sliderActive) this.slider.value = String(d.fraction ?? 0)
		if (d.tocItem?.href) {
			const match = Array.from(this.tocSelect.options).find(o => o.value === d.tocItem!.href)
			if (match) this.tocSelect.value = d.tocItem.href
		}
		if (d.cfi && d.cfi !== this.lastSavedCfi && this.data) {
			this.lastSavedCfi = d.cfi
			this.data.lastLocation = {
				cfi: d.cfi,
				index: d.section?.current ?? 0,
				fraction: d.fraction,
				updatedAt: Date.now(),
			}
			this.#scheduleSave()
		}
	}

	#onDrawAnnotation = (e: Event): void => {
		const { draw, annotation } = (e as CustomEvent<{
			draw: (func: typeof Overlayer.highlight, options?: Record<string, unknown>) => void
			annotation: { color?: string }
		}>).detail
		draw(Overlayer.highlight, { color: annotation.color ?? '#ffe066' })
	}

	#onCreateOverlay = (e: Event): void => {
		const { index } = (e as CustomEvent<{ index: number }>).detail
		for (const a of this.data?.annotations ?? []) {
			if (this.#sectionIndexOf(a) === index) void this.#drawAnnotation(a)
		}
	}

	#onShowAnnotation = (e: Event): void => {
		const detail = (e as CustomEvent<{ value: string; index: number; range: Range }>).detail
		const a = this.data?.annotations.find(x => x.cfi === detail.value)
		if (!a) return
		this.#revealInSidebar(a)
		const menu = new Menu()
		menu.addItem(item => item.setTitle('编辑评论').setIcon('message-square').onClick(() => this.#editComment(a)))
		menu.addItem(item => {
			// setSubmenu 运行时存在但未包含在官方类型定义中
			const sub = (item.setTitle('更改颜色').setIcon('palette') as unknown as { setSubmenu(): Menu }).setSubmenu()
			for (const c of HIGHLIGHT_COLORS) {
				sub.addItem((ci: MenuItem) => {
					ci.setTitle(c.name).onClick(() => void this.#changeColor(a, c.key))
					// 原生菜单图标只能是单色，这里直接往菜单项里塞一个彩色圆点
					const dom = (ci as unknown as { dom?: HTMLElement }).dom
					if (dom) {
						const dot = dom.createSpan({ cls: 'grove-menu-color-dot' })
						dot.style.backgroundColor = c.css
					}
				})
			}
		})
		menu.addSeparator()
		menu.addItem(item =>
			item.setTitle('发送到 Canvas').setIcon('layout-dashboard').onClick(() => void this.plugin.exportToCanvas(this, [a.id])))
		menu.addItem(item =>
			item.setTitle('复制原文').setIcon('copy').onClick(() => {
				void navigator.clipboard.writeText(a.text)
				new Notice('Grove Reader：已复制')
			}))
		menu.addItem(item => item.setTitle('删除批注').setIcon('trash-2').onClick(() => this.#confirmDelete(a)))
		menu.showAtPosition(this.#hostCoords(detail.range))
	}

	// ------------------------------------------------------------------
	// 划选 → 高亮 / 评论
	// ------------------------------------------------------------------

	#captureSelection(doc: Document, index: number, point?: { x: number; y: number }): void {
		if (!this.foliate) return
		const sel = doc.defaultView?.getSelection()
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			this.#clearPending()
			return
		}
		const range = sel.getRangeAt(0)
		const text = sel.toString().replace(/\r/g, '')
		if (!text.trim()) {
			this.#clearPending()
			return
		}
		let cfi: string
		try {
			cfi = this.foliate.getCFI(index, range)
		} catch {
			return
		}
		this.pending = { cfi, text: text.trim(), index }
		if (this.plugin.isMobile) {
			this.#hidePopup()
			this.popupTimer = null
		} else this.#showPopup(doc, range, point)
	}

	#clearPending(): void {
		this.pending = null
		this.#hidePopup()
		// 同 TextView：只是清待处理选区，不碰工具栏。点正文时 pointerup 后的
		// #captureSelection 会因为选区为空走到这里，顺手收栏会造成「闪一下就没」。
	}

	#showPopup(_doc: Document, range: Range, point?: { x: number; y: number }): void {
		this.#hidePopup()
		const dark = document.body.classList.contains('theme-dark')
		// 弹条必须挂在主窗口：留在 iframe 里时 position:fixed 会被 iframe 边界裁剪，
		// 侧栏一开一关就会「只露一半」甚至整个消失
		const popup = document.createElement('div')
		popup.className = 'grove-sel-popup'
		popup.style.cssText = [
			'position:fixed',
			'z-index:2147483000',
			'display:flex',
			'gap:6px',
			'align-items:center',
			'padding:5px 8px',
			'border-radius:8px',
			'box-shadow:0 4px 14px rgba(0,0,0,.25)',
			`background:${dark ? '#26262b' : '#ffffff'}`,
			`border:1px solid ${dark ? '#3f3f46' : '#d0d0d6'}`,
		].join(';')
		popup.addEventListener('mousedown', e => e.preventDefault())

		for (const c of HIGHLIGHT_COLORS) {
			const dot = document.createElement('button')
			dot.title = `高亮（${c.name}）`
			dot.style.cssText = `width:18px;height:18px;border-radius:50%;border:1px solid rgba(0,0,0,.25);cursor:pointer;background:${c.css};padding:0;flex:none;`
			dot.addEventListener('click', e => {
				e.preventDefault()
				void this.#createHighlightFromPending(c.key)
			})
			popup.appendChild(dot)
		}

		const commentBtn = document.createElement('button')
		commentBtn.textContent = '评论'
		commentBtn.style.cssText = `border:none;cursor:pointer;padding:3px 8px;border-radius:6px;font-size:12px;background:${dark ? '#3a3a42' : '#ececf0'};color:${dark ? '#dcddde' : '#1f1f23'};`
		commentBtn.addEventListener('click', e => {
			e.preventDefault()
			void this.#commentOnPending()
		})
		popup.appendChild(commentBtn)

		const copyBtn = document.createElement('button')
		copyBtn.textContent = '复制'
		copyBtn.style.cssText = commentBtn.style.cssText
		copyBtn.addEventListener('click', e => {
			e.preventDefault()
			if (this.pending) void navigator.clipboard.writeText(this.pending.text).then(() => new Notice('Grove Reader：已复制'))
			this.#clearPending()
		})
		popup.appendChild(copyBtn)

		const aiBtn = document.createElement('button')
		aiBtn.textContent = '解释'
		aiBtn.title = '用 AI 解释这段文字'
		aiBtn.style.cssText = commentBtn.style.cssText
		aiBtn.addEventListener('click', e => {
			e.preventDefault()
			void this.#explainSelection()
		})
		popup.appendChild(aiBtn)

		document.body.appendChild(popup)
		this.popup = popup

		// 贴着选区「视觉上最靠下的那一行」：分栏时 getClientRects 的顺序不等于视觉顺序，
		// 直接取最后一个会落到左栏；按 bottom 取最大才是真正的末行
		const host = this.readerEl.getBoundingClientRect()
		let anchorX: number
		let anchorBottom: number
		let anchorTop: number
		// 坐标基准必须是 iframe 本身，而不是外层阅读区：
		// foliate 的 iframe 相对 .grove-reader 有 padding（实测左 33px / 上 48px），
		// 用 readerEl 当原点会让弹条整体偏移一格，看起来就是"离字很远"
		const frameEl = _doc.defaultView?.frameElement as HTMLElement | null
		const base = frameEl?.getBoundingClientRect() ?? this.readerEl.getBoundingClientRect()
		// 只取「当前视口里」的矩形：选区可能跨好几屏，视口外的行会把锚点推到几千像素外
		const viewH = _doc.defaultView?.innerHeight ?? window.innerHeight
		const viewW = _doc.defaultView?.innerWidth ?? window.innerWidth
		const rects = Array.from(range.getClientRects()).filter(
			r => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < viewH && r.right > 0 && r.left < viewW,
		)
		// 垂直方向要用选区的「第一行」顶部，否则多行选区时弹条会插到中间盖住前面的行；
		// 水平方向仍用「最后一行」居中，贴近用户松手的位置
		let firstLine: DOMRect | null = null
		let lastLine: DOMRect | null = null
		for (const r of rects) {
			if (!firstLine || r.top < firstLine.top) firstLine = r
			if (!lastLine || r.bottom > lastLine.bottom) lastLine = r
		}
		// 垂直用「选区包围盒的顶边」：它对单行、多行、跨栏都准确，
		// 逐行取 min(top) 反而可能拿到上一行，弹条就会离文字空出一整行。
		// 水平仍用可见末行的中心，贴近松手位置。
		const box = range.getBoundingClientRect()
		const topY = box.top >= 0 ? box.top : (firstLine?.top ?? 0)
		anchorTop = base.top + topY
		if (lastLine) {
			anchorX = base.left + lastLine.left + lastLine.width / 2
		} else if (point) {
			anchorX = base.left + point.x
		} else {
			anchorX = base.left + base.width / 2
		}
		// 以「最后一行」为锚：用户拖选时视线停在松手处，工具条贴在那里最自然
		const lastTop = lastLine ? base.top + lastLine.top : anchorTop
		const lastLeft = lastLine ? base.left + lastLine.left : base.left + box.left
		const lastBottom = base.top + box.bottom
		const size = popup.getBoundingClientRect()
		let left = lastLeft - 4
		left = Math.max(8, Math.min(left, window.innerWidth - size.width - 8))
		// 贴在选区上方：用包围盒顶边（多行时即首行）算，间距 6px；
		// 上方放不下（选区贴着页顶）才落到下方
		const safeTop = this.plugin.isMobile ? 64 : 8
		let top = anchorTop - size.height - 6
		if (top < safeTop) top = Math.min(lastBottom + 6, window.innerHeight - size.height - 8)
		top = Math.max(safeTop, Math.min(top, window.innerHeight - size.height - 8))
		popup.style.left = `${Math.round(left)}px`
		popup.style.top = `${Math.round(top)}px`

		// 点主窗口别处就收起；iframe 内的点击由 captureSelection 重新定位
		const closer = (ev: MouseEvent): void => {
			if (this.popup && !this.popup.contains(ev.target as Node)) this.#hidePopup()
		}
		this.popupCloser = closer
		window.setTimeout(() => {
			if (this.popupCloser) document.addEventListener('mousedown', this.popupCloser, true)
		}, 0)
	}

	/** 划词解释：调 AI 并把结果放进浮层（浮层与 TXT 阅读器共用 aiPanel.ts） */
	async #explainSelection(): Promise<void> {
		const pending = this.pending
		if (!pending) return
		const text = pending.text
		const bar = this.popup?.getBoundingClientRect()
		this.#clearPending()
		const cfg = {
			baseUrl: this.plugin.settings.aiBaseUrl ?? '',
			apiKey: this.plugin.settings.aiApiKey ?? '',
			model: this.plugin.settings.aiModel ?? '',
			prompt: this.plugin.settings.aiPrompt ?? '',
		}
		await this.aiPanel.explain(cfg, text, bar)
	}

	#hidePopup(): void {
		if (this.popupTimer !== null) {
			window.clearTimeout(this.popupTimer)
			this.popupTimer = null
		}
		if (this.popupCloser) {
			document.removeEventListener('mousedown', this.popupCloser, true)
			this.popupCloser = null
		}
		this.popup?.remove()
		this.popup = null
	}

	async #createHighlightFromPending(color: string): Promise<void> {
		const pending = this.pending ?? this.#readCurrentSelection()
		if (!pending) {
			new Notice('Grove Reader：请先在正文中划选文字')
			return
		}
		if (!this.foliate || !this.data) return
		const now = Date.now()
		let a = this.data.annotations.find(x => x.cfi === pending.cfi)
		if (a) {
			a.color = color
			a.updatedAt = now
		} else {
			a = {
				id: randomId(),
				cfi: pending.cfi,
				text: pending.text,
				color,
				note: '',
				createdAt: now,
				updatedAt: now,
			}
			this.data.annotations.push(a)
		}
		await this.#drawAnnotation(a)
		this.#clearPending()
		try {
			this.foliate.deselect()
		} catch {
			// ignore
		}
		this.#scheduleSave(true)
		this.#renderSidebar()
		if (this.plugin.isMobile) this.#setMobileBarOpen(false)
	}

	async #commentOnPending(): Promise<void> {
		const pending = this.pending ?? this.#readCurrentSelection()
		if (!pending) {
			new Notice('Grove Reader：请先在正文中划选文字')
			return
		}
		if (!this.data) return
		let a = this.data.annotations.find(x => x.cfi === pending.cfi)
		if (!a) {
			const now = Date.now()
			a = {
				id: randomId(),
				cfi: pending.cfi,
				text: pending.text,
				color: 'yellow',
				note: '',
				createdAt: now,
				updatedAt: now,
			}
			this.data.annotations.push(a)
			await this.#drawAnnotation(a)
			this.#clearPending()
			try {
				this.foliate?.deselect()
			} catch {
				// ignore
			}
		}
		this.#editComment(a)
	}

	#readCurrentSelection(): PendingSelection | null {
		for (const [doc, index] of this.wheelDocs) {
			const selection = doc.getSelection()
			if (!selection || selection.isCollapsed || !selection.rangeCount) continue
			const range = selection.getRangeAt(0)
			const text = selection.toString().replace(/\r/g, '').trim()
			if (!text) continue
			if (!this.foliate) continue
			try {
				return { cfi: this.foliate.getCFI(index, range), text, index }
			} catch {
				continue
			}
		}
		return null
	}

	async #drawAnnotation(a: Annotation): Promise<void> {
		if (!this.foliate) return
		try {
			const result = await this.foliate.addAnnotation({ ...a, value: a.cfi })
			if (result) {
				a.sectionIndex = result.index
				if (result.label) a.chapter = result.label
			}
		} catch (err) {
			console.error('[Grove Reader] 绘制批注失败', err)
		}
	}

	#sectionIndexOf(a: Annotation): number | null {
		if (typeof a.sectionIndex === 'number') return a.sectionIndex
		try {
			return this.foliate?.resolveNavigation(a.cfi)?.index ?? null
		} catch {
			return null
		}
	}

	/**
	 * 手机端工具栏开合。收起态是一条 20px 窄条（只露「工具栏」按钮），展开态是单行可横滑工具栏。
	 * 状态只认 dataset.barOpen 一处，class / 文案 / 内联样式都由它派生，避免两套状态打架。
	 */
	#setMobileBarOpen(open: boolean): void {
		const bar = this.contentEl.querySelector('.grove-toolbar') as HTMLElement | null
		if (!bar) return
		bar.dataset.barOpen = open ? '1' : '0'
		const handle = this.mobileToolbarHandle
		if (handle) {
			handle.setText(open ? '收起' : '工具栏')
			handle.setAttribute('aria-label', open ? '收起阅读工具栏' : '展开阅读工具栏')
		}
		// 高度由 CSS 的 [data-bar-open] 决定；这里压掉主题可能加的位移，保证两种状态都贴顶
		bar.style.setProperty('transform', 'translateY(0)', 'important')
		if (open) bar.scrollLeft = 0
	}

	#hostCoords(range: Range): { x: number; y: number } {
		// 同样以 iframe 为基准，否则批注菜单也会整体偏一格
		const frame = range.startContainer.ownerDocument?.defaultView?.frameElement as HTMLElement | null
		const host = frame?.getBoundingClientRect() ?? this.readerEl.getBoundingClientRect()
		try {
			// 取选区最后一个矩形，跨栏时才不会飘到页面中间
			const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 || r.height > 0)
			const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
			return {
				x: Math.round(host.left + r.left + r.width / 2),
				y: Math.round(host.top + r.bottom + 6),
			}
		} catch {
			return { x: Math.round(host.left + host.width / 2), y: Math.round(host.top + host.height / 2) }
		}
	}

	// ------------------------------------------------------------------
	// 批注操作
	// ------------------------------------------------------------------

	#editComment(a: Annotation): void {
		new CommentModal(this.app, a.note ?? '', note => {
			a.note = note
			a.updatedAt = Date.now()
			this.#scheduleSave(true)
			this.#renderSidebar()
		}).open()
	}

	async #changeColor(a: Annotation, color: string): Promise<void> {
		a.color = color
		a.updatedAt = Date.now()
		await this.#drawAnnotation(a)
		this.#scheduleSave(true)
		this.#renderSidebar()
	}

	#confirmDelete(a: Annotation): void {
		new ConfirmModal(this.app, `删除这条批注？「${truncate(a.text.replace(/\s+/g, ' ').trim(), 40)}」`, () => void this.#deleteAnnotation(a)).open()
	}

	async #deleteAnnotation(a: Annotation): Promise<void> {
		const arr = this.data?.annotations
		if (!arr) return
		const i = arr.indexOf(a)
		if (i >= 0) arr.splice(i, 1)
		try {
			await this.foliate?.deleteAnnotation({ ...a, value: a.cfi })
		} catch {
			// ignore
		}
		this.#scheduleSave(true)
		this.#renderSidebar()
		new Notice('Grove Reader：批注已删除（历史备份仍保留在插件数据目录中）')
	}

	// ------------------------------------------------------------------
	// 批注多选删除 / 筛选记忆
	// ------------------------------------------------------------------

	#setSelectMode(on: boolean): void {
		this.selectMode = on
		this.selectedIds.clear()
		this.selectBarEl.toggleClass('grove-hidden', !on)
		this.#refreshSelectBar()
		this.#renderSidebar()
	}

	#refreshSelectBar(): void {
		if (this.selectMode) this.selectCountEl.setText(`已选 ${this.selectedIds.size} 条`)
	}

	#toggleSelected(id: string): void {
		if (this.selectedIds.has(id)) this.selectedIds.delete(id)
		else this.selectedIds.add(id)
		this.#refreshSelectBar()
		const item = this.annItemEls.get(id)
		item?.toggleClass('grove-ann-selected', this.selectedIds.has(id))
	}

	#deleteSelected(): void {
		const ids = [...this.selectedIds]
		if (!ids.length) return
		new ConfirmModal(this.app, `删除所选的 ${ids.length} 条批注？此操作不可撤销。`, () => {
			void this.#doDeleteSelected(ids)
		}).open()
	}

	async #doDeleteSelected(ids: string[]): Promise<void> {
		const arr = this.data?.annotations
		if (!arr) return
		for (const id of ids) {
			const i = arr.findIndex(a => a.id === id)
			if (i < 0) continue
			const a = arr[i]
			arr.splice(i, 1)
			try {
				await this.foliate?.deleteAnnotation({ ...a, value: a.cfi })
			} catch {
				// ignore
			}
		}
		this.#scheduleSave(true)
		this.selectedIds.clear()
		this.#refreshSelectBar()
		this.#renderSidebar()
		new Notice(`Grove Reader：已删除 ${ids.length} 条批注（历史备份仍保留在插件数据目录中）`)
	}

	#filterKey(): string {
		return `grove-ann-filter:${this.plugin.store.bookId(this.bookPath)}`
	}

	/** 批注栏搜索词/颜色筛选/排序按书记忆（localStorage） */
	#loadFilterState(): void {
		try {
			const raw = localStorage.getItem(this.#filterKey())
			const f = raw ? (JSON.parse(raw) as { q?: string; color?: string | null; sort?: 'position' | 'recent' }) : {}
			this.sidebarQuery = f.q ?? ''
			this.sidebarColor = f.color ?? null
			if (f.sort === 'recent' || f.sort === 'position') this.sortMode = f.sort
		} catch {
			this.sidebarQuery = ''
			this.sidebarColor = null
		}
	}

	#saveFilterState(): void {
		try {
			localStorage.setItem(this.#filterKey(), JSON.stringify({ q: this.sidebarQuery, color: this.sidebarColor, sort: this.sortMode }))
		} catch {
			// ignore
		}
	}

	// ------------------------------------------------------------------
	// 目录 / 进度 / 侧栏
	// ------------------------------------------------------------------

	#buildToc(toc: FoliateTOCItem[]): void {
		this.tocSelect.empty()
		this.tocSelect.createEl('option', { value: '', text: '目录' })
		this.tocBySection.clear()
		const add = (items: FoliateTOCItem[], depth: number): void => {
			for (const item of items ?? []) {
				if (!item?.href) continue
				const label = `${'\u00a0\u00a0'.repeat(depth)}${item.label ?? '（无标题）'}`
				this.tocSelect.createEl('option', { value: item.href, text: truncate(label, 60) })
				// 「第一部分」和「第1章」常常指向同一个 html（靠 #anchor 区分），
				// 只按 spine 索引匹配会把章吞掉，这里同索引里保留层级最深的那项
				if (this.foliate?.book?.resolveHref) {
					try {
						const resolved = this.foliate.book.resolveHref(item.href)
						if (typeof resolved?.index === 'number') {
							const prev = this.tocBySection.get(resolved.index)
							const title = (item.label ?? '').trim()
							if (title && (!prev || depth >= prev.depth)) {
								this.tocBySection.set(resolved.index, { label: title, depth })
							}
						}
					} catch {
						// 解析失败就退回 foliate 给的 label
					}
				}
				if (item.subitems?.length) add(item.subitems, depth + 1)
			}
		}
		add(toc, 0)
		this.tocSelect.disabled = this.tocSelect.options.length <= 1
	}

	/** 批注所属章节：优先用目录里最具体的那一项，历史数据也一并纠正 */
	#chapterOf(a: Annotation): string {
		const si = this.#sectionIndexOf(a)
		if (si !== null) {
			const hit = this.tocBySection.get(si)
			if (hit) return hit.label
		}
		return (a.chapter ?? '').trim() || '未命名章节'
	}

	#renderSidebar(): void {
		const all = [...(this.data?.annotations ?? [])].sort((x, y) => {
			const ix = x.sectionIndex ?? Number.MAX_SAFE_INTEGER
			const iy = y.sectionIndex ?? Number.MAX_SAFE_INTEGER
			if (ix !== iy) return ix - iy
			// cfi 不能按字符串比：",/104" 里的逗号比数字小，会把靠后的批注排到前面
			return compareCfi(x.cfi, y.cfi)
		})
		const q = this.sidebarQuery.toLowerCase()
		const filtering = !!q || !!this.sidebarColor
		const filtered = all.filter(a => {
			if (this.sidebarColor && a.color !== this.sidebarColor) return false
			if (!q) return true
			return `${a.text}\n${a.note ?? ''}\n${this.#chapterOf(a)}`.toLowerCase().includes(q)
		})

		this.annCountEl.setText(filtering ? `${filtered.length} / ${all.length} 个批注` : `${all.length} 个批注`)
		this.clearBtnEl.toggleClass('grove-hidden', !filtering)
		for (const [key, dot] of this.filterDotEls) dot.toggleClass('is-active', this.sidebarColor === key)

		this.annListEl.empty()
		this.annItemEls.clear()
		if (!all.length) {
			this.annListEl.createDiv('grove-ann-empty').setText('暂无批注。在正文中划选文字即可添加高亮与评论。')
			return
		}
		if (!filtered.length) {
			this.annListEl.createDiv('grove-ann-empty').setText('没有匹配的批注。')
			return
		}

		if (this.collapseAllBtnEl) {
			const keys = new Set<string>()
			for (const a of this.data?.annotations ?? []) keys.add(this.#chapterOf(a))
			const allCollapsed = keys.size > 0 && [...keys].every(k => (this.annCollapsed ?? new Set<string>()).has(k))
			this.collapseAllBtnEl.setText(allCollapsed ? '展开全部' : '折叠全部')
			this.collapseAllBtnEl.disabled = this.sortMode === 'recent' || keys.size === 0
		}

		// 「最近」排序：平铺列出，不按章节分组
		if (this.sortMode === 'recent') {
			for (const a of [...filtered].sort((x, y) => y.createdAt - x.createdAt)) {
				this.annListEl.appendChild(this.#renderAnnItem(a))
			}
			return
		}

		if (this.annCollapsed === null) this.#loadCollapsedState()
		const collapsedSet: Set<string> = this.annCollapsed ?? new Set<string>()
		const groups = new Map<string, Annotation[]>()
		for (const a of filtered) {
			const key = this.#chapterOf(a)
			const arr = groups.get(key)
			if (arr) arr.push(a)
			else groups.set(key, [a])
		}
		for (const [chapter, items] of groups) {
			const group = this.annListEl.createDiv('grove-ann-group')
			const head = group.createDiv('grove-ann-group-head')
			const chev = head.createSpan('grove-ann-group-chev')
			setIcon(chev, 'chevron-down')
			head.createSpan('grove-ann-group-title').setText(chapter)
			head.createSpan('grove-ann-group-count').setText(String(items.length))
			const bodyEl = group.createDiv('grove-ann-group-body')
			const collapsed = !filtering && collapsedSet.has(chapter)
			if (collapsed) {
				bodyEl.addClass('grove-hidden')
				setIcon(chev, 'chevron-right')
			}
			head.addEventListener('click', () => {
				const hidden = bodyEl.hasClass('grove-hidden')
				if (hidden) {
					bodyEl.removeClass('grove-hidden')
					setIcon(chev, 'chevron-down')
					collapsedSet.delete(chapter)
				} else {
					bodyEl.addClass('grove-hidden')
					setIcon(chev, 'chevron-right')
					collapsedSet.add(chapter)
				}
				this.#saveCollapsedState()
			})
			for (const a of items) bodyEl.appendChild(this.#renderAnnItem(a))
		}
	}

	#renderAnnItem(a: Annotation): HTMLElement {
		const item = document.createElement('div')
		item.addClass('grove-ann')
		item.toggleClass('grove-ann-selected', this.selectedIds.has(a.id))
		this.annItemEls.set(a.id, item)
		const head = item.createDiv('grove-ann-head')
		if (this.selectMode) {
			const check = head.createEl('input', { attr: { type: 'checkbox' }, cls: 'grove-ann-check' })
			check.checked = this.selectedIds.has(a.id)
			check.addEventListener('click', e => e.stopPropagation())
			check.addEventListener('change', () => this.#toggleSelected(a.id))
		}
		head.createSpan('grove-ann-dot').style.backgroundColor = colorCss(a.color)
		head.createSpan('grove-ann-chapter').setText(this.#chapterOf(a))
		const text = item.createDiv('grove-ann-text')
		text.setText(truncate(a.text.trim(), 160))
		text.addEventListener('click', () => void this.#jumpToCfi(a.cfi))
		if (a.note) item.createDiv('grove-ann-note').setText(truncate(a.note.trim(), 120))
		const actions = item.createDiv('grove-ann-actions')

		const jump = actions.createEl('button', { cls: 'clickable-icon grove-mini-btn', attr: { 'aria-label': '跳转到原文' } })
		setIcon(jump, 'arrow-up-left')
		jump.addEventListener('click', () => void this.#jumpToCfi(a.cfi))

		const edit = actions.createEl('button', { cls: 'clickable-icon grove-mini-btn', attr: { 'aria-label': '编辑评论' } })
		setIcon(edit, 'message-square')
		edit.addEventListener('click', () => this.#editComment(a))

		const del = actions.createEl('button', { cls: 'clickable-icon grove-mini-btn', attr: { 'aria-label': '删除批注' } })
		setIcon(del, 'trash-2')
		del.addEventListener('click', () => this.#confirmDelete(a))
		return item
	}

	#collapsedKey(): string {
		return `grove-ann-collapsed:${this.plugin.store.bookId(this.bookPath)}`
	}

	/** 正文点击批注后：展开侧栏、清掉挡住该批注的筛选/折叠，滚动定位并闪烁提示 */
	#revealInSidebar(a: Annotation): void {
		this.sidebarEl.classList.remove('grove-hidden')
		const chapter = this.#chapterOf(a)
		const q = this.sidebarQuery.toLowerCase()
		const filteredOut =
			(this.sidebarColor && a.color !== this.sidebarColor) ||
			(!!q && !`${a.text}\n${a.note ?? ''}\n${this.#chapterOf(a)}`.toLowerCase().includes(q))
		const collapsed = this.annCollapsed?.has(chapter) ?? false
		if (filteredOut) {
			this.sidebarQuery = ''
			this.sidebarColor = null
			if (this.searchInput) this.searchInput.value = ''
			this.#saveFilterState()
		}
		if (collapsed && this.annCollapsed) {
			this.annCollapsed.delete(chapter)
			this.#saveCollapsedState()
		}
		if (filteredOut || collapsed) this.#renderSidebar()
		const el = this.annItemEls.get(a.id)
		if (!el) return
		el.scrollIntoView({ block: 'center', behavior: 'smooth' })
		if (this.revealTimer != null) window.clearTimeout(this.revealTimer)
		this.revealTimer = window.setTimeout(() => {
			this.revealTimer = null
			el.removeClass('grove-ann-revealed')
		}, 2000)
		el.addClass('grove-ann-revealed')
	}

	/** 一次折叠/展开所有章节分组（像文件树的 collapse all） */
	#toggleAllGroups(): void {
		if (!this.data) return
		if (this.annCollapsed === null) this.#loadCollapsedState()
		const set = this.annCollapsed ?? new Set<string>()
		const keys = new Set<string>()
		for (const a of this.data.annotations ?? []) keys.add(this.#chapterOf(a))
		if (!keys.size) return
		const allCollapsed = [...keys].every(k => set.has(k))
		if (allCollapsed) set.clear()
		else for (const k of keys) set.add(k)
		this.annCollapsed = set
		this.#saveCollapsedState()
		this.#renderSidebar()
	}

	#loadCollapsedState(): void {
		try {
			const raw = localStorage.getItem(this.#collapsedKey())
			this.annCollapsed = new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
		} catch {
			this.annCollapsed = new Set<string>()
		}
	}

	#saveCollapsedState(): void {
		if (!this.annCollapsed) return
		try {
			localStorage.setItem(this.#collapsedKey(), JSON.stringify([...this.annCollapsed]))
		} catch {
			// ignore
		}
	}

	#resetSidebarFilters(): void {
		this.annCollapsed = null
		// 搜索词/颜色/排序按书记忆：开书时恢复
		this.#loadFilterState()
		if (this.searchInput) this.searchInput.value = this.sidebarQuery
		if (this.sortBtnEl) this.sortBtnEl.setText(this.sortMode === 'position' ? '排序：章节' : '排序：最近')
	}

	// ------------------------------------------------------------------
	// 跳转与持久化
	// ------------------------------------------------------------------

	async #jumpToCfi(cfi: string, remember = true): Promise<void> {
		if (!this.foliate) return
		const before = remember ? (this.data?.lastLocation?.cfi ?? null) : null
		// 用 goTo 而不是 select：select 会把目标处的文字整段选中，
		// 从「返回」跳回来时会留下一片蓝色选区
		try {
			await this.foliate.goTo(cfi)
		} catch {
			try {
				await this.foliate.select(cfi)
			} catch (err) {
				console.error('[Grove Reader] 跳转失败', err)
			}
		}
		if (before && before !== cfi) this.#showJumpReturn(before)
	}

	/** 跳转后在左下角留一条「返回原位置」，可以一直挂着，也能关掉 */
	#showJumpReturn(fromCfi: string): void {
		this.#hideJumpReturn()
		this.aiPanel.hide()
		let fromLabel = ''
		try {
			const nav = this.foliate?.resolveNavigation?.(fromCfi)
			fromLabel = nav?.label?.trim() || (typeof nav?.index === 'number' ? (this.tocBySection.get(nav.index)?.label ?? '') : '')
		} catch {
			fromLabel = ''
		}
		const bar = this.readerEl.createDiv('grove-jump-return')
		const icon = bar.createSpan('grove-jump-return-icon')
		setIcon(icon, 'corner-up-left')
		bar.createSpan('grove-jump-return-text').setText(fromLabel ? `从「${fromLabel}」跳过来` : '已跳转')
		const back = bar.createEl('button', { cls: 'grove-jump-return-btn', text: '返回' })
		back.addEventListener('click', () => {
			this.#hideJumpReturn()
		this.aiPanel.hide()
			void this.#jumpToCfi(fromCfi, false)
		})
		const close = bar.createEl('button', { cls: 'grove-jump-return-close' })
		setIcon(close, 'x')
		close.title = '关闭'
		close.addEventListener('click', () => this.#hideJumpReturn())
		this.jumpReturnEl = bar
	}

	#hideJumpReturn(): void {
		this.jumpReturnEl?.remove()
		this.jumpReturnEl = null
	}

	jumpTo(cfi: string): void {
		void this.#jumpToCfi(cfi)
	}

	/** 书架手动编辑信息后同步：更新内存数据并落盘，标题即时生效 */
	syncMeta(title: string, author: string): void {
		if (title) {
			this.bookTitle = title
			this.#updateHeaderTitle()
		}
		if (!this.data) return
		this.data.title = title || this.data.title
		if (author) this.data.author = author
		this.#scheduleSave(true)
	}

	#scheduleSave(immediate = false): void {
		if (!this.data) return
		if (this.saveTimer != null) window.clearTimeout(this.saveTimer)
		if (immediate) {
			this.plugin.store.save(this.data)
			// 批注/元数据变更走即时保存，顺带防抖刷新已存在的阅读笔记
			this.plugin.scheduleNoteRefresh(this)
			return
		}
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null
			if (this.data) this.plugin.store.save(this.data)
		}, 1500)
	}

	#flushSave(): void {
		if (this.saveTimer != null) {
			window.clearTimeout(this.saveTimer)
			this.saveTimer = null
		}
		if (this.data) this.plugin.store.save(this.data)
	}

	// ------------------------------------------------------------------
	// 命令入口（供 main.ts 调用）
	// ------------------------------------------------------------------

	/** 鼠标滚轮/触控板上下滚动翻页；输入框、侧栏和选择弹窗不拦 */
	#onWheel(e: WheelEvent): void {
		if (!this.plugin.settings.appearance.wheelPageTurn || !this.foliate) return
		if (e.ctrlKey || e.metaKey || e.defaultPrevented) return
		const sel = e.view?.getSelection?.()
		if (sel && !sel.isCollapsed) return
		const target = e.target as Element | null
		if (target && typeof target.closest === 'function' && target.closest('input, textarea, select, .grove-sel-popup, .grove-page-btns, .grove-appear-panel')) return
		const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
		const raw = horizontal ? e.deltaX : e.deltaY
		const delta = e.deltaMode === 1 ? raw * 16 : e.deltaMode === 2 ? raw * window.innerHeight : raw
		if (!delta) return
		const now = Date.now()
		if (now - this.wheelLast > 420) this.wheelAccum = 0
		this.wheelLast = now
		this.wheelAccum += delta
		if (Math.abs(this.wheelAccum) < 36) return
		e.preventDefault()
		if (this.wheelAccum > 0) this.nextPage()
		else this.prevPage()
		this.wheelAccum = 0
	}

	/** 批注被外部改动（从笔记回写）后刷新侧栏 */
	refreshAnnotations(): void {
		this.#renderSidebar()
	}

	nextPage(): void {
		this.foliate?.goRight()
	}

	prevPage(): void {
		this.foliate?.goLeft()
	}

	highlight(color: string): void {
		void this.#createHighlightFromPending(color)
	}

	comment(): void {
		void this.#commentOnPending()
	}
}
