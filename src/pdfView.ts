import './pdfjsPolyfill'
import { ItemView, Notice, TFile, ViewStateResult, WorkspaceLeaf, setIcon } from 'obsidian'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist'
import type GroveReaderPlugin from './main'
import { Annotation, BookData, HIGHLIGHT_COLORS, VIEW_TYPE_GROVE_PDF, colorCss } from './types'
import { CommentModal, ConfirmModal } from './modals'
import { JumpReturnBar } from './navReturn'
import { createBookmarkSection, findBookmarkIndex, makeBookmark, type BookmarkSectionHandle } from './bookmarks'
import { basenameOf, isAbsolutePath, normalizeSelectionText, pageFromFraction, randomId, truncate } from './util'
import { joinPath } from './platformIO'
import type { GroveLinkTarget } from './wikilink'

/** 常量定义在 types.ts（main.ts 不 import 本模块也要能判断 PDF 视图），这里保持原导出名 */
export { VIEW_TYPE_GROVE_PDF }

// pdf.worker 模块被 import 时会自注册 globalThis.pdfjsWorker（毒化 Obsidian 原生
// PDF 视图：其自带 pdfjs 版本与我们的不一致直接冲突），必须立即清除。
// 我们走 MessageChannel 的 port 注入，不需要这个全局。
delete (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker

interface PdfViewport {
	width: number
	height: number
	scale: number
	rotation: number
}

interface PdfPageProxy {
	getViewport(params: { scale: number; rotation?: number }): PdfViewport
	render(params: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void>; cancel(): void }
	streamTextContent(): unknown
	getTextContent(): Promise<{ items: Array<{ str?: string }> }>
	cleanup(): void
}

interface PdfDocProxy {
	numPages: number
	getPage(n: number): Promise<PdfPageProxy>
	getMetadata(): Promise<{ info?: { Title?: string } }>
	getOutline(): Promise<Array<{ title?: string; dest?: unknown; items?: unknown[] }> | null>
	getDestination(ref: string): Promise<unknown[] | null>
	getPageIndex(ref: unknown): Promise<number>
	cleanup(): void
	destroy(): Promise<void>
}

interface NormalizedRect {
	l: number
	t: number
	w: number
	h: number
}

interface PdfSelection {
	page: number
	rects: NormalizedRect[]
	text: string
}

interface PageEntry {
	wrap: HTMLElement
	canvas?: HTMLCanvasElement
	textDiv?: HTMLElement
	hlDiv?: HTMLElement
	vp1w: number
	vp1h: number
	renderScale: number | null
	task: { cancel(): void } | null
	textDone: boolean
	searchText?: { text: string; items: string[]; offsets: number[] }
	/** 同一页画布不允许并发 render：正在渲染时新请求排队，完成后补渲染 */
	rendering: boolean
	queued: boolean
}

interface SearchRange {
	start: number
	end: number
	before: string
	mid: string
	after: string
}

const DPR = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2)
/** 单页画布像素预算：超大扫描页按比例降低渲染分辨率，防止内存爆炸 */
const MAX_CANVAS_PIXELS = 2 ** 23
const MAX_SEARCH_CACHE_CHARS = 1_000_000
const MAX_SEARCH_RESULTS = 5_000

/** 随机读取 PDF 字节；桌面端由 node:fs 实现，手机端不启用（整文件读入）。 */
interface RangeReader {
	read(begin: number, end: number): Promise<Uint8Array>
	close(): void
}

class PdfRangeTransport extends pdfjsLib.PDFDataRangeTransport {
	private aborted = false
	bytesRequested = 0
	requestCount = 0
	bytesDelivered = 0

	constructor(
		private reader: RangeReader,
		length: number,
	) {
		super(length, null, false)
	}

	requestDataRange(begin: number, end: number): void {
		if (this.aborted) return
		this.requestCount++
		this.bytesRequested += end - begin
		void this.reader
			.read(begin, end)
			.then(chunk => {
				if (this.aborted) return
				this.bytesDelivered += chunk.byteLength
				this.onDataRange(begin, chunk)
			})
			.catch(error => {
				if (this.aborted) return
				console.error('[Grove Reader] PDF 分段读取失败', error)
				this.onDataRange(begin, new Uint8Array(0))
			})
	}

	abort(): void {
		if (this.aborted) return
		this.aborted = true
		try {
			this.reader.close()
		} catch {
			// ignore
		}
	}
}

export class PdfView extends ItemView {
	bookPath = ''
	bookTitle = ''

	private pdfDoc: PdfDocProxy | null = null
	private pdfWorker: PDFWorker | null = null
	private pdfLoadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null
	private pdfRangeTransport: PdfRangeTransport | null = null
	private data: BookData | null = null
	private loadedPath: string | null = null
	private pendingCfi: string | null = null
	/** 双链降级信息：PDF 只有页码，页码失效时按百分比落一页 */
	private pendingFallback: GroveLinkTarget | null = null
	private numPages = 0
	private scale = 1
	private zoom = 1
	private currentPage = 1
	/** 跳转后的「返回原位置」浮条（挂 contentEl：pagesEl 是滚动容器，绝对定位会跟着页面滚走） */
	private jumpReturn = new JumpReturnBar(() => this.contentEl ?? null)
	/** 书签区的渲染句柄与工具栏按钮 */
	private bookmarkSection: BookmarkSectionHandle | null = null
	private bookmarkBtnEl: HTMLElement | null = null
	private pages = new Map<number, PageEntry>()
	private renderedPages = new Set<number>()
	private renderingPages = new Set<number>()
	private renderQueue = new Set<number>()
	private activeRenderCount = 0
	private readonly maxConcurrentRenders = 2
	private observer: IntersectionObserver | null = null
	private resizeObserver: ResizeObserver | null = null
	private lastWidth = 0
	private pending: PdfSelection | null = null
	private popup: HTMLElement | null = null
	private saveTimer: number | null = null
	private relayoutTimer: number | null = null
	/** 选区变化防抖：手机长按选择走的是 selectionchange（pointerup 会被 pointercancel 吃掉） */
	private selectionTimer: number | null = null

	private pagesEl!: HTMLElement
	private sidebarEl!: HTMLElement
	private annListEl!: HTMLElement
	private annCountEl!: HTMLElement
	private searchInput!: HTMLInputElement
	private sidebarQuery = ''
	private tocSelect!: HTMLSelectElement
	private zoomLabel!: HTMLElement
	private progressLabel!: HTMLElement
	private annItemEls = new Map<string, HTMLElement>()
	private revealTimer: number | null = null
	private pointerDownAt: { x: number; y: number } | null = null

	// 批注管理
	private selectMode = false
	private selectedIds = new Set<string>()
	private sortMode: 'position' | 'recent' = 'position'

	// 全文搜索
	private searchTaskId = 0
	private pageMatches = new Map<number, SearchRange[]>()
	private searchTextCache = new Map<number, { text: string; items: string[]; offsets: number[] }>()
	private searchTextCacheChars = 0
	private fullTextSearchEl!: HTMLDetailsElement
	private contentSearchInput!: HTMLInputElement
	private searchCountEl!: HTMLElement
	private searchResultsEl!: HTMLElement
	private selectBarEl!: HTMLElement
	private selectCountEl!: HTMLElement

	constructor(leaf: WorkspaceLeaf, private plugin: GroveReaderPlugin) {
		super(leaf)
		this.navigation = false
	}

	getViewType(): string {
		return VIEW_TYPE_GROVE_PDF
	}

	getDisplayText(): string {
		return this.bookTitle || 'PDF'
	}

	getIcon(): string {
		return 'file'
	}

	get ready(): boolean {
		return !!(this.pdfDoc && this.data)
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
		else this.#showEmpty('从书架或文件列表打开一本 PDF。')
	}

	async onClose(): Promise<void> {
		this.#flushSave()
		await this.#teardown()
		this.resizeObserver?.disconnect()
		this.resizeObserver = null
	}

	getState(): Record<string, unknown> {
		const base = super.getState() as Record<string, unknown>
		return { ...base, bookPath: this.bookPath || undefined }
	}

	async setState(state: unknown, result?: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as { bookPath?: string; file?: string; cfi?: string; fallback?: GroveLinkTarget }
		const newCfi = s.cfi ?? null
		const incoming = s.bookPath ?? (s.file ? String(s.file) : '')
		if (incoming) this.bookPath = incoming
		if (newCfi) this.pendingCfi = newCfi
		if (s.fallback) this.pendingFallback = s.fallback
		await super.setState(state, result ?? { history: false })
		if (!this.pagesEl) return
		if (!this.bookPath) return
		if (!this.pdfDoc || this.loadedPath !== this.bookPath) {
			await this.#teardown()
			await this.#openBook(this.pendingCfi ?? undefined)
			return
		}
		if (newCfi || this.pendingFallback) this.#jumpToCfi(newCfi ?? '', true, this.pendingFallback ?? undefined)
	}

	// ------------------------------------------------------------------
	// DOM
	// ------------------------------------------------------------------

	#buildDom(): void {
		const root = this.contentEl
		root.empty()
		root.addClass('grove-pdf-content')
		// 阅读计时的「人在看」信号：PDF 是滚动阅读，只靠翻页计数会漏掉大量时长
		this.registerDomEvent(root, 'pointerdown', () => this.plugin.noteReadingActivity(), { passive: true })
		this.registerDomEvent(root, 'wheel', () => this.plugin.noteReadingActivity(), { passive: true })

		const toolbar = root.createDiv('grove-toolbar')

		const prevBtn = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': '上一页（↑/←）' } })
		setIcon(prevBtn, 'chevron-up')
		prevBtn.addEventListener('click', () => this.prevPage())

		const nextBtn = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': '下一页（↓/→）' } })
		setIcon(nextBtn, 'chevron-down')
		nextBtn.addEventListener('click', () => this.nextPage())

		this.progressLabel = toolbar.createSpan('grove-progress-label')
		this.progressLabel.setText('0 / 0')

		toolbar.createDiv('grove-sep')

		const zoomOut = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': '缩小' } })
		setIcon(zoomOut, 'zoom-out')
		zoomOut.addEventListener('click', () => this.#setZoom(this.zoom / 1.15))
		this.zoomLabel = toolbar.createSpan('grove-progress-label')
		this.zoomLabel.setText('100%')
		const zoomIn = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': '放大' } })
		setIcon(zoomIn, 'zoom-in')
		zoomIn.addEventListener('click', () => this.#setZoom(this.zoom * 1.15))
		const fitBtn = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': '适应宽度' } })
		setIcon(fitBtn, 'move-horizontal')
		fitBtn.addEventListener('click', () => this.#setZoom(1))

		const tocWrap = toolbar.createDiv('grove-toc')
		this.tocSelect = tocWrap.createEl('select', { cls: 'dropdown grove-toc-select' })
		this.tocSelect.createEl('option', { value: '', text: '目录' })
		this.tocSelect.addEventListener('change', () => {
			const v = this.tocSelect.value
			const n = Number.parseInt(v, 10)
			if (Number.isFinite(n)) this.#jumpToPageWithReturn(n)
		})

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

		const noteBtn = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': '生成 / 更新阅读笔记' } })
		setIcon(noteBtn, 'file-text')
		noteBtn.addEventListener('click', () => void this.plugin.generateNoteFor(this))

		const bookmarkBtn = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn grove-bookmark-btn', attr: { 'aria-label': '书签：标记 / 取消当前位置' } })
		setIcon(bookmarkBtn, 'bookmark')
		bookmarkBtn.addEventListener('click', () => this.#toggleBookmark())
		this.bookmarkBtnEl = bookmarkBtn

		// grove-pdf-side-btn 供手机端样式把入口提到工具栏最左（内容多，否则要横滑才找得到）
		const sideBtn = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn grove-pdf-side-btn', attr: { 'aria-label': '批注列表' } })
		setIcon(sideBtn, 'list')
		sideBtn.addEventListener('click', () => this.sidebarEl.classList.toggle('grove-hidden'))

		const body = root.createDiv('grove-body')
		this.pagesEl = body.createDiv('grove-pdf-pages')
		this.pagesEl.addEventListener('scroll', () => this.#onScroll())
		this.pagesEl.addEventListener('pointerdown', e => {
			this.pointerDownAt = { x: e.clientX, y: e.clientY }
		})
		this.pagesEl.addEventListener('pointerup', e => {
			const down = this.pointerDownAt
			this.pointerDownAt = null
			// 原地轻点（非拖拽划选）时命中测试正文高亮，联动右侧批注列表
			if (down && Math.abs(e.clientX - down.x) < 6 && Math.abs(e.clientY - down.y) < 6) {
				this.#handlePageClick(e)
			}
		})
		this.pagesEl.addEventListener('pointerup', () => {
			window.setTimeout(() => this.#captureSelection(), 0)
		})
		// 手机端长按选中文字时，浏览器会发 pointercancel 而不是 pointerup，
		// 只在 pointerup 里捕获会拿不到选区（点颜色按钮就提示"请先划选"）。
		// selectionchange 在拖手柄时也会持续触发，统一在这里兜住。
		this.registerDomEvent(document, 'selectionchange', () => {
			if (this.selectionTimer != null) window.clearTimeout(this.selectionTimer)
			this.selectionTimer = window.setTimeout(() => {
				this.selectionTimer = null
				const sel = window.getSelection()
				if (!sel || sel.isCollapsed || !sel.rangeCount) return
				const node = sel.getRangeAt(0).startContainer
				if (!this.pagesEl.contains(node)) return
				this.#captureSelection()
			}, 120)
		})
		// 容器宽度变化（新标签刚展开、侧栏开关、窗口缩放、分屏）后重算缩放重排。
		// 视图刚创建时宽度为 0，必须等有真实宽度后再算，否则页面会被渲染得极小。
		this.resizeObserver = new ResizeObserver(() => {
			if (!this.pdfDoc) return
			const w = this.pagesEl.clientWidth
			if (w <= 0 || Math.abs(w - this.lastWidth) < 4) return
			if (this.relayoutTimer != null) window.clearTimeout(this.relayoutTimer)
			this.relayoutTimer = window.setTimeout(() => {
				this.relayoutTimer = null
				this.#relayout()
			}, 120)
		})
		this.resizeObserver.observe(this.pagesEl)
		this.registerDomEvent(this.contentEl, 'click', e => {
			const t = e.target
			if (!this.popup) return
			if (t instanceof Element && !t.closest('.grove-sel-popup')) this.#hidePopup()
		}, { capture: true })
		this.registerDomEvent(this.contentEl, 'keydown', (e: KeyboardEvent) => {
			// 焦点在输入框/滑杆时方向键属于编辑操作，不能翻页
			const t = e.target
			if (t instanceof HTMLElement && t.closest('input, textarea, select, [contenteditable="true"]')) return
			if (e.key === 'ArrowRight' || e.key === 'PageDown') { this.nextPage(); e.preventDefault() }
			else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { this.prevPage(); e.preventDefault() }
		})

		this.sidebarEl = body.createDiv('grove-sidebar')
		// 手机窄屏：批注栏默认收起，把宽度让给页面（打开成功后还会按设置再校一次）
		if (this.plugin.isMobile) this.sidebarEl.classList.add('grove-hidden')
		const sideHead = this.sidebarEl.createDiv('grove-sidebar-head')
		this.annCountEl = sideHead.createSpan('grove-ann-count')
		this.annCountEl.setText('0 个批注')
		// 与 EPUB / TXT 对齐：手机端批注栏是覆盖式抽屉，必须有一个明确的退出按钮
		const closeSidebar = sideHead.createEl('button', { cls: 'clickable-icon grove-sidebar-close', attr: { 'aria-label': '关闭批注栏', title: '关闭批注栏' } })
		setIcon(closeSidebar, 'x')
		closeSidebar.addEventListener('click', () => this.sidebarEl.classList.add('grove-hidden'))

		// 书签区放在批注区之上：它是导航，不该被下面的搜索/筛选挡住
		this.bookmarkSection = createBookmarkSection(this.sidebarEl, { onAdd: () => this.#toggleBookmark() })

		// 全文搜索折叠区，与 EPUB 阅读器使用相同的侧栏结构。
		this.fullTextSearchEl = this.sidebarEl.createEl('details', { cls: 'grove-fulltext-search' })
		this.fullTextSearchEl.createEl('summary', { text: '全文搜索' })
		const sControls = this.fullTextSearchEl.createDiv('grove-fulltext-search-controls')
		this.contentSearchInput = sControls.createEl('input', {
			cls: 'grove-ann-search',
			attr: { type: 'search', placeholder: '输入关键词，按 Enter 搜索全文…' },
		})
		this.contentSearchInput.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault()
				this.#runContentSearch()
			} else if (e.key === 'Escape') {
				this.#clearContentSearch()
			}
		})
		const sMeta = this.fullTextSearchEl.createDiv('grove-fulltext-search-meta')
		this.searchCountEl = sMeta.createSpan('grove-fulltext-search-status')
		this.searchCountEl.setText('输入关键词后按回车')
		const clearSearchBtn = sMeta.createEl('button', { cls: 'grove-manage-btn', text: '清除', attr: { 'aria-label': '清除全文搜索' } })
		clearSearchBtn.addEventListener('click', () => this.#clearContentSearch())
		this.searchResultsEl = this.fullTextSearchEl.createDiv('grove-ann-list grove-fulltext-search-results')

		// 批注列表与 EPUB 阅读器保持相同的排列方式。
		const controls = this.sidebarEl.createDiv('grove-sidebar-controls')
		this.searchInput = controls.createEl('input', {
			cls: 'grove-ann-search',
			attr: { type: 'search', placeholder: '搜索批注…' },
		})
		this.searchInput.addEventListener('input', () => {
			this.sidebarQuery = this.searchInput.value.trim()
			this.#saveFilterState()
			this.#renderSidebar()
		})
		const manageRow = controls.createDiv('grove-ann-filters')
		const sortBtn = manageRow.createEl('button', { cls: 'grove-manage-btn', text: '排序：位置' })
		sortBtn.addEventListener('click', () => {
			this.sortMode = this.sortMode === 'position' ? 'recent' : 'position'
			sortBtn.setText(this.sortMode === 'position' ? '排序：位置' : '排序：最近')
			this.#saveFilterState()
			this.#renderSidebar()
		})
		const multiBtn = manageRow.createEl('button', { cls: 'grove-manage-btn', text: '多选' })
		multiBtn.addEventListener('click', () => this.#setSelectMode(!this.selectMode))

		this.selectBarEl = this.sidebarEl.createDiv('grove-select-bar grove-hidden')
		this.selectCountEl = this.selectBarEl.createSpan('grove-select-count')
		this.selectCountEl.setText('已选 0 条')
		const delBtn = this.selectBarEl.createEl('button', { text: '删除所选', cls: 'grove-select-delete' })
		delBtn.addEventListener('click', () => this.#deleteSelected())
		const cancelBtn = this.selectBarEl.createEl('button', { text: '取消', cls: 'grove-select-cancel' })
		cancelBtn.addEventListener('click', () => this.#setSelectMode(false))

		this.annListEl = this.sidebarEl.createDiv('grove-ann-list')
	}

	#showEmpty(message: string): void {
		this.pagesEl.empty()
		this.pagesEl.createDiv('grove-empty').setText(message)
	}

	// ------------------------------------------------------------------
	// 打开 / 关闭
	// ------------------------------------------------------------------

	async #openBook(cfi?: string): Promise<void> {
		const target = this.bookPath
		this.pendingCfi = cfi ?? null
		if (!target) return
		this.pagesEl.empty()
		this.pagesEl.createDiv('grove-empty').setText('正在打开…')
		try {
			const data = this.plugin.store.load(target)
			data.kind = 'pdf'
			this.data = data

			// 扫描版 PDF 的整页图片是 JBIG2/JPX 编码，pdf.js 依赖随插件分发的
			// wasm 解码资源（以及 cmaps / standard_fonts）；缺资源时页面会渲染成空白
			// worker：经 MessageChannel 直连 worker 侧处理器，作用域限于本文档，
			// 不污染 globalThis（曾毒化 Obsidian 原生 PDF 视图，详见开发全记录）
			const workerSrc = await this.#resolveWorkerSrc()
			if (!workerSrc) throw new Error('PDF.js worker resource is unavailable')
			;(pdfjsLib.GlobalWorkerOptions as unknown as { workerSrc: string }).workerSrc = workerSrc
			this.pdfWorker = new pdfjsLib.PDFWorker()
			await this.pdfWorker.promise
			delete (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker
			const docParams: Record<string, unknown> = { worker: this.pdfWorker }
			docParams.canvasMaxAreaInBytes = MAX_CANVAS_PIXELS * 4
			const localPath = isAbsolutePath(target)
				? target
				: this.plugin.vaultBase
					? joinPath(this.plugin.vaultBase, target)
					: ''
			let useRangeTransport = false
			// 桌面：本地文件按 range 分段读，几百 MB 的扫描书也不会一次性进内存。
			// 手机没有 node:fs，走下面的 vault.readBinary 整文件读（大文件直接拒绝）。
			if (localPath && !this.plugin.isMobile) {
				try {
					const fsp = await import('node:fs/promises')
					const fileInfo = await fsp.stat(localPath)
					if (fileInfo.isFile()) {
						const handle = await fsp.open(localPath, 'r')
						const reader: RangeReader = {
							async read(begin, end) {
								const chunk = new Uint8Array(end - begin)
								let offset = 0
								while (offset < chunk.length) {
									const { bytesRead } = await handle.read(chunk, offset, chunk.length - offset, begin + offset)
									if (bytesRead <= 0) throw new Error(`PDF 文件读取提前结束（${begin + offset}/${end}）`)
									offset += bytesRead
								}
								return chunk
							},
							close() {
								void handle.close().catch(() => undefined)
							},
						}
						const rangeTransport = new PdfRangeTransport(reader, fileInfo.size)
						this.pdfRangeTransport = rangeTransport
						docParams.range = rangeTransport
						docParams.rangeChunkSize = 512 * 1024
						docParams.disableStream = true
						docParams.disableAutoFetch = true
						useRangeTransport = true
					}
				} catch {
					// 读不到本地文件或非桌面环境：退回 vault 的二进制读取接口
				}
			}
			if (!useRangeTransport) {
				if (this.plugin.isMobile) {
					const file = this.app.vault.getAbstractFileByPath(target)
					const mb = file instanceof TFile ? file.stat.size / (1024 * 1024) : 0
					if (mb > 64) throw new Error(`这个 PDF 有 ${Math.round(mb)}MB，手机内存放不下，请到桌面端打开`)
				}
				const buf = await this.plugin.readBookBytes(target)
				docParams.data = new Uint8Array(buf)
			}
			const wasmUrl = this.plugin.pdfjsAssetUrl('wasm/')
			// 手机端 getResourcePath 给的是 /storage/... 文件路径，fetch 不到；
			// 这类可选资源（wasm 解码 / cmaps / 标准字体）先跳过，需要时再走 Blob
			if (wasmUrl && /^(https?|app|capacitor):/i.test(wasmUrl)) {
				docParams.wasmUrl = wasmUrl
				docParams.cMapUrl = this.plugin.pdfjsAssetUrl('cmaps/')
				docParams.cMapPacked = true
				docParams.standardFontDataUrl = this.plugin.pdfjsAssetUrl('standard_fonts/')
			}
			const task = pdfjsLib.getDocument(docParams as Parameters<typeof pdfjsLib.getDocument>[0])
			this.pdfLoadingTask = task
			const doc = (await task.promise) as unknown as PdfDocProxy
			this.pdfDoc = doc
			this.numPages = doc.numPages
			this.loadedPath = target
			this.currentPage = 1

			const meta = await doc.getMetadata().catch(() => undefined)
			const shelfEntry = this.plugin.shelfCache.get(target)
			// 书架上手动编辑过的书名优先于内嵌元数据（笔记标题取 data.title）
			this.bookTitle = shelfEntry?.title || meta?.info?.Title?.trim() || basenameOf(target).replace(/\.[^.]+$/, '')
			if (!data.title) {
				data.title = this.bookTitle
				this.#scheduleSave(true)
			}
			this.#updateHeaderTitle()
			// 打开书即校正一次笔记标题/文件名（如数字 ID 前缀清洗），无变化时不会写盘
			if (data.notePath) this.plugin.scheduleNoteRefresh(this)

			this.pagesEl.empty()
			this.observer?.disconnect()
			this.observer = new IntersectionObserver(entries => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue
					const n = Number((entry.target as HTMLElement).dataset.page)
					void this.#renderPage(n)
				}
			}, { root: this.pagesEl, rootMargin: '300px 0px' })

			// 只取第 1 页的尺寸做占位（绝不能预读全部页面：主线程 worker 下
			// 逐页 getPage 是几百次重往返，是「打开 40 秒 + 全程卡顿」的根因）。
			// 尺寸不同的页面在实际渲染时再修正占位大小。
			const firstPage = await doc.getPage(1)
			const firstVp = firstPage.getViewport({ scale: 1 })
			for (let n = 1; n <= this.numPages; n++) {
				const wrap = this.pagesEl.createDiv('grove-pdf-page')
				wrap.dataset.page = String(n)
				this.pages.set(n, {
					wrap,
					vp1w: firstVp.width, vp1h: firstVp.height,
					renderScale: null, task: null, textDone: false,
					rendering: false, queued: false,
				})
				this.observer.observe(wrap)
			}

			this.#relayout()
			await this.#buildToc(doc)
			this.progressLabel.setText(`1 / ${this.numPages}`)

			if (data.lastLocation?.page && data.lastLocation.page > 1) {
				this.#scrollToPage(data.lastLocation.page)
			}
			if (this.pendingCfi || this.pendingFallback) {
				const c = this.pendingCfi ?? ''
				const fb = this.pendingFallback ?? undefined
				this.pendingCfi = null
				this.pendingFallback = null
				// 从笔记链接进来：这是本视图的初始位置，没有「上一处」可回
				this.#jumpToCfi(c, false, fb)
			}
			// 换书时重置搜索状态，恢复本书的记忆筛选
			this.searchTaskId++
			this.pageMatches.clear()
			this.contentSearchInput.value = ''
			this.searchResultsEl.empty()
			this.#loadFilterState()
			this.searchInput.value = this.sidebarQuery
			this.#renderSidebar()
			this.sidebarEl.classList.toggle('grove-hidden', this.plugin.isMobile || !this.plugin.settings.openSidebarWithBook)
		} catch (e) {
			console.error('[Grove Reader] 打开 PDF 失败', e)
			await this.#teardown()
			this.#showEmpty(`打开失败：${e instanceof Error ? e.message : String(e)}`)
		}
	}

	async #teardown(): Promise<void> {
		this.searchTaskId++ // 取消进行中的全文搜索
		this.searchTextCache.clear()
		this.searchTextCacheChars = 0
		this.#hidePopup()
		if (this.saveTimer != null) {
			window.clearTimeout(this.saveTimer)
			this.saveTimer = null
		}
		if (this.relayoutTimer != null) {
			window.clearTimeout(this.relayoutTimer)
			this.relayoutTimer = null
		}
		if (this.selectionTimer != null) {
			window.clearTimeout(this.selectionTimer)
			this.selectionTimer = null
		}
		if (this.idleTimer != null) {
			window.clearTimeout(this.idleTimer)
			this.idleTimer = null
		}
		this.observer?.disconnect()
		this.observer = null
		for (const p of this.pages.values()) {
			p.task?.cancel()
			this.#releasePageLayers(p)
		}
		this.renderQueue.clear()
		this.renderedPages.clear()
		this.renderingPages.clear()
		this.pages.clear()
		const worker = this.pdfWorker
		this.pdfWorker = null
		const loadingTask = this.pdfLoadingTask
		this.pdfLoadingTask = null
		const rangeTransport = this.pdfRangeTransport
		this.pdfRangeTransport = null
		const doc = this.pdfDoc
		this.pdfDoc = null
		if (doc) {
			try {
				await doc.destroy()
			} catch {
				// ignore
			}
		} else if (loadingTask) {
			try {
				await loadingTask.destroy()
			} catch {
				// ignore
			}
		}
		rangeTransport?.abort()
		if (worker) {
			try {
				worker.destroy()
			} catch {
				// ignore
			}
		}
	}

	/** 手机端 resourcePath 是 /storage/... 文件路径，Worker 加载不了；由插件统一读成 Blob URL
	 *  （同一份 Blob 也被书架 PDF 封面解析复用，不要在视图关闭时释放） */
	async #resolveWorkerSrc(): Promise<string | null> {
		return this.plugin.resolvePdfWorkerSrc()
	}

	#updateHeaderTitle(): void {
		const header = this.containerEl.children[0] as HTMLElement | undefined
		const el = header?.querySelector('.view-header-title')
		if (el) el.textContent = this.bookTitle || 'PDF'
	}

	// ------------------------------------------------------------------
	// 布局与渲染
	// ------------------------------------------------------------------

	#relayout(): void {
		if (!this.pdfDoc) return
		const width = this.pagesEl.clientWidth
		// 宽度为 0（视图刚创建/被隐藏）时不能计算缩放，否则得到极小值；
		// 等 ResizeObserver 拿到真实宽度后再重排
		if (width <= 0) return
		this.lastWidth = width
		this.scale = Math.max(0.2, ((width - 32) / (this.pages.get(1)?.vp1w || 600)) * this.zoom)
		for (const [n, p] of this.pages) {
			p.wrap.style.width = `${Math.round(p.vp1w * this.scale)}px`
			p.wrap.style.height = `${Math.round(p.vp1h * this.scale)}px`
			p.wrap.style.setProperty('--total-scale-factor', String(this.scale))
			// 正在渲染的页不能碰画布（并发 render 会抛错）：排队等它完成后按新缩放重画
			if (p.rendering) {
				if (p.renderScale !== this.scale) {
					p.queued = true
					this.renderQueue.add(n)
				}
				continue
			}
			p.renderScale = null
			p.queued = false
			this.renderQueue.delete(n)
			this.renderedPages.delete(n)
			this.#releasePageLayers(p)
			p.textDone = false
			this.#drawHighlightsOf(p.wrap)
		}
		this.zoomLabel.setText(`${Math.round(this.zoom * 100)}%`)
		void this.#renderVisible()
	}

	#setZoom(zoom: number): void {
		this.zoom = Math.min(4, Math.max(0.4, zoom))
		this.#relayout()
	}

	#renderVisible(): void {
		const from = Math.max(1, this.currentPage - 1)
		const to = Math.min(this.numPages, this.currentPage + 1)
		for (let n = from; n <= to; n++) void this.#renderPage(n)
	}

	#renderPage(n: number): void {
		if (!this.pdfDoc) return
		// 拖动滚动条跳页时只保留当前页和相邻页的请求，远处页面不排队渲染。
		if (Math.abs(n - this.currentPage) > 1) return
		const p = this.pages.get(n)
		if (!p) return
		if (p.renderScale === this.scale && !p.queued) return
		if (p.rendering && p.renderScale === this.scale) return
		p.queued = true
		this.renderQueue.add(n)
		this.#drainRenderQueue()
	}

	#drainRenderQueue(): void {
		while (this.activeRenderCount < this.maxConcurrentRenders) {
			let next: number | null = null
			let nearest = Number.POSITIVE_INFINITY
			for (const n of this.renderQueue) {
				if (Math.abs(n - this.currentPage) > 1) {
					this.renderQueue.delete(n)
					const stale = this.pages.get(n)
					if (stale) stale.queued = false
					continue
				}
				const page = this.pages.get(n)
				if (!page || page.rendering) continue
				const distance = Math.abs(n - this.currentPage)
				if (distance < nearest) {
					next = n
					nearest = distance
				}
			}
			if (next === null) return
			this.renderQueue.delete(next)
			const page = this.pages.get(next)
			if (!page) continue
			page.queued = false
			if (page.renderScale === this.scale) continue
			this.activeRenderCount++
			void this.#renderPageNow(next, page).finally(() => {
				this.activeRenderCount--
				this.#drainRenderQueue()
			})
		}
	}

	async #renderPageNow(n: number, p: PageEntry): Promise<void> {
		const doc = this.pdfDoc
		if (!doc || Math.abs(n - this.currentPage) > 1) return
		const scale = this.scale
		p.rendering = true
		this.renderingPages.add(n)
		p.queued = false
		p.task?.cancel()
		p.renderScale = scale
		try {
			this.#ensurePageLayers(p)
			const page = await doc.getPage(n)
			if (p.renderScale !== scale || this.scale !== scale || this.pdfDoc !== doc) {
				if (this.pdfDoc === doc) p.renderScale = null
				return
			}
			// 实际尺寸与占位不符（占位用的是第 1 页尺寸）时修正页面大小
			const vp1 = page.getViewport({ scale: 1 })
			if (p.vp1w !== vp1.width || p.vp1h !== vp1.height) {
				p.vp1w = vp1.width
				p.vp1h = vp1.height
				p.wrap.style.width = `${Math.round(p.vp1w * this.scale)}px`
				p.wrap.style.height = `${Math.round(p.vp1h * this.scale)}px`
			}
			// 渲染分辨率 = 缩放 × DPR，超过像素预算时按比例降低 DPR
			let dpr = DPR
			const cssPixels = p.vp1w * scale * p.vp1h * scale
			if (cssPixels * DPR * DPR > MAX_CANVAS_PIXELS) {
				dpr = Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / cssPixels))
			}
			const vp = page.getViewport({ scale: scale * dpr })
			const canvas = p.canvas!
			canvas.width = Math.floor(vp.width)
			canvas.height = Math.floor(vp.height)
			const ctx = canvas.getContext('2d')
			if (!ctx) {
				p.renderScale = null
				this.#reportRenderError(n, new Error('无法获取 2D 画布上下文'))
				return
			}
			const task = page.render({ canvasContext: ctx, viewport: vp })
			p.task = task
			await task.promise
			if (p.renderScale !== scale || this.scale !== scale || this.pdfDoc !== doc) {
				if (this.pdfDoc === doc) p.renderScale = null
				return
			}
			if (!(await this.#drawTextLayer(page, p, n))) {
				// 文字层失败不阻塞阅读，仅影响划选（降级）
				p.textDone = true
			}
			this.#drawHighlightsOf(p.wrap)
			this.renderedPages.add(n)
			this.#bumpIdleCleanup()
		} catch (e) {
			// 渲染取消（renderScale 变化）属正常路径
			if (!(e instanceof Error && e.name === 'RenderingCancelledException')) {
				p.renderScale = null
				this.#reportRenderError(n, e)
			}
		} finally {
			p.task = null
			p.rendering = false
			this.renderingPages.delete(n)
			if (p.renderScale === null) {
				this.#releasePageLayers(p)
				p.textDone = false
				this.renderedPages.delete(n)
				void this.#cleanupPage(n)
			}
		}
	}

	#ensurePageLayers(p: PageEntry): void {
		if (p.canvas) return
		p.canvas = p.wrap.createEl('canvas')
		p.textDiv = p.wrap.createDiv('grove-pdf-textlayer textLayer')
		p.hlDiv = p.wrap.createDiv('grove-pdf-hllayer')
	}

	#releasePageLayers(p: PageEntry): void {
		if (p.canvas) {
			p.canvas.width = 0
			p.canvas.height = 0
			p.canvas.remove()
			p.canvas = undefined
		}
		p.textDiv?.remove()
		p.textDiv = undefined
		p.hlDiv?.remove()
		p.hlDiv = undefined
		p.textDone = false
		p.searchText = undefined
	}

	#cachePageSearchText(n: number, value: { text: string; items: string[]; offsets: number[] }): void {
		const weight = value.text.length + value.items.reduce((sum, item) => sum + item.length, 0) + value.offsets.length
		if (weight > MAX_SEARCH_CACHE_CHARS) return
		const old = this.searchTextCache.get(n)
		if (old) {
			this.searchTextCacheChars -= old.text.length + old.items.reduce((sum, item) => sum + item.length, 0) + old.offsets.length
			this.searchTextCache.delete(n)
		}
		while (this.searchTextCacheChars + weight > MAX_SEARCH_CACHE_CHARS) {
			const oldest = this.searchTextCache.keys().next().value as number | undefined
			if (oldest === undefined) break
			const removed = this.searchTextCache.get(oldest)!
			this.searchTextCacheChars -= removed.text.length + removed.items.reduce((sum, item) => sum + item.length, 0) + removed.offsets.length
			this.searchTextCache.delete(oldest)
		}
		this.searchTextCache.set(n, value)
		this.searchTextCacheChars += weight
	}

	#getPageSearchText(n: number): { text: string; items: string[]; offsets: number[] } | undefined {
		const cached = this.searchTextCache.get(n)
		if (!cached) return undefined
		this.searchTextCache.delete(n)
		this.searchTextCache.set(n, cached)
		return cached
	}

	#releaseRenderedPage(n: number): void {
		const page = this.pages.get(n)
		if (!page || page.rendering) return
		page.renderScale = null
		page.queued = false
		this.renderQueue.delete(n)
		this.#releasePageLayers(page)
		page.textDone = false
		this.renderedPages.delete(n)
		void this.#cleanupPage(n)
	}

	#renderErrorReported = false

	#reportRenderError(n: number, e: unknown): void {
		console.error(`[Grove Reader] 渲染第 ${n} 页失败`, e)
		if (this.#renderErrorReported) return
		this.#renderErrorReported = true
		new Notice(`Grove Reader：PDF 页面渲染失败：${e instanceof Error ? e.message : String(e)}（详见控制台）`)
	}

	async #drawTextLayer(page: PdfPageProxy, p: PageEntry, n: number): Promise<boolean> {
		try {
			const textDiv = p.textDiv
			if (!textDiv) return false
			textDiv.empty()
			const vp = page.getViewport({ scale: this.scale })
			const tl = new (pdfjsLib as unknown as {
				TextLayer: new (o: { textContentSource: unknown; container: HTMLElement; viewport: PdfViewport }) => { render(): Promise<void> }
			}).TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport: vp })
			await tl.render()
			if (this.pageMatches.has(n)) {
				const cached = this.#getPageSearchText(n)
				if (cached) p.searchText = cached
				else {
					const content = await page.getTextContent()
					const items = (content.items ?? []).map(item => item.str ?? '')
					const offsets: number[] = []
					let text = ''
					for (const item of items) {
						offsets.push(text.length)
						text += item
					}
					p.searchText = { text, items, offsets }
				}
			}
			this.#applySearchHighlights(p)
			return true
		} catch (e) {
			console.error(`[Grove Reader] 第 ${n} 页文字层创建失败`, e)
			return false
		}
	}

	async #cleanupPage(n: number): Promise<void> {
		try {
			const page = await this.pdfDoc?.getPage(n)
			page?.cleanup()
		} catch {
			// 渲染未结束时 cleanup 会抛错，忽略即可
		}
	}

	private idleTimer: number | null = null

	/** 闲置 30 秒后整体释放 pdf.js 后端资源（画布保留，翻回时按需重建） */
	#bumpIdleCleanup(): void {
		if (this.idleTimer != null) window.clearTimeout(this.idleTimer)
		this.idleTimer = window.setTimeout(() => {
			this.idleTimer = null
			try {
				void this.pdfDoc?.cleanup()
			} catch {
				// ignore
			}
		}, 30_000)
	}

	#onScroll(): void {
		// 二分定位当前页，避免每次滚动都逐页遍历超长 PDF 的整张页面表。
		const top = this.pagesEl.scrollTop + this.pagesEl.clientHeight * 0.25
		let current = 1
		let low = 1
		let high = this.numPages
		while (low <= high) {
			const mid = Math.floor((low + high) / 2)
			const page = this.pages.get(mid)
			if (page && page.wrap.offsetTop <= top) {
				current = mid
				low = mid + 1
			} else {
				high = mid - 1
			}
		}
		if (current !== this.currentPage && current >= 1 && current <= this.numPages) {
			this.currentPage = current
			this.progressLabel.setText(`${current} / ${this.numPages}`)
			this.plugin.statsPageTurn(this.bookPath)
			if (this.data) {
				this.data.lastLocation = {
					cfi: `page:${current}`,
					index: current - 1,
					page: current,
					fraction: current / this.numPages,
					updatedAt: Date.now(),
				}
				this.#scheduleSave()
			}
			// 翻页后当前位置变了：书签按钮的「已标记」状态要跟着变
			this.#updateBookmarkBtn()
			this.#bumpIdleCleanup()
			// 释放远端页面内存：清空画布并调用 page.cleanup() 释放解码后的整页位图
			//（扫描版每页一张大图，不解清理会累积到 GB 级）
			for (const n of this.renderQueue) {
				if (Math.abs(n - current) > 1) {
					this.renderQueue.delete(n)
					const page = this.pages.get(n)
					if (page) page.queued = false
				}
			}
			for (const n of this.renderedPages) {
				if (Math.abs(n - current) > 1) this.#releaseRenderedPage(n)
			}
			for (const n of this.renderingPages) {
				const p = this.pages.get(n)
				if (p && Math.abs(n - current) > 1) {
					p.queued = false
					this.renderQueue.delete(n)
					p.renderScale = null
					p.task?.cancel()
				}
			}
			this.#drainRenderQueue()
			this.#renderVisible()
		}
		if (this.relayoutTimer != null) window.clearTimeout(this.relayoutTimer)
		this.relayoutTimer = window.setTimeout(() => {
			this.relayoutTimer = null
			this.#renderVisible()
		}, 350)
	}

	// ------------------------------------------------------------------
	// 目录 / 翻页 / 跳转
	// ------------------------------------------------------------------

	async #buildToc(doc: PdfDocProxy): Promise<void> {
		this.tocSelect.empty()
		this.tocSelect.createEl('option', { value: '', text: '目录' })
		try {
			const outline = await doc.getOutline()
			const addItems = async (items: Array<{ title?: string; dest?: unknown; items?: unknown[] }> | null, depth: number): Promise<void> => {
				for (const item of items ?? []) {
					let pageIndex: number | null = null
					let dest = item.dest
					if (typeof dest === 'string') dest = await doc.getDestination(dest).catch(() => null)
					if (Array.isArray(dest) && dest[0] && typeof dest[0] === 'object') {
						pageIndex = (await doc.getPageIndex(dest[0]).catch(() => -1)) + 1
					}
					if (!pageIndex) continue
					const label = `${'\u00a0\u00a0'.repeat(depth)}${item.title ?? '（无标题）'}`
					this.tocSelect.createEl('option', { value: String(pageIndex), text: truncate(label, 60) })
					if (item.items?.length) await addItems(item.items as typeof items, depth + 1)
				}
			}
			await addItems(outline, 0)
		} catch (e) {
			console.error('[Grove Reader] 读取 PDF 目录失败', e)
		}
		this.tocSelect.disabled = this.tocSelect.options.length <= 1
	}

	#scrollToPage(n: number): void {
		const p = this.pages.get(n)
		if (!p) return
		this.pagesEl.scrollTo({ top: Math.max(0, p.wrap.offsetTop - 8), behavior: 'smooth' })
	}

	jumpToCfi(cfi: string, fallback?: GroveLinkTarget): void {
		this.#jumpToCfi(cfi, true, fallback)
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

	#handlePageClick(e: PointerEvent): void {
		if (!this.data) return
		const t = e.target
		if (!(t instanceof Element)) return
		const wrap = t.closest('.grove-pdf-page') as HTMLElement | null
		if (!wrap) return
		const page = Number(wrap.dataset.page)
		const rect = wrap.getBoundingClientRect()
		if (rect.width <= 0 || rect.height <= 0) return
		const px = (e.clientX - rect.left) / rect.width
		const py = (e.clientY - rect.top) / rect.height
		const pad = 0.004
		const sorted = [...this.data.annotations].sort((x, y) => (x.sectionIndex ?? 0) - (y.sectionIndex ?? 0))
		for (const a of sorted) {
			if (!a.pdf || a.pdf.page !== page) continue
			for (const r of a.pdf.rects) {
				if (px >= r.l - pad && px <= r.l + r.w + pad && py >= r.t - pad && py <= r.t + r.h + pad) {
					this.#revealInSidebar(a)
					return
				}
			}
		}
	}

	/** 正文点击批注后：展开侧栏、清掉挡住该批注的筛选，滚动定位并闪烁提示 */
	#revealInSidebar(a: Annotation): void {
		this.sidebarEl.classList.remove('grove-hidden')
		const q = this.sidebarQuery.toLowerCase()
		if (q && !`${a.text}\n${a.note ?? ''}\n${a.chapter ?? ''}`.toLowerCase().includes(q)) {
			this.sidebarQuery = ''
			if (this.searchInput) this.searchInput.value = ''
			this.#renderSidebar()
		}
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

	#jumpToCfi(cfi: string, remember = true, fb?: GroveLinkTarget): void {
		const m = /^page:(\d+)$/.exec((cfi ?? '').trim())
		let page = m ? Number.parseInt(m[1], 10) : 0
		// 页码失效（文件换了版本、页数变少）时按章节百分比落一页
		if ((!page || page < 1 || page > this.numPages) && fb && typeof fb.pct === 'number') {
			page = pageFromFraction(fb.pct, this.numPages)
		}
		if (!page || page < 1 || page > this.numPages) return
		if (!remember) {
			this.#scrollToPage(page)
			return
		}
		this.#jumpToPageWithReturn(page)
	}

	/** 明确跳页（批注 / 目录）：跳完在左下角留「返回原位置」。翻页按钮不走这里 */
	#jumpToPageWithReturn(page: number): void {
		const from = this.currentPage
		this.#scrollToPage(page)
		// 手机上批注栏是覆盖式抽屉（z-index 70），会把返回胶囊压住；
		// 而且用户点跳转就是要看原文，顺手收起抽屉
		if (this.plugin.isMobile) this.sidebarEl.classList.add('grove-hidden')
		if (from === page) return
		this.jumpReturn.show({
			label: `第 ${from} 页`,
			back: () => this.#scrollToPage(from),
		})
	}

	// ------------------------------------------------------------------
	// 书签
	// ------------------------------------------------------------------

	/** 当前位置的 CFI（PDF 是 `page:N`，与批注同一套） */
	#currentCfi(): string {
		return `page:${this.currentPage}`
	}

	#toggleBookmark(): void {
		if (!this.data) {
			new Notice('Grove Reader：还没加载完，稍等一下再试')
			return
		}
		const cfi = this.#currentCfi()
		const list = this.data.bookmarks ?? (this.data.bookmarks = [])
		const idx = findBookmarkIndex(list, cfi)
		if (idx >= 0) {
			list.splice(idx, 1)
			new Notice('Grove Reader：已移除当前位置的书签')
		} else {
			list.push(makeBookmark(cfi, `第 ${this.currentPage} 页`))
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
		const on = findBookmarkIndex(this.data?.bookmarks ?? [], this.#currentCfi()) >= 0
		this.bookmarkBtnEl?.toggleClass('is-active', on)
		if (this.bookmarkBtnEl) setIcon(this.bookmarkBtnEl, on ? 'bookmark-check' : 'bookmark')
	}

	#renderBookmarks(): void {
		this.bookmarkSection?.update(this.data?.bookmarks ?? [], {
			onJump: b => this.#jumpToCfi(b.cfi),
			onDelete: b => this.#deleteBookmark(b.id),
		})
		this.#updateBookmarkBtn()
	}

	/** 批注被外部改动（从笔记回写）后刷新侧栏 */
	refreshAnnotations(): void {
		this.#renderSidebar()
	}

	nextPage(): void {
		this.#scrollToPage(Math.min(this.numPages, this.currentPage + 1))
	}

	prevPage(): void {
		this.#scrollToPage(Math.max(1, this.currentPage - 1))
	}

	// ------------------------------------------------------------------
	// 划选 → 高亮 / 评论
	// ------------------------------------------------------------------

	#captureSelection(): void {
		const sel = window.getSelection()
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			this.#clearPending()
			return
		}
		const range = sel.getRangeAt(0)
		const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
		const wrap = startEl?.closest('.grove-pdf-page') as HTMLElement | undefined
		if (!wrap) {
			this.#clearPending()
			return
		}
		const page = Number(wrap.dataset.page)
		const wrapRect = wrap.getBoundingClientRect()
		const rects: NormalizedRect[] = []
		for (const r of Array.from(range.getClientRects())) {
			if (r.width < 1 || r.height < 1) continue
			if (r.right < wrapRect.left || r.left > wrapRect.right) continue
			rects.push({
				l: (r.left - wrapRect.left) / wrapRect.width,
				t: (r.top - wrapRect.top) / wrapRect.height,
				w: r.width / wrapRect.width,
				h: r.height / wrapRect.height,
			})
		}
		const text = normalizeSelectionText(sel.toString().replace(/\r/g, ''))
		if (!rects.length || !text) {
			this.#clearPending()
			return
		}
		this.pending = { page, rects: rects.slice(0, 400), text }
		this.#showPopup(wrap, rects)
	}

	#clearPending(): void {
		this.pending = null
		this.#hidePopup()
	}

	#showPopup(wrap: HTMLElement, rects: NormalizedRect[]): void {
		this.#hidePopup()
		const dark = document.body.classList.contains('theme-dark')
		const popup = this.contentEl.createDiv('grove-pdf-popup')
		popup.style.background = dark ? '#26262b' : '#ffffff'
		popup.style.borderColor = dark ? '#3f3f46' : '#d0d0d6'
		for (const c of HIGHLIGHT_COLORS) {
			const dot = popup.createEl('button', { cls: 'grove-color-dot', attr: { 'aria-label': `高亮（${c.name}）` } })
			dot.style.backgroundColor = c.css
			dot.addEventListener('click', () => void this.#createHighlightFromPending(c.key))
		}
		const commentBtn = popup.createEl('button', { text: '评论', cls: 'grove-pdf-popup-btn' })
		commentBtn.addEventListener('click', () => void this.#commentOnPending())
		const copyBtn = popup.createEl('button', { text: '复制', cls: 'grove-pdf-popup-btn' })
		copyBtn.addEventListener('click', () => {
			if (this.pending) void navigator.clipboard.writeText(this.pending.text).then(() => new Notice('Grove Reader：已复制'))
			this.#clearPending()
		})
		this.popup = popup

		const contentRect = this.contentEl.getBoundingClientRect()
		const last = rects[rects.length - 1]
		const wrapRect = wrap.getBoundingClientRect()
		const left = wrapRect.left + last.l * wrapRect.width + last.w * wrapRect.width / 2 - 116
		const top = wrapRect.top + (last.t + last.h) * wrapRect.height - contentRect.top + 8
		popup.style.left = `${Math.max(8, Math.min(left, contentRect.width - 240))}px`
		popup.style.top = `${Math.max(8, top)}px`
	}

	#hidePopup(): void {
		this.popup?.remove()
		this.popup = null
	}

	async #createHighlightFromPending(color: string): Promise<void> {
		const pending = this.pending
		if (!pending) {
			new Notice('Grove Reader：请先在 PDF 中划选文字')
			return
		}
		if (!this.data) return
		const now = Date.now()
		const a: Annotation = {
			id: randomId(),
			cfi: `page:${pending.page}`,
			text: pending.text,
			color,
			note: '',
			chapter: `第 ${pending.page} 页`,
			sectionIndex: pending.page,
			createdAt: now,
			updatedAt: now,
			pdf: { page: pending.page, rects: pending.rects },
		}
		this.data.annotations.push(a)
		this.#drawAnnotation(a)
		this.#clearPending()
		window.getSelection()?.removeAllRanges()
		this.#scheduleSave(true)
		this.#renderSidebar()
	}

	#drawAnnotation(a: Annotation): void {
		if (!a.pdf) return
		const p = this.pages.get(a.pdf.page)
		if (!p) return
		this.#drawHighlightsOf(p.wrap)
	}

	#drawHighlightsOf(wrap: HTMLElement): void {
		const page = Number(wrap.dataset.page)
		const hlDiv = this.pages.get(page)?.hlDiv
		if (!hlDiv || !this.data) return
		hlDiv.empty()
		for (const a of this.data.annotations) {
			if (!a.pdf || a.pdf.page !== page) continue
			for (const r of a.pdf.rects) {
				const div = hlDiv.createDiv('grove-pdf-hl')
				div.style.left = `${r.l * 100}%`
				div.style.top = `${r.t * 100}%`
				div.style.width = `${r.w * 100}%`
				div.style.height = `${r.h * 100}%`
				div.style.backgroundColor = colorCss(a.color)
			}
		}
	}

	async #commentOnPending(): Promise<void> {
		const pending = this.pending
		if (!pending) {
			new Notice('Grove Reader：请先在 PDF 中划选文字')
			return
		}
		if (!this.data) return
		const now = Date.now()
		const a: Annotation = {
			id: randomId(),
			cfi: `page:${pending.page}`,
			text: pending.text,
			color: 'yellow',
			note: '',
			chapter: `第 ${pending.page} 页`,
			sectionIndex: pending.page,
			createdAt: now,
			updatedAt: now,
			pdf: { page: pending.page, rects: pending.rects },
		}
		this.data.annotations.push(a)
		this.#drawAnnotation(a)
		this.#clearPending()
		window.getSelection()?.removeAllRanges()
		new CommentModal(this.app, '', note => {
			a.note = note
			a.updatedAt = Date.now()
			this.#scheduleSave(true)
			this.#renderSidebar()
		}).open()
	}

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
		this.#drawAnnotation(a)
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
		if (a.pdf) this.#drawAnnotation(a) // 重画该页（批注已删，等效清除）
		this.#scheduleSave(true)
		this.#renderSidebar()
		new Notice('Grove Reader：批注已删除（历史备份仍保留在插件数据目录中）')
	}

	// ------------------------------------------------------------------
	// 侧栏页签 / 全文搜索
	// ------------------------------------------------------------------

	#clearContentSearch(): void {
		this.searchTaskId++ // 取消进行中的搜索
		this.pageMatches.clear()
		this.contentSearchInput.value = ''
		this.searchCountEl.setText('输入关键词后回车')
		this.searchResultsEl.empty()
		this.#unwrapSearchHits()
	}

	#findRanges(text: string, lowerQuery: string, limit = 500): SearchRange[] {
		if (limit <= 0) return []
		const hay = text.toLowerCase()
		const out: SearchRange[] = []
		let from = 0
		for (;;) {
			const start = hay.indexOf(lowerQuery, from)
			if (start < 0) break
			const end = start + lowerQuery.length
			out.push({
				start,
				end,
				before: text.slice(Math.max(0, start - 16), start),
				mid: text.slice(start, end),
				after: text.slice(end, end + 20),
			})
			from = end
			if (out.length >= Math.min(500, limit)) break // 单页与全文上限，防极端情况卡死
		}
		return out
	}

	/** 全文搜索：并发 4 提取各页文字（带缓存），大小写不敏感匹配 */
	async #runContentSearch(): Promise<void> {
		const q = this.contentSearchInput.value.trim()
		const taskId = ++this.searchTaskId
		this.pageMatches.clear()
		this.#unwrapSearchHits()
		this.searchResultsEl.empty()
		if (!q) {
			this.searchCountEl.setText('输入关键词后回车')
			return
		}
		this.searchCountEl.setText('搜索中…')
		const lower = q.toLowerCase()
		const queue: number[] = []
		for (let n = 1; n <= this.numPages; n++) queue.push(n)
		let done = 0
		let matchCount = 0
		const worker = async (): Promise<void> => {
			while (queue.length && matchCount < MAX_SEARCH_RESULTS) {
				if (taskId !== this.searchTaskId) return
				const n = queue.shift()!
				let st = this.#getPageSearchText(n)
				if (!st) {
					try {
						const page = await this.pdfDoc?.getPage(n)
						const tc = await page?.getTextContent()
						if (taskId !== this.searchTaskId) return
						const items = (tc?.items ?? []).map(i => i.str ?? '')
						const offsets: number[] = []
						let text = ''
						for (const s of items) {
							offsets.push(text.length)
							text += s
						}
						st = { text, items, offsets }
						this.#cachePageSearchText(n, st)
					} catch {
						st = { text: '', items: [], offsets: [] }
					}
				}
				const ranges = this.#findRanges(st.text, lower, MAX_SEARCH_RESULTS - matchCount)
				if (ranges.length) {
					matchCount += ranges.length
					this.pageMatches.set(n, ranges)
					// 已渲染的页面立即补高亮
					const p = this.pages.get(n)
					if (p?.textDiv && p.renderScale !== null && !p.rendering) {
						p.searchText = st
						this.#applySearchHighlights(p)
					}
				}
				done++
				if (taskId === this.searchTaskId) this.searchCountEl.setText(`搜索中… ${done} / ${this.numPages} 页`)
			}
		}
		await Promise.all([worker(), worker(), worker(), worker()])
		if (taskId !== this.searchTaskId) return
		this.#renderSearchResults()
	}

	#renderSearchResults(): void {
		this.searchResultsEl.empty()
		const pages = [...this.pageMatches.keys()].sort((a, b) => a - b)
		const total = pages.reduce((s, n) => s + this.pageMatches.get(n)!.length, 0)
		this.searchCountEl.setText(total ? `${pages.length} 页中命中 ${total} 处` : '没有找到，试试更短的关键词')
		if (!total) return
		for (const n of pages) {
			const group = this.searchResultsEl.createDiv('grove-search-group')
			group.createDiv('grove-search-page').setText(`第 ${n} 页 · ${this.pageMatches.get(n)!.length} 处`)
			for (const m of this.pageMatches.get(n)!) {
				const item = group.createDiv('grove-search-item')
				item.createSpan('grove-search-frag').setText(m.before)
				item.createSpan('grove-search-hit-text').setText(m.mid)
				item.createSpan('grove-search-frag').setText(m.after)
				item.addEventListener('click', () => {
					this.#scrollToPage(n)
					// 高亮可能尚未包裹（页面还没渲染过）：到位渲染后会自动补
				})
			}
		}
	}

	/** 把当前页文字层里命中的子串包上高亮 span（先清后包） */
	#applySearchHighlights(p: PageEntry): void {
		const n = Number(p.wrap.dataset.page)
		const ranges = this.pageMatches.get(n)
		this.#unwrapSearchHits(p)
		if (!ranges?.length) return
		const st = p.searchText ?? this.#getPageSearchText(n)
		if (!st || !p.textDiv) return
		const spans = Array.from(p.textDiv.querySelectorAll('span'))
		for (let k = 0; k < st.items.length && k < spans.length; k++) {
			if (!st.items[k]) continue
			const itemStart = st.offsets[k]
			const itemEnd = itemStart + st.items[k].length
			// 同一 span 内多个命中按位置倒序包裹，避免拆分后偏移失效
			const local = ranges
				.filter(r => r.end > itemStart && r.start < itemEnd)
				.map(r => ({ lo: Math.max(r.start, itemStart) - itemStart, hi: Math.min(r.end, itemEnd) - itemStart }))
				.sort((a, b) => b.lo - a.lo)
			for (const { lo, hi } of local) this.#wrapRange(spans[k], lo, hi)
		}
	}

	#wrapRange(span: HTMLElement, lo: number, hi: number): void {
		const node = span.firstChild
		if (!node || node.nodeType !== Node.TEXT_NODE) return
		const text = node.textContent ?? ''
		if (lo >= hi || hi > text.length) return
		const mid = document.createElement('span')
		mid.className = 'grove-search-hit'
		mid.textContent = text.slice(lo, hi)
		const after = document.createTextNode(text.slice(hi))
		node.textContent = text.slice(0, lo)
		node.after(mid)
		mid.after(after)
	}

	#unwrapSearchHits(p?: PageEntry): void {
		const scopes = p ? (p.textDiv ? [p.textDiv] : []) : [...this.pages.values()].flatMap(x => x.textDiv ? [x.textDiv] : [])
		for (const scope of scopes) {
			for (const mark of Array.from(scope.querySelectorAll('span.grove-search-hit'))) {
				mark.replaceWith(document.createTextNode(mark.textContent ?? ''))
				mark.parentNode?.normalize()
			}
		}
	}

	// ------------------------------------------------------------------
	// 批注多选删除
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

	async #deleteSelected(): Promise<void> {
		const ids = [...this.selectedIds]
		if (!ids.length) return
		new ConfirmModal(this.app, `删除所选的 ${ids.length} 条批注？此操作不可撤销。`, () => {
			void this.#doDeleteSelected(ids)
		}).open()
	}

	async #doDeleteSelected(ids: string[]): Promise<void> {
		const arr = this.data?.annotations
		if (!arr) return
		const touchedPages = new Set<number>()
		for (const id of ids) {
			const i = arr.findIndex(a => a.id === id)
			if (i < 0) continue
			const a = arr[i]
			if (a.pdf) touchedPages.add(a.pdf.page)
			arr.splice(i, 1)
		}
		this.#scheduleSave(true)
		this.selectedIds.clear()
		this.#refreshSelectBar()
		this.#renderSidebar()
		for (const n of touchedPages) {
			const p = this.pages.get(n)
			if (p) this.#drawHighlightsOf(p.wrap)
		}
		new Notice(`Grove Reader：已删除 ${ids.length} 条批注（历史备份仍保留在插件数据目录中）`)
	}

	// ------------------------------------------------------------------
	// 批注侧栏
	// ------------------------------------------------------------------

	#renderSidebar(): void {
		// 批注与书签在同一个侧栏里，刷新批注时顺手把书签也刷一次
		this.#renderBookmarks()
		const all = [...(this.data?.annotations ?? [])].sort((x, y) =>
			this.sortMode === 'recent'
				? y.createdAt - x.createdAt
				: (x.sectionIndex ?? 0) - (y.sectionIndex ?? 0),
		)
		const q = this.sidebarQuery.toLowerCase()
		const filtered = q ? all.filter(a => `${a.text}\n${a.note ?? ''}\n${a.chapter ?? ''}`.toLowerCase().includes(q)) : all
		this.annCountEl.setText(q ? `${filtered.length} / ${all.length} 个批注` : `${all.length} 个批注`)
		this.annListEl.empty()
		this.annItemEls.clear()
		if (!all.length) {
			this.annListEl.createDiv('grove-ann-empty').setText('暂无批注。在 PDF 中划选文字即可添加高亮与评论。')
			return
		}
		if (!filtered.length) {
			this.annListEl.createDiv('grove-ann-empty').setText('没有匹配的批注。')
			return
		}
		for (const a of filtered) {
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
			const dot = head.createSpan('grove-ann-dot')
			dot.style.backgroundColor = colorCss(a.color)
			dot.title = '点击切换颜色'
			dot.addEventListener('click', () => {
				const i = HIGHLIGHT_COLORS.findIndex(c => c.key === a.color)
				const next = HIGHLIGHT_COLORS[(i + 1) % HIGHLIGHT_COLORS.length]
				void this.#changeColor(a, next.key)
			})
			head.createSpan('grove-ann-chapter').setText(a.chapter || '')
			const text = item.createDiv('grove-ann-text')
			text.setText(truncate(a.text.trim(), 160))
			text.addEventListener('click', () => this.#jumpToCfi(a.cfi))
			if (a.note) item.createDiv('grove-ann-note').setText(truncate(a.note.trim(), 120))
			const actions = item.createDiv('grove-ann-actions')

			const jump = actions.createEl('button', { cls: 'clickable-icon grove-mini-btn', attr: { 'aria-label': '跳转到该页' } })
			setIcon(jump, 'arrow-up-left')
			jump.addEventListener('click', () => this.#jumpToCfi(a.cfi))

			const edit = actions.createEl('button', { cls: 'clickable-icon grove-mini-btn', attr: { 'aria-label': '编辑评论' } })
			setIcon(edit, 'message-square')
			edit.addEventListener('click', () => this.#editComment(a))

			const del = actions.createEl('button', { cls: 'clickable-icon grove-mini-btn', attr: { 'aria-label': '删除批注' } })
			setIcon(del, 'trash-2')
			del.addEventListener('click', () => this.#confirmDelete(a))
			this.annListEl.appendChild(item)
		}
	}

	// ------------------------------------------------------------------
	// 持久化
	// ------------------------------------------------------------------

	/** 批注栏筛选/排序按书记忆（localStorage） */
	#filterKey(): string {
		return `grove-ann-filter:pdf:${this.plugin.store.bookId(this.bookPath)}`
	}

	#loadFilterState(): void {
		try {
			const raw = localStorage.getItem(this.#filterKey())
			const f = raw ? (JSON.parse(raw) as { q?: string; sort?: 'position' | 'recent' }) : {}
			this.sidebarQuery = f.q ?? ''
			if (f.sort === 'recent' || f.sort === 'position') this.sortMode = f.sort
		} catch {
			this.sidebarQuery = ''
		}
	}

	#saveFilterState(): void {
		try {
			localStorage.setItem(this.#filterKey(), JSON.stringify({ q: this.sidebarQuery, sort: this.sortMode }))
		} catch {
			// ignore
		}
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

	highlight(color: string): void {
		void this.#createHighlightFromPending(color)
	}

	comment(): void {
		void this.#commentOnPending()
	}
}
