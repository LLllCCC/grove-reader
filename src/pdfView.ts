import './pdfjsPolyfill'
import { ItemView, Notice, TFile, ViewStateResult, WorkspaceLeaf, setIcon } from 'obsidian'
import * as pdfjsLib from 'pdfjs-dist'
import * as pdfjsWorkerModule from 'pdfjs-dist/build/pdf.worker.mjs'
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist'
import type GroveReaderPlugin from './main'
import { Annotation, BookData, HIGHLIGHT_COLORS, colorCss } from './types'
import { CommentModal, ConfirmModal } from './modals'
import { basenameOf, normalizeSelectionText, randomId, truncate } from './util'

export const VIEW_TYPE_GROVE_PDF = 'grove-pdf-view'

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
	canvas: HTMLCanvasElement
	textDiv: HTMLElement
	hlDiv: HTMLElement
	vp1w: number
	vp1h: number
	renderScale: number | null
	task: { cancel(): void } | null
	textDone: boolean
	/** 同一页画布不允许并发 render：正在渲染时新请求排队，完成后补渲染 */
	rendering: boolean
	queued: boolean
}

const DPR = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2)
/** 单页画布像素预算：超大扫描页按比例降低渲染分辨率，防止内存爆炸 */
const MAX_CANVAS_PIXELS = 2 ** 24

export class PdfView extends ItemView {
	bookPath = ''
	bookTitle = ''

	private pdfDoc: PdfDocProxy | null = null
	private pdfWorker: PDFWorker | null = null
	private data: BookData | null = null
	private loadedPath: string | null = null
	private pendingCfi: string | null = null
	private numPages = 0
	private scale = 1
	private zoom = 1
	private currentPage = 1
	private pages = new Map<number, PageEntry>()
	private observer: IntersectionObserver | null = null
	private resizeObserver: ResizeObserver | null = null
	private lastWidth = 0
	private pending: PdfSelection | null = null
	private popup: HTMLElement | null = null
	private saveTimer: number | null = null
	private relayoutTimer: number | null = null

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
		const s = (state ?? {}) as { bookPath?: string; file?: string; cfi?: string }
		const newCfi = s.cfi ?? null
		const incoming = s.bookPath ?? (s.file ? String(s.file) : '')
		if (incoming) this.bookPath = incoming
		if (newCfi) this.pendingCfi = newCfi
		await super.setState(state, result ?? { history: false })
		if (!this.pagesEl) return
		if (!this.bookPath) return
		if (!this.pdfDoc || this.loadedPath !== this.bookPath) {
			await this.#teardown()
			await this.#openBook(this.pendingCfi ?? undefined)
			return
		}
		if (newCfi) this.#jumpToCfi(newCfi)
	}

	// ------------------------------------------------------------------
	// DOM
	// ------------------------------------------------------------------

	#buildDom(): void {
		const root = this.contentEl
		root.empty()
		root.addClass('grove-pdf-content')

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
			if (Number.isFinite(n)) this.#scrollToPage(n)
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

		const sideBtn = toolbar.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': '批注列表' } })
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
			if (e.key === 'ArrowRight' || e.key === 'PageDown') { this.nextPage(); e.preventDefault() }
			else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { this.prevPage(); e.preventDefault() }
		})

		this.sidebarEl = body.createDiv('grove-sidebar')
		const sideHead = this.sidebarEl.createDiv('grove-sidebar-head')
		this.annCountEl = sideHead.createSpan('grove-ann-count')
		this.annCountEl.setText('0 个批注')
		const controls = this.sidebarEl.createDiv('grove-sidebar-controls')
		this.searchInput = controls.createEl('input', {
			cls: 'grove-ann-search',
			attr: { type: 'search', placeholder: '搜索批注…' },
		})
		this.searchInput.addEventListener('input', () => {
			this.sidebarQuery = this.searchInput.value.trim()
			this.#renderSidebar()
		})
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

			const buf = await this.plugin.readBookBytes(target)
			// 扫描版 PDF 的整页图片是 JBIG2/JPX 编码，pdf.js 依赖随插件分发的
			// wasm 解码资源（以及 cmaps / standard_fonts）；缺资源时页面会渲染成空白
			// worker：经 MessageChannel 直连 worker 侧处理器，作用域限于本文档，
			// 不污染 globalThis（曾毒化 Obsidian 原生 PDF 视图，详见开发全记录）
			const channel = new MessageChannel()
			;(pdfjsWorkerModule.WorkerMessageHandler as unknown as { initializeFromPort(p: MessagePort): void })
				.initializeFromPort(channel.port1)
			// PDFWorker 的 port 构造参数未收录进官方类型定义，运行时支持
			this.pdfWorker = new (pdfjsLib.PDFWorker as unknown as new (params: { port: MessagePort }) => PDFWorker)({ port: channel.port2 })
			// MessageChannel 端口用 addEventListener 接收时必须显式 start()，
			// 否则消息永远不到达（表现为「正在打开…」卡住）
			channel.port1.start()
			channel.port2.start()
			const docParams: Record<string, unknown> = {
				data: new Uint8Array(buf.slice(0)),
				worker: this.pdfWorker,
			}
			const wasmUrl = this.plugin.pdfjsAssetUrl('wasm/')
			if (wasmUrl) {
				docParams.wasmUrl = wasmUrl
				docParams.cMapUrl = this.plugin.pdfjsAssetUrl('cmaps/')
				docParams.cMapPacked = true
				docParams.standardFontDataUrl = this.plugin.pdfjsAssetUrl('standard_fonts/')
			}
			const task = pdfjsLib.getDocument(docParams as Parameters<typeof pdfjsLib.getDocument>[0])
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

			this.pagesEl.empty()
			this.observer?.disconnect()
			this.observer = new IntersectionObserver(entries => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue
					const n = Number((entry.target as HTMLElement).dataset.page)
					void this.#renderPage(n)
				}
			}, { root: this.pagesEl, rootMargin: '600px 0px' })

			// 只取第 1 页的尺寸做占位（绝不能预读全部页面：主线程 worker 下
			// 逐页 getPage 是几百次重往返，是「打开 40 秒 + 全程卡顿」的根因）。
			// 尺寸不同的页面在实际渲染时再修正占位大小。
			const firstPage = await doc.getPage(1)
			const firstVp = firstPage.getViewport({ scale: 1 })
			for (let n = 1; n <= this.numPages; n++) {
				const wrap = this.pagesEl.createDiv('grove-pdf-page')
				wrap.dataset.page = String(n)
				const canvas = wrap.createEl('canvas')
				const textDiv = wrap.createDiv('grove-pdf-textlayer textLayer')
				const hlDiv = wrap.createDiv('grove-pdf-hllayer')
				this.pages.set(n, {
					wrap, canvas, textDiv, hlDiv,
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
			if (this.pendingCfi) {
				const c = this.pendingCfi
				this.pendingCfi = null
				this.#jumpToCfi(c)
			}
			this.#renderSidebar()
			this.sidebarEl.classList.toggle('grove-hidden', !this.plugin.settings.openSidebarWithBook)
		} catch (e) {
			console.error('[Grove Reader] 打开 PDF 失败', e)
			this.#showEmpty(`打开失败：${e instanceof Error ? e.message : String(e)}`)
			this.pdfDoc = null
		}
	}

	async #teardown(): Promise<void> {
		this.#hidePopup()
		if (this.saveTimer != null) {
			window.clearTimeout(this.saveTimer)
			this.saveTimer = null
		}
		if (this.relayoutTimer != null) {
			window.clearTimeout(this.relayoutTimer)
			this.relayoutTimer = null
		}
		this.observer?.disconnect()
		this.observer = null
		for (const p of this.pages.values()) p.task?.cancel()
		this.pages.clear()
		const worker = this.pdfWorker
		this.pdfWorker = null
		const doc = this.pdfDoc
		this.pdfDoc = null
		if (doc) {
			try {
				await doc.destroy()
			} catch {
				// ignore
			}
		}
		if (worker) {
			try {
				worker.destroy()
			} catch {
				// ignore
			}
		}
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
		for (const p of this.pages.values()) {
			p.wrap.style.width = `${Math.round(p.vp1w * this.scale)}px`
			p.wrap.style.height = `${Math.round(p.vp1h * this.scale)}px`
			p.wrap.style.setProperty('--total-scale-factor', String(this.scale))
			// 正在渲染的页不能碰画布（并发 render 会抛错）：排队等它完成后按新缩放重画
			if (p.rendering) {
				p.queued = true
				continue
			}
			p.renderScale = null
			p.canvas.width = 0
			p.textDiv.empty()
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
		const from = Math.max(1, this.currentPage - 2)
		const to = Math.min(this.numPages, this.currentPage + 2)
		for (let n = from; n <= to; n++) void this.#renderPage(n)
	}

	async #renderPage(n: number): Promise<void> {
		if (!this.pdfDoc) return
		// 打开瞬间占位页尚无尺寸，380 页会被同时判定「进入视口」；不限距离就会
		// 几百页同时向 worker 要图——白屏与鼠标卡顿的根源。只渲染当前页附近。
		if (Math.abs(n - this.currentPage) > 4) return
		const p = this.pages.get(n)
		if (!p) return
		if (p.rendering) {
			p.queued = true
			return
		}
		if (p.renderScale === this.scale) return
		p.rendering = true
		p.queued = false
		p.task?.cancel()
		p.renderScale = this.scale
		try {
			const page = await this.pdfDoc.getPage(n)
			if (p.renderScale !== this.scale || !this.pdfDoc) return
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
			const cssPixels = p.vp1w * this.scale * p.vp1h * this.scale
			if (cssPixels * DPR * DPR > MAX_CANVAS_PIXELS) {
				dpr = Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / cssPixels))
			}
			const vp = page.getViewport({ scale: this.scale * dpr })
			p.canvas.width = Math.floor(vp.width)
			p.canvas.height = Math.floor(vp.height)
			const ctx = p.canvas.getContext('2d')
			if (!ctx) {
				p.renderScale = null
				this.#reportRenderError(n, new Error('无法获取 2D 画布上下文'))
				return
			}
			const task = page.render({ canvasContext: ctx, viewport: vp })
			p.task = task
			await task.promise
			if (!this.#drawTextLayer(page, p, n)) {
				// 文字层失败不阻塞阅读，仅影响划选（降级）
				p.textDone = true
			}
			this.#drawHighlightsOf(p.wrap)
			this.#bumpIdleCleanup()
		} catch (e) {
			// 渲染取消（renderScale 变化）属正常路径
			if (!(e instanceof Error && e.name === 'RenderingCancelledException')) {
				p.renderScale = null
				this.#reportRenderError(n, e)
			}
		} finally {
			p.rendering = false
			if (p.queued) {
				p.queued = false
				void this.#renderPage(n)
			}
		}
	}

	#renderErrorReported = false

	#reportRenderError(n: number, e: unknown): void {
		console.error(`[Grove Reader] 渲染第 ${n} 页失败`, e)
		if (this.#renderErrorReported) return
		this.#renderErrorReported = true
		new Notice(`Grove Reader：PDF 页面渲染失败：${e instanceof Error ? e.message : String(e)}（详见控制台）`)
	}

	#drawTextLayer(page: PdfPageProxy, p: PageEntry, n: number): boolean {
		try {
			p.textDiv.empty()
			const vp = page.getViewport({ scale: this.scale })
			const tl = new (pdfjsLib as unknown as {
				TextLayer: new (o: { textContentSource: unknown; container: HTMLElement; viewport: PdfViewport }) => { render(): Promise<void> }
			}).TextLayer({ textContentSource: page.streamTextContent(), container: p.textDiv, viewport: vp })
			void tl.render().catch(e => console.error(`[Grove Reader] 第 ${n} 页文字层失败`, e))
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
		// 当前页 = 视口上沿所在页
		const top = this.pagesEl.scrollTop + this.pagesEl.clientHeight * 0.25
		let current = 1
		for (const [n, p] of this.pages) {
			if (p.wrap.offsetTop <= top) current = n
			else break
		}
		if (current !== this.currentPage && current >= 1 && current <= this.numPages) {
			this.currentPage = current
			this.progressLabel.setText(`${current} / ${this.numPages}`)
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
			this.#renderVisible()
			this.#bumpIdleCleanup()
			// 释放远端页面内存：清空画布并调用 page.cleanup() 释放解码后的整页位图
			//（扫描版每页一张大图，不解清理会累积到 GB 级）
			for (const [n, p] of this.pages) {
				if (Math.abs(n - current) > 3 && p.renderScale !== null && !p.rendering) {
					p.task?.cancel()
					p.renderScale = null
					p.canvas.width = 0
					p.textDiv.empty()
					p.textDone = false
					void this.#cleanupPage(n)
				}
			}
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

	jumpToCfi(cfi: string): void {
		this.#jumpToCfi(cfi)
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

	#jumpToCfi(cfi: string): void {
		const m = /^page:(\d+)$/.exec(cfi.trim())
		if (m) this.#scrollToPage(Number.parseInt(m[1], 10))
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
	// 批注侧栏
	// ------------------------------------------------------------------

	#renderSidebar(): void {
		const all = [...(this.data?.annotations ?? [])].sort((x, y) => (x.sectionIndex ?? 0) - (y.sectionIndex ?? 0))
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
			this.annItemEls.set(a.id, item)
			const head = item.createDiv('grove-ann-head')
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
