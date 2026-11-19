import { ItemView, Menu, Notice, Platform, WorkspaceLeaf, normalizePath, requestUrl, setIcon } from 'obsidian'
import type { TAbstractFile } from 'obsidian'
import { TFile } from 'obsidian'
import { makeBook } from '../lib/foliate-js/view.js'
import type GroveReaderPlugin from './main'
import { FORMAT_LABELS, LIBRARY_ROOT, READING_STATUS_LABELS, READING_STATUS_ORDER, SHELF_EXTRA_EXTS, SUPPORTED_BOOK_EXTS, ShelfBookInfo, isReaderExt, isShelfExt, type ReadingStatus } from './types'
import { appendInlineSvg, basenameOf, cleanBookTitle, duplicateKeyOf, formatAuthor, formatBytes, formatDuration, formatLanguageMap, isAbsolutePath, relativeTime, stripNumericTitlePrefix, stripTitleAuthor, truncate } from './util'
import { PlatformIO, joinPath, readJsonFile, writeJsonFile } from './platformIO'
import { BookInfoModal, ConfirmModal, CoverUrlModal, DeleteBookModal, FolderPromptModal, ListPickerModal, ReadingStatsModal, TextPromptModal } from './modals'
import { BookMetaModal } from './bookMetaModal'
import type { BookInfoValues } from './modals'
import type { BookList } from './lists'
import { computeShelfWindow, estimateRowHeight, spacerHeight } from './shelfWindow'
import { t } from './i18n'

export const VIEW_TYPE_GROVE_BOOKSHELF = 'grove-bookshelf-view'

const MAX_CACHED_COVERS = 96
const MAX_CACHED_COVER_CHARS = 24_000_000

/** PDF 封面解析版本：2 起手机端也解析首页（旧缓存靠这个字段触发一次重试） */
const PDF_COVER_VERSION = 2

const IMAGE_REQUEST_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 下载图片直链。豆瓣等图床会校验 Referer，裸请求直接返回 418/403，
 * 这里按「直连 → 同源 → 站点首页」的顺序带 Referer 重试。
 */
async function downloadImageFromUrl(url: string): Promise<{ buffer: ArrayBuffer; mime: string }> {
	let origin = ''
	let host = ''
	try {
		const parsed = new URL(url)
		origin = `${parsed.origin}/`
		host = parsed.hostname
	} catch {
		// 交给后面的请求报错
	}
	const referers: Array<string | undefined> = [
		undefined,
		origin,
		/doubanio\.com$|douban\.com$/i.test(host) ? 'https://book.douban.com/' : undefined,
	]
	const seen = new Set<string>()
	let lastStatus = 0
	for (const referer of referers) {
		const key = referer ?? ''
		if (seen.has(key)) continue
		seen.add(key)
		const headers: Record<string, string> = { 'User-Agent': IMAGE_REQUEST_UA }
		if (referer) headers.Referer = referer
		let res: Awaited<ReturnType<typeof requestUrl>>
		try {
			res = await Promise.race([
				requestUrl({ url, method: 'GET', headers }),
				new Promise<never>((_, reject) =>
					window.setTimeout(() => reject(new Error(t('下载超时（20 秒）'))), 20_000),
				),
			])
		} catch (e) {
			if (e instanceof Error && e.message.includes('超时')) throw e
			continue
		}
		if (res.status >= 200 && res.status < 300) {
			const mime = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
			if (!mime.startsWith('image/')) throw new Error(t('这个链接返回的不是图片'))
			if (res.arrayBuffer.byteLength > 12 * 1024 * 1024) throw new Error(t('图片超过 12 MB，请换一张小一些的'))
			return { buffer: res.arrayBuffer, mime }
		}
		lastStatus = res.status
	}
	if (lastStatus === 418 || lastStatus === 403 || lastStatus === 401) {
		throw new Error(
			`对方站点拒绝了下载（HTTP ${lastStatus}，防盗链）。可以右键图片「图片另存为」，再用「更换封面」选择本地文件。`,
		)
	}
	throw new Error(`下载失败：HTTP ${lastStatus || t('未知')}`)
}

// ------------------------------------------------------------------
// 书架缓存：metadata + 封面，存于插件数据目录，避免每次进书架重复解析
// ------------------------------------------------------------------

export interface ShelfEntry {
	title?: string
	author?: string
	publisher?: string
	category?: string
	intro?: string
	/** 封面图片文件名（位于 data/covers/ 下） */
	cover?: string
	/** 用户手动更换过的封面：重新解析时保留 */
	customCover?: boolean
	/** 用户手动编辑过书名/作者/出版社：自动解析结果不再覆盖 */
	manualMeta?: boolean
	mtime?: number
	/** 文件字节数：改名后按大小找回个性化数据用 */
	size?: number
	/** 首次入库时间（区别于文件自身的 mtime） */
	addedAt?: number
	failed?: boolean
	/** PDF 封面解析版本：2 起手机端也会解析首页。旧条目没有该字段 → 手机上重试一次 */
	coverVersion?: number
}

interface ShelfTitleParts {
	title?: string
	author?: string
	publisher?: string
}

interface ShelfCacheFile {
	version: number
	entries: Record<string, ShelfEntry>
}

export class ShelfCache {
	private file: string
	private coversDir: string
	private data: ShelfCacheFile = { version: 1, entries: {} }
	private saveTimer: ReturnType<typeof setTimeout> | null = null
	private queue: Promise<void> = Promise.resolve()
	/** 封面 dataURL 缓存：卡片每次刷新都会取封面，避免反复读盘 + base64 */
	private coverCache = new Map<string, string | null>()
	private coverCacheChars = 0
	/** 封面是否已经预热过（由书架首次渲染触发，避免启动就全量读盘） */
	private coversLoaded = false
	/** 封面后台读完后的通知（书架用来补画首次加载时还是空白的卡片） */
	private coverListeners = new Set<(filename: string, url: string | null) => void>()
	private io: PlatformIO

	constructor(rootDir: string, io: PlatformIO) {
		this.io = io
		this.file = joinPath(rootDir, 'data', 'shelf.json')
		this.coversDir = joinPath(rootDir, 'data', 'covers')
	}

	/**
	 * 读缓存。封面不在这里预热——书架没打开时（比如直接进阅读页），
	 * 逐个读封面再转 base64 纯属白烧启动时间和内存。
	 * 需要封面时由 ensureCoversLoaded() 触发一次。
	 */
	async load(): Promise<void> {
		const parsed = await readJsonFile<ShelfCacheFile>(this.io, this.file)
		if (parsed && typeof parsed === 'object' && parsed.entries) {
			this.data = parsed
			// 旧缓存里带数字前缀/下载站后缀的书名一次性洗掉；手动改过的不动
			let changed = false
			for (const entry of Object.values(this.data.entries)) {
				if (!entry.title || entry.manualMeta) continue
				const next = stripTitleAuthor(cleanBookTitle(stripNumericTitlePrefix(entry.title)), entry.author ?? '')
				if (next !== entry.title) {
					entry.title = next
					changed = true
				}
			}
			if (changed) this.saveSoon()
		}
	}

	/** 书架首次渲染前调用一次；之后再调是空操作 */
	async ensureCoversLoaded(): Promise<void> {
		if (this.coversLoaded) return
		this.coversLoaded = true
		await this.#preloadCovers()
	}

	/** 封面后台读完时通知（url 为 null 表示读取失败）；返回取消订阅函数 */
	onCoverLoaded(listener: (filename: string, url: string | null) => void): () => void {
		this.coverListeners.add(listener)
		return () => this.coverListeners.delete(listener)
	}

	get(path: string): ShelfEntry | undefined {
		return this.data.entries[path]
	}

	set(path: string, entry: ShelfEntry): void {
		this.data.entries[path] = entry
		this.saveSoon()
	}

	entries(): Array<[string, ShelfEntry]> {
		return Object.entries(this.data.entries)
	}

	remove(path: string): void {
		if (this.data.entries[path]) {
			delete this.data.entries[path]
			this.saveSoon()
		}
	}

	/** 删除某本书的封面文件（删书时调用） */
	removeCover(filename?: string): void {
		if (!filename) return
		this.#deleteCoverCache(filename)
		void this.io.remove(joinPath(this.coversDir, filename)).catch(() => {
			// 封面可能已被手动删除
		})
	}

	private saveSoon(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer)
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null
			this.saveNow()
		}, 800)
	}

	saveNow(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer)
			this.saveTimer = null
		}
		const snapshot = this.data
		this.queue = this.queue
			.catch(() => undefined)
			.then(() => writeJsonFile(this.io, this.file, snapshot))
			.catch(e => {
				console.error(t('[Grove Reader] 书架缓存写入失败'), e)
			})
	}

	async flush(): Promise<void> {
		await this.queue
	}

	async saveCover(bookId: string, blob: Blob): Promise<string | undefined> {
		try {
			const ext = blob.type.includes('png') ? 'png' : blob.type.includes('gif') ? 'gif' : 'jpg'
			return await this.#writeCover(`${bookId}.${ext}`, await blob.arrayBuffer(), blob.type)
		} catch (e) {
			console.error(t('[Grove Reader] 封面保存失败'), e)
			return undefined
		}
	}

	/** 用户手动选择的本地图片作为封面 */
	async saveCustomCover(bookId: string, file: File): Promise<string | undefined> {
		try {
			const lower = file.name.toLowerCase()
			const ext = lower.endsWith('.png') ? 'png' : lower.endsWith('.gif') ? 'gif' : lower.endsWith('.webp') ? 'webp' : 'jpg'
			return await this.#writeCover(`${bookId}-custom.${ext}`, await file.arrayBuffer(), file.type)
		} catch (e) {
			console.error(t('[Grove Reader] 自定义封面保存失败'), e)
			return undefined
		}
	}

	/** 从网络图片字节保存自定义封面 */
	async saveCustomCoverFromBuffer(bookId: string, data: ArrayBuffer, mime: string): Promise<string | undefined> {
		try {
			const ext = mime.includes('png') ? 'png' : mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : 'jpg'
			return await this.#writeCover(`${bookId}-custom.${ext}`, data, mime)
		} catch (e) {
			console.error(t('[Grove Reader] 网络封面保存失败'), e)
			return undefined
		}
	}

	coverDataUrl(filename?: string): string | null {
		if (!filename) return null
		if (this.coverCache.has(filename)) {
			const cached = this.coverCache.get(filename) ?? null
			this.coverCache.delete(filename)
			this.coverCache.set(filename, cached)
			return cached
		}
		// 启动后新增的封面：后台补进缓存，本次先返回 null
		void this.#loadCover(filename)
		return null
	}

	async #writeCover(name: string, data: ArrayBuffer, mime: string): Promise<string> {
		await this.io.mkdir(this.coversDir)
		await this.io.writeBinary(joinPath(this.coversDir, name), data)
		this.#deleteCoverCache(name)
		this.#putCover(name, `data:${mime || mimeOf(name)};base64,${arrayBufferToBase64(data)}`)
		return name
	}

	async #preloadCovers(): Promise<void> {
		// 只预热缓存装得下的那部分：多读进来的会被 LRU 立刻淘汰，白读一次盘
		const names = new Set<string>()
		for (const entry of Object.values(this.data.entries)) {
			if (entry.cover) names.add(entry.cover)
		}
		for (const name of [...names].slice(0, MAX_CACHED_COVERS)) await this.#loadCover(name)
	}

	async #loadCover(filename: string): Promise<void> {
		if (this.coverCache.has(filename)) return
		try {
			const buf = await this.io.readBinary(joinPath(this.coversDir, filename))
			this.#putCover(filename, `data:${mimeOf(filename)};base64,${arrayBufferToBase64(buf)}`)
		} catch {
			this.#putCover(filename, null)
		}
	}

	#putCover(filename: string, url: string | null): void {
		if (url !== null && url.length > MAX_CACHED_COVER_CHARS) return
		this.#deleteCoverCache(filename)
		while (this.coverCache.size >= MAX_CACHED_COVERS || this.coverCacheChars + (url?.length ?? 0) > MAX_CACHED_COVER_CHARS) {
			const oldest = this.coverCache.keys().next().value as string | undefined
			if (oldest === undefined) break
			this.#deleteCoverCache(oldest)
		}
		this.coverCache.set(filename, url)
		if (url) this.coverCacheChars += url.length
		for (const listener of this.coverListeners) {
			try {
				listener(filename, url)
			} catch {
				// 监听方（书架视图）已经关闭时忽略
			}
		}
	}

	#deleteCoverCache(filename: string): void {
		const cached = this.coverCache.get(filename)
		if (cached) this.coverCacheChars -= cached.length
		this.coverCache.delete(filename)
	}
}

function mimeOf(filename: string): string {
	if (filename.endsWith('.png')) return 'image/png'
	if (filename.endsWith('.gif')) return 'image/gif'
	if (filename.endsWith('.webp')) return 'image/webp'
	return 'image/jpeg'
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf)
	let binary = ''
	const chunk = 0x8000
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
	}
	return btoa(binary)
}

// ------------------------------------------------------------------
// 扫描
// ------------------------------------------------------------------

export function scanBookFolders(folders: string[], vaultFiles: string[]): string[] {
	const found = new Set<string>()
	for (const folder of folders) {
		const clean = folder.replace(/\\/g, '/').replace(/\/+$/, '')
		let prefixes: string[] = []
		if (isAbsolutePath(clean)) {
			// 手机端的文件夹选择器可能返回绝对路径（/storage/.../GroveTest/书籍）。
			// 从末尾往前取 1–4 段，找能和库内路径对上的那一层。
			const segs = clean.split('/').filter(Boolean)
			prefixes = []
			for (let n = 1; n <= Math.min(4, segs.length); n++) prefixes.push(segs.slice(-n).join('/'))
		} else {
			prefixes = [clean]
		}
		for (const file of vaultFiles) {
			if (!isShelfExt(file.split('.').pop()?.toLowerCase() ?? '')) continue
			const hit = prefixes.some(p => p && (file === p || file.startsWith(`${p}/`)))
			if (!hit) continue
			if (file.split('/').length > 8) continue
			found.add(file)
		}
	}
	return [...found].sort()
}

// ------------------------------------------------------------------
// 书架视图
// ------------------------------------------------------------------

const SORT_OPTIONS: Array<[string, string]> = [
	['default', '默认（按文件名）'],
	['added', '最近添加'],
	['title', '按书名'],
	['progress', '阅读进度'],
]

/** 书单色条：由 id 稳定映射到色相，避免额外存颜色字段 */
function listHue(id: string): number {
	let h = 0
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
	return h
}

export class BookshelfView extends ItemView {
	private gridEl!: HTMLElement
	private listsRowEl!: HTMLElement
	private listsEl!: HTMLElement
	/** 'all' = 全部，'none' = 未分类，其余为书单 id */
	private listFilter = 'all'
	/** 手动阅读状态筛选（不持久化，和书单筛选一样属于本次会话） */
	private statusFilter: ReadingStatus | 'all' = 'all'
	private toolsEl!: HTMLElement
	private emptyEl!: HTMLElement
	private continueEl!: HTMLElement
	private continueHasItems = false
	/** 继续阅读条目里的标题节点：书籍信息解析完成后同步更新 */
	private continueTitleEls = new Map<string, HTMLElement>()
	private searchInput!: HTMLInputElement
	private sortSelect!: HTMLSelectElement
	private cardEls = new Map<string, HTMLElement>()
	private searchTimer: number | null = null
	private refreshTimer: number | null = null
	/** 目录扫描缓存：手动刷新 / 文件夹变更 / 库内增删改名时递增 */
	private scanToken = 0
	private scanCache: { key: string; token: number; paths: string[] } | null = null
	private tooltipEl: HTMLElement | null = null
	private tooltipTimer: number | null = null
	private cardSeq = 0
	/** 封面后台读完的订阅开关 */
	private coverOff: (() => void) | null = null
	/** 等封面加载的卡片容器：封面文件名 → 占位元素（首次渲染时封面还没读进缓存） */
	private coverWaiters = new Map<string, Set<HTMLElement>>()
	/** 当前筛选后的完整路径列表（虚拟化窗口从里面切片） */
	private allPaths: string[] = []
	/** 书架右上角的复习按钮：到期数会随复习进度变化，需要单独刷新 */
	private reviewBtn: HTMLButtonElement | null = null
	private filteredPaths: string[] = []
	private statsMap = new Map<string, ShelfBookInfo>()
	private dupesMap = new Map<string, string[]>()
	/** 当前渲染的窗口 [start, end)（按 filteredPaths 下标） */
	private windowStart = -1
	private windowEnd = -1
	private rowHeight = 0
	private topSpacer: HTMLElement | null = null
	private bottomSpacer: HTMLElement | null = null
	private topRows = 0
	private bottomRows = 0
	private windowRaf = 0
	private resizeObserver: ResizeObserver | null = null
	/** 观察窗口里第一张卡：封面/字体加载后卡片高度变了，行高要跟着修正 */
	private cardObserver: ResizeObserver | null = null
	private lastWidth = 0
	private lastSearch = ''

	constructor(leaf: WorkspaceLeaf, private plugin: GroveReaderPlugin) {
		super(leaf)
		this.navigation = false
	}

	getViewType(): string {
		return VIEW_TYPE_GROVE_BOOKSHELF
	}

	getDisplayText(): string {
		return t('书架')
	}

	getIcon(): string {
		return this.plugin.currentLogoIcon()
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl
		root.empty()
		root.addClass('grove-shelf-content')
		this.registerDomEvent(root, 'scroll', () => {
			this.#hideTooltip()
			this.#scheduleWindow()
		}, true)
		this.registerDomEvent(window, 'resize', () => this.#hideTooltip())

		this.listsRowEl = root.createDiv('grove-shelf-list-row')
		this.listsEl = this.listsRowEl.createDiv('grove-shelf-lists')
		this.#renderTools(root)
		this.continueEl = root.createDiv('grove-shelf-continue grove-hidden')
		this.gridEl = root.createDiv('grove-shelf-grid')
		this.emptyEl = this.gridEl.createDiv('grove-shelf-empty grove-hidden')
		// 只观察宽度：窗口内容变高变矮不该触发重排
		this.resizeObserver = new ResizeObserver(entries => {
			const width = entries[0]?.contentRect.width ?? 0
			if (!width || Math.abs(width - this.lastWidth) < 1) return
			this.lastWidth = width
			this.#reflow()
		})
		this.resizeObserver.observe(root)

		this.#registerVaultEvents()
		this.coverOff = this.plugin.shelfCache.onCoverLoaded((filename, url) => this.#onCoverLoaded(filename, url))
		await this.refresh()
	}

	/** 库内新增/删除/改名书籍时自动重扫，不必手动点刷新 */
	#registerVaultEvents(): void {
		const onChange = (file: TAbstractFile): void => {
			if (!(file instanceof TFile)) return
			if (!isShelfExt(file.extension)) return
			this.#scheduleRescan()
		}
		this.registerEvent(this.app.vault.on('create', onChange))
		this.registerEvent(this.app.vault.on('delete', onChange))
		this.registerEvent(this.app.vault.on('rename', onChange))
	}

	#scheduleRescan(): void {
		if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer)
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null
			void this.refresh({ rescan: true })
		}, 500)
	}

	#renderTools(root: HTMLElement): void {
		this.toolsEl = root.createDiv('grove-shelf-tools')
		const searchWrap = this.toolsEl.createDiv('grove-shelf-search')
		const searchIcon = searchWrap.createSpan('grove-shelf-search-icon')
		setIcon(searchIcon, 'search')
		this.searchInput = searchWrap.createEl('input', { type: 'search', placeholder: t('搜索书名 / 作者 / 出版社…') })
		this.searchInput.value = this.plugin.shelfSearch
		this.searchInput.addEventListener('input', () => {
			this.plugin.shelfSearch = this.searchInput.value.trim().toLowerCase()
			// 搜索只重算筛选列表与虚拟化窗口，不重扫目录
			if (this.searchTimer != null) window.clearTimeout(this.searchTimer)
			this.searchTimer = window.setTimeout(() => {
				this.searchTimer = null
				this.#applySearch()
			}, 120)
		})
		// 排序单独包一层并带「排序」字样：否则它和搜索框长得一样，容易被当成第二个搜索框
		const sortWrap = this.toolsEl.createDiv('grove-shelf-sort')
		sortWrap.createSpan('grove-shelf-sort-label').setText(t('排序'))
		this.sortSelect = sortWrap.createEl('select', { cls: 'dropdown' })
		for (const [key, label] of SORT_OPTIONS) this.sortSelect.createEl('option', { value: key, text: t(label) })
		this.sortSelect.value = this.plugin.settings.shelfSort
		this.sortSelect.addEventListener('change', () => {
			this.plugin.settings.shelfSort = this.sortSelect.value
			void this.plugin.saveSettings()
			void this.refresh()
		})

		// 手动阅读状态筛选：只筛已标记的书，没标记的归到「全部」
		const statusWrap = this.toolsEl.createDiv('grove-shelf-status-filter')
		statusWrap.createSpan('grove-shelf-sort-label').setText(t('状态'))
		const statusSelect = statusWrap.createEl('select', { cls: 'dropdown' })
		statusSelect.createEl('option', { value: 'all', text: t('全部') })
		for (const key of READING_STATUS_ORDER) {
			statusSelect.createEl('option', { value: key, text: t(READING_STATUS_LABELS[key]) })
		}
		statusSelect.value = this.statusFilter
		statusSelect.addEventListener('change', () => {
			this.statusFilter = statusSelect.value as ReadingStatus | 'all'
			this.#applySearch()
		})

		// 书架右上角三个动作：添加文件夹 / 重新扫描 / 阅读统计
		const actions = this.listsRowEl.createDiv('grove-shelf-tools-actions')
		const action = (icon: string, label: string, onClick: () => void): HTMLButtonElement => {
			const btn = actions.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': label, title: label } })
			setIcon(btn, icon)
			btn.addEventListener('click', onClick)
			return btn
		}
		action('folder-plus', t('添加扫描文件夹'), () => void this.#addFolder())
		action('upload', t('导入书籍…'), () => this.#importBooks())
		action('refresh-cw', t('重新扫描'), () => void this.refresh({ rescan: true }))
		action('bar-chart-2', t('阅读统计'), () => new ReadingStatsModal(this.app, this.plugin).open())
		this.reviewBtn = action('repeat', t('今日复习'), () => this.plugin.openReview())
		this.updateReviewEntry()
	}

	/** 刷新复习按钮的待复习数（徽标 + 标题）：复习结束 / 清空排期 / 书架刷新后调用 */
	updateReviewEntry(): void {
		const btn = this.reviewBtn
		if (!btn) return
		const pending = this.plugin.reviewPendingCount()
		const label = pending ? `今日复习（${pending} 条可复习）` : t('今日复习')
		btn.setAttribute('aria-label', label)
		btn.setAttribute('title', label)
		btn.querySelector('.grove-review-badge')?.remove()
		if (pending > 0) btn.createSpan({ cls: 'grove-review-badge', text: pending > 99 ? '99+' : String(pending) })
	}

	async onClose(): Promise<void> {
		if (this.searchTimer != null) window.clearTimeout(this.searchTimer)
		if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer)
		this.searchTimer = null
		this.refreshTimer = null
		this.coverOff?.()
		this.coverOff = null
		this.resizeObserver?.disconnect()
		this.resizeObserver = null
		this.cardObserver?.disconnect()
		this.cardObserver = null
		if (this.windowRaf) cancelAnimationFrame(this.windowRaf)
		this.windowRaf = 0
		this.coverWaiters.clear()
		this.#hideTooltip()
		this.plugin.shelfCache.saveNow()
		this.plugin.lists.saveNow()
	}

	async refresh(opts: { rescan?: boolean } = {}): Promise<void> {
		const { plugin } = this
		if (!this.gridEl) return
		this.updateReviewEntry()
		await plugin.shelfCache.ensureCoversLoaded()
		this.#hideTooltip()
		if (opts.rescan) this.scanToken++
		this.cardEls.clear()
		this.coverWaiters.clear()
		this.allPaths = []
		this.filteredPaths = []
		this.windowStart = -1
		this.windowEnd = -1
		this.rowHeight = 0
		this.gridEl.empty()
		this.emptyEl = this.gridEl.createDiv('grove-shelf-empty grove-hidden')
		this.continueEl.empty()
		this.continueHasItems = false
		this.continueTitleEls.clear()

		const folders = plugin.settings.scanFolders

		if (!folders.length) {
			this.#showEmpty(t('还没有扫描文件夹。选择一个放书的文件夹（库内或本机任意路径），书架会递归扫描其中的电子书与 PDF。'))
			const addBtn = this.emptyEl.createEl('button', { text: t('添加文件夹'), cls: 'mod-cta' })
			addBtn.addEventListener('click', () => void this.#addFolder())
			plugin.markShelfInteractive(0)
			return
		}

		const allPaths = this.#scan(folders)
		this.#migrateStaleEntries(allPaths)
		// 从书架移除但保留文件的书籍：仍在磁盘上，只是不显示
		const hidden = new Set(plugin.settings.hiddenBooks ?? [])
		const present = new Set(allPaths)
		const stillHidden = [...hidden].filter(p => present.has(p))
		if (stillHidden.length !== hidden.size) {
			plugin.settings.hiddenBooks = stillHidden
			void plugin.saveSettings()
		}
		const visiblePaths = allPaths.filter(p => !hidden.has(p))
		this.#renderListBar(visiblePaths)
		if (this.listFilter !== 'all' && this.listFilter !== 'none'
			&& !plugin.lists.lists().some(l => l.id === this.listFilter)) {
			this.listFilter = 'all'
		}
		const stats = plugin.collectBookStats()
		const dupes = this.#duplicateGroups(visiblePaths)
		const inList = this.#filterByList(visiblePaths)
		this.continueEl.addClass('grove-hidden')
		this.#renderContinue(stats, visiblePaths)

		if (!inList.length) {
			const hiddenCount = plugin.settings.hiddenBooks?.length ?? 0
			if (!visiblePaths.length && hiddenCount) {
				this.#showEmpty(`扫描到的 ${hiddenCount} 本书都被移出书架了，原文件仍在库中。`)
				const restore = this.emptyEl.createEl('button', { text: t('全部恢复'), cls: 'mod-cta' })
				restore.addEventListener('click', () => void plugin.restoreHiddenBooks())
				plugin.markShelfInteractive(0)
				return
			}
			this.#showEmpty(visiblePaths.length && this.listFilter !== 'all'
				? t('这个书单里还没有书。在书籍卡片上右键 →「移入书单…」，或直接把书拖到书单标签上。')
				: t('扫描文件夹里没有找到书籍文件（支持 epub / mobi / azw3 / fb2 / cbz / txt，PDF 会一并收纳）。'))
			plugin.markShelfInteractive(0)
			return
		}

		const pathsForCards = this.#sortPaths(inList, stats)
		this.allPaths = pathsForCards
		this.statsMap = stats
		this.dupesMap = dupes
		this.#applySearch()
		// 首屏卡片已建好：记一次「启动 → 书架可交互」（本次会话只记第一次）
		plugin.markShelfInteractive(visiblePaths.length)
	}

	/** 手机上一屏放不了几张，虚拟化窗口的上下缓冲按行算，不按本算 */
	#scheduleWindow(): void {
		if (this.windowRaf) return
		this.windowRaf = window.requestAnimationFrame(() => {
			this.windowRaf = 0
			this.#renderWindow()
		})
	}

	/** 宽度变化：列数/行高都会变，清掉缓存后整窗重排 */
	#reflow(): void {
		this.rowHeight = 0
		this.windowStart = -1
		this.windowEnd = -1
		this.#renderWindow(true)
	}

	#columnCount(): number {
		const template = getComputedStyle(this.gridEl).gridTemplateColumns
		if (!template || template === 'none') return 1
		return Math.max(1, template.trim().split(/\s+/).length)
	}

	/** 行高 = 卡片高 + 16px 间隙；先估一个，渲染后用真实卡片高度修正 */
	#rowHeightFor(cols: number): number {
		if (this.rowHeight > 0) return this.rowHeight
		this.rowHeight = estimateRowHeight(this.gridEl.clientWidth, cols)
		return this.rowHeight
	}

	#createSpacer(top: boolean): void {
		const rows = top ? this.topRows : this.bottomRows
		const spacer = this.gridEl.createDiv('grove-shelf-spacer')
		spacer.style.gridColumn = '1 / -1'
		spacer.style.height = `${spacerHeight(rows, this.rowHeight)}px`
		if (top) this.topSpacer = spacer
		else this.bottomSpacer = spacer
	}

	#remeasureRow(): void {
		const cards = Array.from(this.gridEl.querySelectorAll('.grove-shelf-card')) as HTMLElement[]
		if (!cards.length) return
		const first = cards[0].getBoundingClientRect()
		// 用相邻两行的 top 差算真实行距，避免只测一张卡时漏掉行高差异
		const cols = this.#columnCount()
		const next = cards.length > cols
			? Math.abs(cards[cols].getBoundingClientRect().top - first.top)
			: first.height + 16
		if (!next || Math.abs(next - this.rowHeight) <= 1) return
		this.rowHeight = next
		if (this.topSpacer) this.topSpacer.style.height = `${spacerHeight(this.topRows, next)}px`
		if (this.bottomSpacer) this.bottomSpacer.style.height = `${spacerHeight(this.bottomRows, next)}px`
	}

	#observeFirstCard(): void {
		this.cardObserver?.disconnect()
		const first = this.gridEl.querySelector('.grove-shelf-card') as HTMLElement | null
		if (!first) return
		this.cardObserver = new ResizeObserver(() => this.#remeasureRow())
		this.cardObserver.observe(first)
	}

	/** 只渲染当前视口上下各 3 行的卡片，其余用上下 spacer 撑出滚动高度 */
	#renderWindow(force = false): void {
		if (!this.gridEl) return
		const paths = this.filteredPaths
		if (!paths.length) {
			this.#resetGrid()
			this.windowStart = -1
			this.windowEnd = -1
			return
		}
		const cols = this.#columnCount()
		const rowHeight = this.#rowHeightFor(cols)
		const contentRect = this.contentEl.getBoundingClientRect()
		const gridRect = this.gridEl.getBoundingClientRect()
		const gridTop = gridRect.top - contentRect.top + this.contentEl.scrollTop
		const win = computeShelfWindow({
			scrollTop: this.contentEl.scrollTop,
			clientHeight: this.contentEl.clientHeight,
			gridTop,
			columns: cols,
			rowHeight,
			itemCount: paths.length,
		})
		const { start, end } = win
		if (!force && start === this.windowStart && end === this.windowEnd) return

		this.#resetGrid()
		this.windowStart = start
		this.windowEnd = end
		this.topRows = win.topRows
		this.bottomRows = win.bottomRows
		if (this.topRows > 0) this.#createSpacer(true)
		const tasks: Array<() => Promise<void>> = []
		for (let i = start; i < end; i++) {
			const path = paths[i]
			const card = this.#renderCard(path, this.statsMap.get(path), this.dupesMap.get(path))
			tasks.push(() => this.#ensureEntry(path, card))
		}
		if (this.bottomRows > 0) this.#createSpacer(false)
		void this.#runQueue(tasks, 2)
		this.#observeFirstCard()
		window.requestAnimationFrame(() => this.#remeasureRow())
	}

	#resetGrid(): void {
		this.gridEl.empty()
		this.emptyEl = this.gridEl.createDiv('grove-shelf-empty grove-hidden')
		this.cardEls.clear()
		this.coverWaiters.clear()
		this.topSpacer = null
		this.bottomSpacer = null
	}

	/** 扫描结果按「文件夹列表 + token」缓存：搜索/排序刷新不再走磁盘 */
	#scan(folders: string[]): string[] {
		const key = folders.join('\u0000')
		if (!this.scanCache || this.scanCache.key !== key || this.scanCache.token !== this.scanToken) {
			this.scanCache = { key, token: this.scanToken, paths: scanBookFolders(folders, this.app.vault.getFiles().map(f => f.path)) }
		}
		return this.scanCache.paths
	}

	#showEmpty(message: string): void {
		this.emptyEl.empty()
		const wordmark = this.plugin.logoWordmark()
		if (wordmark) {
			const logo = this.emptyEl.createDiv('grove-empty-logo')
			appendInlineSvg(logo, wordmark)
		}
		this.emptyEl.createSpan('grove-empty-text').setText(message)
		this.emptyEl.removeClass('grove-hidden')
	}

	#matches(path: string, q: string): boolean {
		if (!q) return true
		const entry = this.plugin.shelfCache.get(path)
		const hit = (s?: string): boolean => !!s && s.toLowerCase().includes(q)
		return hit(entry?.title) || hit(entry?.author) || hit(entry?.publisher)
			|| hit(entry?.category) || hit(entry?.intro) || hit(basenameOf(path))
	}

	/**
	 * 搜索：重算筛选后的完整路径列表，再让虚拟化窗口按当前滚动位置重画。
	 * 不再逐个切换几百张卡片的 display。
	 */
	#applySearch(): void {
		if (!this.emptyEl || !this.allPaths.length) return
		const q = this.plugin.shelfSearch
		// 搜索词变了就回到顶部：结果变少时旧滚动位置会落到窗口之外
		if (q !== this.lastSearch) {
			this.lastSearch = q
			this.contentEl.scrollTop = 0
		}
		const byStatus = this.statusFilter === 'all'
			? this.allPaths
			: this.allPaths.filter(path => this.statsMap.get(path)?.readingStatus === this.statusFilter)
		this.filteredPaths = q ? byStatus.filter(path => this.#matches(path, q)) : byStatus.slice()
		this.#renderWindow(true)
		if (this.filteredPaths.length === 0 && this.allPaths.length > 0) {
			this.#showEmpty(this.statusFilter === 'all'
				? t('没有匹配的书。试试只输书名或作者里的关键词。')
				: t('没有标记为「{s}」的书。右键书籍卡片可以设置阅读状态。', { s: t(READING_STATUS_LABELS[this.statusFilter]) }))
		} else {
			this.emptyEl.addClass('grove-hidden')
		}
		this.continueEl.toggleClass('grove-hidden', !!q || !this.continueHasItems)
	}

	// ------------------------------------------------------------------
	// 继续阅读
	// ------------------------------------------------------------------

	#renderContinue(stats: Map<string, ShelfBookInfo>, allPaths: string[]): void {
		const display = this.plugin.settings.shelfDisplay
		if (!display.showContinueReading) return
		const present = new Set(allPaths)
		const items = [...stats.entries()]
			.filter(([p, i]) => present.has(p)
				&& (i.lastRead ?? 0) > 0
				&& (i.fraction ?? 0) > 0.0005
				&& (i.fraction ?? 0) < 0.995)
			.sort((a, b) => (b[1].lastRead ?? 0) - (a[1].lastRead ?? 0))
			.slice(0, 6)
		if (!items.length) return

		this.continueHasItems = true
		this.continueEl.removeClass('grove-hidden')
		this.continueEl.createDiv('grove-continue-head').setText(t('继续阅读'))
		const row = this.continueEl.createDiv('grove-continue-row')
		for (const [path, info] of items) {
			const item = row.createEl('button', { cls: 'grove-continue-item', attr: { type: 'button' } })
			item.title = cleanBookTitle(basenameOf(path))
			const cover = item.createDiv('grove-continue-cover')
			const url = this.plugin.shelfCache.coverDataUrl(this.plugin.shelfCache.get(path)?.cover)
			if (url) {
				const img = cover.createEl('img', { attr: { src: url, alt: '' } })
				img.draggable = false
			}
			const body = item.createDiv('grove-continue-body')
			const titleEl = body.createDiv('grove-continue-title')
			titleEl.setText(truncate(this.#displayTitle(path), 28))
			this.continueTitleEls.set(path, titleEl)
			const pct = Math.round((info.fraction ?? 0) * 100)
			const meta = [info.lastRead ? relativeTime(info.lastRead) : '', info.annotations ? `${info.annotations} 条批注` : '']
				.filter(Boolean).join(' · ')
			body.createDiv('grove-continue-meta').setText(meta || `${pct}%`)
			const bar = body.createDiv('grove-continue-bar')
			bar.createDiv('grove-continue-fill').style.width = `${pct}%`
			body.createDiv('grove-continue-pct').setText(`读至 ${pct}%`)
			item.addEventListener('click', () => void this.plugin.openBookByPath(path))
		}
	}

	// ------------------------------------------------------------------
	// 书单筛选条
	// ------------------------------------------------------------------

	#renderListBar(allPaths: string[]): void {
		const lists = this.plugin.lists
		this.listsEl.empty()
		const mkChip = (label: string, key: string, count: number, list?: BookList): void => {
			const chip = this.listsEl.createSpan('grove-shelf-list-chip')
			chip.setText(`${label} ${count}`)
			if (this.listFilter === key) chip.addClass('is-active')
			chip.addEventListener('click', () => {
				this.listFilter = key
				void this.refresh()
			})
			if (key !== 'all') {
				chip.addEventListener('dragover', e => {
					e.preventDefault()
					chip.addClass('is-drop-target')
				})
				chip.addEventListener('dragleave', () => chip.removeClass('is-drop-target'))
				chip.addEventListener('drop', e => {
					e.preventDefault()
					chip.removeClass('is-drop-target')
					const p = e.dataTransfer?.getData('text/plain')
					if (!p) return
					lists.setMember(p, key === 'none' ? null : key)
					void this.refresh()
				})
			}
			if (list) {
				chip.addEventListener('contextmenu', e => {
					e.preventDefault()
					const menu = new Menu()
					menu.addItem(item => item.setTitle(t('重命名书单')).setIcon('pencil').onClick(() => {
						new TextPromptModal(this.app, t('重命名书单'), t('书单名称'), list.name, name => {
							lists.rename(list.id, name)
							void this.refresh()
						}).open()
					}))
					menu.addItem(item => item.setTitle(t('删除书单')).setIcon('trash-2').onClick(() => {
						new ConfirmModal(this.app, `删除书单「${list.name}」？不会删除书籍文件，书会回到「未分类」。`, () => {
							if (this.listFilter === list.id) this.listFilter = 'all'
							lists.remove(list.id)
							void this.refresh()
						}).open()
					}))
					menu.showAtPosition({ x: e.clientX, y: e.clientY })
				})
			}
		}
		mkChip(t('全部'), 'all', allPaths.length)
		mkChip(t('未分类'), 'none', allPaths.filter(p => !lists.listIdOf(p)).length)
		for (const l of lists.lists()) {
			mkChip(l.name, l.id, allPaths.filter(p => lists.listIdOf(p) === l.id).length, l)
		}
		const newBtn = this.listsEl.createSpan('grove-shelf-list-chip grove-shelf-list-new')
		newBtn.setText(t('＋ 新建书单'))
		newBtn.addEventListener('click', () => {
			new TextPromptModal(this.app, t('新建书单'), t('书单名称'), '', name => {
				const created = lists.create(name)
				this.listFilter = created.id
				void this.refresh()
			}).open()
		})
	}

	#filterByList(paths: string[]): string[] {
		if (this.listFilter === 'all') return paths
		const lists = this.plugin.lists
		if (this.listFilter === 'none') return paths.filter(p => !lists.listIdOf(p))
		return paths.filter(p => lists.listIdOf(p) === this.listFilter)
	}

	#displayTitle(path: string): string {
		const entry = this.plugin.shelfCache.get(path)
		return entry?.title || stripTitleAuthor(cleanBookTitle(basenameOf(path)), entry?.author ?? '')
	}

	#sortPaths(paths: string[], stats: Map<string, ShelfBookInfo>): string[] {
		const sortKey = this.plugin.settings.shelfSort
		if (sortKey === 'default') return paths
		const arr = [...paths]
		if (sortKey === 'added') {
			const added = (p: string): number => {
				const e = this.plugin.shelfCache.get(p)
				return e?.addedAt ?? e?.mtime ?? 0
			}
			return arr.sort((a, b) => added(b) - added(a))
		}
		if (sortKey === 'title') {
			return arr.sort((a, b) => this.#displayTitle(a).localeCompare(this.#displayTitle(b), 'zh'))
		}
		return arr.sort((a, b) => (stats.get(b)?.fraction ?? 0) - (stats.get(a)?.fraction ?? 0))
	}

	/** 按归一化文件名分组，返回 路径 → 同组其他路径 的映射 */
	#duplicateGroups(paths: string[]): Map<string, string[]> {
		const byKey = new Map<string, string[]>()
		for (const p of paths) {
			const key = duplicateKeyOf(basenameOf(p))
			if (!key) continue
			const arr = byKey.get(key)
			if (arr) arr.push(p)
			else byKey.set(key, [p])
		}
		const result = new Map<string, string[]>()
		for (const arr of byKey.values()) {
			if (arr.length < 2) continue
			for (const p of arr) result.set(p, arr.filter(x => x !== p))
		}
		return result
	}

	/** 书被移动/改名后，把书单归属与个性化缓存迁移到新路径（仅唯一匹配时迁移） */
	#migrateStaleEntries(allPaths: string[]): void {
		const cache = this.plugin.shelfCache
		const lists = this.plugin.lists
		const present = new Set(allPaths)
		for (const [oldPath, entry] of cache.entries()) {
			if (present.has(oldPath)) continue
			const lid = lists.listIdOf(oldPath)
			const hasBookData = this.plugin.store.hasDataFor(oldPath)
			if (!lid && !entry.customCover && !entry.manualMeta && !hasBookData) continue
			const free = allPaths.filter(p => !cache.get(p))
			let candidates = free.filter(p => basenameOf(p) === basenameOf(oldPath))
			if (!candidates.length && entry.size != null) {
				candidates = free.filter(p => {
					const f = this.app.vault.getAbstractFileByPath(p)
					return f instanceof TFile && entry.size !== undefined && f.stat.size === entry.size
				})
			}
			if (candidates.length !== 1) continue
			const newPath = candidates[0]
			cache.set(newPath, entry)
			cache.remove(oldPath)
			if (lid) {
				lists.setMember(newPath, lid)
				lists.setMember(oldPath, null)
			}
			if (hasBookData) this.plugin.store.migrateData(oldPath, newPath)
			// AI 要点索引按书 id 存，改名/移动也要跟着迁
			this.plugin.migratePortrait(oldPath, newPath)
		}
		// 文件已彻底消失且条目无个性化数据（自定义封面/手改信息）：清掉，
		// 避免书架缓存无限膨胀；有个性化数据的保留，防移动硬盘临时掉线时误删
		for (const [oldPath, entry] of cache.entries()) {
			if (present.has(oldPath)) continue
			if (entry.customCover || entry.manualMeta) continue
			let gone = false
			try {
				gone = !this.app.vault.getAbstractFileByPath(oldPath)
			} catch {
				continue
			}
			if (gone) cache.remove(oldPath)
		}
	}

	#editInfo(path: string): void {
		const cache = this.plugin.shelfCache
		const entry = cache.get(path) ?? {}
		const data = this.plugin.store.load(path)
		const current: BookInfoValues = {
			title: entry.title ?? cleanBookTitle(basenameOf(path)),
			author: entry.author ?? data.author ?? '',
			publisher: entry.publisher ?? '',
			category: entry.category ?? data.category ?? '',
			intro: entry.intro ?? data.intro ?? '',
			rating: data.rating ?? 0,
			isbn: data.isbn ?? '',
			aiMeta: data.aiMeta,
		}
		new BookInfoModal(this.app, current, values => {
			cache.set(path, {
				...entry,
				title: values.title || undefined,
				author: values.author || undefined,
				publisher: values.publisher,
				category: values.category || undefined,
				intro: values.intro || undefined,
				manualMeta: true,
			})
			// 手动改过的字段不再算 AI 补全
			const next = this.plugin.store.load(path)
			const aiMeta = { ...(next.aiMeta ?? {}) }
			if (values.author !== (next.author ?? '')) delete aiMeta.author
			if (values.category !== (next.category ?? '')) delete aiMeta.category
			if (values.intro !== (next.intro ?? '')) delete aiMeta.intro
			next.category = values.category || undefined
			next.intro = values.intro || undefined
			next.rating = values.rating > 0 ? values.rating : undefined
			next.isbn = values.isbn || undefined
			if (values.author) next.author = values.author
			if (Object.keys(aiMeta).length) next.aiMeta = aiMeta
			else delete next.aiMeta
			this.plugin.store.save(next)
			// 同步进批注数据：笔记标题/阅读界面标题取的是 data.title
			this.plugin.syncBookMeta(
				path,
				values.title || basenameOf(path).replace(/\.[^.]+$/, ''),
				values.author,
			)
			void this.refresh()
		}).open()
	}

	/** AI 补全作者 / 分类 / 简介：只填空字段，预览确认后写回 */
	#aiMeta(path: string): void {
		new BookMetaModal(this.app, this.plugin, path, () => void this.refresh()).open()
	}

	#pickList(path: string): void {
		const lists = this.plugin.lists
		new ListPickerModal(this.app, lists.lists(), picked => {
			if (picked === 'new') {
				new TextPromptModal(this.app, t('新建书单'), t('书单名称'), '', name => {
					const created = lists.create(name)
					lists.setMember(path, created.id)
					void this.refresh()
				}).open()
				return
			}
			lists.setMember(path, picked ? picked.id : null)
			void this.refresh()
		}).open()
	}

	/** 手动标记阅读状态（null = 清除，回到按进度自动判断） */
	#setReadingStatus(path: string, status: ReadingStatus | null): void {
		const data = this.plugin.store.load(path)
		if (status) data.readingStatus = status
		else delete data.readingStatus
		this.plugin.store.save(data)
		// 已生成的笔记里 grove_status 跟着变
		this.plugin.refreshNoteForBook(path)
		new Notice(status
			? t('Grove Reader：已标记为「{s}」', { s: t(READING_STATUS_LABELS[status]) })
			: t('Grove Reader：已清除手动阅读状态'))
		void this.refresh()
	}

	async #changeCoverByUrl(path: string, card: HTMLElement): Promise<void> {
		new CoverUrlModal(this.app, async url => {
			const { buffer, mime } = await downloadImageFromUrl(url)
			const name = await this.plugin.shelfCache.saveCustomCoverFromBuffer(
				this.plugin.store.bookId(path),
				buffer,
				mime,
			)
			if (!name) throw new Error(t('封面保存失败，请检查磁盘权限'))
			const prev = this.plugin.shelfCache.get(path) ?? {}
			this.plugin.shelfCache.set(path, { ...prev, cover: name, customCover: true, failed: false })
			this.#updateCard(card, { ...prev, coverName: name })
			new Notice(t('封面已更新'))
		}).open()
	}

	async #changeCover(path: string, card: HTMLElement): Promise<void> {
		const input = createEl('input', { type: 'file', attr: { accept: 'image/*' } })
		input.addEventListener('change', () => {
			const file = input.files?.[0]
			if (!file) return
			if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|gif)$/i.test(file.name)) {
				new Notice(t('请选择图片文件（jpg / png / webp / gif）'))
				return
			}
			if (file.size > 12 * 1024 * 1024) {
				new Notice(t('图片超过 12 MB，请换一张小一些的'))
				return
			}
			void (async () => {
				const name = await this.plugin.shelfCache.saveCustomCover(this.plugin.store.bookId(path), file)
				if (!name) {
					new Notice(t('更换封面失败'))
					return
				}
				const prev = this.plugin.shelfCache.get(path) ?? {}
				this.plugin.shelfCache.set(path, { ...prev, cover: name, customCover: true, failed: false })
				this.#updateCard(card, { ...prev, coverName: name })
				new Notice(t('封面已更新'))
			})()
		})
		input.click()
	}

	/** 删除书籍：可选择是否连原文件、生成的阅读笔记一起删除 */
	async #deleteBook(path: string): Promise<void> {
		const title = this.#displayTitle(path)
		const data = this.plugin.store.load(path)
		const count = data.annotations?.length ?? 0
		const notePath = data.notePath && this.app.vault.getAbstractFileByPath(data.notePath) ? data.notePath : undefined
		const noteName = notePath ? basenameOf(notePath) : undefined
		new DeleteBookModal(this.app, title, count, noteName, async (deleteFile, deleteNote) => {
			const closed = this.plugin.closeBookViews(path)
			// 关闭阅读视图时可能触发一次 onClose 写盘，等它落完再移动数据
			if (closed) await new Promise(resolve => window.setTimeout(resolve, 300))
			this.plugin.debug('delete', 'book', { path, deleteFile, deleteNote })
			if (deleteFile) {
				const trashed = await this.plugin.moveToTrash(path, title, deleteNote ? notePath : undefined)
				if (!trashed) {
					// 手机端没有插件回收站：按 Obsidian 的删除设置直接删原文件（与笔记）
					const bookFile = this.app.vault.getAbstractFileByPath(path)
					if (bookFile instanceof TFile) await this.app.fileManager.trashFile(bookFile)
					if (deleteNote && notePath) {
						const noteFile = this.app.vault.getAbstractFileByPath(notePath)
						if (noteFile instanceof TFile) await this.app.fileManager.trashFile(noteFile)
					}
				}
				// 批注 JSON 已移入回收站，这里只清自动备份与索引
				this.plugin.store.delete(path)
				this.plugin.stats.remove(path)
				this.plugin.lists.setMember(path, null)
				this.plugin.shelfCache.remove(path)
				const hidden = this.plugin.settings.hiddenBooks ?? []
				this.plugin.settings.hiddenBooks = hidden.filter(p => p !== path)
				await this.plugin.saveSettings()
				this.plugin.oplog.add(t('删除书籍'), `《${title}》；${trashed ? t('移入回收站') : t('已删除原文件')}；阅读笔记${deleteNote ? (trashed ? t('一并移入') : t('一并删除')) : t('保留')}`)
				new Notice(trashed ? t('已移入回收站，可在 设置 → 回收站 恢复') : t('已删除书籍文件'))
			} else {
				const hidden = this.plugin.settings.hiddenBooks ?? []
				if (!hidden.includes(path)) hidden.push(path)
				this.plugin.settings.hiddenBooks = hidden
				if (deleteNote && notePath) {
					// 级联下不会出现；兜底时按 Obsidian 的删除设置处理笔记
					const noteFile = this.app.vault.getAbstractFileByPath(notePath)
					if (noteFile instanceof TFile) await this.app.fileManager.trashFile(noteFile)
					const fresh = this.plugin.store.load(path)
					fresh.notePath = undefined
					this.plugin.store.save(fresh)
				}
				await this.plugin.saveSettings()
				this.plugin.oplog.add(t('删除书籍'), `《${title}》；仅移出书架；阅读笔记${deleteNote ? t('已删除') : t('保留')}`)
				new Notice(t('已从书架移除，原文件与批注数据都保留'))
			}
			await this.refresh({ rescan: true })
		}).open()
	}

	#renderCard(path: string, info?: ShelfBookInfo, dupes?: string[]): HTMLElement {
		const { plugin } = this
		const display = plugin.settings.shelfDisplay
		const entry = plugin.shelfCache.get(path)
		const card = this.gridEl.createDiv('grove-shelf-card')
		this.cardEls.set(path, card)

		const fallbackTitle = stripTitleAuthor(cleanBookTitle(basenameOf(path)), entry?.author ?? '')
		const title = entry?.title || fallbackTitle
		const author = entry?.author ?? ''
		const publisher = entry?.publisher ?? ''
		card.dataset.title = title
		card.dataset.author = author
		card.dataset.publisher = publisher
		card.dataset.path = path
		// 键盘可达：卡片本身是按钮语义
		card.tabIndex = 0
		card.setAttr('role', 'button')
		if (display.showListColor) {
			const lid = plugin.lists.listIdOf(path)
			if (lid) {
				card.addClass('has-list')
				card.style.setProperty('--grove-list-hue', String(listHue(lid)))
			}
		}

		const size = this.#fileSize(path)
		const coverWrap = card.createDiv('grove-shelf-cover')
		const media = coverWrap.createDiv('grove-shelf-cover-media')
		const coverUrl = plugin.shelfCache.coverDataUrl(entry?.cover)
		this.#fillCover(media, coverUrl, title)
		// 缓存未命中：先显示占位，后台读完封面后按文件名补画这张卡
		if (!coverUrl && entry?.cover) this.#waitForCover(entry.cover, media)

		// 封面底部进度条：扫视时比读百分比快
		const fraction = info?.fraction
		if (display.showProgress && typeof fraction === 'number' && fraction > 0.001) {
			const track = coverWrap.createDiv('grove-cover-progress')
			const pct = Math.min(100, Math.max(1, Math.round(fraction * 100)))
			track.createDiv('grove-cover-progress-fill').style.width = `${pct}%`
			track.title = fraction >= 0.995 ? t('已读完') : `读至 ${pct}%`
		}

		// 悬浮/键盘聚焦：只保留一个自定义提示，整合书名、文件名、大小与阅读信息
		const detailLines = [title]
		if (author) detailLines.push(author)
		if (entry?.category) detailLines.push(`分类：${entry.category}`)
		if (entry?.intro) detailLines.push(truncate(entry.intro, 80))
		detailLines.push(`文件：${basenameOf(path)}`)
		if (size != null) detailLines.push(`大小：${formatBytes(size)}`)
		if (info?.seconds) detailLines.push(`累计阅读：${formatDuration(info.seconds)}`)
		if (info?.lastRead) detailLines.push(`最近阅读：${new Date(info.lastRead).toLocaleString('zh-CN', { hour12: false })}`)
		const detail = detailLines.join('\n')
		card.addEventListener('mouseenter', () => this.#scheduleTooltip(card, detail))
		card.addEventListener('mouseleave', () => this.#hideTooltip())
		card.addEventListener('focus', () => this.#scheduleTooltip(card, detail))
		card.addEventListener('blur', () => this.#hideTooltip())

		const titleEl = card.createDiv('grove-shelf-booktitle')
		titleEl.id = `grove-card-title-${++this.cardSeq}`
		titleEl.setText(truncate(title, 24))
		card.setAttr('aria-labelledby', titleEl.id)
		if (display.mergeAuthorPublisher) {
			card.createDiv('grove-shelf-author').setText([author, publisher].filter(Boolean).join(' · ') || ' ')
		} else {
			card.createDiv('grove-shelf-author').setText(author || ' ')
			card.createDiv('grove-shelf-publisher').setText(publisher || ' ')
		}

		const meta = card.createDiv('grove-shelf-meta')
		const ext = (path.split('.').pop() ?? '').toLowerCase()
		const format = FORMAT_LABELS[ext]
		if (display.showFormatBadge && format) {
			const badge = meta.createSpan(`grove-shelf-badge grove-fmt-${ext}`)
			badge.setText(format)
			badge.title = `${format} · ${ext === 'pdf' ? t('用 Obsidian 查看器打开') : t('在插件内阅读')}`
		}
		if (display.showProgress && typeof fraction === 'number' && fraction > 0.001) {
			const done = fraction >= 0.995
			const progress = meta.createSpan('grove-shelf-progress')
			progress.setText(done ? t('已读') : `${Math.round(fraction * 100)}%`)
			progress.title = done ? t('已读完') : t('读至 {n}%', { n: Math.round(fraction * 100) })
		}
		if (display.showAnnotationCount && info && info.annotations > 0) {
			meta.createSpan('grove-shelf-badge').setText(t('批注 {n}', { n: info.annotations }))
			if ((info.thoughts ?? 0) > 0) {
				const thoughts = meta.createSpan('grove-shelf-badge grove-thought-badge')
				thoughts.setText(t('想法 {n}', { n: info.thoughts ?? 0 }))
				thoughts.title = t('{n} 条批注写了想法', { n: info.thoughts ?? 0 })
			}
		}
		if (display.showLastRead && info?.lastRead) {
			const time = meta.createSpan('grove-shelf-time')
			time.setText(relativeTime(info.lastRead))
			time.title = new Date(info.lastRead).toLocaleString('zh-CN', { hour12: false })
		}
		if (display.showFileSize && size != null) {
			meta.createSpan('grove-shelf-size').setText(formatBytes(size))
		}
		if (display.showNoteBadge && info?.notePath) {
			const note = meta.createSpan('grove-note-badge')
			setIcon(note, 'file-text')
			note.title = t('已生成阅读笔记，点击打开')
			note.setAttr('role', 'button')
			note.tabIndex = 0
			note.addEventListener('click', e => {
				e.stopPropagation()
				void plugin.openBookNote(path)
			})
			note.addEventListener('keydown', e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault()
					e.stopPropagation()
					void plugin.openBookNote(path)
				}
			})
		}
		if (dupes && dupes.length) {
			const badge = meta.createSpan('grove-shelf-badge grove-shelf-dup')
			badge.setText(t('疑似重复'))
			badge.title = `文件名与其他 ${dupes.length} 本书高度相似：\n${dupes.map(d => basenameOf(d)).join('\n')}`
		}
		if (info?.readingStatus) {
			const status = meta.createSpan(`grove-shelf-badge grove-shelf-status grove-status-${info.readingStatus}`)
			status.setText(READING_STATUS_LABELS[info.readingStatus])
			status.title = t('手动标记的阅读状态（右键卡片可修改）')
		}

		// 拖拽到书单标签上即可归类
		card.draggable = true
		card.addEventListener('dragstart', e => {
			if (e.dataTransfer) {
				e.dataTransfer.setData('text/plain', path)
				e.dataTransfer.effectAllowed = 'move'
			}
		})
		card.addEventListener('click', () => void plugin.openBookByPath(path))
		card.addEventListener('keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault()
				void plugin.openBookByPath(path)
			}
		})
		card.addEventListener('contextmenu', e => {
			e.preventDefault()
			const menu = new Menu()
			menu.addItem(item => item.setTitle(t('打开书籍')).setIcon('book-open').onClick(() => void plugin.openBookByPath(path)))
			menu.addItem(item => item.setTitle(t('笔记模板…')).setIcon('file-text').onClick(() => plugin.showTemplatePicker(path)))
			menu.addItem(item => item.setTitle(t('更换封面')).setIcon('image').onClick(() => void this.#changeCover(path, card)))
			menu.addItem(item => item.setTitle(t('用图片链接更换封面…')).setIcon('link').onClick(() => void this.#changeCoverByUrl(path, card)))
			menu.addItem(item => item.setTitle(t('编辑书籍信息')).setIcon('pencil').onClick(() => this.#editInfo(path)))
			menu.addItem(item => {
				const lid = plugin.lists.listIdOf(path)
				const name = plugin.lists.lists().find(l => l.id === lid)?.name
				item.setTitle(name ? `移入书单（当前：${name}）` : t('移入书单…')).setIcon('list').onClick(() => this.#pickList(path))
			})
			// 阅读状态：手动标记后覆盖按进度自动判断的状态
			const currentStatus = plugin.store.load(path).readingStatus
			for (const key of READING_STATUS_ORDER) {
				menu.addItem(item => item
					.setTitle(t('标记为{p0}', { p0: t(READING_STATUS_LABELS[key]) }))
					.setIcon(currentStatus === key ? 'check' : 'circle')
					.onClick(() => this.#setReadingStatus(path, key)))
			}
			if (currentStatus) {
				menu.addItem(item => item
					.setTitle(t('清除阅读状态'))
					.setIcon('x')
					.onClick(() => this.#setReadingStatus(path, null)))
			}
			menu.addItem(item => item.setTitle(t('AI 补全书籍信息…')).setIcon('sparkles').onClick(() => this.#aiMeta(path)))
			menu.addItem(item => item.setTitle(t('重新解析封面与信息')).setIcon('refresh-cw').onClick(() => {
				const entry = this.plugin.shelfCache.get(path)
				const run = (): void => {
					this.plugin.shelfCache.set(path, {})
					void this.#ensureEntry(path, card, true)
				}
				if (entry?.customCover || entry?.manualMeta) {
					new ConfirmModal(this.app, t('重新解析会清除手动更换的封面或手动编辑的书名/作者，继续？'), run).open()
				} else {
					run()
				}
			}))
			// electron 只在桌面端存在：延迟 require，避免手机端加载插件时就 require('electron')
			if (!Platform.isMobile) {
				menu.addItem(item => item.setTitle(t('在文件夹中显示')).setIcon('folder-open').onClick(() => {
					try {
						const { shell } = require('electron') as typeof import('electron')
						shell.showItemInFolder(this.#absPath(path))
					} catch (e) {
						new Notice(t("无法在文件夹中显示：{p0}", { p0: e instanceof Error ? e.message : String(e) }))
					}
				}))
			}
			menu.addItem(item => item.setTitle(t('复制完整文件名')).setIcon('copy').onClick(() => {
				void navigator.clipboard.writeText(basenameOf(path))
				new Notice(t('已复制文件名'))
			}))
			menu.addSeparator()
			menu.addItem(item => item.setTitle(t('清空本书批注…')).setIcon('eraser').onClick(() => this.plugin.clearAnnotationsFor(path)))
			menu.addItem(item => item.setTitle(t('删除书籍…')).setIcon('trash-2').onClick(() => void this.#deleteBook(path)))
			menu.showAtPosition({ x: e.clientX, y: e.clientY })
		})
		return card
	}

	#fillCover(container: HTMLElement, url: string | null, title: string): void {
		container.empty()
		if (url) {
			const img = container.createEl('img', { attr: { src: url, alt: '' } })
			img.draggable = false
		} else {
			container.createDiv('grove-shelf-cover-empty').setText(truncate(title, 24))
		}
	}

	#waitForCover(filename: string, media: HTMLElement): void {
		let set = this.coverWaiters.get(filename)
		if (!set) {
			set = new Set()
			this.coverWaiters.set(filename, set)
		}
		set.add(media)
	}

	/** 封面后台读完：补画当时还是占位的卡片；失败就丢掉等待者 */
	#onCoverLoaded(filename: string, url: string | null): void {
		const waiting = this.coverWaiters.get(filename)
		if (!waiting) return
		this.coverWaiters.delete(filename)
		if (!url) return
		for (const media of waiting) {
			if (!media.isConnected) continue
			const card = media.closest('.grove-shelf-card') as HTMLElement | null
			this.#fillCover(media, url, card?.dataset.title ?? '')
		}
	}

	#fileSize(path: string): number | undefined {
		const f = this.app.vault.getAbstractFileByPath(path)
		return f instanceof TFile ? f.stat.size : undefined
	}

	#scheduleTooltip(card: HTMLElement, text: string): void {
		if (this.tooltipTimer != null) window.clearTimeout(this.tooltipTimer)
		this.tooltipTimer = window.setTimeout(() => {
			this.tooltipTimer = null
			this.#showTooltip(card, text)
		}, 220)
	}

	#showTooltip(card: HTMLElement, text: string): void {
		this.#hideTooltip()
		const el = document.body.createDiv('tooltip grove-card-tooltip')
		el.setText(text)
		el.createDiv('tooltip-arrow')
		const rect = card.getBoundingClientRect()
		const margin = 10
		const width = el.offsetWidth
		const height = el.offsetHeight
		const center = rect.left + rect.width / 2
		const left = Math.min(window.innerWidth - width / 2 - margin, Math.max(width / 2 + margin, center))
		let top = rect.bottom + 8
		let above = false
		if (top + height > window.innerHeight - margin) {
			top = rect.top - height - 8
			above = true
		}
		top = Math.max(margin, top)
		if (above) el.addClass('mod-top')
		el.style.left = `${left}px`
		el.style.top = `${top}px`
		const arrowX = Math.min(width - 14, Math.max(14, center - (left - width / 2)))
		const arrow = el.querySelector('.tooltip-arrow')
		if (arrow instanceof HTMLElement) arrow.style.left = `${arrowX}px`
		this.tooltipEl = el
	}

	#hideTooltip(): void {
		if (this.tooltipTimer != null) {
			window.clearTimeout(this.tooltipTimer)
			this.tooltipTimer = null
		}
		this.tooltipEl?.remove()
		this.tooltipEl = null
	}

	async #ensureEntry(path: string, card: HTMLElement, force = false): Promise<void> {
		const { plugin } = this
		const cache = plugin.shelfCache
		const existing = cache.get(path)
		let mtime: number | undefined
		let size: number | undefined
		const vf = this.app.vault.getAbstractFileByPath(path)
		if (!(vf instanceof TFile)) return
		mtime = vf.stat.mtime
		size = vf.stat.size
		const addedAt = existing?.addedAt ?? Date.now()
		const ext = (path.split('.').pop() ?? '').toLowerCase()
		// 缺 publisher 字段的旧电子书缓存视为不完整：下次刷新重解析补一次
		const needsPublisher = isReaderExt(ext) && ext !== 'pdf' && existing?.publisher === undefined
		// PDF 封面解析升级：手机端从「一律跳过」改成能解析首页，老缓存里的
		// failed 标记要继续有效就得靠版本号区分，否则用户升级后永远看不到封面
		const needsPdfCover = ext === 'pdf' && Platform.isMobile && existing?.coverVersion !== PDF_COVER_VERSION
		if (!force && existing && existing.mtime === mtime && (existing.cover || existing.failed) && !needsPublisher && !needsPdfCover) return

		// PDF：渲染首页为封面 + 读取元数据标题（比文件名干净）
		if (ext === 'pdf') {
			let title = cleanBookTitle(basenameOf(path))
			let author: string | undefined
			let coverName: string | undefined
			// 旧版缓存条目可能没有封面也没有 failed 标记（阶段一只存了文件名），
			// 这种情况也要触发解析补封面
			if (!existing || force || existing.mtime !== mtime || (!existing.cover && !existing.failed) || needsPdfCover) {
				try {
					// 手机端也能解析（worker 走插件级 Blob URL、字节走 PlatformIO），
					// 但要整本读进内存：超过 32MB 直接跳过，卡片退回通用图标，避免 OOM
					const mb = (size ?? 0) / (1024 * 1024)
					if (Platform.isMobile && mb > 32) {
						throw new Error(`mobile: pdf ${Math.round(mb)}MB 超过封面解析上限（32MB）`)
					}
					const bytes = await plugin.readBookBytes(path)
					const { readPdfShelfInfo } = await import('./pdfThumbnail')
					const info = await readPdfShelfInfo(bytes, 300, rel => plugin.pdfjsAssetUrl(rel), () => plugin.resolvePdfWorkerSrc())
					if (info.title) title = cleanBookTitle(stripNumericTitlePrefix(info.title))
					if (info.author) author = info.author
					if (existing?.customCover && existing.cover && !force) {
						coverName = existing.cover
					} else if (info.cover) {
						coverName = (await cache.saveCover(plugin.store.bookId(path), info.cover)) ?? undefined
					}
				} catch (e) {
					console.error(t('[Grove Reader] 生成 PDF 封面失败'), path, e)
				}
				// 解析失败时保留旧封面，避免一次异常把已有封面抹掉
				if (!coverName && !force) coverName = existing?.cover
				// 封面缺失时标记 failed：避免每次刷新都重读整本大文件；
				// 可右键卡片「重新解析封面与信息」手动重试
				// 手动编辑过的信息不被自动解析覆盖（「重新解析」除外）
				if (!force && existing?.manualMeta) {
					title = existing.title ?? title
					author = existing.author ?? author
					cache.set(path, { ...existing, cover: coverName, mtime, size, addedAt, failed: !coverName, coverVersion: PDF_COVER_VERSION })
				} else {
					title = stripTitleAuthor(title, author ?? '')
					cache.set(path, { title, author, cover: coverName, customCover: existing?.customCover, mtime, size, addedAt, failed: !coverName, coverVersion: PDF_COVER_VERSION })
				}
			} else {
				title = existing.title ?? title
				author = existing.author
				coverName = existing.cover
			}
			this.#updateCard(card, { title, author, coverName })
			return
		}

		// TXT：不做 EPUB/PDF 解析，直接用文件名做标题；点开走 Grove TXT 视图
		if (ext === 'txt') {
			const title = existing?.title || cleanBookTitle(basenameOf(path))
			const author = existing?.author ?? ''
			cache.set(path, {
				...existing,
				title,
				author,
				cover: existing?.cover,
				mtime,
				size,
				addedAt,
				failed: true,
			})
			this.#updateCard(card, { title, author, coverName: existing?.cover })
			return
		}

		try {
			const bytes = await plugin.readBookBytes(path)
			const book = await makeBook(new File([bytes], basenameOf(path)))
			let title = cleanBookTitle(stripNumericTitlePrefix(formatLanguageMap(book.metadata?.title)))
			let author = formatAuthor(book.metadata?.author)
			let publisher = formatAuthor(book.metadata?.publisher)
			// 手动编辑过的信息不被自动解析覆盖（「重新解析」除外）
			if (!force && existing?.manualMeta) {
				title = existing.title ?? title
				author = existing.author ?? author
				publisher = existing.publisher ?? publisher
			} else {
				title = stripTitleAuthor(title, author)
			}
			let coverName: string | undefined
			if (existing?.customCover && existing.cover && !force) {
				coverName = existing.cover
			} else {
				try {
					const blob = await book.getCover?.()
					if (blob) coverName = await cache.saveCover(plugin.store.bookId(path), blob)
				} catch {
					// 无封面是常态
				}
				if (!coverName && !force) coverName = existing?.cover
			}
			cache.set(path, { title, author, publisher, cover: coverName, customCover: existing?.customCover, manualMeta: existing?.manualMeta, mtime, size, addedAt })
			this.#updateCard(card, { title, author, publisher, coverName })
		} catch (e) {
			console.error(t('[Grove Reader] 解析书籍信息失败'), path, e)
			// publisher 补空串：避免每次刷新都重读解析失败的整本书
			cache.set(path, { ...existing, mtime, size, addedAt, failed: true, publisher: existing?.publisher ?? '' })
			this.#updateCard(card, {})
		}
	}

	#updateCard(card: HTMLElement, info: ShelfTitleParts & { coverName?: string }): void {
		const display = this.plugin.settings.shelfDisplay
		const media = card.querySelector('.grove-shelf-cover-media') as HTMLElement | null
		// coverName 为 undefined 表示本次没解析出封面：保留现有显示，不要清空
		if (media && info.coverName !== undefined) {
			this.#fillCover(media, this.plugin.shelfCache.coverDataUrl(info.coverName), info.title || card.dataset.title || '')
		}
		if (info.title !== undefined) card.dataset.title = info.title
		if (info.author !== undefined) card.dataset.author = info.author
		if (info.publisher !== undefined) card.dataset.publisher = info.publisher
		const title = card.dataset.title ?? ''
		const author = card.dataset.author ?? ''
		const publisher = card.dataset.publisher ?? ''

		const titleEl = card.querySelector('.grove-shelf-booktitle')
		if (titleEl && info.title) titleEl.textContent = truncate(title, 24)
		if (info.title) {
			const continueTitle = this.continueTitleEls.get(card.dataset.path ?? '')
			if (continueTitle) continueTitle.textContent = truncate(title, 28)
		}
		const authorEl = card.querySelector('.grove-shelf-author')
		if (authorEl) {
			authorEl.textContent = display.mergeAuthorPublisher
				? ([author, publisher].filter(Boolean).join(' · ') || ' ')
				: (author || ' ')
		}
		const pubEl = card.querySelector('.grove-shelf-publisher')
		if (pubEl) pubEl.textContent = publisher || ' '
	}

	#absPath(path: string): string {
		return isAbsolutePath(path) ? path : joinPath(this.plugin.vaultBase, path)
	}

	async #runQueue(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
		let index = 0
		const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
			while (index < tasks.length) {
				const task = tasks[index++]
				try {
					await task()
				} catch (e) {
					console.error(e)
				}
			}
		})
		await Promise.all(workers)
	}

	async #addFolder(): Promise<void> {
		new FolderPromptModal(this.app, t('添加扫描文件夹'), t('例如：书籍'), async value => {
			if (this.plugin.settings.scanFolders.includes(value)) {
				new Notice(t('该文件夹已在列表中'))
				return
			}
			this.plugin.settings.scanFolders.push(value)
			await this.plugin.saveSettings()
			await this.refresh({ rescan: true })
		}).open()
	}

	async #removeFolder(folder: string): Promise<void> {
		const i = this.plugin.settings.scanFolders.indexOf(folder)
		if (i >= 0) this.plugin.settings.scanFolders.splice(i, 1)
		await this.plugin.saveSettings()
		await this.refresh({ rescan: true })
	}

	/**
	 * 导入书籍：选中的文件复制进库内第一个扫描文件夹（没有就用 Grove Reader/书籍），
	 * 同名文件自动加 (2)(3) 后缀，原文件不动。
	 */
	#importBooks(): void {
		const input = createEl('input', { type: 'file' })
		input.accept = [...SUPPORTED_BOOK_EXTS, ...SHELF_EXTRA_EXTS].map(ext => `.${ext}`).join(',')
		input.multiple = true
		input.addEventListener('change', () => {
			void (async () => {
				const files = Array.from(input.files ?? [])
				if (!files.length) return
				const { plugin } = this
				const folders = plugin.settings.scanFolders ?? []
				const target = folders.find(f => !isAbsolutePath(f)) ?? `${LIBRARY_ROOT}/书籍`
				if (!folders.length) {
					plugin.settings.scanFolders = [target]
					await plugin.saveSettings()
				}
				try {
					if (!(await this.app.vault.adapter.exists(target))) await this.app.vault.createFolder(target)
				} catch {
					// 目录已存在或创建失败，写文件时会再报错
				}
				let done = 0
				const failed: string[] = []
				for (const file of files) {
					const ext = (file.name.split('.').pop() ?? '').toLowerCase()
					if (!isShelfExt(ext)) {
						failed.push(file.name)
						continue
					}
					const dot = file.name.lastIndexOf('.')
					const stem = dot > 0 ? file.name.slice(0, dot) : file.name
					const suffix = dot > 0 ? file.name.slice(dot) : ''
					let path = normalizePath(`${target}/${file.name}`)
					let i = 2
					while (this.app.vault.getAbstractFileByPath(path) || await this.app.vault.adapter.exists(path)) {
						path = normalizePath(`${target}/${stem} (${i})${suffix}`)
						i++
					}
					try {
						await this.app.vault.createBinary(path, await file.arrayBuffer())
						done++
					} catch (e) {
						console.error(t('[Grove Reader] 导入书籍失败'), file.name, e)
						failed.push(file.name)
					}
				}
				if (done) new Notice(t("Grove Reader：已导入 {p0} 本书到 {p1}", { p0: done, p1: target }))
				if (failed.length) new Notice(t("Grove Reader：{p0} 个文件导入失败（{p1}）", { p0: failed.length, p1: failed.slice(0, 3).join('、') }), 8000)
				if (done) await this.refresh({ rescan: true })
			})()
		})
		input.click()
	}
}
