import { ItemView, Notice, ViewStateResult, WorkspaceLeaf, setIcon } from 'obsidian'
import type GroveReaderPlugin from './main'
import {
	Annotation,
	BACKGROUND_PRESETS,
	BookData,
	DEFAULT_APPEARANCE,
	HIGHLIGHT_COLORS,
	ReaderAppearance,
	colorCss,
} from './types'
import { renderAppearancePanel } from './appearancePanel'
import { JumpReturnBar } from './navReturn'
import { createBookmarkSection, findBookmarkIndex, makeBookmark, type BookmarkSectionHandle } from './bookmarks'
import { createColorControls } from './colorMenu'
import { createCitationSection, type CitationSectionHandle } from './backlinks'
import { CommentModal, ConfirmModal } from './modals'
import { closeAnnMenu, showAnnMenu } from './annMenu'
import { AiPanel } from './aiPanel'
import { basenameOf, cleanBookTitle, contrastFg, isDarkColor, randomId, truncate } from './util'
import { decodeTextBuffer, TextViewState, VIEW_TYPE_GROVE_TEXT } from './textCodec'
import type { GroveLinkTarget } from './wikilink'

export { VIEW_TYPE_GROVE_TEXT } from './textCodec'

/** 与 EPUB 阅读外观面板保持同一组字体预设 */

/** TXT 批注定位：全文字符偏移，形如 txt:1234-1300 */
const TXT_CFI_RE = /^txt:(\d+)(?:-(\d+))?$/
/** 选区弹条宽度，用于夹住屏幕边界 */
const POPUP_WIDTH = 232
/** 章节标题：第X章 / 序章 / 楔子 / 番外 等 */
const CHAPTER_RE =
	/^(?:第[0-9零一二三四五六七八九十百千万两〇○]{1,12}[章节回卷部篇]|序章|楔子|引子|尾声|后记|番外)[\s\u3000]*\S{0,40}$/

interface TextSelection {
	start: number
	end: number
	text: string
}

interface ChapterMark {
	title: string
	offset: number
	/** 1 = 卷/部/篇，2 = 章/节/回 */
	level: 1 | 2
}

function parseTextCfi(cfi: string): { start: number; end: number } | null {
	const m = TXT_CFI_RE.exec((cfi ?? '').trim())
	if (!m) return null
	const start = Number(m[1])
	// 单点定位（txt:1234，阅读进度）允许 end === start；批注一律是 start-end 区间
	const end = m[2] ? Number(m[2]) : start
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
	return { start, end }
}

export class TextView extends ItemView {
	bookPath = ''
	private data: BookData | null = null
	private bytes: ArrayBuffer | null = null
	private pages: string[] = ['']
	/** 每页在全文中的起始字符偏移 */
	private pageStarts: number[] = [0]
	private chapters: ChapterMark[] = []
	private page = 0
	/** 跳转后的「返回原位置」浮条（挂 contentEl：阅读区里的滚动容器会盖住它） */
	private jumpReturn = new JumpReturnBar(() => this.contentEl ?? null)
	/** 书签区的渲染句柄与工具栏按钮 */
	private bookmarkSection: BookmarkSectionHandle | null = null
	/** 手机端颜色弹层的清理函数（桌面是 5 个色点，返回空函数） */
	private colorMenuClose: (() => void) | null = null
	private citationSection: CitationSectionHandle | null = null
	private bookmarkBtnEl: HTMLElement | null = null
	private encoding = 'auto'
	private detected = ''
	private warning: string | undefined
	private bookTitle = 'TXT'
	private loadingPath = ''
	private pendingCfi: string | null = null
	/** 双链降级信息（摘录前若干字 + 章节名），定位串失效时用 */
	private pendingFallback: GroveLinkTarget | null = null
	private lastWheel = 0
	private touchStart: { x: number; y: number } | null = null
	/** 按下那一刻是否已经存在文字选区（拖选手柄时抬手选区可能已空，不能单看抬手状态） */
	private touchHadSelection = false
	private saveTimer: number | null = null

	private pending: TextSelection | null = null
	private popup: HTMLElement | null = null
	private aiPanel = new AiPanel()
	private sidebarQuery = ''
	private sidebarColor: string | null = null
	private sortMode: 'position' | 'recent' = 'position'
	private selectMode = false
	private selectedIds = new Set<string>()
	private annCollapsed: Set<string> | null = null

	private readerEl!: HTMLElement
	private scrollEl!: HTMLElement
	private trackEl!: HTMLElement
	private textEl!: HTMLElement
	private metaEl!: HTMLElement
	private slider!: HTMLInputElement
	private progressLabel!: HTMLElement
	private prevBtn!: HTMLButtonElement
	private pageBtnsEl!: HTMLElement
	private nextBtn!: HTMLButtonElement
	private encodingSelect!: HTMLSelectElement
	private appearPanelEl!: HTMLElement
	private mobileToolbarHandle: HTMLElement | null = null
	private sidebarEl!: HTMLElement
	private annListEl!: HTMLElement
	private annCountEl!: HTMLElement
	private searchInput!: HTMLInputElement
	// 全文搜索（正文，不是批注）
	private fullTextSearchEl: HTMLDetailsElement | null = null
	private fullTextSearchInput!: HTMLInputElement
	private fullTextSearchStatus!: HTMLElement
	private fullTextSearchResults!: HTMLElement
	private fullTextTaskId = 0
	private fullTextCache: string | null = null
	private fullTextLowerCache: string | null = null
	/** 当前定位到的正文命中区间；翻页后消失，重新搜索会替换 */
	private findHit: { start: number; end: number } | null = null
	private filterDotEls = new Map<string, HTMLElement>()
	private clearBtnEl!: HTMLButtonElement
	private sortBtnEl!: HTMLButtonElement
	private selectBarEl!: HTMLElement
	private selectCountEl!: HTMLElement
	private annItemEls = new Map<string, HTMLElement>()
	private tocBtn!: HTMLButtonElement
	private currentChapterOffset = -1
	private tocPop: HTMLElement | null = null
	private tocOutside: ((e: MouseEvent) => void) | null = null
	/** 当前逻辑页内的第几屏（一屏＝一列或两列） */
	private screen = 0
	private screenCount = 1
	/** 渲染后要定位到的字符偏移（目录跳转 / 恢复阅读位置） */
	private pendingOffset: number | null = null
	/** 下一页到上一个逻辑页时，直接落到最后一屏 */
	private gotoLastScreen = false
	/** 需要在渲染后闪烁提示的批注 id */
	private flashAnnId: string | null = null
	/** 跳转时是否让目标文字顶到列首（目录/进度跳转用） */
	private alignToColumnTop = false
	/** 首次渲染/定位过程中，忽略 ResizeObserver 的重排请求 */
	private rendering = false
	private layoutRetry = 0
	private resizeObserver: ResizeObserver | null = null
	private relayoutTimer: number | null = null

	constructor(leaf: WorkspaceLeaf, private plugin: GroveReaderPlugin) {
		super(leaf)
		// 与 ReaderView / PdfView 一致：TXT 视图不需要 Obsidian 的前进后退导航栏。
		// 注意：titleEl 是 View 基类字段，子类不要声明同名字段，否则会覆盖基类元素，
		// 导致 View.load() 里 this.titleEl.setText 抛错、onOpen 永不执行（整页空白）。
		this.navigation = false
	}

	getViewType(): string {
		return VIEW_TYPE_GROVE_TEXT
	}

	getDisplayText(): string {
		if (this.bookTitle && this.bookTitle !== 'TXT') return this.bookTitle
		return this.bookPath ? cleanBookTitle(basenameOf(this.bookPath)) : 'TXT'
	}

	getIcon(): string {
		return 'file-text'
	}

	get ready(): boolean {
		return !!this.data
	}

	snapshot(): BookData | null {
		return this.data
	}

	getState(): Record<string, unknown> {
		const base = super.getState() as Record<string, unknown>
		return { ...base, bookPath: this.bookPath || undefined, page: this.page }
	}

	async setState(state: unknown, result?: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as TextViewState & { file?: string }
		const incoming = s.bookPath ?? (s.file ? String(s.file) : '')
		const page = Number.isFinite(s.page) ? Math.max(0, Number(s.page)) : 0
		if (incoming && incoming !== this.bookPath) {
			this.bookPath = incoming
			this.encoding = 'auto'
			this.page = page
		} else if (incoming) {
			this.page = page
		}
		if (s.cfi) this.pendingCfi = s.cfi
		if (s.fallback) this.pendingFallback = s.fallback
		await super.setState(state, result ?? { history: false })
		if (this.readerEl && this.bookPath) await this.#load()
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty()
		this.contentEl.addClass('grove-content')
		this.#buildDom()
		this.#applyAppearance()
		this.registerEvent(this.app.workspace.on('css-change', () => this.#applyAppearance()))
		this.resizeObserver = new ResizeObserver(() => this.#scheduleRelayout())
		this.resizeObserver.observe(this.scrollEl)
		if (this.bookPath) await this.#load()
		else this.#showEmpty('没有指定要打开的 TXT 文件')
	}

	async onClose(): Promise<void> {
		this.colorMenuClose?.()
		this.colorMenuClose = null
		this.#flushSave()
		this.#hidePopup()
		this.aiPanel.hide()
		this.#closeToc()
		closeAnnMenu()
		this.resizeObserver?.disconnect()
		this.resizeObserver = null
		if (this.relayoutTimer != null) {
			window.clearTimeout(this.relayoutTimer)
			this.relayoutTimer = null
		}
		this.contentEl.empty()
	}

	// ------------------------------------------------------------------
	// DOM 结构（与 ReaderView 保持同一套工具栏 / 侧栏）
	// ------------------------------------------------------------------

	#buildDom(): void {
		const root = this.contentEl
		root.addClass('grove-content')
		this.registerDomEvent(root, 'pointerdown', () => this.plugin.noteReadingActivity(), { passive: true })
		this.registerDomEvent(root, 'click', (event: MouseEvent) => {
			if (!this.plugin.isMobile) return
			const target = event.target as HTMLElement | null
			if (target?.closest('a, button, input, select, .grove-toolbar, .grove-annotation, .grove-sel-popup')) return
			if (window.getSelection()?.toString()) {
				// 这是「选完松手」收尾的那一次点击。别再往上冒泡，否则 Obsidian 的
				// 点击处理会把它当普通点按，顺手把刚选好的文字清掉（表现为选完自己消失）。
				event.stopPropagation()
				return
			}
			this.#setMobileBarOpen(true)
		})
		const toolbar = root.createDiv('grove-toolbar')
		if (this.plugin.isMobile) {
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
		// 本书章节上千条，原生下拉框难用，改成「按钮 + 可搜索目录面板」
		this.tocBtn = tocWrap.createEl('button', { cls: 'grove-toc-btn', text: '目录' })
		this.tocBtn.addEventListener('click', () => this.#openToc())

		const progress = toolbar.createDiv('grove-progress')
		this.slider = progress.createEl('input', {
			attr: { type: 'range', min: '1', max: '1', step: '1', value: '1' },
		})
		this.slider.disabled = true
		this.progressLabel = progress.createSpan('grove-progress-label')
		this.progressLabel.setText('—')
		this.slider.addEventListener('input', () => {
			const offset = Number(this.slider.value)
			if (!Number.isFinite(offset)) return
			const total = this.#totalChars()
			this.progressLabel.setText(total > 0 ? `${Math.round((offset / total) * 100)}%` : '0%')
		})
		this.slider.addEventListener('change', () => {
			const offset = Number(this.slider.value)
			if (Number.isFinite(offset)) this.#jumpToOffset(offset)
		})

		toolbar.createDiv('grove-sep')

		this.colorMenuClose = createColorControls(toolbar, key => void this.#createHighlight(key))

		const commentBtn = toolbar.createEl('button', {
			cls: 'clickable-icon grove-icon-btn',
			attr: { 'aria-label': '为划选文字添加评论' },
		})
		setIcon(commentBtn, 'message-square-plus')
		commentBtn.addEventListener('click', () => void this.#commentOnSelection())

		toolbar.createDiv('grove-flex-spacer')

		const appearBtn = toolbar.createEl('button', {
			cls: 'clickable-icon grove-icon-btn',
			attr: { 'aria-label': '阅读外观（字体 / 背景 / 行距）' },
		})
		setIcon(appearBtn, 'type')
		appearBtn.addEventListener('click', e => {
			e.stopPropagation()
			this.#toggleAppearancePanel()
		})

		const noteBtn = toolbar.createEl('button', {
			cls: 'clickable-icon grove-icon-btn',
			attr: { 'aria-label': '生成 / 更新阅读笔记' },
		})
		setIcon(noteBtn, 'file-text')
		noteBtn.addEventListener('click', () => void this.plugin.generateNoteFor(this))

		const bookmarkBtn = toolbar.createEl('button', {
			cls: 'clickable-icon grove-icon-btn grove-bookmark-btn',
			attr: { 'aria-label': '书签：标记 / 取消当前位置' },
		})
		setIcon(bookmarkBtn, 'bookmark')
		bookmarkBtn.addEventListener('click', () => this.#toggleBookmark())
		this.bookmarkBtnEl = bookmarkBtn

		const sideBtn = toolbar.createEl('button', {
			cls: 'clickable-icon grove-icon-btn',
			attr: { 'aria-label': '批注列表' },
		})
		setIcon(sideBtn, 'list')
		sideBtn.addEventListener('click', () => this.sidebarEl.classList.toggle('grove-hidden'))

		const encodingWrap = toolbar.createDiv('grove-text-encoding')
		this.encodingSelect = encodingWrap.createEl('select', { cls: 'dropdown' })
		for (const [value, label] of [
			['auto', '自动'],
			['utf-8', 'UTF-8'],
			['gb18030', 'GB18030'],
			['big5', 'Big5'],
			['utf-16le', 'UTF-16LE'],
			['utf-16be', 'UTF-16BE'],
		]) this.encodingSelect.createEl('option', { value, text: label })
		this.encodingSelect.value = this.encoding
		this.encodingSelect.addEventListener('change', () => {
			this.encoding = this.encodingSelect.value
			const fraction = this.pages.length > 1 ? this.page / (this.pages.length - 1) : 0
			this.#decodeAndRender(fraction)
			new Notice(`${this.plugin.manifest.name}：编码已切换为 ${this.encoding === 'auto' ? '自动' : this.encoding}`)
		})

		// 编码识别结果：短标签放末尾，鼠标悬停看完整信息
		this.metaEl = toolbar.createDiv('grove-text-meta')

		this.appearPanelEl = root.createDiv('grove-appear-panel grove-hidden')
		this.registerDomEvent(this.contentEl, 'click', e => {
			if (this.appearPanelEl.hasClass('grove-hidden')) return
			const t = e.target
			if (t instanceof Element && !t.closest('.grove-appear-panel') && !t.closest('.grove-appear-button')) {
				this.#setAppearancePanelOpen(false)
			}
		}, { capture: true })

		const body = root.createDiv('grove-body')
		this.readerEl = body.createDiv('grove-reader')
		this.scrollEl = this.readerEl.createDiv('grove-reader-inner grove-text-scroll')
		// track 负责撑出足够的可滚动宽度，保证最后一屏也能左对齐，不露出上一列半截字
		this.trackEl = this.scrollEl.createDiv({ cls: 'grove-text-track' })
		this.textEl = this.trackEl.createDiv({ cls: 'grove-text-content' })
		this.registerDomEvent(this.scrollEl, 'wheel', e => this.#onWheel(e), { passive: false })
		// Obsidian 手机端把横向拖动识别成「拉开侧栏」：到手阈值会整屏开栏，
		// 没到阈值也会一路拖动画布，在相反一侧露白边。这里从第一帧起就不让手势冒泡，
		// 否则前 12px 的位移已经足够让整屏晃一下。
		this.registerDomEvent(this.scrollEl, 'touchmove', (e: TouchEvent) => {
			e.stopPropagation()
		}, { passive: true, capture: true })
		// Obsidian 的手势层对触摸同时挂 pointer 事件，一并截停
		this.registerDomEvent(this.scrollEl, 'pointermove', (e: PointerEvent) => {
			if (e.pointerType === 'touch') e.stopPropagation()
		}, { passive: true, capture: true })
		this.registerDomEvent(this.scrollEl, 'touchstart', (e: TouchEvent) => {
			const touch = e.changedTouches[0]
			if (touch) this.touchStart = { x: touch.clientX, y: touch.clientY }
			this.touchHadSelection = !!window.getSelection()?.toString()
		}, { passive: true })
		this.registerDomEvent(this.scrollEl, 'touchend', (e: TouchEvent) => {
			const start = this.touchStart
			const hadSelection = this.touchHadSelection
			this.touchStart = null
			this.touchHadSelection = false
			const touch = e.changedTouches[0]
			if (!start || !touch) return
			if (this.popup) return
			if (!this.sidebarEl.hasClass('grove-hidden')) return
			if (hadSelection || window.getSelection()?.toString()) return
			const dx = touch.clientX - start.x
			const dy = touch.clientY - start.y
			if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.25) return
			if (dx < 0) this.nextPage()
			else this.prevPage()
		}, { passive: true })

		// 划选 → 弹条；点击已有高亮 → 批注菜单
		this.registerDomEvent(this.scrollEl, 'mouseup', () =>
			window.setTimeout(() => this.#captureSelection(), 10),
		)
		this.registerDomEvent(this.scrollEl, 'keyup', () => this.#captureSelection())
		this.registerDomEvent(this.textEl, 'click', (e: MouseEvent) => this.#onTextClick(e))

		const pageBtns = this.readerEl.createDiv('grove-page-btns')
		this.pageBtnsEl = pageBtns
		this.prevBtn = pageBtns.createEl('button', {
			cls: 'clickable-icon grove-page-btn',
			attr: { 'aria-label': '上一页' },
		})
		setIcon(this.prevBtn, 'chevron-left')
		this.prevBtn.disabled = true
		this.prevBtn.addEventListener('click', () => this.prevPage())
		this.nextBtn = pageBtns.createEl('button', {
			cls: 'clickable-icon grove-page-btn',
			attr: { 'aria-label': '下一页' },
		})
		setIcon(this.nextBtn, 'chevron-right')
		this.nextBtn.disabled = true
		this.nextBtn.addEventListener('click', () => this.nextPage())

		this.#buildSidebar(body)

		this.registerDomEvent(this.contentEl, 'keydown', (e: KeyboardEvent) => {
			const t = e.target
			if (t instanceof HTMLElement && t.closest('input, textarea, select, [contenteditable="true"]')) return
			if (window.getSelection()?.toString()) return
			const axis = this.plugin.settings.txtTurnAxis ?? 'horizontal'
			const prevKey = axis === 'vertical' ? 'ArrowUp' : 'ArrowLeft'
			const nextKey = axis === 'vertical' ? 'ArrowDown' : 'ArrowRight'
			if (e.key !== prevKey && e.key !== nextKey) return
			e.preventDefault()
			if (e.key === nextKey) this.nextPage()
			else this.prevPage()
		})
	}

	#buildSidebar(body: HTMLElement): void {
		this.sidebarEl = body.createDiv('grove-sidebar grove-hidden')
		const sideHead = this.sidebarEl.createDiv('grove-sidebar-head')
		this.annCountEl = sideHead.createSpan('grove-ann-count')
		this.annCountEl.setText('0 个批注')
		const closeSidebar = sideHead.createEl('button', { cls: 'clickable-icon grove-sidebar-close', attr: { 'aria-label': '关闭批注栏', title: '关闭批注栏' } })
		setIcon(closeSidebar, 'x')
		closeSidebar.addEventListener('click', () => this.sidebarEl.classList.add('grove-hidden'))

		// 书签区放在批注区之上：它是导航，不该被下面的搜索/筛选挡住
		this.bookmarkSection = createBookmarkSection(this.sidebarEl, { onAdd: () => this.#toggleBookmark() })
		this.citationSection = createCitationSection(this.sidebarEl)

		// 正文全文搜索：与 EPUB 阅读器同一套 DOM/CSS，收起时不占空间
		const fullTextSearch = this.sidebarEl.createEl('details', { cls: 'grove-fulltext-search' })
		this.fullTextSearchEl = fullTextSearch as HTMLDetailsElement
		fullTextSearch.createEl('summary', { text: '全文搜索' })
		const fullTextSearchControls = fullTextSearch.createDiv('grove-fulltext-search-controls')
		this.fullTextSearchInput = fullTextSearchControls.createEl('input', {
			cls: 'grove-ann-search',
			attr: { type: 'search', placeholder: '输入关键词，按 Enter 搜索本书…' },
		})
		this.fullTextSearchInput.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault()
				this.#runFullTextSearch()
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
			this.#renderSidebar()
		})
		const filterRow = controls.createDiv('grove-ann-filters')
		for (const c of HIGHLIGHT_COLORS) {
			const dot = filterRow.createEl('button', {
				cls: 'grove-filter-dot',
				attr: { 'aria-label': `只看${c.name}色批注`, title: `只看${c.name}色` },
			})
			dot.style.backgroundColor = c.css
			dot.addEventListener('click', () => {
				this.sidebarColor = this.sidebarColor === c.key ? null : c.key
				this.#renderSidebar()
			})
			this.filterDotEls.set(c.key, dot)
		}
		this.clearBtnEl = filterRow.createEl('button', { cls: 'grove-filter-clear grove-hidden', text: '清除筛选' })
		this.clearBtnEl.addEventListener('click', () => {
			this.sidebarQuery = ''
			this.sidebarColor = null
			this.searchInput.value = ''
			this.#renderSidebar()
		})
		const manageRow = controls.createDiv('grove-ann-filters')
		this.sortBtnEl = manageRow.createEl('button', { cls: 'grove-manage-btn', text: '排序：章节' })
		this.sortBtnEl.addEventListener('click', () => {
			this.sortMode = this.sortMode === 'position' ? 'recent' : 'position'
			this.sortBtnEl.setText(this.sortMode === 'position' ? '排序：章节' : '排序：最近')
			this.#renderSidebar()
		})
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
	}

	#showEmpty(message: string): void {
		if (!this.textEl) return
		this.textEl.style.width = ''
		this.textEl.style.height = ''
		this.textEl.style.columnCount = ''
		this.textEl.setText(message)
		this.metaEl.setText('')
		this.progressLabel.setText('—')
		this.slider.disabled = true
		this.prevBtn.disabled = true
		this.nextBtn.disabled = true
	}

	// ------------------------------------------------------------------
	// 读取 / 解码 / 分页
	// ------------------------------------------------------------------

	async #load(): Promise<void> {
		const path = this.bookPath
		if (!path || this.loadingPath === path) return
		this.loadingPath = path
		this.#showEmpty('正在读取…')
		try {
			const bytes = await this.plugin.readBookBytes(path)
			if (this.loadingPath !== path) return
			this.bytes = bytes
			this.data = this.plugin.store.load(path)
			this.bookTitle =
				this.data.title || this.plugin.shelfCache.get(path)?.title || cleanBookTitle(basenameOf(path))
			// 笔记标题取 data.title：首次打开时把书名/作者写进数据
			if (!this.data.title) {
				this.data.title = this.bookTitle
				this.data.author = this.data.author || this.plugin.shelfCache.get(path)?.author || ''
				this.#scheduleSave(true)
			}
			this.#decodeAndRender()
		} catch (e) {
			this.#showEmpty(`读取失败：${e instanceof Error ? e.message : String(e)}`)
		} finally {
			if (this.loadingPath === path) this.loadingPath = ''
		}
	}

	#decodeAndRender(fraction?: number): void {
		if (!this.bytes) return
		const decoded = decodeTextBuffer(this.bytes, this.encoding)
		this.detected = decoded.encoding
		this.warning = decoded.warning
		this.#buildChapters(decoded.text)
		this.#buildPages(decoded.text)
		// 换编码 / 重新解码后原文变了，全文搜索的缓存与命中也必须作废
		this.fullTextCache = null
		this.fullTextLowerCache = null
		this.findHit = null
		this.fullTextSearchResults?.empty()
		this.fullTextSearchStatus?.setText('输入关键词后按 Enter 搜索全文')

		let target: number | null = null
		const jump = this.pendingCfi ? parseTextCfi(this.pendingCfi) : null
		const expected = (this.pendingFallback?.text ?? '').trim()
		if (jump && this.#offsetMatches(jump.start, expected)) target = jump.start
		else if (this.pendingFallback) target = this.#fallbackOffset(this.pendingFallback)
		else if (fraction !== undefined) target = Math.round(fraction * this.#totalChars())
		else if (this.data?.lastLocation?.cfi) {
			const last = parseTextCfi(this.data.lastLocation.cfi)
			if (last) target = last.start
		}
		this.pendingCfi = null
		this.pendingFallback = null
		this.page = target !== null ? this.#pageOfOffset(target) : 0
		this.page = Math.max(0, Math.min(this.pages.length - 1, this.page))
		this.screen = 0
		this.screenCount = 1
		this.gotoLastScreen = false
		this.alignToColumnTop = false
		// 交给 #renderPage 在排版完成后精确定位到那一屏
		this.pendingOffset = target

		const encName = this.detected ? this.detected.toUpperCase() : ''
		// 识别结果压进编码下拉的悬停提示；只有编码异常时才在工具栏显示小标签
		this.metaEl.setText(this.warning ? '编码异常' : '')
		this.metaEl.toggleClass('grove-hidden', !this.warning)
		this.metaEl.title = `编码 ${encName} · ${this.pages.length} 页${this.warning ? ` · ${this.warning}` : ''}`
		this.encodingSelect.title = this.metaEl.title
		this.encodingSelect.value = this.encoding
		this.#buildToc()
		this.#renderSidebar()
		this.#renderPage()
		this.sidebarEl.classList.toggle('grove-hidden', this.plugin.isMobile || !this.plugin.settings.openSidebarWithBook)
	}

	/** 扫描全文里的「第X章 / 序章 / 番外」作为目录；只取行首、长度有限的短行 */
	#buildChapters(text: string): void {
		const out: ChapterMark[] = []
		let offset = 0
		for (const line of text.split('\n')) {
			const trimmed = line.trim()
			if (trimmed.length > 0 && trimmed.length <= 48 && CHAPTER_RE.test(trimmed)) {
				const level: 1 | 2 = /^第[0-9零一二三四五六七八九十百千万两〇○]{1,12}[卷部篇]/.test(trimmed) ? 1 : 2
				out.push({ title: trimmed, offset, level })
				if (out.length >= 3000) break
			}
			offset += line.length + 1
		}
		this.chapters = out
	}

	/**
	 * 按章节切分逻辑页：每章从新的一页开始，标题天然落在页首（与 EPUB「每章一个文档」一致）。
	 * 章节过长时按 3 万字硬切；相邻标题相距不足 200 字时只保留前一个，避免出现大半页空白。
	 */
	#buildPages(text: string): void {
		// 卷标题（第X卷/部/篇）单独占一页，像 EPUB 里每个「部分」是独立文档；
		// 章/节按边界分页，只是切点。全程只读原文，不做任何改写。
		const points: Array<{ offset: number; level: 1 | 2 }> = []
		for (const c of this.chapters) {
			if (c.offset <= 0 || c.offset >= text.length) continue
			if (c.level === 1) {
				points.push({ offset: c.offset, level: 1 })
				continue
			}
			const last = points.length ? points[points.length - 1].offset : 0
			if (c.offset - last < 200) continue
			points.push({ offset: c.offset, level: 2 })
		}
		const hard = 30_000
		const maxPages = 6000
		const pages: string[] = []
		const starts: number[] = []
		let start = 0
		const cuts: Array<{ offset: number; level: 1 | 2 }> = [...points, { offset: text.length, level: 2 }]
		for (const cut of cuts) {
			const at = cut.offset
			while (at - start > hard) {
				pages.push(text.slice(start, start + hard))
				starts.push(start)
				start += hard
			}
			if (cut.level === 1 && at > start) {
				pages.push(text.slice(start, at))
				starts.push(start)
				// 卷标题 + 紧随其后的空行，单独一页
				let end = at
				while (end < text.length && text[end] !== '\n') end++
				while (end < text.length && (text[end] === '\n' || text[end] === '\r')) end++
				pages.push(text.slice(at, end))
				starts.push(at)
				start = end
				if (pages.length >= maxPages) break
				continue
			}
			if (at > start) {
				pages.push(text.slice(start, at))
				starts.push(start)
				start = at
			}
			if (pages.length >= maxPages) break
		}
		if (start < text.length && pages.length < maxPages) {
			pages.push(text.slice(start))
			starts.push(start)
		}
		this.pages = pages.length ? pages : ['']
		this.pageStarts = starts.length ? starts : [0]
	}

	#buildToc(): void {
		if (!this.tocBtn) return
		this.currentChapterOffset = -1
		this.tocBtn.setText(this.chapters.length ? `目录（${this.chapters.length}）` : '目录')
		this.tocBtn.title = this.chapters.length ? '打开目录（可搜索）' : '没有识别到章节'
	}

	/** 打开可搜索目录面板 */
	/** 目录浮层：锚在工具栏按钮下方展开，像原生下拉那样贴着左上角，同时带搜索 */
	#openToc(): void {
		if (this.tocPop) {
			this.#closeToc()
			return
		}
		if (!this.chapters.length) {
			new Notice(`Grove Reader：这本 TXT 没有识别到章节标题`)
			return
		}
		const pop = document.createElement('div')
		pop.className = 'grove-toc-popover'
		pop.addEventListener('mousedown', e => e.stopPropagation())

		const search = document.createElement('input')
		search.className = 'grove-toc-search'
		search.type = 'search'
		search.placeholder = '搜索章节名…'
		pop.appendChild(search)

		const list = document.createElement('div')
		list.className = 'grove-toc-list'
		pop.appendChild(list)

		const render = (keyword: string): void => {
			list.empty()
			const kw = keyword.trim().toLowerCase()
			const items = kw ? this.chapters.filter(c => c.title.toLowerCase().includes(kw)) : this.chapters
			if (!items.length) {
				list.createDiv('grove-toc-empty').setText('没有匹配的章节')
				return
			}
			const limit = 400
			let activeEl: HTMLElement | null = null
			for (const c of items.slice(0, limit)) {
				const item = list.createDiv('grove-toc-item')
				if (c.level === 1) item.addClass('is-volume')
				if (c.offset === this.currentChapterOffset) {
					item.addClass('is-active')
					activeEl = item
				}
				item.createSpan('grove-toc-item-title').setText(c.title)
				item.addEventListener('click', () => {
					this.#closeToc()
					this.#jumpToOffset(c.offset)
				})
			}
			if (items.length > limit) {
				list.createDiv('grove-toc-more').setText(`只显示前 ${limit} 条，输入关键词继续筛选（共 ${items.length} 条）`)
			}
			if (activeEl) {
				const el = activeEl as HTMLElement
				window.setTimeout(() => el.scrollIntoView({ block: 'center' }), 20)
			}
		}

		search.addEventListener('input', () => render(search.value))
		search.addEventListener('keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault()
				this.#closeToc()
				return
			}
			if (e.key !== 'Enter') return
			const kw = search.value.trim().toLowerCase()
			const first = kw ? this.chapters.find(c => c.title.toLowerCase().includes(kw)) : this.chapters[0]
			if (first) {
				this.#closeToc()
				this.#jumpToOffset(first.offset)
			}
		})
		render('')

		document.body.appendChild(pop)
		// 贴在按钮下方；下方放不下就翻到上方，左右夹在视口内
		const btnRect = this.tocBtn.getBoundingClientRect()
		const size = pop.getBoundingClientRect()
		const left = Math.min(Math.max(8, btnRect.left), Math.max(8, window.innerWidth - size.width - 8))
		let top = btnRect.bottom + 6
		if (top + size.height > window.innerHeight - 8) top = Math.max(8, btnRect.top - size.height - 6)
		pop.style.left = `${Math.round(left)}px`
		pop.style.top = `${Math.round(top)}px`

		this.tocPop = pop
		// 浮层开着时让工具栏保持展开，不要因为鼠标移开而收起
		this.readerEl.addClass('is-toc-open')
		window.setTimeout(() => search.focus(), 30)
		this.tocOutside = (e: MouseEvent): void => {
			const target = e.target as Node | null
			if (!target) return
			if (this.tocPop?.contains(target) || this.tocBtn.contains(target)) return
			this.#closeToc()
		}
		window.setTimeout(() => {
			if (this.tocOutside) document.addEventListener('mousedown', this.tocOutside, true)
		}, 0)
	}

	#closeToc(): void {
		this.tocPop?.remove()
		this.tocPop = null
		this.readerEl?.removeClass('is-toc-open')
		if (this.tocOutside) {
			document.removeEventListener('mousedown', this.tocOutside, true)
			this.tocOutside = null
		}
	}

	#syncToc(offsetArg?: number): void {
		if (!this.tocBtn || !this.chapters.length) return
		// 用当前屏的起始字符，而不是逻辑页起点：一页 3 万字里可能跨好几节
		const start = offsetArg ?? this.#currentOffset()
		const pageLen = this.pages[this.page]?.length ?? 0
		const span = pageLen / Math.max(1, this.screenCount)
		let idx = this.#sectionIndexOf(start)
		// 这一屏里刚好开始了下一章（目录跳转后标题通常就在屏内），优先显示它
		const next = idx + 1
		if (next < this.chapters.length && this.chapters[next].offset < start + span) idx = next
		this.currentChapterOffset = idx >= 0 ? this.chapters[idx].offset : -1
		this.tocBtn.setText(idx >= 0 ? truncate(this.chapters[idx].title, 28) : `目录（${this.chapters.length}）`)
		this.tocBtn.title = idx >= 0 ? `${this.chapters[idx].title} · 点击打开目录` : '点击打开目录'
	}

	#chapterAt(offset: number): string | undefined {
		const idx = this.#sectionIndexOf(offset)
		return idx >= 0 ? this.chapters[idx].title : undefined
	}

	#sectionIndexOf(offset: number): number {
		let lo = 0
		let hi = this.chapters.length - 1
		let ans = -1
		while (lo <= hi) {
			const mid = (lo + hi) >> 1
			if (this.chapters[mid].offset <= offset) {
				ans = mid
				lo = mid + 1
			} else hi = mid - 1
		}
		return ans
	}

	#pageOfOffset(offset: number): number {
		let lo = 0
		let hi = this.pageStarts.length - 1
		let ans = 0
		while (lo <= hi) {
			const mid = (lo + hi) >> 1
			if (this.pageStarts[mid] <= offset) {
				ans = mid
				lo = mid + 1
			} else hi = mid - 1
		}
		return ans
	}

	// ------------------------------------------------------------------
	// 渲染当前页（含已有高亮）
	// ------------------------------------------------------------------

	// ------------------------------------------------------------------
	// 分栏分页：一屏＝一列（单页）或两列（双页），翻页整屏切换
	// ------------------------------------------------------------------

	/** 视口内可排版宽度（扣除左右内边距） */
	/** 视口当前能给的宽度（窗口变化后立刻反映） */
	#targetWidth(): number {
		if (!this.scrollEl) return 0
		const style = getComputedStyle(this.scrollEl)
		const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
		const width = this.scrollEl.clientWidth || this.scrollEl.getBoundingClientRect().width
		return Math.max(0, width - pad)
	}

	/**
	 * 当前实际排版用的宽度。
	 * 窗口刚变化时 textEl 还是旧宽度（style.width 是显式 px，不会跟着视口变），
	 * 这时必须用旧值来换算屏号，否则新旧尺寸混用会把位置算跑。
	 */
	#contentWidth(): number {
		const laid = Number.parseFloat(this.textEl?.style.width || '0')
		return laid > 0 ? laid : this.#targetWidth()
	}

	#contentHeight(): number {
		const style = getComputedStyle(this.scrollEl)
		const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
		return Math.max(120, this.scrollEl.clientHeight - pad)
	}

	#columnGap(): number {
		return 56
	}

	/** 当前版式下每屏几列：单页 1，双页 2，自动按可用宽度切换 */
	#columnCount(): number {
		const mode = this.plugin.settings.txtLayout ?? 'auto'
		if (mode === 'single') return 1
		const width = this.#contentWidth()
		if (mode === 'double') return width >= 560 ? 2 : 1
		return width >= 820 ? 2 : 1
	}

	/** 翻一屏的位移：一屏宽 + 一个列间距 */
	#step(): number {
		return this.#contentWidth() + this.#columnGap()
	}

	/**
	 * 下一帧执行，并带定时器兜底与异常保护。
	 * 只用 rAF 时，一旦回调抛错或浏览器暂停 rAF，rendering 锁会永远卡住，
	 * 之后所有翻页/跳转都定位失败（表现为进度和位置不再更新）。
	 */
	#afterFrame(fn: () => void): void {
		let done = false
		const run = (): void => {
			if (done) return
			done = true
			try {
				fn()
			} catch (e) {
				console.error('[Grove Reader] 分页刷新失败', e)
			}
		}
		window.requestAnimationFrame(run)
		window.setTimeout(run, 80)
	}

	#layout(): void {
		if (!this.scrollEl || !this.textEl) return
		if (this.#targetWidth() < 80) return
		this.textEl.style.width = `${this.#targetWidth()}px`
		this.textEl.style.height = `${this.#contentHeight()}px`
		this.textEl.style.columnCount = String(this.#columnCount())
		this.textEl.style.columnGap = `${this.#columnGap()}px`
	}

	/** 让可滚动距离正好等于 (屏数-1)*step，末屏才能左对齐 */
	#syncTrackWidth(): void {
		if (!this.trackEl || !this.textEl) return
		const step = this.#step()
		const count = this.#computeScreenCount()
		const client = this.scrollEl.clientWidth
		const need = (count - 1) * step + client
		this.trackEl.style.width = `${Math.max(this.#contentWidth(), need)}px`
	}

	#computeScreenCount(): number {
		const step = this.#step()
		const total = this.textEl.scrollWidth
		if (!Number.isFinite(total) || total <= 0 || step <= 0) return 1
		return Math.max(1, Math.ceil(total / step - 0.02))
	}

	/** 本页范围内出现的章节标题区间 */
	#headingsInPage(pageStart: number, pageEnd: number): Array<{ start: number; end: number; level: 1 | 2; colon?: number }> {
		const out: Array<{ start: number; end: number; level: 1 | 2; colon?: number }> = []
		if (!this.chapters.length) return out
		let i = Math.max(0, this.#sectionIndexOf(pageStart))
		for (; i < this.chapters.length; i++) {
			const c = this.chapters[i]
			if (c.offset >= pageEnd) break
			const end = c.offset + c.title.length
			if (end <= pageStart) continue
			// 「第一卷：魔性不改」拆成两行：编号一行、标题名一行（与 EPUB 的分行标题一致）
			const colonIdx = c.title.search(/[:：]/)
			const colon = colonIdx > 0 && colonIdx < c.title.length - 1 ? c.offset + colonIdx + 1 : undefined
			out.push({ start: c.offset, end, level: c.level, colon })
		}
		return out
	}

	/** 渲染当前逻辑页（含高亮），等一帧后测量屏数并定位 */
	#renderPage(): void {
		if (!this.textEl) return
		// 视图刚挂载时容器宽度还是 0，这时排版会算错每屏字符数，等下一帧再试
		if (this.#targetWidth() < 80) {
			if (this.layoutRetry < 40) {
				this.layoutRetry += 1
				window.setTimeout(() => this.#renderPage(), 40)
			}
			return
		}
		this.layoutRetry = 0
		const text = this.pages[this.page] ?? ''
		const pageStart = this.pageStarts[this.page] ?? 0
		const pageEnd = pageStart + text.length

		const hits = (this.data?.annotations ?? [])
			.map(a => ({ a, range: parseTextCfi(a.cfi) }))
			.filter((x): x is { a: Annotation; range: { start: number; end: number } } => !!x.range)
			.filter(x => x.range.start < pageEnd && x.range.end > pageStart)
			.sort((x, y) => x.range.start - y.range.start)
		// 全文搜索的命中只保留一条，跨页时不画
		const find =
			this.findHit && this.findHit.start < pageEnd && this.findHit.end > pageStart ? this.findHit : null

		this.textEl.empty()
		// 章节标题（本页出现的）与高亮分别切区间，按边界逐段输出：
		// 标题用 span 放大加粗，高亮用 mark，两者可嵌套
		const headings = this.#headingsInPage(pageStart, pageEnd)
		const bounds = new Set<number>([0, text.length])
		for (const h of headings) {
			bounds.add(Math.max(0, Math.min(text.length, h.start - pageStart)))
			bounds.add(Math.max(0, Math.min(text.length, h.end - pageStart)))
			if (h.colon !== undefined) bounds.add(Math.max(0, Math.min(text.length, h.colon - pageStart)))
		}
		for (const { range } of hits) {
			bounds.add(Math.max(0, Math.min(text.length, range.start - pageStart)))
			bounds.add(Math.max(0, Math.min(text.length, range.end - pageStart)))
		}
		if (find) {
			bounds.add(Math.max(0, Math.min(text.length, find.start - pageStart)))
			bounds.add(Math.max(0, Math.min(text.length, find.end - pageStart)))
		}
		const points = [...bounds].sort((a, b) => a - b)
		for (let i = 0; i < points.length - 1; i++) {
			const from = points[i]
			const to = points[i + 1]
			if (to <= from) continue
			const seg = text.slice(from, to)
			const gStart = pageStart + from
			const gEnd = pageStart + to
			const heading = headings.find(h => h.start < gEnd && h.end > gStart)
			const hit = hits.find(x => x.range.start < gEnd && x.range.end > gStart)
			const isFind = !!find && find.start < gEnd && find.end > gStart
			if (!heading && !hit && !isFind) {
				this.textEl.appendChild(document.createTextNode(seg))
				continue
			}
			let leaf: Node = document.createTextNode(seg)
			// 命中底色压在批注高亮之上：搜索时最先要看到的是「在哪」
			if (isFind) {
				const mark = document.createElement('mark')
				mark.className = 'grove-find-hit'
				mark.appendChild(leaf)
				leaf = mark
			}
			if (hit) {
				const mark = document.createElement('mark')
				mark.className = 'grove-txt-mark'
				mark.dataset.annId = hit.a.id
				mark.style.backgroundColor = colorCss(hit.a.color)
				mark.style.color = contrastFg(colorCss(hit.a.color))
				mark.title = truncate(hit.a.note || hit.a.text, 120)
				mark.appendChild(leaf)
				leaf = mark
			}
			if (heading) {
				const isTitleLine = heading.colon !== undefined && gStart >= heading.colon
				const span = document.createElement('span')
				span.className = `grove-txt-h grove-txt-h${heading.level} ${isTitleLine ? 'grove-txt-h-main' : 'grove-txt-h-kicker'}`
				span.appendChild(leaf)
				leaf = span
			}
			this.textEl.appendChild(leaf)
		}

		this.#layout()
		this.rendering = true
		this.scrollEl.scrollLeft = 0
		this.scrollEl.scrollTop = 0

		this.#afterFrame(() => {
			try {
				this.screenCount = this.#computeScreenCount()
				this.#syncTrackWidth()
				if (this.gotoLastScreen) {
					this.gotoLastScreen = false
					this.screen = this.screenCount - 1
				} else if (this.pendingOffset !== null) {
					const target = this.pendingOffset
					this.pendingOffset = null
					this.screen = this.#offsetToScreen(target)
					this.alignToColumnTop = false
				}
				this.screen = Math.max(0, Math.min(this.screen, this.screenCount - 1))
				this.#applyScreen()
				this.#flashPendingMark()
			} finally {
				this.rendering = false
			}
			// 视图刚打开时可能是小尺寸排版，等真实宽度出现后自愈一次
			const laid = Number.parseFloat(this.textEl.style.width || '0')
			if (Math.abs(this.#targetWidth() - laid) > 4) this.#scheduleRelayout()
		})
	}

	/** 把视口移动到当前屏 */
	#applyScreen(): void {
		if (!this.scrollEl || !this.textEl) return
		const step = this.#step()
		this.scrollEl.scrollLeft = this.screen * step
		this.prevBtn.disabled = this.screen <= 0 && this.page <= 0
		this.nextBtn.disabled = this.screen >= this.screenCount - 1 && this.page >= this.pages.length - 1
		// 刚改完 scrollLeft 时命中测试还是旧位置，等一帧再算进度与位置
		this.#afterFrame(() => {
			// 用屏号换算字符偏移：即使刚被重排过 scrollLeft 也不影响进度与位置记忆
			const offset = this.#offsetAtX(this.screen * this.#step())
			this.#updateProgress(offset)
			this.#syncToc(offset)
			this.#touchLocation(offset)
		})
	}

	#totalChars(): number {
		const last = this.pages.length - 1
		return (this.pageStarts[last] ?? 0) + (this.pages[last]?.length ?? 0)
	}

	/** 排版横坐标处第一个字符的全文偏移（二分测量，不依赖 scrollLeft） */
	#offsetAtX(targetX: number): number {
		const pageStart = this.pageStarts[this.page] ?? 0
		if (!this.textEl) return pageStart
		const total = this.pages[this.page]?.length ?? 0
		if (!total || targetX <= 0) return pageStart
		let lo = 0
		let hi = total - 1
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			const hit = this.#charRect(mid)
			if (!hit || hit.x < targetX - 0.5) lo = mid + 1
			else hi = mid
		}
		return pageStart + lo
	}

	/** 当前屏第一个字符的全文偏移 */
	#currentOffset(): number {
		return this.#offsetAtX(this.scrollEl ? this.scrollEl.scrollLeft : 0)
	}

	#domOffset(node: Node, offset: number): number {
		const walker = document.createTreeWalker(this.textEl, NodeFilter.SHOW_TEXT)
		let total = 0
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (n === node) return total + offset
			total += (n.textContent ?? '').length
		}
		return total
	}

	#findTextPos(target: number): { node: Text; offset: number } | null {
		const walker = document.createTreeWalker(this.textEl, NodeFilter.SHOW_TEXT)
		let total = 0
		for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
			const len = n.textContent?.length ?? 0
			// 用 < 而不是 <=：目标正好落在节点末尾时应该归到下一个节点，
			// 否则 offset 等于长度，后续测量字符矩形时循环一次都不会执行
			if (target < total + len) {
				return { node: n, offset: Math.max(0, Math.min(len - 1, target - total)) }
			}
			total += len
		}
		return null
	}

	/** 单列宽度 */
	#columnWidth(): number {
		const n = this.#columnCount()
		return (this.#contentWidth() - this.#columnGap() * (n - 1)) / n
	}

	/** 逻辑页内的字符偏移 → 第几屏（调用时 scrollLeft 必须为 0） */
	/** 测量某个字符的位置（相对排版起点）。折叠 range 遇到换行符会返回全 0 矩形，这里改测一个字符 */
	#charRect(local: number): { x: number; top: number } | null {
		const pos = this.#findTextPos(Math.max(0, local))
		if (!pos) return null
		const base = this.textEl.getBoundingClientRect()
		const text = pos.node.textContent ?? ''
		// 换行符自身没有尺寸，往后找最多 24 个非换行字符来定位
		for (let i = pos.offset; i < text.length && i < pos.offset + 24; i++) {
			const ch = text[i]
			if (ch === '\n' || ch === '\r') continue
			const range = document.createRange()
			range.setStart(pos.node, i)
			range.setEnd(pos.node, i + 1)
			const rect = range.getBoundingClientRect()
			if (rect.width > 0 && rect.height > 0) return { x: rect.left - base.left, top: rect.top - base.top }
		}
		return null
	}

	#offsetToScreen(globalOffset: number): number {
		const local = Math.max(0, globalOffset - (this.pageStarts[this.page] ?? 0))
		const step = this.#step()
		const colW = this.#columnWidth()
		if (step <= 0 || colW <= 0) return 0
		const hit = this.#charRect(local)
		if (!hit) return 0
		const colIndex = Math.floor(hit.x / (colW + this.#columnGap()) + 0.001)
		// 目录跳转时希望章节标题出现在页面顶部：标题落在列的下半部分就推到下一列
		const targetCol = this.alignToColumnTop && hit.top > this.#contentHeight() * 0.45 ? colIndex + 1 : colIndex
		return Math.max(0, Math.floor(targetCol / this.#columnCount() + 0.001))
	}

	#updateProgress(offsetArg?: number): void {
		const total = this.#totalChars()
		const offset = offsetArg ?? this.#currentOffset()
		const pct = total > 0 ? (offset / total) * 100 : 0
		this.progressLabel.setText(`${Math.round(pct)}%`)
		this.slider.min = '0'
		this.slider.max = String(Math.max(1, total))
		this.slider.value = String(offset)
		// 本页第几屏：翻页立即有反馈；全书页码放在悬停提示里
		this.metaEl.removeClass('grove-hidden')
		this.metaEl.setText(`${this.screen + 1}/${this.screenCount}${this.warning ? ' ⚠' : ''}`)
		this.metaEl.title = `本页第 ${this.screen + 1} 屏 / 共 ${this.screenCount} 屏 · 全书第 ${this.page + 1}/${this.pages.length} 页`
	}

	#touchLocation(offsetArg?: number): void {
		if (!this.data) return
		const offset = offsetArg ?? this.#currentOffset()
		const cfi = `txt:${offset}`
		const prev = this.data.lastLocation
		// 位置没变就别重写时间戳：每次落盘都会引起一轮「回读 + 刷新」，白耗电还会打断选区
		if (prev && prev.cfi === cfi && prev.index === this.page) return
		const total = this.#totalChars()
		this.data.lastLocation = {
			cfi,
			index: this.page,
			fraction: total > 0 ? offset / total : 0,
			updatedAt: Date.now(),
		}
		this.#scheduleSave()
		// 翻页/滚动后当前位置变了：书签按钮的「已标记」状态要跟着变
		this.#updateBookmarkBtn()
	}

	/** 跳到指定字符偏移（目录、进度条、回跳链接） */
	/**
	 * 明确跳转（目录 / 搜索命中 / 批注 / 进度滑杆）：跳完在左下角留「返回原位置」。
	 * 翻页与滚动不走这里，否则每翻一屏都挂一条提示。
	 */
	#jumpToOffset(offset: number, flashId?: string, alignTop = true, remember = true): void {
		const fromOffset = remember ? this.#currentOffset() : 0
		this.#applyJump(offset, flashId, alignTop)
		// 同一个位置附近就不必提示（比如点目录里当前所在的章）
		if (!remember || Math.abs(fromOffset - offset) < 50) {
			if (remember && this.plugin.isMobile) this.sidebarEl.classList.add('grove-hidden')
			return
		}
		const idx = this.#sectionIndexOf(fromOffset)
		this.jumpReturn.show({
			label: idx >= 0 ? (this.chapters[idx]?.title?.trim() ?? '') : '',
			// 返回本身不能再记一次，否则刚点完又挂一条（alignTop=false 保持原列位置）
			back: () => this.#jumpToOffset(fromOffset, undefined, false, false),
		})
		// 手机上批注栏是覆盖式抽屉，会压住返回胶囊；点跳转就是要看原文，顺手收起
		if (this.plugin.isMobile) this.sidebarEl.classList.add('grove-hidden')
	}

	#applyJump(offset: number, flashId?: string, alignTop = true): void {
		this.alignToColumnTop = alignTop
		const page = this.#pageOfOffset(offset)
		this.flashAnnId = flashId ?? null
		this.gotoLastScreen = false
		if (page !== this.page) {
			this.page = page
			this.screen = 0
			this.pendingOffset = offset
			this.#renderPage()
			return
		}
		const prevLeft = this.scrollEl.scrollLeft
		this.scrollEl.scrollLeft = 0
		this.screen = this.#offsetToScreen(offset)
		this.alignToColumnTop = false
		this.scrollEl.scrollLeft = prevLeft
		this.screenCount = this.#computeScreenCount()
		this.screen = Math.max(0, Math.min(this.screen, this.screenCount - 1))
		this.#applyScreen()
		this.#flashPendingMark()
	}

	#flashPendingMark(): void {
		const id = this.flashAnnId
		this.flashAnnId = null
		if (!id) return
		const mark = this.textEl.querySelector(`mark[data-ann-id="${id}"]`) as HTMLElement | null
		if (!mark) return
		mark.addClass('is-flash')
		window.setTimeout(() => mark.removeClass('is-flash'), 1400)
	}

	// ------------------------------------------------------------------
	// 正文全文搜索（TXT）
	// ------------------------------------------------------------------

	/** 各页首尾相接就是原文，拼一次缓存起来，避免每次搜索都重拼 800 万字 */
	#fullText(): string {
		if (this.fullTextCache === null) this.fullTextCache = this.pages.join('')
		return this.fullTextCache
	}

	/**
	 * 忽略大小写用的干草堆。
	 * 少数语言字符小写后长度会变（如 İ → i̇），那时索引对不上，退回区分大小写。
	 */
	#searchHaystack(): { text: string; fold: boolean } {
		const text = this.#fullText()
		if (this.fullTextLowerCache === null) this.fullTextLowerCache = text.toLowerCase()
		return { text: this.fullTextLowerCache, fold: this.fullTextLowerCache.length === text.length }
	}

	/** 命令面板「搜索当前书全文」复用侧栏面板 */
	searchFullText(query: string): void {
		const q = query.trim()
		if (!q) return
		if (!this.bytes) {
			new Notice('Grove Reader：文件还在加载，请稍后再试')
			return
		}
		this.sidebarEl.removeClass('grove-hidden')
		if (this.fullTextSearchEl) this.fullTextSearchEl.open = true
		this.fullTextSearchInput.value = q
		this.#runFullTextSearch()
	}

	#runFullTextSearch(): void {
		const query = this.fullTextSearchInput.value.trim()
		this.fullTextTaskId++
		this.fullTextSearchResults.empty()
		if (this.findHit) {
			this.findHit = null
			this.#renderPage()
		}
		if (!query) {
			this.fullTextSearchStatus.setText('输入关键词后按 Enter 搜索全文')
			return
		}
		const text = this.#fullText()
		const { text: hay, fold } = this.#searchHaystack()
		const needle = fold ? query.toLowerCase() : query
		const limit = 300
		const hits: Array<{ start: number; end: number }> = []
		let from = 0
		while (from <= text.length) {
			const idx = hay.indexOf(needle, from)
			if (idx < 0) break
			hits.push({ start: idx, end: idx + query.length })
			if (hits.length >= limit) break
			from = idx + Math.max(1, needle.length)
		}
		if (!hits.length) {
			this.fullTextSearchStatus.setText('没有找到匹配内容')
			return
		}
		for (const hit of hits) {
			const row = this.fullTextSearchResults.createEl('button', { cls: 'grove-fulltext-search-result' })
			row.createSpan('grove-fulltext-search-context').setText(
				text.slice(Math.max(0, hit.start - 18), hit.start).replace(/\s+/g, ' '),
			)
			row.createSpan('grove-fulltext-search-hit').setText(text.slice(hit.start, hit.end))
			row.createSpan('grove-fulltext-search-context').setText(
				text.slice(hit.end, Math.min(text.length, hit.end + 26)).replace(/\s+/g, ' '),
			)
			row.createSpan('grove-fulltext-search-page').setText(`第 ${this.#pageOfOffset(hit.start) + 1} 页`)
			row.addEventListener('click', () => this.#jumpToFind(hit))
		}
		this.fullTextSearchStatus.setText(
			`${hits.length} 处命中${hits.length >= limit ? `（仅显示前 ${limit} 处）` : ''}`,
		)
	}

	#jumpToFind(hit: { start: number; end: number }): void {
		this.findHit = hit
		if (this.#pageOfOffset(hit.start) !== this.page) {
			this.#jumpToOffset(hit.start)
			return
		}
		// 同一页内跳转也让 #renderPage 重画一次，命中底色才会出现
		this.pendingOffset = hit.start
		this.#renderPage()
	}

	#clearFullTextSearch(): void {
		this.fullTextTaskId++
		if (this.fullTextSearchInput) this.fullTextSearchInput.value = ''
		this.fullTextSearchResults?.empty()
		this.fullTextSearchStatus?.setText('输入关键词后按 Enter 搜索全文')
		if (this.findHit) {
			this.findHit = null
			this.#renderPage()
		}
	}

	#goPage(page: number): void {
		const next = Math.max(0, Math.min(this.pages.length - 1, page))
		// 真的换了页才算一次翻页（重排/重绘也会走这里，同页不算）
		if (next !== this.page && this.bookPath) this.plugin.statsPageTurn(this.bookPath)
		this.page = next
		this.screen = 0
		this.gotoLastScreen = false
		this.pendingOffset = null
		this.#renderPage()
	}

	// ------------------------------------------------------------------
	// 翻页
	// ------------------------------------------------------------------

	/** 批注被外部改动（从笔记回写）后刷新侧栏与当前页高亮 */
	refreshAnnotations(): void {
		this.#renderSidebar()
		if (!this.bytes) return
		// 正在选字时先别重绘：重绘会重建正文 DOM，把用户选到一半的文字冲掉。
		// 外部改批注不急这几百毫秒，等选区消失再补。
		if (this.#hasActiveSelection()) {
			window.setTimeout(() => this.refreshAnnotations(), 1200)
			return
		}
		this.#renderPage()
	}

	nextPage(): void {
		if (this.screen < this.screenCount - 1) {
			this.screen += 1
			this.#applyScreen()
			this.#collapseMobileBar()
			return
		}
		if (this.page >= this.pages.length - 1) return
		this.page += 1
		this.screen = 0
		this.gotoLastScreen = false
		this.pendingOffset = null
		this.#renderPage()
		this.#collapseMobileBar()
	}

	prevPage(): void {
		if (this.screen > 0) {
			this.screen -= 1
			this.#applyScreen()
			this.#collapseMobileBar()
			return
		}
		if (this.page <= 0) return
		this.page -= 1
		this.screen = 0
		this.gotoLastScreen = true
		this.pendingOffset = null
		this.#renderPage()
		this.#collapseMobileBar()
	}

	/** 手机端：翻页后自动收起工具栏，避免一直挡住正文 */
	#collapseMobileBar(): void {
		if (!this.plugin.isMobile) return
		const bar = this.contentEl.querySelector('.grove-toolbar') as HTMLElement | null
		if (bar?.dataset.barOpen === '1') this.#setMobileBarOpen(false)
	}

	/** 鼠标滚轮固定翻页（分页模式下滚轮不再滚动正文） */
	#onWheel(e: WheelEvent): void {
		this.plugin.noteReadingActivity()
		// 与 EPUB 同一个开关：关掉后滚轮不再翻页（TXT 是一屏一页，没有滚动可做）
		if (!this.plugin.settings.appearance.wheelPageTurn) return
		if (e.ctrlKey || e.metaKey || e.altKey) return
		if (Math.abs(e.deltaY) < 1) return
		e.preventDefault()
		const now = Date.now()
		if (now - this.lastWheel < 180) return
		this.lastWheel = now
		if (e.deltaY > 0) this.nextPage()
		else this.prevPage()
	}

	/** 窗口尺寸/版式变化后重新分栏，并停在原来的文字位置 */
	relayout(): void {
		if (!this.textEl || !this.scrollEl || !this.pages.length) return
		// 首次定位还没完成时不要打断，否则会被重排回页首
		if (this.rendering || this.pendingOffset !== null) return
		const offset = this.#offsetAtX(this.screen * this.#step())
		this.#layout()
		this.scrollEl.scrollLeft = 0
		this.#afterFrame(() => {
			this.screenCount = this.#computeScreenCount()
			this.#syncTrackWidth()
			this.alignToColumnTop = false
			this.screen = Math.max(0, Math.min(this.#offsetToScreen(offset), this.screenCount - 1))
			this.#applyScreen()
		})
	}

	#scheduleRelayout(): void {
		if (this.relayoutTimer != null) window.clearTimeout(this.relayoutTimer)
		this.relayoutTimer = window.setTimeout(() => {
			this.relayoutTimer = null
			// 重排会重建正文 DOM，正在选的文字会跟着没了，表现就是
			// 「手指一松开，刚选中的文段自己消失」。有选区时先让路，选完再排。
			if (this.#hasActiveSelection()) {
				this.#scheduleRelayout()
				return
			}
			this.relayout()
		}, 160)
	}

	/** 正文里是否有正在进行的文字选区（选完了但还没处理也算） */
	#hasActiveSelection(): boolean {
		const sel = window.getSelection()
		if (!sel || sel.isCollapsed || !sel.rangeCount || !this.textEl) return false
		return this.textEl.contains(sel.getRangeAt(0).startContainer)
	}

	// ------------------------------------------------------------------
	// 保存
	// ------------------------------------------------------------------

	#scheduleSave(immediate = false): void {
		if (!this.data) return
		if (this.saveTimer != null) window.clearTimeout(this.saveTimer)
		const run = (): void => {
			this.saveTimer = null
			if (this.data) this.plugin.store.save(this.data)
		}
		if (immediate) {
			this.saveTimer = null
			run()
			// 批注/书签变更走即时保存，顺带防抖刷新已存在的阅读笔记（与 EPUB/PDF 一致）
			this.plugin.scheduleNoteRefresh(this)
		} else {
			this.saveTimer = window.setTimeout(run, 900)
		}
	}

	#flushSave(): void {
		if (this.saveTimer != null) {
			window.clearTimeout(this.saveTimer)
			this.saveTimer = null
		}
		if (this.data) this.plugin.store.save(this.data)
	}

	// ------------------------------------------------------------------
	// 书签
	// ------------------------------------------------------------------

	/** 当前位置的 CFI（书签用；TXT 是 `txt:<字符偏移>`） */
	#currentCfi(): string | null {
		const offset = this.#currentOffset()
		return Number.isFinite(offset) ? `txt:${offset}` : null
	}

	#toggleBookmark(): void {
		if (!this.data) {
			new Notice('Grove Reader：还没加载完，稍等一下再试')
			return
		}
		const cfi = this.#currentCfi()
		if (!cfi) {
			new Notice('Grove Reader：还没定位到当前位置')
			return
		}
		const list = this.data.bookmarks ?? (this.data.bookmarks = [])
		const idx = findBookmarkIndex(list, cfi)
		if (idx >= 0) {
			list.splice(idx, 1)
			new Notice('Grove Reader：已移除当前位置的书签')
		} else {
			const offset = this.#currentOffset()
			const si = this.#sectionIndexOf(offset)
			const label = si >= 0 ? (this.chapters[si]?.title?.trim() ?? '') : ''
			list.push(makeBookmark(cfi, label))
			new Notice('Grove Reader：已加书签')
		}
		this.#afterBookmarksChanged()
	}

	#deleteBookmark(id: string): void {
		if (!this.data) return
		this.data.bookmarks = (this.data.bookmarks ?? []).filter(b => b.id !== id)
		this.#afterBookmarksChanged()
	}

	#afterBookmarksChanged(): void {
		this.#renderBookmarks()
		this.#updateBookmarkBtn()
		this.#scheduleSave(true)
	}

	#updateBookmarkBtn(): void {
		const cfi = this.#currentCfi()
		const on = !!cfi && findBookmarkIndex(this.data?.bookmarks ?? [], cfi) >= 0
		this.bookmarkBtnEl?.toggleClass('is-active', on)
		if (this.bookmarkBtnEl) setIcon(this.bookmarkBtnEl, on ? 'bookmark-check' : 'bookmark')
	}

	#renderBookmarks(): void {
		this.bookmarkSection?.update(this.data?.bookmarks ?? [], {
			onJump: b => this.jumpTo(b.cfi),
			onDelete: b => this.#deleteBookmark(b.id),
		})
		this.#updateBookmarkBtn()
		this.refreshCitations()
	}
	/** 引用页签：这本书被哪些笔记引用（metadataCache 实时解析） */
	refreshCitations(): void {
		this.citationSection?.update(this.plugin.collectExcerptBacklinks(this.bookPath), {
			onJump: row => void this.plugin.openCitation(row),
		})
	}


	// ------------------------------------------------------------------
	// 划选与批注
	// ------------------------------------------------------------------

	#captureSelection(): void {
		const sel = window.getSelection()
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			this.#clearPending()
			return
		}
		const range = sel.getRangeAt(0)
		if (!this.textEl.contains(range.startContainer) || !this.textEl.contains(range.endContainer)) {
			this.#clearPending()
			return
		}
		const prefix = document.createRange()
		prefix.selectNodeContents(this.textEl)
		try {
			prefix.setEnd(range.startContainer, range.startOffset)
		} catch {
			this.#clearPending()
			return
		}
		const localStart = prefix.toString().length
		// 注意：不要规范化 \r，页面文本与原文逐字符对齐，去掉 \r 会让高亮区间整体错位
		const raw = range.toString()
		const trimmed = raw.trim()
		if (!trimmed) {
			this.#clearPending()
			return
		}
		const pageStart = this.pageStarts[this.page] ?? 0
		this.pending = { start: pageStart + localStart, end: pageStart + localStart + raw.length, text: trimmed }
		if (this.plugin.isMobile) {
			this.#hidePopup()
			return
		}
		this.#showPopup(range)
	}

	#clearPending(): void {
		this.pending = null
		this.#hidePopup()
		// 注意：这里**不能**动工具栏开合。普通点一下正文时，pointerup 后的
		// #captureSelection 发现选区为空就会走到这里，一旦顺手收栏，用户看到的就是
		// 「点一下屏幕，工具栏闪一下又消失」。收栏只在真正完成批注动作后显式调用。
	}

	#showPopup(range: Range): void {
		this.#hidePopup()
		const dark = document.body.classList.contains('theme-dark')
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
			const dot = popup.createEl('button')
			dot.title = `高亮（${c.name}）`
			dot.style.cssText = `width:18px;height:18px;border-radius:50%;border:1px solid rgba(0,0,0,.25);cursor:pointer;background:${c.css};padding:0;flex:none;`
			dot.addEventListener('click', e => {
				e.preventDefault()
				void this.#createHighlight(c.key)
			})
		}

		const buttonCss = `border:none;cursor:pointer;padding:3px 8px;border-radius:6px;font-size:12px;background:${dark ? '#3a3a42' : '#ececf0'};color:${dark ? '#dcddde' : '#1f1f23'};`
		const commentBtn = popup.createEl('button', { text: '评论' })
		commentBtn.style.cssText = buttonCss
		commentBtn.addEventListener('click', e => {
			e.preventDefault()
			void this.#commentOnSelection()
		})

		const copyBtn = popup.createEl('button', { text: '复制' })
		copyBtn.style.cssText = buttonCss
		copyBtn.addEventListener('click', e => {
			e.preventDefault()
			if (this.pending) {
				void navigator.clipboard.writeText(this.pending.text).then(() => new Notice('Grove Reader：已复制'))
			}
			this.#clearPending()
		})

		const explainBtn = popup.createEl('button', { text: '解释' })
		explainBtn.title = '用 AI 解释这段文字'
		explainBtn.style.cssText = buttonCss
		explainBtn.addEventListener('click', e => {
			e.preventDefault()
			void this.#explainSelection()
		})

		document.body.appendChild(popup)
		this.popup = popup

		// 按钮数量会变（高亮色点 + 评论/复制/解释），宽度实测后再夹边界，
		// 写死常量会在加按钮后把弹条顶出屏幕
		const rect = range.getBoundingClientRect()
		const width = popup.getBoundingClientRect().width || POPUP_WIDTH
		let left = rect.left + rect.width / 2 - width / 2
		left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
		let top = rect.bottom + 8
		if (top + 44 > window.innerHeight) top = Math.max(8, rect.top - 44)
		popup.style.left = `${Math.round(left)}px`
		popup.style.top = `${Math.round(top)}px`
	}

	/** 划词解释：与 EPUB 共用 aiPanel，未配置 AI 时由浮层给出明确提示 */
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
		this.popup?.remove()
		this.popup = null
	}

	#setMobileBarOpen(open: boolean): void {
		const bar = this.contentEl.querySelector('.grove-toolbar') as HTMLElement | null
		if (!bar) return
		bar.dataset.barOpen = open ? '1' : '0'
		const handle = this.mobileToolbarHandle
		if (handle) {
			handle.setText(open ? '收起' : '工具栏')
			handle.setAttribute('aria-label', open ? '收起阅读工具栏' : '展开阅读工具栏')
		}
		bar.style.setProperty('transform', 'translateY(0)', 'important')
		if (open) bar.scrollLeft = 0
	}

	#onTextClick(e: MouseEvent): void {
		const target = e.target as HTMLElement | null
		const mark = target?.closest('mark.grove-txt-mark') as HTMLElement | null
		if (!mark) return
		const id = mark.dataset.annId
		if (!id) return
		const a = this.data?.annotations.find(x => x.id === id)
		if (!a) return
		if (window.getSelection()?.toString()) return // 拖选经过高亮时不要弹菜单
		e.preventDefault()
		e.stopPropagation()
		this.#showAnnotationMenu(a, e)
	}

	#showAnnotationMenu(a: Annotation, e: MouseEvent): void {
		// 用共享的批注菜单：颜色以色圆 + 名称并排显示，和后续统一到 EPUB 的菜单一致
		showAnnMenu(e, a.color, {
			onEditComment: () => this.#editComment(a),
			onChangeColor: color => this.#changeColor(a, color),
			onCopyText: () => {
				void navigator.clipboard.writeText(a.text).then(() => new Notice('Grove Reader：已复制'))
			},
			onDelete: () => this.#confirmDelete(a),
			onSendToCanvas: () => void this.plugin.exportToCanvas(this, [a.id]),
		})
	}

	async #createHighlight(color: string): Promise<void> {
		const pending = this.pending
		if (!pending) {
			new Notice('Grove Reader：请先在正文中划选文字')
			return
		}
		if (!this.data) return
		const cfi = `txt:${pending.start}-${pending.end}`
		const now = Date.now()
		let a = this.data.annotations.find(x => x.cfi === cfi)
		if (a) {
			a.color = color
			a.updatedAt = now
		} else {
			a = {
				id: randomId(),
				cfi,
				text: pending.text,
				color,
				note: '',
				chapter: this.#chapterAt(pending.start),
				sectionIndex: this.#sectionIndexOf(pending.start),
				createdAt: now,
				updatedAt: now,
			}
			this.data.annotations.push(a)
		}
		this.#clearPending()
		window.getSelection()?.removeAllRanges()
		this.#renderPage()
		this.#scheduleSave(true)
		this.#renderSidebar()
		this.#collapseMobileBar()
	}

	async #commentOnSelection(): Promise<void> {
		const pending = this.pending
		if (!pending) {
			new Notice('Grove Reader：请先在正文中划选文字')
			return
		}
		if (!this.data) return
		const cfi = `txt:${pending.start}-${pending.end}`
		let a = this.data.annotations.find(x => x.cfi === cfi)
		if (!a) {
			const now = Date.now()
			a = {
				id: randomId(),
				cfi,
				text: pending.text,
				color: 'yellow',
				note: '',
				chapter: this.#chapterAt(pending.start),
				sectionIndex: this.#sectionIndexOf(pending.start),
				createdAt: now,
				updatedAt: now,
			}
			this.data.annotations.push(a)
			this.#renderPage()
			this.#scheduleSave(true)
		}
		this.#clearPending()
		window.getSelection()?.removeAllRanges()
		this.#editComment(a)
	}

	#editComment(a: Annotation): void {
		new CommentModal(this.app, a.note ?? '', note => {
			a.note = note
			a.updatedAt = Date.now()
			this.#scheduleSave(true)
			this.#renderPage()
			this.#renderSidebar()
			this.#collapseMobileBar()
		}).open()
	}

	#changeColor(a: Annotation, color: string): void {
		a.color = color
		a.updatedAt = Date.now()
		this.#scheduleSave(true)
		this.#renderPage()
		this.#renderSidebar()
	}

	#confirmDelete(a: Annotation): void {
		new ConfirmModal(
			this.app,
			`删除这条批注？「${truncate(a.text.replace(/\s+/g, ' ').trim(), 40)}」`,
			() => this.#deleteAnnotation(a),
		).open()
	}

	#deleteAnnotation(a: Annotation): void {
		const arr = this.data?.annotations
		if (!arr) return
		const i = arr.indexOf(a)
		if (i >= 0) arr.splice(i, 1)
		this.#scheduleSave(true)
		this.#renderPage()
		this.#renderSidebar()
		new Notice('Grove Reader：批注已删除（历史备份仍保留在插件数据目录中）')
	}

	#setSelectMode(on: boolean): void {
		this.selectMode = on
		this.selectedIds.clear()
		this.selectBarEl.toggleClass('grove-hidden', !on)
		this.#refreshSelectBar()
		this.#renderSidebar()
	}

	#toggleSelected(id: string): void {
		if (this.selectedIds.has(id)) this.selectedIds.delete(id)
		else this.selectedIds.add(id)
		this.#refreshSelectBar()
		this.annItemEls.get(id)?.toggleClass('grove-ann-selected', this.selectedIds.has(id))
	}

	#refreshSelectBar(): void {
		this.selectCountEl.setText(`已选 ${this.selectedIds.size} 条`)
	}

	#deleteSelected(): void {
		if (!this.data || !this.selectedIds.size) return
		const count = this.selectedIds.size
		this.data.annotations = this.data.annotations.filter(a => !this.selectedIds.has(a.id))
		this.selectedIds.clear()
		this.#setSelectMode(false)
		this.#scheduleSave(true)
		this.#renderPage()
		this.#renderSidebar()
		new Notice(`Grove Reader：已删除 ${count} 条批注（历史备份仍保留）`)
	}

	// ------------------------------------------------------------------
	// 批注侧栏
	// ------------------------------------------------------------------

	#collapsedKey(): string {
		return `grove-txt-ann-collapsed:${this.plugin.store.bookId(this.bookPath)}`
	}

	#loadCollapsedState(): void {
		try {
			const raw = window.localStorage.getItem(this.#collapsedKey())
			this.annCollapsed = new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
		} catch {
			this.annCollapsed = new Set<string>()
		}
	}

	#saveCollapsedState(): void {
		try {
			window.localStorage.setItem(this.#collapsedKey(), JSON.stringify([...(this.annCollapsed ?? [])]))
		} catch {
			// ignore
		}
	}

	#renderSidebar(): void {
		if (!this.annListEl) return
		this.#renderBookmarks()
		const all = [...(this.data?.annotations ?? [])].sort((x, y) => {
			const ix = x.sectionIndex ?? Number.MAX_SAFE_INTEGER
			const iy = y.sectionIndex ?? Number.MAX_SAFE_INTEGER
			if (ix !== iy) return ix - iy
			return (parseTextCfi(x.cfi)?.start ?? 0) - (parseTextCfi(y.cfi)?.start ?? 0)
		})
		const q = this.sidebarQuery.toLowerCase()
		const filtering = !!q || !!this.sidebarColor
		const filtered = all.filter(a => {
			if (this.sidebarColor && a.color !== this.sidebarColor) return false
			if (!q) return true
			return `${a.text}\n${a.note ?? ''}\n${a.chapter ?? ''}`.toLowerCase().includes(q)
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

		if (this.sortMode === 'recent') {
			for (const a of [...filtered].sort((x, y) => y.createdAt - x.createdAt)) {
				this.annListEl.appendChild(this.#renderAnnItem(a))
			}
			return
		}

		if (this.annCollapsed === null) this.#loadCollapsedState()
		const collapsedSet = this.annCollapsed ?? new Set<string>()
		const groups = new Map<string, Annotation[]>()
		for (const a of filtered) {
			const key = (a.chapter ?? '').trim() || '未命名章节'
			const arr = groups.get(key)
			if (arr) arr.push(a)
			else groups.set(key, [a])
		}
		for (const [chapter, items] of groups) {
			const group = this.annListEl.createDiv('grove-ann-group')
			const head = group.createDiv('grove-ann-group-head')
			const chev = head.createSpan('grove-ann-group-chev')
			setIcon(chev, 'chevron-down')
			head.createSpan('grove-ann-group-title').setText(truncate(chapter, 40))
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
		head.createSpan('grove-ann-chapter').setText(a.chapter || '')
		const text = item.createDiv('grove-ann-text')
		text.setText(truncate(a.text.trim(), 160))
		text.addEventListener('click', () => this.jumpTo(a.cfi))
		if (a.note) item.createDiv('grove-ann-note').setText(truncate(a.note.trim(), 120))
		const actions = item.createDiv('grove-ann-actions')

		const jump = actions.createEl('button', {
			cls: 'clickable-icon grove-mini-btn',
			attr: { 'aria-label': '跳转到原文' },
		})
		setIcon(jump, 'arrow-up-left')
		jump.addEventListener('click', () => this.jumpTo(a.cfi))

		const edit = actions.createEl('button', {
			cls: 'clickable-icon grove-mini-btn',
			attr: { 'aria-label': '编辑评论' },
		})
		setIcon(edit, 'message-square')
		edit.addEventListener('click', () => this.#editComment(a))

		const del = actions.createEl('button', {
			cls: 'clickable-icon grove-mini-btn',
			attr: { 'aria-label': '删除批注' },
		})
		setIcon(del, 'trash-2')
		del.addEventListener('click', () => this.#confirmDelete(a))
		return item
	}

	// ------------------------------------------------------------------
	// 供命令面板调用的公开方法（与 ReaderView / PdfView 同名）
	// ------------------------------------------------------------------

	highlight(color: string): void {
		void this.#createHighlight(color)
	}

	comment(): void {
		void this.#commentOnSelection()
	}

	/** 跳转到某条批注：切到它所在的屏并让高亮闪一下 */
	jumpTo(cfi: string, fallback?: GroveLinkTarget): void {
		const range = parseTextCfi(cfi)
		const ann = cfi ? this.data?.annotations.find(a => a.cfi === cfi) : undefined
		const expected = (fallback?.text ?? '').trim()
		// 偏移能解析不代表还在原文那句上：整本文件被替换/重新编码后，偏移会落在别处
		if (range && this.#offsetMatches(range.start, expected)) {
			this.#jumpToOffset(range.start, ann?.id, false)
			return
		}
		// 三级降级：摘录原文 → 章节 → 百分比
		if (fallback) {
			const offset = this.#fallbackOffset(fallback)
			if (offset != null) {
				this.#jumpToOffset(offset, undefined, false)
				return
			}
			new Notice('Grove Reader：找不到原句（文件可能换了版本），先停在当前位置')
			return
		}
		if (range) this.#jumpToOffset(range.start, ann?.id, false)
	}

	/** 偏移处的内容是否还对得上摘录开头（对不上就走了形，应该降级） */
	#offsetMatches(offset: number, expected: string): boolean {
		if (!expected) return true
		const text = this.#fullText()
		if (!text || offset < 0 || offset >= text.length) return false
		const norm = (s: string): string => s.replace(/\s+/g, '')
		const head = norm(expected).slice(0, 8)
		if (!head) return true
		// 原文里的空白/换行与摘录里的不一致，比较前先抹平，窗口给宽一点
		return norm(text.slice(offset, offset + head.length * 4 + 24)).startsWith(head)
	}

	/** 三级降级：摘录原文（前 24 字）→ 章节名 → 百分比，返回字符偏移 */
	#fallbackOffset(fb: GroveLinkTarget): number | null {
		if (!this.pages.length) return null
		const q = (fb.text ?? '').trim()
		if (q) {
			const { text, fold } = this.#searchHaystack()
			const at = fold ? text.indexOf(q.toLowerCase()) : text.indexOf(q)
			if (at >= 0) return at
		}
		const norm = (s: string): string => s.replace(/\s+/g, '').trim()
		const want = norm(fb.chapter ?? '')
		if (want) {
			const exact = this.chapters.find(c => norm(c.title) === want)
			const loose = exact ?? this.chapters.find(c => {
				const t = norm(c.title)
				return t.includes(want) || want.includes(t)
			})
			if (loose) return loose.offset
		}
		if (typeof fb.pct === 'number' && Number.isFinite(fb.pct)) {
			return Math.round(Math.max(0, Math.min(1, fb.pct)) * this.#totalChars())
		}
		return null
	}

	/** 书架手动编辑信息后同步标题 */
	syncMeta(title: string, author: string): void {
		if (title) {
			this.bookTitle = title
			;(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.()
		}
		if (!this.data) return
		this.data.title = title || this.data.title
		if (author) this.data.author = author
		this.#scheduleSave(true)
	}

	// ------------------------------------------------------------------
	// 外观面板（与 EPUB 共用同一份设置）
	// ------------------------------------------------------------------

	/**
	 * 面板开合的唯一入口。打开时给内容区挂 `is-appear-open`，
	 * 让平时藏在顶边外的工具栏常驻（与 EPUB 视图同一套 CSS）。
	 */
	#setAppearancePanelOpen(open: boolean): void {
		this.appearPanelEl.toggleClass('grove-hidden', !open)
		this.contentEl.toggleClass('is-appear-open', open)
	}

	#toggleAppearancePanel(): void {
		const hidden = this.appearPanelEl.hasClass('grove-hidden')
		if (hidden) this.#renderAppearancePanel()
		this.#setAppearancePanelOpen(hidden)
	}

	#renderAppearancePanel(): void {
		renderAppearancePanel(this.appearPanelEl, {
			surface: 'txt',
			appearance: () => this.plugin.settings.appearance,
			patch: (patch, rerender) => this.#patchAppearance(patch, rerender),
			reset: () => {
				Object.assign(this.plugin.settings.appearance, DEFAULT_APPEARANCE)
				this.#applyAppearance()
				void this.plugin.persistSettingsNow()
				this.#renderAppearancePanel()
			},
		})
	}


	#patchAppearance(patch: Partial<ReaderAppearance>, rerender = false): void {
		Object.assign(this.plugin.settings.appearance, patch)
		this.#applyAppearance()
		this.plugin.persistSettingsSoon()
		// 字号/行距/留白变化会改变每屏能放多少字，需要重新分栏
		this.#scheduleRelayout()
		if (rerender) this.#renderAppearancePanel()
	}

	/** 与 EPUB 视图同一条规则：勾了「鼠标滚动换页」，右下角箭头就是重复入口 */
	#applyPageBtns(): void {
		const hide = this.plugin.settings.appearance.wheelPageTurn && !this.plugin.isMobile
		this.pageBtnsEl?.toggleClass('grove-hidden', hide)
	}

	#applyAppearance(): void {
		if (!this.readerEl || !this.textEl) return
		this.#applyPageBtns()
		const a = this.plugin.settings.appearance
		let bg: string
		let fg: string
		if (a.followTheme) {
			const style = getComputedStyle(document.body)
			const dark = document.body.classList.contains('theme-dark')
			bg = style.getPropertyValue('--background-primary').trim() || (dark ? '#1e1e20' : '#ffffff')
			fg = style.getPropertyValue('--text-normal').trim() || (dark ? '#dcddde' : '#2b2b2b')
		} else {
			const preset = BACKGROUND_PRESETS.find(item => item.key === a.bgKey)
			bg = a.bgKey === 'custom' ? a.customBg : (preset?.bg ?? '#ffffff')
			fg = a.bgKey === 'custom' ? contrastFg(bg) : (preset?.fg ?? contrastFg(bg))
		}
		const themeFont = getComputedStyle(document.body).getPropertyValue('--font-text').trim()
		const font = a.fontFamily || themeFont || 'serif'
		this.readerEl.style.backgroundColor = bg
		this.readerEl.style.color = fg
		this.scrollEl.style.backgroundColor = bg
		this.textEl.style.color = fg
		this.textEl.style.fontFamily = font
		this.textEl.style.fontSize = `${((16 * a.fontSize) / 100).toFixed(1)}px`
		this.textEl.style.lineHeight = String(a.lineHeight)
		// 分栏分页下版心就是可视宽度，留白放在视口上；宽高由 #layout() 计算
		this.scrollEl.style.paddingTop = `${a.pageMargin}px`
		this.scrollEl.style.paddingBottom = `${a.pageMargin}px`
		this.scrollEl.style.paddingLeft = '32px'
		this.scrollEl.style.paddingRight = '32px'
		this.textEl.style.padding = '0'
		this.textEl.style.maxWidth = 'none'
		this.readerEl.style.setProperty(
			'--text-selection',
			isDarkColor(bg) ? 'rgba(120,160,255,0.35)' : 'rgba(64,120,255,0.25)',
		)
	}
}
