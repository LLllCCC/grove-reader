import { ItemView, Menu, Notice, WorkspaceLeaf, requestUrl, setIcon } from 'obsidian'
import type { TAbstractFile } from 'obsidian'
import { TFile } from 'obsidian'
import fs from 'node:fs'
import pathModule from 'node:path'
import { shell } from 'electron'
import { makeBook } from '../lib/foliate-js/view.js'
import type GroveReaderPlugin from './main'
import { FORMAT_LABELS, ShelfBookInfo, isReaderExt, isShelfExt } from './types'
import { basenameOf, cleanBookTitle, duplicateKeyOf, formatAuthor, formatBytes, formatDuration, formatLanguageMap, isAbsolutePath, relativeTime, stripNumericTitlePrefix, stripTitleAuthor, truncate } from './util'
import { readPdfShelfInfo } from './pdfThumbnail'
import { BookInfoModal, ConfirmModal, CoverUrlModal, DeleteBookModal, FolderPromptModal, ListPickerModal, ReadingStatsModal, TextPromptModal } from './modals'
import type { BookInfoValues } from './modals'
import type { BookList } from './lists'

export const VIEW_TYPE_GROVE_BOOKSHELF = 'grove-bookshelf-view'

const MAX_CACHED_COVERS = 96
const MAX_CACHED_COVER_CHARS = 24_000_000

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
					window.setTimeout(() => reject(new Error('下载超时（20 秒）')), 20_000),
				),
			])
		} catch (e) {
			if (e instanceof Error && e.message.includes('超时')) throw e
			continue
		}
		if (res.status >= 200 && res.status < 300) {
			const mime = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
			if (!mime.startsWith('image/')) throw new Error('这个链接返回的不是图片')
			if (res.arrayBuffer.byteLength > 12 * 1024 * 1024) throw new Error('图片超过 12 MB，请换一张小一些的')
			return { buffer: res.arrayBuffer, mime }
		}
		lastStatus = res.status
	}
	if (lastStatus === 418 || lastStatus === 403 || lastStatus === 401) {
		throw new Error(
			`对方站点拒绝了下载（HTTP ${lastStatus}，防盗链）。可以右键图片「图片另存为」，再用「更换封面」选择本地文件。`,
		)
	}
	throw new Error(`下载失败：HTTP ${lastStatus || '未知'}`)
}

// ------------------------------------------------------------------
// 书架缓存：metadata + 封面，存于插件数据目录，避免每次进书架重复解析
// ------------------------------------------------------------------

export interface ShelfEntry {
	title?: string
	author?: string
	publisher?: string
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
	private saveTimer: NodeJS.Timeout | null = null
	/** 封面 dataURL 缓存：卡片每次刷新都会取封面，避免反复同步读盘 + base64 */
	private coverCache = new Map<string, string | null>()
	private coverCacheChars = 0

	constructor(rootDir: string) {
		this.file = pathModule.join(rootDir, 'data', 'shelf.json')
		this.coversDir = pathModule.join(rootDir, 'data', 'covers')
	}

	load(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as ShelfCacheFile
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
		} catch {
			// 首次或损坏时使用空缓存
		}
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
		try {
			fs.rmSync(pathModule.join(this.coversDir, filename), { force: true })
		} catch {
			// 封面可能已被手动删除
		}
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
		try {
			fs.mkdirSync(pathModule.dirname(this.file), { recursive: true })
			const tmp = `${this.file}.tmp`
			fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf-8')
			fs.renameSync(tmp, this.file)
		} catch (e) {
			console.error('[Grove Reader] 书架缓存写入失败', e)
		}
	}

	async saveCover(bookId: string, blob: Blob): Promise<string | undefined> {
		try {
			fs.mkdirSync(this.coversDir, { recursive: true })
			const ext = blob.type.includes('png') ? 'png' : blob.type.includes('gif') ? 'gif' : 'jpg'
			const name = `${bookId}.${ext}`
			const buf = Buffer.from(await blob.arrayBuffer())
			fs.writeFileSync(pathModule.join(this.coversDir, name), buf)
			this.#deleteCoverCache(name)
			return name
		} catch (e) {
			console.error('[Grove Reader] 封面保存失败', e)
			return undefined
		}
	}

	/** 用户手动选择的本地图片作为封面 */
	async saveCustomCover(bookId: string, file: File): Promise<string | undefined> {
		try {
			fs.mkdirSync(this.coversDir, { recursive: true })
			const lower = file.name.toLowerCase()
			const ext = lower.endsWith('.png') ? 'png' : lower.endsWith('.gif') ? 'gif' : lower.endsWith('.webp') ? 'webp' : 'jpg'
			const name = `${bookId}-custom.${ext}`
			const buf = Buffer.from(await file.arrayBuffer())
			fs.writeFileSync(pathModule.join(this.coversDir, name), buf)
			this.#deleteCoverCache(name)
			return name
		} catch (e) {
			console.error('[Grove Reader] 自定义封面保存失败', e)
			return undefined
		}
	}

	/** 从网络图片字节保存自定义封面 */
	async saveCustomCoverFromBuffer(bookId: string, data: ArrayBuffer, mime: string): Promise<string | undefined> {
		try {
			fs.mkdirSync(this.coversDir, { recursive: true })
			const ext = mime.includes('png') ? 'png'
				: mime.includes('gif') ? 'gif'
				: mime.includes('webp') ? 'webp'
				: 'jpg'
			const name = `${bookId}-custom.${ext}`
			fs.writeFileSync(pathModule.join(this.coversDir, name), Buffer.from(data))
			this.#deleteCoverCache(name)
			return name
		} catch (e) {
			console.error('[Grove Reader] 网络封面保存失败', e)
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
		let url: string | null = null
		try {
			const buf = fs.readFileSync(pathModule.join(this.coversDir, filename))
			const mime = filename.endsWith('.png') ? 'image/png'
				: filename.endsWith('.gif') ? 'image/gif'
				: filename.endsWith('.webp') ? 'image/webp'
				: 'image/jpeg'
			url = `data:${mime};base64,${buf.toString('base64')}`
		} catch {
			url = null
		}
		if (url !== null && url.length <= 2_000_000) {
			while (this.coverCache.size >= MAX_CACHED_COVERS || this.coverCacheChars + url.length > MAX_CACHED_COVER_CHARS) {
				const oldest = this.coverCache.keys().next().value as string | undefined
				if (oldest === undefined) break
				this.#deleteCoverCache(oldest)
			}
			this.coverCache.set(filename, url)
			this.coverCacheChars += url.length
		}
		return url
	}

	#deleteCoverCache(filename: string): void {
		const cached = this.coverCache.get(filename)
		if (cached) this.coverCacheChars -= cached.length
		this.coverCache.delete(filename)
	}
}

// ------------------------------------------------------------------
// 扫描
// ------------------------------------------------------------------

export function scanBookFolders(folders: string[], vaultBase: string): string[] {
	const found: string[] = []
	const seen = new Set<string>()

	const walk = (dir: string, depth: number): void => {
		if (depth > 6) return
		let list: fs.Dirent[]
		try {
			list = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const item of list) {
			if (item.name.startsWith('.')) continue
			const full = pathModule.join(dir, item.name)
			if (item.isDirectory()) {
				walk(full, depth + 1)
			} else if (item.isFile() && isShelfExt(item.name.split('.').pop()?.toLowerCase() ?? '')) {
				if (!seen.has(full)) {
					seen.add(full)
					found.push(full)
				}
			}
		}
	}

	for (const folder of folders) {
		const abs = isAbsolutePath(folder) ? folder : pathModule.join(vaultBase, folder)
		walk(abs, 0)
	}

	// 库内文件统一转换为库相对路径（与选书器、批注数据的 bookPath 一致）
	return found
		.map(abs => {
			const rel = pathModule.relative(vaultBase, abs)
			if (rel && !rel.startsWith('..') && !pathModule.isAbsolute(rel)) return rel.split(pathModule.sep).join('/')
			return abs
		})
		.sort()
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
	private listsEl!: HTMLElement
	/** 'all' = 全部，'none' = 未分类，其余为书单 id */
	private listFilter = 'all'
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

	constructor(leaf: WorkspaceLeaf, private plugin: GroveReaderPlugin) {
		super(leaf)
		this.navigation = false
	}

	getViewType(): string {
		return VIEW_TYPE_GROVE_BOOKSHELF
	}

	getDisplayText(): string {
		return '书架'
	}

	getIcon(): string {
		return this.plugin.currentLogoIcon()
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl
		root.empty()
		root.addClass('grove-shelf-content')
		this.registerDomEvent(root, 'scroll', () => this.#hideTooltip(), true)
		this.registerDomEvent(window, 'resize', () => this.#hideTooltip())

		this.listsEl = root.createDiv('grove-shelf-lists')
		this.#renderTools(root)
		this.continueEl = root.createDiv('grove-shelf-continue grove-hidden')
		this.gridEl = root.createDiv('grove-shelf-grid')
		this.emptyEl = this.gridEl.createDiv('grove-shelf-empty grove-hidden')

		this.#registerVaultEvents()
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
		this.searchInput = searchWrap.createEl('input', { type: 'search', placeholder: '搜索书名 / 作者 / 出版社…' })
		this.searchInput.value = this.plugin.shelfSearch
		this.searchInput.addEventListener('input', () => {
			this.plugin.shelfSearch = this.searchInput.value.trim().toLowerCase()
			// 搜索只切换已有卡片的显示状态，不再重扫目录 / 重建 DOM
			if (this.searchTimer != null) window.clearTimeout(this.searchTimer)
			this.searchTimer = window.setTimeout(() => {
				this.searchTimer = null
				this.#applySearch()
			}, 120)
		})
		this.sortSelect = this.toolsEl.createEl('select', { cls: 'dropdown' })
		for (const [key, label] of SORT_OPTIONS) this.sortSelect.createEl('option', { value: key, text: label })
		this.sortSelect.value = this.plugin.settings.shelfSort
		this.sortSelect.addEventListener('change', () => {
			this.plugin.settings.shelfSort = this.sortSelect.value
			void this.plugin.saveSettings()
			void this.refresh()
		})

		// 书架右上角三个动作：添加文件夹 / 重新扫描 / 阅读统计
		const actions = this.toolsEl.createDiv('grove-shelf-tools-actions')
		const action = (icon: string, label: string, onClick: () => void): void => {
			const btn = actions.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': label, title: label } })
			setIcon(btn, icon)
			btn.addEventListener('click', onClick)
		}
		action('folder-plus', '添加扫描文件夹', () => void this.#addFolder())
		action('refresh-cw', '重新扫描', () => void this.refresh({ rescan: true }))
		action('bar-chart-2', '阅读统计', () => new ReadingStatsModal(this.app, this.plugin).open())
	}

	async onClose(): Promise<void> {
		if (this.searchTimer != null) window.clearTimeout(this.searchTimer)
		if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer)
		this.searchTimer = null
		this.refreshTimer = null
		this.#hideTooltip()
		this.plugin.shelfCache.saveNow()
		this.plugin.lists.saveNow()
	}

	async refresh(opts: { rescan?: boolean } = {}): Promise<void> {
		const { plugin } = this
		if (!this.gridEl) return
		this.#hideTooltip()
		if (opts.rescan) this.scanToken++
		this.cardEls.clear()
		this.gridEl.empty()
		this.emptyEl = this.gridEl.createDiv('grove-shelf-empty grove-hidden')
		this.continueEl.empty()
		this.continueHasItems = false
		this.continueTitleEls.clear()

		const folders = plugin.settings.scanFolders

		if (!folders.length) {
			this.#showEmpty('还没有扫描文件夹。选择一个放书的文件夹（库内或本机任意路径），书架会递归扫描其中的电子书与 PDF。')
			const addBtn = this.emptyEl.createEl('button', { text: '添加文件夹', cls: 'mod-cta' })
			addBtn.addEventListener('click', () => void this.#addFolder())
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
				const restore = this.emptyEl.createEl('button', { text: '全部恢复', cls: 'mod-cta' })
				restore.addEventListener('click', () => void plugin.restoreHiddenBooks())
				return
			}
			this.#showEmpty(visiblePaths.length && this.listFilter !== 'all'
				? '这个书单里还没有书。在书籍卡片上右键 →「移入书单…」，或直接把书拖到书单标签上。'
				: '扫描文件夹里没有找到书籍文件（支持 epub / mobi / azw3 / fb2 / cbz / txt，PDF 会一并收纳）。')
			return
		}

		const tasks: Array<() => Promise<void>> = []
		for (const p of this.#sortPaths(inList, stats)) {
			const card = this.#renderCard(p, stats.get(p), dupes.get(p))
			tasks.push(() => this.#ensureEntry(p, card))
		}
		this.#applySearch()
		void this.#runQueue(tasks, 2).then(() => this.#applySearch())
	}

	/** 扫描结果按「文件夹列表 + token」缓存：搜索/排序刷新不再走磁盘 */
	#scan(folders: string[]): string[] {
		const key = folders.join('\u0000')
		if (!this.scanCache || this.scanCache.key !== key || this.scanCache.token !== this.scanToken) {
			this.scanCache = { key, token: this.scanToken, paths: scanBookFolders(folders, this.plugin.vaultBase) }
		}
		return this.scanCache.paths
	}

	#showEmpty(message: string): void {
		this.emptyEl.empty()
		const wordmark = this.plugin.logoWordmark()
		if (wordmark) {
			const logo = this.emptyEl.createDiv('grove-empty-logo')
			logo.innerHTML = wordmark
		}
		this.emptyEl.createSpan('grove-empty-text').setText(message)
		this.emptyEl.removeClass('grove-hidden')
	}

	#matches(path: string, q: string): boolean {
		if (!q) return true
		const entry = this.plugin.shelfCache.get(path)
		const hit = (s?: string): boolean => !!s && s.toLowerCase().includes(q)
		return hit(entry?.title) || hit(entry?.author) || hit(entry?.publisher) || hit(basenameOf(path))
	}

	/**
	 * 搜索：只切换卡片可见性 + 更新计数，不动 DOM 结构。
	 * 卡片在 refresh() 时按书单维度全量建好，清空搜索可即时恢复。
	 */
	#applySearch(): void {
		if (!this.emptyEl) return
		const q = this.plugin.shelfSearch
		let shown = 0
		for (const [path, card] of this.cardEls) {
			const match = this.#matches(path, q)
			card.toggleClass('is-hidden', !match)
			if (match) shown++
		}
		const total = this.cardEls.size
		if (shown === 0 && total > 0) {
			this.#showEmpty('没有匹配的书。试试只输书名或作者里的关键词。')
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
		this.continueEl.createDiv('grove-continue-head').setText('继续阅读')
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
					menu.addItem(item => item.setTitle('重命名书单').setIcon('pencil').onClick(() => {
						new TextPromptModal(this.app, '重命名书单', '书单名称', list.name, name => {
							lists.rename(list.id, name)
							void this.refresh()
						}).open()
					}))
					menu.addItem(item => item.setTitle('删除书单').setIcon('trash-2').onClick(() => {
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
		mkChip('全部', 'all', allPaths.length)
		mkChip('未分类', 'none', allPaths.filter(p => !lists.listIdOf(p)).length)
		for (const l of lists.lists()) {
			mkChip(l.name, l.id, allPaths.filter(p => lists.listIdOf(p) === l.id).length, l)
		}
		const newBtn = this.listsEl.createSpan('grove-shelf-list-chip grove-shelf-list-new')
		newBtn.setText('＋ 新建书单')
		newBtn.addEventListener('click', () => {
			new TextPromptModal(this.app, '新建书单', '书单名称', '', name => {
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
					try {
						return fs.statSync(this.#absPath(p)).size === entry.size
					} catch {
						return false
					}
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
		}
		// 文件已彻底消失且条目无个性化数据（自定义封面/手改信息）：清掉，
		// 避免书架缓存无限膨胀；有个性化数据的保留，防移动硬盘临时掉线时误删
		for (const [oldPath, entry] of cache.entries()) {
			if (present.has(oldPath)) continue
			if (entry.customCover || entry.manualMeta) continue
			let gone = false
			try {
				gone = !fs.existsSync(this.#absPath(oldPath))
			} catch {
				continue
			}
			if (gone) cache.remove(oldPath)
		}
	}

	#editInfo(path: string): void {
		const cache = this.plugin.shelfCache
		const entry = cache.get(path) ?? {}
		const current: BookInfoValues = {
			title: entry.title ?? cleanBookTitle(basenameOf(path)),
			author: entry.author ?? '',
			publisher: entry.publisher ?? '',
		}
		new BookInfoModal(this.app, current, values => {
			cache.set(path, {
				...entry,
				title: values.title || undefined,
				author: values.author || undefined,
				publisher: values.publisher,
				manualMeta: true,
			})
			// 同步进批注数据：笔记标题/阅读界面标题取的是 data.title
			this.plugin.syncBookMeta(
				path,
				values.title || basenameOf(path).replace(/\.[^.]+$/, ''),
				values.author,
			)
			void this.refresh()
		}).open()
	}

	#pickList(path: string): void {
		const lists = this.plugin.lists
		new ListPickerModal(this.app, lists.lists(), picked => {
			if (picked === 'new') {
				new TextPromptModal(this.app, '新建书单', '书单名称', '', name => {
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

	async #changeCoverByUrl(path: string, card: HTMLElement): Promise<void> {
		new CoverUrlModal(this.app, async url => {
			const { buffer, mime } = await downloadImageFromUrl(url)
			const name = await this.plugin.shelfCache.saveCustomCoverFromBuffer(
				this.plugin.store.bookId(path),
				buffer,
				mime,
			)
			if (!name) throw new Error('封面保存失败，请检查磁盘权限')
			const prev = this.plugin.shelfCache.get(path) ?? {}
			this.plugin.shelfCache.set(path, { ...prev, cover: name, customCover: true, failed: false })
			this.#updateCard(card, { ...prev, coverName: name })
			new Notice('封面已更新')
		}).open()
	}

	async #changeCover(path: string, card: HTMLElement): Promise<void> {
		const input = createEl('input', { type: 'file', attr: { accept: 'image/*' } })
		input.addEventListener('change', () => {
			const file = input.files?.[0]
			if (!file) return
			if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|gif)$/i.test(file.name)) {
				new Notice('请选择图片文件（jpg / png / webp / gif）')
				return
			}
			if (file.size > 12 * 1024 * 1024) {
				new Notice('图片超过 12 MB，请换一张小一些的')
				return
			}
			void (async () => {
				const name = await this.plugin.shelfCache.saveCustomCover(this.plugin.store.bookId(path), file)
				if (!name) {
					new Notice('更换封面失败')
					return
				}
				const prev = this.plugin.shelfCache.get(path) ?? {}
				this.plugin.shelfCache.set(path, { ...prev, cover: name, customCover: true, failed: false })
				this.#updateCard(card, { ...prev, coverName: name })
				new Notice('封面已更新')
			})()
		})
		input.click()
	}

	/** 删除书籍：可选择是否连原文件、生成的阅读笔记一起删除 */
	async #deleteBook(path: string): Promise<void> {
		const title = this.#displayTitle(path)
		const data = this.plugin.store.load(path)
		const count = data.annotations?.length ?? 0
		const notePath = data.notePath && fs.existsSync(this.#absPath(data.notePath)) ? data.notePath : undefined
		const noteName = notePath ? basenameOf(notePath) : undefined
		new DeleteBookModal(this.app, title, count, noteName, async (deleteFile, deleteNote) => {
			const closed = this.plugin.closeBookViews(path)
			// 关闭阅读视图时可能触发一次 onClose 写盘，等它落完再移动数据
			if (closed) await new Promise(resolve => window.setTimeout(resolve, 300))
			this.plugin.debug('delete', 'book', { path, deleteFile, deleteNote })
			if (deleteFile) {
				this.plugin.moveToTrash(path, title, deleteNote ? notePath : undefined)
				// 批注 JSON 已移入回收站，这里只清自动备份与索引
				this.plugin.store.delete(path)
				this.plugin.stats.remove(path)
				this.plugin.lists.setMember(path, null)
				this.plugin.shelfCache.remove(path)
				const hidden = this.plugin.settings.hiddenBooks ?? []
				this.plugin.settings.hiddenBooks = hidden.filter(p => p !== path)
				await this.plugin.saveSettings()
				this.plugin.oplog.add('删除书籍', `《${title}》；移入回收站；阅读笔记${deleteNote ? '一并移入' : '保留'}`)
				new Notice('已移入回收站，可在 设置 → 回收站 恢复')
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
				this.plugin.oplog.add('删除书籍', `《${title}》；仅移出书架；阅读笔记${deleteNote ? '已删除' : '保留'}`)
				new Notice('已从书架移除，原文件与批注数据都保留')
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
		this.#fillCover(media, plugin.shelfCache.coverDataUrl(entry?.cover), title)

		// 封面底部进度条：扫视时比读百分比快
		const fraction = info?.fraction
		if (display.showProgress && typeof fraction === 'number' && fraction > 0.001) {
			const track = coverWrap.createDiv('grove-cover-progress')
			const pct = Math.min(100, Math.max(1, Math.round(fraction * 100)))
			track.createDiv('grove-cover-progress-fill').style.width = `${pct}%`
			track.title = fraction >= 0.995 ? '已读完' : `读至 ${pct}%`
		}

		// 悬浮/键盘聚焦：只保留一个自定义提示，整合书名、文件名、大小与阅读信息
		const detailLines = [title]
		if (author) detailLines.push(author)
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
			badge.title = `${format} · ${ext === 'pdf' ? '用 Obsidian 查看器打开' : '在插件内阅读'}`
		}
		if (display.showProgress && typeof fraction === 'number' && fraction > 0.001) {
			const done = fraction >= 0.995
			const progress = meta.createSpan('grove-shelf-progress')
			progress.setText(done ? '已读' : `${Math.round(fraction * 100)}%`)
			progress.title = done ? '已读完' : `读至 ${Math.round(fraction * 100)}%`
		}
		if (display.showAnnotationCount && info && info.annotations > 0) {
			meta.createSpan('grove-shelf-badge').setText(`批注 ${info.annotations}`)
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
			note.title = '已生成阅读笔记，点击打开'
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
			badge.setText('疑似重复')
			badge.title = `文件名与其他 ${dupes.length} 本书高度相似：\n${dupes.map(d => basenameOf(d)).join('\n')}`
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
			menu.addItem(item => item.setTitle('打开书籍').setIcon('book-open').onClick(() => void plugin.openBookByPath(path)))
			menu.addItem(item => item.setTitle('笔记模板…').setIcon('file-text').onClick(() => plugin.showTemplatePicker(path)))
			menu.addItem(item => item.setTitle('更换封面').setIcon('image').onClick(() => void this.#changeCover(path, card)))
			menu.addItem(item => item.setTitle('用图片链接更换封面…').setIcon('link').onClick(() => void this.#changeCoverByUrl(path, card)))
			menu.addItem(item => item.setTitle('编辑书籍信息').setIcon('pencil').onClick(() => this.#editInfo(path)))
			menu.addItem(item => {
				const lid = plugin.lists.listIdOf(path)
				const name = plugin.lists.lists().find(l => l.id === lid)?.name
				item.setTitle(name ? `移入书单（当前：${name}）` : '移入书单…').setIcon('list').onClick(() => this.#pickList(path))
			})
			menu.addItem(item => item.setTitle('重新解析封面与信息').setIcon('refresh-cw').onClick(() => {
				const entry = this.plugin.shelfCache.get(path)
				const run = (): void => {
					this.plugin.shelfCache.set(path, {})
					void this.#ensureEntry(path, card, true)
				}
				if (entry?.customCover || entry?.manualMeta) {
					new ConfirmModal(this.app, '重新解析会清除手动更换的封面或手动编辑的书名/作者，继续？', run).open()
				} else {
					run()
				}
			}))
			menu.addItem(item => item.setTitle('在文件夹中显示').setIcon('folder-open').onClick(() => {
				shell.showItemInFolder(this.#absPath(path))
			}))
			menu.addItem(item => item.setTitle('复制完整文件名').setIcon('copy').onClick(() => {
				void navigator.clipboard.writeText(basenameOf(path))
				new Notice('已复制文件名')
			}))
			menu.addSeparator()
			menu.addItem(item => item.setTitle('清空本书批注…').setIcon('eraser').onClick(() => this.plugin.clearAnnotationsFor(path)))
			menu.addItem(item => item.setTitle('删除书籍…').setIcon('trash-2').onClick(() => void this.#deleteBook(path)))
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

	#fileSize(path: string): number | undefined {
		try {
			return fs.statSync(this.#absPath(path)).size
		} catch {
			return undefined
		}
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
		try {
			const st = fs.statSync(this.#absPath(path))
			mtime = st.mtimeMs
			size = st.size
		} catch {
			return
		}
		const addedAt = existing?.addedAt ?? Date.now()
		const ext = (path.split('.').pop() ?? '').toLowerCase()
		// 缺 publisher 字段的旧电子书缓存视为不完整：下次刷新重解析补一次
		const needsPublisher = isReaderExt(ext) && ext !== 'pdf' && existing?.publisher === undefined
		if (!force && existing && existing.mtime === mtime && (existing.cover || existing.failed) && !needsPublisher) return

		// PDF：渲染首页为封面 + 读取元数据标题（比文件名干净）
		if (ext === 'pdf') {
			let title = cleanBookTitle(basenameOf(path))
			let author: string | undefined
			let coverName: string | undefined
			// 旧版缓存条目可能没有封面也没有 failed 标记（阶段一只存了文件名），
			// 这种情况也要触发解析补封面
			if (!existing || force || existing.mtime !== mtime || (!existing.cover && !existing.failed)) {
				try {
					const bytes = await plugin.readBookBytes(path)
					const info = await readPdfShelfInfo(bytes, 300, rel => plugin.pdfjsAssetUrl(rel))
					if (info.title) title = cleanBookTitle(stripNumericTitlePrefix(info.title))
					if (info.author) author = info.author
					if (existing?.customCover && existing.cover && !force) {
						coverName = existing.cover
					} else if (info.cover) {
						coverName = (await cache.saveCover(plugin.store.bookId(path), info.cover)) ?? undefined
					}
				} catch (e) {
					console.error('[Grove Reader] 生成 PDF 封面失败', path, e)
				}
				// 解析失败时保留旧封面，避免一次异常把已有封面抹掉
				if (!coverName && !force) coverName = existing?.cover
				// 封面缺失时标记 failed：避免每次刷新都重读整本大文件；
				// 可右键卡片「重新解析封面与信息」手动重试
				// 手动编辑过的信息不被自动解析覆盖（「重新解析」除外）
				if (!force && existing?.manualMeta) {
					title = existing.title ?? title
					author = existing.author ?? author
					cache.set(path, { ...existing, cover: coverName, mtime, size, addedAt, failed: !coverName })
				} else {
					title = stripTitleAuthor(title, author ?? '')
					cache.set(path, { title, author, cover: coverName, customCover: existing?.customCover, mtime, size, addedAt, failed: !coverName })
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
			console.error('[Grove Reader] 解析书籍信息失败', path, e)
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
		return isAbsolutePath(path) ? path : pathModule.join(this.plugin.vaultBase, path)
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
		new FolderPromptModal(this.app, '添加扫描文件夹', '例如：书籍', async value => {
			if (this.plugin.settings.scanFolders.includes(value)) {
				new Notice('该文件夹已在列表中')
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
}
