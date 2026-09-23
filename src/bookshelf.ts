import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from 'obsidian'
import fs from 'node:fs'
import pathModule from 'node:path'
import { shell } from 'electron'
import { makeBook } from '../lib/foliate-js/view.js'
import type GroveReaderPlugin from './main'
import { SUPPORTED_BOOK_EXTS, isReaderExt, isShelfExt } from './types'
import { basenameOf, cleanPdfDisplayTitle, duplicateKeyOf, formatAuthor, formatBytes, formatLanguageMap, isAbsolutePath, truncate } from './util'
import { readPdfShelfInfo } from './pdfThumbnail'
import { BookInfoModal, ConfirmModal, FolderPromptModal, ListPickerModal, TextPromptModal } from './modals'
import type { BookInfoValues } from './modals'
import type { BookList } from './lists'

export const VIEW_TYPE_GROVE_BOOKSHELF = 'grove-bookshelf-view'

// ------------------------------------------------------------------
// 书架缓存：metadata + 封面，存于插件数据目录，避免每次进书架重复解析
// ------------------------------------------------------------------

interface ShelfEntry {
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

	constructor(rootDir: string) {
		this.file = pathModule.join(rootDir, 'data', 'shelf.json')
		this.coversDir = pathModule.join(rootDir, 'data', 'covers')
	}

	load(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as ShelfCacheFile
			if (parsed && typeof parsed === 'object' && parsed.entries) this.data = parsed
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
			return name
		} catch (e) {
			console.error('[Grove Reader] 自定义封面保存失败', e)
			return undefined
		}
	}

	coverDataUrl(filename?: string): string | null {
		if (!filename) return null
		try {
			const buf = fs.readFileSync(pathModule.join(this.coversDir, filename))
			const mime = filename.endsWith('.png') ? 'image/png'
				: filename.endsWith('.gif') ? 'image/gif'
				: filename.endsWith('.webp') ? 'image/webp'
				: 'image/jpeg'
			return `data:${mime};base64,${buf.toString('base64')}`
		} catch {
			return null
		}
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

interface BookStat {
	annotations: number
	fraction?: number
}

const SORT_OPTIONS: Array<[string, string]> = [
	['default', '默认（按文件名）'],
	['added', '最近添加'],
	['title', '按书名'],
	['progress', '阅读进度'],
]

export class BookshelfView extends ItemView {
	private gridEl!: HTMLElement
	private hintEl!: HTMLElement
	private countEl!: HTMLElement
	private listsEl!: HTMLElement
	/** 'all' = 全部，'none' = 未分类，其余为书单 id */
	private listFilter = 'all'
	private toolsEl!: HTMLElement
	private searchInput!: HTMLInputElement
	private sortSelect!: HTMLSelectElement
	private cardEls = new Map<string, HTMLElement>()

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
		return 'library'
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl
		root.empty()
		root.addClass('grove-shelf-content')

		const head = root.createDiv('grove-shelf-head')
		head.createSpan('grove-shelf-title').setText('书架')
		this.countEl = head.createSpan('grove-shelf-count')
		head.createDiv('grove-flex-spacer')
		const addBtn = head.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': '添加扫描文件夹' } })
		setIcon(addBtn, 'folder-plus')
		addBtn.addEventListener('click', () => this.#addFolder())
		const refreshBtn = head.createEl('button', { cls: 'clickable-icon grove-icon-btn', attr: { 'aria-label': '重新扫描' } })
		setIcon(refreshBtn, 'refresh-cw')
		refreshBtn.addEventListener('click', () => void this.refresh())

		this.hintEl = root.createDiv('grove-shelf-folders')
		this.listsEl = root.createDiv('grove-shelf-lists')
		this.#renderTools()
		this.gridEl = root.createDiv('grove-shelf-grid')

		await this.refresh()
	}

	#renderTools(): void {
		this.toolsEl = this.contentEl.createDiv('grove-shelf-tools')
		const searchWrap = this.toolsEl.createDiv('grove-shelf-search')
		const searchIcon = searchWrap.createSpan('grove-shelf-search-icon')
		setIcon(searchIcon, 'search')
		this.searchInput = searchWrap.createEl('input', { type: 'search', placeholder: '搜索书名 / 作者 / 出版社…' })
		this.searchInput.value = this.plugin.shelfSearch
		this.searchInput.addEventListener('input', () => {
			this.plugin.shelfSearch = this.searchInput.value.trim().toLowerCase()
			void this.refresh()
		})
		this.sortSelect = this.toolsEl.createEl('select', { cls: 'dropdown' })
		for (const [key, label] of SORT_OPTIONS) this.sortSelect.createEl('option', { value: key, text: label })
		this.sortSelect.value = this.plugin.settings.shelfSort
		this.sortSelect.addEventListener('change', () => {
			this.plugin.settings.shelfSort = this.sortSelect.value
			void this.plugin.saveSettings()
			void this.refresh()
		})
	}

	async onClose(): Promise<void> {
		this.plugin.shelfCache.saveNow()
		this.plugin.lists.saveNow()
	}

	async refresh(): Promise<void> {
		const { plugin } = this
		this.cardEls.clear()
		this.gridEl.empty()
		this.hintEl.empty()

		const folders = plugin.settings.scanFolders
		this.#renderFolderChips(folders)

		if (!folders.length) {
			this.countEl.setText('')
			const empty = this.gridEl.createDiv('grove-shelf-empty')
			empty.setText('还没有扫描文件夹。点击右上角的「添加文件夹」，选择库里放书的文件夹（或本机任意文件夹）。')
			return
		}

		const allPaths = scanBookFolders(folders, plugin.vaultBase)
		this.#migrateStaleEntries(allPaths)
		this.#renderListBar(allPaths)
		if (this.listFilter !== 'all' && this.listFilter !== 'none'
			&& !plugin.lists.lists().some(l => l.id === this.listFilter)) {
			this.listFilter = 'all'
		}
		const stats = plugin.collectBookStats()
		const dupes = this.#duplicateGroups(allPaths)
		const q = plugin.shelfSearch
		const inList = this.#filterByList(allPaths)
		const paths = this.#sortPaths(this.#filterBySearch(inList, q), stats)
		this.countEl.setText(q ? `找到 ${paths.length} / ${inList.length} 本` : `共 ${paths.length} 本`)
		if (!paths.length) {
			this.gridEl.createDiv('grove-shelf-empty').setText(
				q && inList.length
					? '没有匹配的书。试试只输书名或作者里的关键词。'
					: allPaths.length && this.listFilter !== 'all'
						? '这个书单里还没有书。在书籍卡片上右键 →「移入书单…」，或直接把书拖到书单标签上。'
						: '扫描文件夹里没有找到书籍文件（支持 epub / mobi / azw3 / fb2 / cbz，PDF 会一并收纳）。')
			return
		}

		const tasks: Array<() => Promise<void>> = []
		for (const p of paths) {
			const card = this.#renderCard(p, stats.get(p), dupes.get(p))
			tasks.push(() => this.#ensureEntry(p, card))
		}
		void this.#runQueue(tasks, 2)
	}

	#renderFolderChips(folders: string[]): void {
		if (!folders.length) return
		this.hintEl.createSpan('grove-shelf-folders-label').setText('扫描：')
		for (const folder of folders) {
			const chip = this.hintEl.createSpan('grove-shelf-chip')
			chip.setText(truncate(folder, 30))
			chip.title = folder
			const remove = chip.createSpan('grove-shelf-chip-x')
			remove.setText('×')
			remove.addEventListener('click', e => {
				e.stopPropagation()
				void this.#removeFolder(folder)
			})
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
		return this.plugin.shelfCache.get(path)?.title || basenameOf(path).replace(/\.[^.]+$/, '')
	}

	#filterBySearch(paths: string[], q: string): string[] {
		if (!q) return paths
		const match = (s?: string): boolean => !!s && s.toLowerCase().includes(q)
		return paths.filter(p => {
			const e = this.plugin.shelfCache.get(p)
			return match(e?.title) || match(e?.author) || match(e?.publisher) || match(basenameOf(p))
		})
	}

	#sortPaths(paths: string[], stats: Map<string, BookStat>): string[] {
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
	}

	#editInfo(path: string): void {
		const cache = this.plugin.shelfCache
		const entry = cache.get(path) ?? {}
		const current: BookInfoValues = {
			title: entry.title ?? basenameOf(path).replace(/\.[^.]+$/, ''),
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

	async #changeCover(path: string, card: HTMLElement): Promise<void> {
		const input = createEl('input', { type: 'file', attr: { accept: 'image/*' } })
		input.addEventListener('change', () => {
			const file = input.files?.[0]
			if (!file) return
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

	#renderCard(path: string, stat?: BookStat, dupes?: string[]): HTMLElement {
		const { plugin } = this
		const entry = plugin.shelfCache.get(path)
		const card = this.gridEl.createDiv('grove-shelf-card')
		this.cardEls.set(path, card)

		const coverWrap = card.createDiv('grove-shelf-cover')
		const coverUrl = plugin.shelfCache.coverDataUrl(entry?.cover)
		const fallbackTitle = basenameOf(path).replace(/\.[^.]+$/, '')
		if (coverUrl) {
			const img = coverWrap.createEl('img', { attr: { src: coverUrl, alt: '' } })
			img.draggable = false
		} else {
			coverWrap.createDiv('grove-shelf-cover-empty').setText(truncate(entry?.title || fallbackTitle, 24))
		}
		// 悬浮显示完整文件名与大小
		let tooltip = basenameOf(path)
		try {
			tooltip += `\n${formatBytes(fs.statSync(this.#absPath(path)).size)}`
		} catch {
			// 文件可能刚被移走
		}
		card.title = tooltip
		card.createDiv('grove-shelf-booktitle').setText(truncate(entry?.title || fallbackTitle, 24))
		card.createDiv('grove-shelf-author').setText(entry?.author || ' ')
		card.createDiv('grove-shelf-publisher').setText(entry?.publisher || ' ')

		const meta = card.createDiv('grove-shelf-meta')
		const ext = (path.split('.').pop() ?? '').toLowerCase()
		if (!isReaderExt(ext)) meta.createSpan('grove-shelf-badge').setText(ext.toUpperCase())
		if (stat && stat.annotations > 0) meta.createSpan('grove-shelf-badge').setText(`批注 ${stat.annotations}`)
		if (typeof stat?.fraction === 'number' && stat.fraction > 0.001) {
			meta.createSpan('grove-shelf-progress').setText(`读至 ${Math.round(stat.fraction * 100)}%`)
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
		card.addEventListener('click', () => void this.plugin.openBookByPath(path))
		card.addEventListener('contextmenu', e => {
			e.preventDefault()
			const menu = new Menu()
			menu.addItem(item => item.setTitle('打开书籍').setIcon('book-open').onClick(() => void this.plugin.openBookByPath(path)))
			menu.addItem(item => item.setTitle('更换封面').setIcon('image').onClick(() => void this.#changeCover(path, card)))
			menu.addItem(item => item.setTitle('编辑书籍信息').setIcon('pencil').onClick(() => this.#editInfo(path)))
			menu.addItem(item => {
				const lid = plugin.lists.listIdOf(path)
				const name = plugin.lists.lists().find(l => l.id === lid)?.name
				item.setTitle(name ? `移入书单（当前：${name}）` : '移入书单…').setIcon('list').onClick(() => this.#pickList(path))
			})
			menu.addItem(item => item.setTitle('重新解析封面与信息').setIcon('refresh-cw').onClick(() => {
				this.plugin.shelfCache.set(path, {})
				void this.#ensureEntry(path, card, true)
			}))
			menu.addItem(item => item.setTitle('在文件夹中显示').setIcon('folder-open').onClick(() => {
				shell.showItemInFolder(this.#absPath(path))
			}))
			menu.addItem(item => item.setTitle('复制完整文件名').setIcon('copy').onClick(() => {
				void navigator.clipboard.writeText(basenameOf(path))
				new Notice('已复制文件名')
			}))
			menu.showAtPosition({ x: e.clientX, y: e.clientY })
		})
		return card
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
			let title = cleanPdfDisplayTitle(basenameOf(path))
			let author: string | undefined
			let coverName: string | undefined
			// 旧版缓存条目可能没有封面也没有 failed 标记（阶段一只存了文件名），
			// 这种情况也要触发解析补封面
			if (!existing || force || existing.mtime !== mtime || (!existing.cover && !existing.failed)) {
				try {
					const bytes = await plugin.readBookBytes(path)
					const info = await readPdfShelfInfo(bytes, 300, rel => plugin.pdfjsAssetUrl(rel))
					if (info.title) title = info.title
					if (info.author) author = info.author
					if (existing?.customCover && existing.cover && !force) {
						coverName = existing.cover
					} else if (info.cover) {
						coverName = (await cache.saveCover(plugin.store.bookId(path), info.cover)) ?? undefined
					}
				} catch (e) {
					console.error('[Grove Reader] 生成 PDF 封面失败', path, e)
				}
				// 封面缺失时标记 failed：避免每次刷新都重读整本大文件；
				// 可右键卡片「重新解析封面与信息」手动重试
				// 手动编辑过的信息不被自动解析覆盖（「重新解析」除外）
				if (!force && existing?.manualMeta) {
					title = existing.title ?? title
					author = existing.author ?? author
					cache.set(path, { ...existing, cover: coverName, mtime, size, addedAt, failed: !coverName })
				} else {
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
		// 其他非插件自渲染格式：仅记录标题
		if (!isReaderExt(ext)) {
			const fallback = basenameOf(path).replace(/\.[^.]+$/, '')
			const title = existing?.manualMeta ? existing.title ?? fallback : fallback
			if (!existing || force || existing.mtime !== mtime) cache.set(path, { ...existing, title, mtime, size, addedAt })
			this.#updateCard(card, { title })
			return
		}

		try {
			const bytes = await plugin.readBookBytes(path)
			const book = await makeBook(new File([bytes], basenameOf(path)))
			let title = formatLanguageMap(book.metadata?.title)
			let author = formatAuthor(book.metadata?.author)
			let publisher = formatAuthor(book.metadata?.publisher)
			// 手动编辑过的信息不被自动解析覆盖（「重新解析」除外）
			if (!force && existing?.manualMeta) {
				title = existing.title ?? title
				author = existing.author ?? author
				publisher = existing.publisher ?? publisher
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
		const coverWrap = card.querySelector('.grove-shelf-cover') as HTMLElement | null
		if (!coverWrap) return
		coverWrap.empty()
		const url = this.plugin.shelfCache.coverDataUrl(info.coverName)
		if (url) {
			const img = coverWrap.createEl('img', { attr: { src: url, alt: '' } })
			img.draggable = false
		} else {
			coverWrap.createDiv('grove-shelf-cover-empty').setText(truncate(info.title || '', 24))
		}
		const titleEl = card.querySelector('.grove-shelf-booktitle')
		if (titleEl && info.title) titleEl.textContent = truncate(info.title, 24)
		const authorEl = card.querySelector('.grove-shelf-author')
		if (authorEl && info.author) authorEl.textContent = info.author
		const pubEl = card.querySelector('.grove-shelf-publisher')
		if (pubEl && info.publisher) pubEl.textContent = info.publisher
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
			await this.refresh()
		}).open()
	}

	async #removeFolder(folder: string): Promise<void> {
		const i = this.plugin.settings.scanFolders.indexOf(folder)
		if (i >= 0) this.plugin.settings.scanFolders.splice(i, 1)
		await this.plugin.saveSettings()
		await this.refresh()
	}
}
