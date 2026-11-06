import { ItemView, Menu, MenuItem, Notice, ViewStateResult, WorkspaceLeaf, setIcon } from 'obsidian'
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
import { CommentModal, ConfirmModal } from './modals'
import { basenameOf, cleanBookTitle, contrastFg, isDarkColor, randomId, truncate } from './util'
import { decodeTextBuffer, paginateText, TextViewState, VIEW_TYPE_GROVE_TEXT } from './textCodec'

export { VIEW_TYPE_GROVE_TEXT } from './textCodec'

/** 与 EPUB 阅读外观面板保持同一组字体预设 */
const TEXT_FONT_PRESETS: Array<{ label: string; value: string }> = [
	{ label: '跟随主题', value: '' },
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
	private encoding = 'auto'
	private detected = ''
	private warning: string | undefined
	private bookTitle = 'TXT'
	private loadingPath = ''
	private pendingCfi: string | null = null
	private lastWheel = 0
	private saveTimer: number | null = null

	private pending: TextSelection | null = null
	private popup: HTMLElement | null = null
	private sidebarQuery = ''
	private sidebarColor: string | null = null
	private sortMode: 'position' | 'recent' = 'position'
	private selectMode = false
	private selectedIds = new Set<string>()
	private annCollapsed: Set<string> | null = null

	private readerEl!: HTMLElement
	private scrollEl!: HTMLElement
	private textEl!: HTMLElement
	private metaEl!: HTMLElement
	private slider!: HTMLInputElement
	private progressLabel!: HTMLElement
	private prevBtn!: HTMLButtonElement
	private nextBtn!: HTMLButtonElement
	private encodingSelect!: HTMLSelectElement
	private appearPanelEl!: HTMLElement
	private sidebarEl!: HTMLElement
	private annListEl!: HTMLElement
	private annCountEl!: HTMLElement
	private searchInput!: HTMLInputElement
	private filterDotEls = new Map<string, HTMLElement>()
	private clearBtnEl!: HTMLButtonElement
	private sortBtnEl!: HTMLButtonElement
	private selectBarEl!: HTMLElement
	private selectCountEl!: HTMLElement
	private annItemEls = new Map<string, HTMLElement>()
	private tocSelect!: HTMLSelectElement
	/** 当前逻辑页内的第几屏（一屏＝一列或两列） */
	private screen = 0
	private screenCount = 1
	/** 渲染后要定位到的字符偏移（目录跳转 / 恢复阅读位置） */
	private pendingOffset: number | null = null
	/** 下一页到上一个逻辑页时，直接落到最后一屏 */
	private gotoLastScreen = false
	/** 需要在渲染后闪烁提示的批注 id */
	private flashAnnId: string | null = null
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
		this.#flushSave()
		this.#hidePopup()
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
		const toolbar = root.createDiv('grove-toolbar')

		const tocWrap = toolbar.createDiv('grove-toc')
		this.tocSelect = tocWrap.createEl('select', { cls: 'dropdown grove-toc-select' })
		this.tocSelect.createEl('option', { value: '', text: '目录' })
		this.tocSelect.addEventListener('change', () => {
			const value = this.tocSelect.value
			if (!value) return
			this.#jumpToOffset(Number(value))
		})

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

		for (const c of HIGHLIGHT_COLORS) {
			const dot = toolbar.createEl('button', {
				cls: 'clickable-icon grove-color-dot',
				attr: { 'aria-label': `高亮（${c.name}）` },
			})
			dot.style.backgroundColor = c.css
			dot.addEventListener('click', () => void this.#createHighlight(c.key))
		}

		const commentBtn = toolbar.createEl('button', {
			cls: 'clickable-icon grove-icon-btn',
			attr: { 'aria-label': '为划选文字添加评论' },
		})
		setIcon(commentBtn, 'message-square-plus')
		commentBtn.addEventListener('click', () => void this.#commentOnSelection())

		toolbar.createDiv('grove-flex-spacer')

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

		const sideBtn = toolbar.createEl('button', {
			cls: 'clickable-icon grove-icon-btn',
			attr: { 'aria-label': '批注列表' },
		})
		setIcon(sideBtn, 'list')
		sideBtn.addEventListener('click', () => this.sidebarEl.classList.toggle('grove-hidden'))

		// 编码识别结果：短标签放末尾，鼠标悬停看完整信息
		this.metaEl = toolbar.createDiv('grove-text-meta')

		this.appearPanelEl = root.createDiv('grove-appear-panel grove-hidden')
		this.registerDomEvent(this.contentEl, 'click', e => {
			if (this.appearPanelEl.hasClass('grove-hidden')) return
			const t = e.target
			if (t instanceof Element && !t.closest('.grove-appear-panel') && !t.closest('.grove-icon-btn')) {
				this.appearPanelEl.addClass('grove-hidden')
			}
		}, { capture: true })

		const body = root.createDiv('grove-body')
		this.readerEl = body.createDiv('grove-reader')
		this.scrollEl = this.readerEl.createDiv('grove-reader-inner grove-text-scroll')
		this.textEl = this.scrollEl.createDiv({ cls: 'grove-text-content' })
		this.registerDomEvent(this.scrollEl, 'wheel', e => this.#onWheel(e), { passive: false })

		// 划选 → 弹条；点击已有高亮 → 批注菜单
		this.registerDomEvent(this.scrollEl, 'mouseup', () =>
			window.setTimeout(() => this.#captureSelection(), 10),
		)
		this.registerDomEvent(this.scrollEl, 'keyup', () => this.#captureSelection())
		this.registerDomEvent(this.textEl, 'click', (e: MouseEvent) => this.#onTextClick(e))

		const pageBtns = this.readerEl.createDiv('grove-page-btns')
		this.prevBtn = pageBtns.createEl('button', {
			cls: 'clickable-icon grove-page-btn',
			attr: { 'aria-label': '上一页（←）' },
		})
		setIcon(this.prevBtn, 'chevron-left')
		this.prevBtn.disabled = true
		this.prevBtn.addEventListener('click', () => this.#goPage(this.page - 1))
		this.nextBtn = pageBtns.createEl('button', {
			cls: 'clickable-icon grove-page-btn',
			attr: { 'aria-label': '下一页（→）' },
		})
		setIcon(this.nextBtn, 'chevron-right')
		this.nextBtn.disabled = true
		this.nextBtn.addEventListener('click', () => this.#goPage(this.page + 1))

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
		this.pages = paginateText(decoded.text)
		this.pageStarts = []
		let acc = 0
		for (const p of this.pages) {
			this.pageStarts.push(acc)
			acc += p.length
		}
		this.#buildChapters(decoded.text)

		let target: number | null = null
		const jump = this.pendingCfi ? parseTextCfi(this.pendingCfi) : null
		if (jump) target = jump.start
		else if (fraction !== undefined) target = Math.round(fraction * this.#totalChars())
		else if (this.data?.lastLocation?.cfi) {
			const last = parseTextCfi(this.data.lastLocation.cfi)
			if (last) target = last.start
		}
		this.pendingCfi = null
		this.page = target !== null ? this.#pageOfOffset(target) : 0
		this.page = Math.max(0, Math.min(this.pages.length - 1, this.page))
		this.screen = 0
		this.screenCount = 1
		this.gotoLastScreen = false
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
		this.sidebarEl.classList.toggle('grove-hidden', !this.plugin.settings.openSidebarWithBook)
	}

	/** 扫描全文里的「第X章 / 序章 / 番外」作为目录；只取行首、长度有限的短行 */
	#buildChapters(text: string): void {
		const out: ChapterMark[] = []
		let offset = 0
		for (const line of text.split('\n')) {
			const trimmed = line.trim()
			if (
				trimmed.length > 0 &&
				trimmed.length <= 48 &&
				CHAPTER_RE.test(trimmed) &&
				(out.length === 0 || offset - out[out.length - 1].offset > 200)
			) {
				out.push({ title: trimmed, offset })
				if (out.length >= 3000) break
			}
			offset += line.length + 1
		}
		this.chapters = out
	}

	#buildToc(): void {
		if (!this.tocSelect) return
		this.tocSelect.empty()
		this.tocSelect.createEl('option', {
			value: '',
			text: this.chapters.length ? `目录（${this.chapters.length} 章）` : '目录（未识别章节）',
		})
		for (const c of this.chapters) {
			this.tocSelect.createEl('option', { value: String(c.offset), text: truncate(c.title, 40) })
		}
	}

	#syncToc(): void {
		if (!this.tocSelect || !this.chapters.length) return
		const idx = this.#sectionIndexOf(this.pageStarts[this.page] ?? 0)
		this.tocSelect.value = idx >= 0 ? String(this.chapters[idx].offset) : ''
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
	#contentWidth(): number {
		const style = getComputedStyle(this.scrollEl)
		const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
		// 视图刚打开时容器可能还是 0 宽，先给一个兜底值，resize 后会自动重排
		const width = this.scrollEl.clientWidth || this.scrollEl.getBoundingClientRect().width
		return Math.max(240, width - pad)
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

	#layout(): void {
		if (!this.scrollEl || !this.textEl) return
		this.textEl.style.width = `${this.#contentWidth()}px`
		this.textEl.style.height = `${this.#contentHeight()}px`
		this.textEl.style.columnCount = String(this.#columnCount())
		this.textEl.style.columnGap = `${this.#columnGap()}px`
	}

	#computeScreenCount(): number {
		const step = this.#step()
		const total = this.textEl.scrollWidth
		if (!Number.isFinite(total) || total <= 0 || step <= 0) return 1
		return Math.max(1, Math.ceil(total / step))
	}

	/** 渲染当前逻辑页（含高亮），等一帧后测量屏数并定位 */
	#renderPage(): void {
		if (!this.textEl) return
		const text = this.pages[this.page] ?? ''
		const pageStart = this.pageStarts[this.page] ?? 0
		const pageEnd = pageStart + text.length

		const hits = (this.data?.annotations ?? [])
			.map(a => ({ a, range: parseTextCfi(a.cfi) }))
			.filter((x): x is { a: Annotation; range: { start: number; end: number } } => !!x.range)
			.filter(x => x.range.start < pageEnd && x.range.end > pageStart)
			.sort((x, y) => x.range.start - y.range.start)

		this.textEl.empty()
		let cursor = 0
		for (const { a, range } of hits) {
			const from = Math.max(0, range.start - pageStart)
			const to = Math.min(text.length, range.end - pageStart)
			if (to <= cursor) continue
			const start = Math.max(from, cursor)
			if (start > cursor) this.textEl.appendChild(document.createTextNode(text.slice(cursor, start)))
			const mark = document.createElement('mark')
			mark.className = 'grove-txt-mark'
			mark.dataset.annId = a.id
			mark.style.backgroundColor = colorCss(a.color)
			mark.style.color = contrastFg(colorCss(a.color))
			mark.title = truncate(a.note || a.text, 120)
			mark.setText(text.slice(start, to))
			this.textEl.appendChild(mark)
			cursor = to
		}
		if (cursor < text.length) this.textEl.appendChild(document.createTextNode(text.slice(cursor)))

		this.#layout()
		this.scrollEl.scrollLeft = 0
		this.scrollEl.scrollTop = 0

		window.requestAnimationFrame(() => {
			this.screenCount = this.#computeScreenCount()
			if (this.gotoLastScreen) {
				this.gotoLastScreen = false
				this.screen = this.screenCount - 1
			} else if (this.pendingOffset !== null) {
				const target = this.pendingOffset
				this.pendingOffset = null
				this.screen = this.#offsetToScreen(target)
			}
			this.screen = Math.max(0, Math.min(this.screen, this.screenCount - 1))
			this.#applyScreen()
			this.#flashPendingMark()
		})
	}

	/** 把视口移动到当前屏 */
	#applyScreen(): void {
		if (!this.scrollEl || !this.textEl) return
		const step = this.#step()
		const max = Math.max(0, this.textEl.scrollWidth - this.scrollEl.clientWidth)
		this.scrollEl.scrollLeft = Math.min(this.screen * step, max)
		this.#syncToc()
		this.prevBtn.disabled = this.screen <= 0 && this.page <= 0
		this.nextBtn.disabled = this.screen >= this.screenCount - 1 && this.page >= this.pages.length - 1
		// 刚改完 scrollLeft 时命中测试还是旧位置，等一帧再算进度与位置
		window.requestAnimationFrame(() => {
			this.#updateProgress()
			this.#touchLocation()
		})
	}

	#totalChars(): number {
		const last = this.pages.length - 1
		return (this.pageStarts[last] ?? 0) + (this.pages[last]?.length ?? 0)
	}

	/**
	 * 当前屏第一个字符的全文偏移。
	 * 多列 + overflow 容器里 caretRangeFromPoint 不可靠（总是命中第一列），
	 * 改为二分测量「第 n 个字符的横坐标」，找第一个落在视口左缘之后的字符。
	 */
	#currentOffset(): number {
		const pageStart = this.pageStarts[this.page] ?? 0
		if (!this.textEl || !this.scrollEl) return pageStart
		const total = this.pages[this.page]?.length ?? 0
		if (!total) return pageStart
		const target = this.scrollEl.scrollLeft
		if (target <= 0) return pageStart
		const base = this.textEl.getBoundingClientRect().left
		const xAt = (local: number): number => {
			const pos = this.#findTextPos(local)
			if (!pos) return Number.POSITIVE_INFINITY
			const range = document.createRange()
			range.setStart(pos.node, pos.offset)
			range.collapse(true)
			const rect = range.getBoundingClientRect()
			if (!Number.isFinite(rect.left)) return Number.POSITIVE_INFINITY
			return rect.left - base
		}
		let lo = 0
		let hi = total - 1
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			if (xAt(mid) < target - 0.5) lo = mid + 1
			else hi = mid
		}
		return pageStart + lo
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
			if (target <= total + len) return { node: n, offset: Math.max(0, Math.min(len, target - total)) }
			total += len
		}
		return null
	}

	/** 逻辑页内的字符偏移 → 第几屏（调用时 scrollLeft 必须为 0） */
	#offsetToScreen(globalOffset: number): number {
		const local = Math.max(0, globalOffset - (this.pageStarts[this.page] ?? 0))
		const pos = this.#findTextPos(local)
		const step = this.#step()
		if (!pos || step <= 0) return 0
		const range = document.createRange()
		range.setStart(pos.node, pos.offset)
		range.collapse(true)
		const rect = range.getBoundingClientRect()
		const base = this.textEl.getBoundingClientRect().left
		if (!Number.isFinite(rect.left)) return 0
		return Math.max(0, Math.round((rect.left - base) / step))
	}

	#updateProgress(): void {
		const total = this.#totalChars()
		const offset = this.#currentOffset()
		const pct = total > 0 ? (offset / total) * 100 : 0
		this.progressLabel.setText(`${pct.toFixed(1)}%`)
		this.slider.min = '0'
		this.slider.max = String(Math.max(1, total))
		this.slider.value = String(offset)
		// 本页第几屏：翻页立即有反馈；全书页码放在悬停提示里
		this.metaEl.removeClass('grove-hidden')
		this.metaEl.setText(`${this.screen + 1}/${this.screenCount}${this.warning ? ' ⚠' : ''}`)
		this.metaEl.title = `本页第 ${this.screen + 1} 屏 / 共 ${this.screenCount} 屏 · 全书第 ${this.page + 1}/${this.pages.length} 页`
	}

	#touchLocation(): void {
		if (!this.data) return
		const offset = this.#currentOffset()
		const total = this.#totalChars()
		this.data.lastLocation = {
			cfi: `txt:${offset}`,
			index: this.page,
			fraction: total > 0 ? offset / total : 0,
			updatedAt: Date.now(),
		}
		this.#scheduleSave()
	}

	/** 跳到指定字符偏移（目录、进度条、回跳链接） */
	#jumpToOffset(offset: number, flashId?: string): void {
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

	#goPage(page: number): void {
		this.page = Math.max(0, Math.min(this.pages.length - 1, page))
		this.screen = 0
		this.gotoLastScreen = false
		this.pendingOffset = null
		this.#renderPage()
	}

	// ------------------------------------------------------------------
	// 翻页
	// ------------------------------------------------------------------

	nextPage(): void {
		if (this.screen < this.screenCount - 1) {
			this.screen += 1
			this.#applyScreen()
			return
		}
		if (this.page >= this.pages.length - 1) return
		this.page += 1
		this.screen = 0
		this.gotoLastScreen = false
		this.pendingOffset = null
		this.#renderPage()
	}

	prevPage(): void {
		if (this.screen > 0) {
			this.screen -= 1
			this.#applyScreen()
			return
		}
		if (this.page <= 0) return
		this.page -= 1
		this.screen = 0
		this.gotoLastScreen = true
		this.pendingOffset = null
		this.#renderPage()
	}

	/** 鼠标滚轮固定翻页（分页模式下滚轮不再滚动正文） */
	#onWheel(e: WheelEvent): void {
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
		// 还没完成首次定位时不要打断
		if (this.pendingOffset !== null) return
		const offset = this.#currentOffset()
		this.#layout()
		this.scrollEl.scrollLeft = 0
		window.requestAnimationFrame(() => {
			this.screenCount = this.#computeScreenCount()
			this.screen = Math.max(0, Math.min(this.#offsetToScreen(offset), this.screenCount - 1))
			this.#applyScreen()
		})
	}

	#scheduleRelayout(): void {
		if (this.relayoutTimer != null) window.clearTimeout(this.relayoutTimer)
		this.relayoutTimer = window.setTimeout(() => {
			this.relayoutTimer = null
			this.relayout()
		}, 160)
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
		this.#showPopup(range)
	}

	#clearPending(): void {
		this.pending = null
		this.#hidePopup()
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

		document.body.appendChild(popup)
		this.popup = popup

		const rect = range.getBoundingClientRect()
		let left = rect.left + rect.width / 2 - POPUP_WIDTH / 2
		left = Math.max(8, Math.min(left, window.innerWidth - POPUP_WIDTH - 8))
		let top = rect.bottom + 8
		if (top + 44 > window.innerHeight) top = Math.max(8, rect.top - 44)
		popup.style.left = `${Math.round(left)}px`
		popup.style.top = `${Math.round(top)}px`
	}

	#hidePopup(): void {
		this.popup?.remove()
		this.popup = null
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
		const menu = new Menu()
		menu.addItem(item => item.setTitle('编辑评论').setIcon('message-square').onClick(() => this.#editComment(a)))
		menu.addItem(item => {
			// setSubmenu 运行时存在但未包含在官方类型定义中
			const sub = (item.setTitle('改为其他颜色').setIcon('palette') as unknown as { setSubmenu(): Menu }).setSubmenu()
			for (const c of HIGHLIGHT_COLORS) {
				sub.addItem((ci: MenuItem) => ci.setTitle(c.name).onClick(() => this.#changeColor(a, c.key)))
			}
		})
		menu.addItem(item =>
			item
				.setTitle('复制原文')
				.setIcon('copy')
				.onClick(() => void navigator.clipboard.writeText(a.text).then(() => new Notice('Grove Reader：已复制'))),
		)
		menu.addSeparator()
		menu.addItem(item => item.setTitle('删除批注').setIcon('trash-2').onClick(() => this.#confirmDelete(a)))
		menu.showAtMouseEvent(e)
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
	jumpTo(cfi: string): void {
		const range = parseTextCfi(cfi)
		if (!range) return
		const ann = this.data?.annotations.find(a => a.cfi === cfi)
		this.#jumpToOffset(range.start, ann?.id)
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

	#toggleAppearancePanel(): void {
		if (this.appearPanelEl.hasClass('grove-hidden')) {
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

		const bgRow = panel.createDiv('grove-appear-row')
		bgRow.createSpan('grove-appear-label').setText('背景')
		const swatches = bgRow.createDiv('grove-appear-swatches')
		const themeChip = swatches.createEl('button', { cls: 'grove-appear-chip', text: '跟随主题' })
		if (a.followTheme) themeChip.addClass('is-active')
		themeChip.addEventListener('click', () => this.#patchAppearance({ followTheme: true }, true))
		for (const preset of BACKGROUND_PRESETS) {
			const sw = swatches.createEl('button', {
				cls: 'grove-appear-swatch',
				attr: { 'aria-label': preset.name, title: preset.name },
			})
			sw.style.backgroundColor = preset.bg
			if (!a.followTheme && a.bgKey === preset.key) sw.addClass('is-active')
			sw.addEventListener('click', () => this.#patchAppearance({ followTheme: false, bgKey: preset.key }, true))
		}
		const customWrap = swatches.createDiv('grove-appear-swatch grove-appear-custom')
		customWrap.style.backgroundColor = a.customBg
		if (!a.followTheme && a.bgKey === 'custom') customWrap.addClass('is-active')
		const colorInput = customWrap.createEl('input', { attr: { type: 'color', title: '自定义背景色' } })
		colorInput.value = /^#[0-9a-fA-F]{6}$/.test(a.customBg) ? a.customBg : '#ffffff'
		colorInput.addEventListener('input', () => {
			Object.assign(this.plugin.settings.appearance, {
				followTheme: false,
				bgKey: 'custom',
				customBg: colorInput.value,
			})
			customWrap.style.backgroundColor = colorInput.value
			this.#applyAppearance()
			this.plugin.persistSettingsSoon()
		})

		const fontRow = panel.createDiv('grove-appear-row')
		fontRow.createSpan('grove-appear-label').setText('字体')
		const fontSelect = fontRow.createEl('select', { cls: 'dropdown' })
		for (const font of TEXT_FONT_PRESETS) fontSelect.createEl('option', { value: font.value, text: font.label })
		fontSelect.value = TEXT_FONT_PRESETS.some(font => font.value === a.fontFamily) ? a.fontFamily : ''
		fontSelect.addEventListener('change', () => this.#patchAppearance({ fontFamily: fontSelect.value }, true))

		const sliders: Array<{
			label: string
			key: keyof ReaderAppearance
			min: number
			max: number
			step: number
			fmt: (v: number) => string
		}> = [
			{ label: '字号', key: 'fontSize', min: 80, max: 180, step: 5, fmt: v => `${Math.round(v)}%` },
			{ label: '行距', key: 'lineHeight', min: 1.2, max: 2.4, step: 0.05, fmt: v => v.toFixed(2) },
			{ label: '上下留白', key: 'pageMargin', min: 0, max: 200, step: 4, fmt: v => `${Math.round(v)}px` },
			{ label: '版心宽', key: 'maxInlineSize', min: 480, max: 1200, step: 20, fmt: v => `${Math.round(v)}px` },
		]
		for (const item of sliders) {
			const row = panel.createDiv('grove-appear-row')
			row.createSpan('grove-appear-label').setText(item.label)
			const wrap = row.createDiv('grove-appear-slider')
			const range = wrap.createEl('input', {
				attr: { type: 'range', min: String(item.min), max: String(item.max), step: String(item.step) },
			})
			const valueEl = wrap.createSpan('grove-appear-value')
			const current = Number(a[item.key]) || item.min
			range.value = String(current)
			valueEl.setText(item.fmt(current))
			range.addEventListener('input', () => {
				const value = Number.parseFloat(range.value)
				valueEl.setText(item.fmt(value))
				this.#patchAppearance({ [item.key]: value } as Partial<ReaderAppearance>)
			})
		}

		const foot = panel.createDiv('grove-appear-foot')
		const reset = foot.createEl('button', { text: '恢复默认' })
		reset.addEventListener('click', () => {
			Object.assign(this.plugin.settings.appearance, DEFAULT_APPEARANCE)
			this.#applyAppearance()
			void this.plugin.persistSettingsNow()
			this.#renderAppearancePanel()
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

	#applyAppearance(): void {
		if (!this.readerEl || !this.textEl) return
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
