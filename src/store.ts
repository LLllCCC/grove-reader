import { BookData, DATA_VERSION, type Annotation, type Bookmark } from './types'
import { PlatformIO, baseName, joinPath, stripExt } from './platformIO'
import { basenameOf, bookIdFor, cleanBookTitle, stripNumericTitlePrefix, stripTitleAuthor } from './util'

const BACKUP_INTERVAL_MS = 10 * 60 * 1000
/** 删除墓碑保留期：超过这个时间的墓碑会被清掉，磁盘上不会无限增长 */
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000

/** 合并两台设备的删除墓碑：取较新的删除时间 */
function mergeTombstones(
	disk: Record<string, number> | undefined,
	local: Record<string, number> | undefined,
): Record<string, number> {
	const merged: Record<string, number> = {}
	for (const source of [disk, local]) {
		for (const [id, at] of Object.entries(source ?? {})) {
			if (!id || !Number.isFinite(at)) continue
			if (!(id in merged) || merged[id] < at) merged[id] = at
		}
	}
	return merged
}

/** 清掉过期墓碑；坏值一律丢弃 */
function pruneTombstones(map: Record<string, number> | undefined): Record<string, number> {
	const now = Date.now()
	const out: Record<string, number> = {}
	for (const [id, at] of Object.entries(map ?? {})) {
		if (!id || !Number.isFinite(at)) continue
		if (now - at > TOMBSTONE_TTL_MS) continue
		out[id] = at
	}
	return out
}

/** 批注合并：同一 id 取 updatedAt 更新的版本，墓碑优先 */
function mergeAnnotations(
	disk: Annotation[],
	local: Annotation[],
	deleted: Record<string, number>,
): Annotation[] {
	const map = new Map<string, Annotation>()
	for (const item of disk) if (item?.id) map.set(item.id, item)
	for (const item of local) {
		if (!item?.id) continue
		const current = map.get(item.id)
		if (!current || (item.updatedAt ?? 0) > (current.updatedAt ?? 0)) map.set(item.id, item)
	}
	return [...map.values()].filter(item => !deleted[item.id])
}

/** 书签合并：书签不可编辑，同一 id 视为同一条；墓碑优先 */
function mergeBookmarks(
	disk: Bookmark[],
	local: Bookmark[],
	deleted: Record<string, number>,
): Bookmark[] {
	const map = new Map<string, Bookmark>()
	for (const item of disk) if (item?.id) map.set(item.id, item)
	for (const item of local) if (item?.id && !map.has(item.id)) map.set(item.id, item)
	return [...map.values()].filter(item => !deleted[item.id])
}

/** 合并批注/书签/墓碑；base 先放入，incoming 里更新的版本覆盖 */
function mergeTrackedCollections(
	base: BookData,
	incoming: BookData,
): Pick<BookData, 'annotations' | 'bookmarks' | 'deletedAnnotations' | 'deletedBookmarks'> {
	const deletedAnnotations = mergeTombstones(base.deletedAnnotations, incoming.deletedAnnotations)
	const deletedBookmarks = mergeTombstones(base.deletedBookmarks, incoming.deletedBookmarks)
	return {
		annotations: mergeAnnotations(base.annotations, incoming.annotations, deletedAnnotations),
		bookmarks: mergeBookmarks(base.bookmarks ?? [], incoming.bookmarks ?? [], deletedBookmarks),
		deletedAnnotations,
		deletedBookmarks,
	}
}

/** 只比较合并关心的字段，避免键顺序不同造成「假变化」反复写盘 */
function mergeSignature(data: BookData): string {
	const annotations = data.annotations
		.map(item => `${item.id}@${item.updatedAt ?? 0}`)
		.sort()
		.join('|')
	const bookmarks = (data.bookmarks ?? []).map(item => item.id).sort().join('|')
	const deadA = Object.entries(data.deletedAnnotations ?? {})
		.map(([id, at]) => `${id}@${at}`)
		.sort()
		.join('|')
	const deadB = Object.entries(data.deletedBookmarks ?? {})
		.map(([id, at]) => `${id}@${at}`)
		.sort()
		.join('|')
	return `${annotations}\n${bookmarks}\n${deadA}\n${deadB}`
}

/**
 * 批注数据存储：每本书一个 JSON 文件。
 *
 * 读：启动时 `preload()` 把 data/books 下的 JSON 一次性读进内存，之后 `load()` 是纯内存查表，
 * 视图层与命令层不需要改成 async。
 * 写：`save()` 立即更新内存并按书排队落盘（临时文件 + 原子重命名，覆盖前滚动备份）。
 *      桌面走 Node fs，移动端走 vault.adapter —— 具体实现由 PlatformIO 决定。
 */
export class BookStore {
	/** 保存失败时的回调（主进程用于弹 Notice） */
	onError?: (e: Error) => void

	private cache = new Map<string, BookData>()
	/** 每本书一条写入链，保证顺序，避免并发写同一文件 */
	private writes = new Map<string, Promise<void>>()
	/**
	 * 最近一次自己写盘的内容。vault 的 modify 事件是我们自己触发的也会来一遍，
	 * 不比对内容就会「存盘 → 回读 → 刷新界面 → 再存盘」自激成死循环，
	 * 表现之一就是手机端正文每秒重绘、刚选中的文字被冲掉。
	 */
	private lastWritten = new Map<string, string>()
	/**
	 * 每个数据对象上次保存时有哪些批注/书签，用于检测「本次保存少了谁」并补删除墓碑。
	 * 用对象做键（而不是书籍 id）：外部同步后视图可能还持有旧对象，
	 * 旧对象缺的「别人的新批注」不该被误记成删除。
	 */
	private known = new WeakMap<BookData, { annotations: Set<string>; bookmarks: Set<string> }>()
	private loaded = false
	/** 预载失败时暂停写入：宁可弹错，也不能用空数据覆盖磁盘上的批注 */
	private preloadError: Error | null = null

	constructor(
		public rootDir: string,
		public maxBackups: number,
		private io: PlatformIO,
	) {}

	private get booksDir(): string {
		return joinPath(this.rootDir, 'data', 'books')
	}

	private fileFor(id: string): string {
		return joinPath(this.booksDir, `${id}.json`)
	}

	private backupsDir(id: string): string {
		return joinPath(this.rootDir, 'data', 'backups', id)
	}

	bookId(vaultPath: string): string {
		return bookIdFor(vaultPath)
	}

	fresh(vaultPath: string): BookData {
		return { version: DATA_VERSION, bookPath: vaultPath, title: '', author: '', annotations: [] }
	}

	/** 读取全部批注数据；必须在打开任何书之前 await 一次 */
	async preload(): Promise<void> {
		if (this.loaded) return
		this.loaded = true
		try {
			await this.io.mkdir(this.booksDir)
		} catch {
			// 目录已存在
		}
		await this.#cleanStaleTmp()
		let files: string[] = []
		try {
			const listed = await this.io.list(this.booksDir)
			files = listed.files.filter(f => f.endsWith('.json'))
		} catch (e) {
			this.preloadError = e instanceof Error ? e : new Error(String(e))
			console.error('[Grove Reader] 批注数据预载失败，已暂停写入', e)
			this.onError?.(this.preloadError)
			return
		}
		for (const file of files) {
			const id = stripExt(baseName(file))
			const data = await this.#readWithRepair(id, file)
			if (!data) continue
			this.#normalize(data)
			this.cache.set(id, data)
			this.#rememberKnown(data)
		}
	}

	load(vaultPath: string): BookData {
		const id = this.bookId(vaultPath)
		const cached = this.cache.get(id)
		if (cached) {
			if (cached.bookPath !== vaultPath) {
				cached.bookPath = vaultPath
				this.save(cached)
			}
			return cached
		}
		// 书被移动/重命名后 bookId 变了：从内存里按 bookPath / 唯一文件名找回
		const recovered = this.#recoverInCache(id, vaultPath)
		if (recovered) return recovered
		return this.fresh(vaultPath)
	}

	getPathForBookId(id: string): string | null {
		return this.cache.get(id)?.bookPath ?? null
	}

	/** 所有已有批注数据的书籍路径（批量维护、刷新笔记用） */
	listBookPaths(): string[] {
		const out: string[] = []
		for (const data of this.cache.values()) {
			if (typeof data.bookPath === 'string' && data.bookPath) out.push(data.bookPath)
		}
		return out
	}

	/** 这本书的数据是否在内存里（按 bookId 判断，给外部文件变更监听用） */
	hasBookId(id: string): boolean {
		return this.cache.has(id)
	}

	/** 外部（Syncthing 等）改动 JSON 后重新读入内存，返回是否真的更新了 */
	async reloadFromDisk(id: string): Promise<boolean> {
		const file = this.fileFor(id)
		if (!(await this.io.exists(file))) return false
		// 自己刚写完的文件不要立刻回读，否则会和排队中的写入打架
		const pending = this.writes.get(id)
		if (pending) await pending.catch(() => undefined)
		let raw = ''
		try {
			raw = await this.io.read(file)
		} catch {
			return false
		}
		// 内容和刚写下去的一模一样 → 这条 modify 是我们自己造成的，不必刷新界面；
		// 但内存里没有这本书时（回收站恢复前 store.delete 清过缓存）仍要读入，否则打开会拿空数据覆盖
		if (this.lastWritten.get(id) === raw && this.cache.has(id)) return false
		let data: BookData | null = null
		try {
			data = JSON.parse(raw) as BookData
		} catch {
			data = null
		}
		if (!data) {
			const repaired = await this.#readWithRepair(id, file)
			if (!repaired) return false
			data = repaired
		}
		this.#normalize(data)
		const previous = this.cache.get(id)
		this.lastWritten.set(id, raw)
		if (!previous) {
			this.cache.set(id, data)
			this.#rememberKnown(data)
			return true
		}
		// 多设备同步时，另一台可能带着旧内容把文件写回来：
		// 批注/书签按 id 合并，删除墓碑优先；进度按 updatedAt 取新。
		const merged: BookData = { ...data, ...mergeTrackedCollections(data, previous) }
		const localNewer = previous.lastLocation
			&& (!merged.lastLocation || previous.lastLocation.updatedAt > merged.lastLocation.updatedAt)
		if (localNewer) merged.lastLocation = previous.lastLocation
		this.#normalize(merged)
		// 合并结果和磁盘内容不同（本机有更新的批注/墓碑）才写回，避免两台设备来回空写
		const changed = mergeSignature(merged) !== mergeSignature(data)
		this.cache.set(id, merged)
		this.#rememberKnown(merged)
		if (changed) this.save(merged)
		return true
	}

	hasDataFor(vaultPath: string): boolean {
		return this.cache.has(this.bookId(vaultPath))
	}

	/** 书改名/移动后把批注数据迁到新路径 ID 下；新旧任一侧缺数据或新路径已有数据则不动 */
	migrateData(oldPath: string, newPath: string): void {
		const oldId = this.bookId(oldPath)
		const newId = this.bookId(newPath)
		if (oldId === newId) return
		const data = this.cache.get(oldId)
		if (!data || this.cache.has(newId)) return
		this.cache.delete(oldId)
		data.bookPath = newPath
		this.cache.set(newId, data)
		void (async () => {
			try {
				await this.io.mkdir(this.booksDir)
				await this.io.rename(this.fileFor(oldId), this.fileFor(newId))
			} catch (e) {
				console.error('[Grove Reader] 批注数据迁移失败', e)
			}
			this.save(data)
		})()
	}

	save(data: BookData): void {
		if (this.preloadError) {
			// 读不到旧数据时不要写：否则会用一份空数据覆盖掉磁盘上的批注
			return
		}
		this.#normalize(data)
		const id = this.bookId(data.bookPath)
		// 先按这个对象自身的已知 id 记墓碑（视图删掉的条目在这里补删除时间）
		this.#recordTombstones(data)
		const existing = this.cache.get(id)
		let target = data
		if (existing && existing !== data) {
			// 视图可能还拿着同步前的旧对象：保存时与缓存里的合并结果再并一次，
			// 避免它把另一台设备刚同步进来的批注/书签覆盖掉。
			target = { ...existing, ...data, ...mergeTrackedCollections(existing, data) }
			if (existing.lastLocation
				&& (!target.lastLocation || existing.lastLocation.updatedAt > target.lastLocation.updatedAt)) {
				target.lastLocation = existing.lastLocation
			}
			this.#normalize(target)
		}
		this.cache.set(id, target)
		this.#rememberKnown(target)
		this.#enqueue(id, target)
	}

	/** 等待所有排队中的写入落盘（视图关闭、插件卸载、测试断言前调用） */
	async flush(): Promise<void> {
		await Promise.all([...this.writes.values()])
	}

	/** 清掉某本书记录的笔记路径（笔记已删除时用），不动批注 */
	clearNotePath(vaultPath: string): void {
		const data = this.load(vaultPath)
		if (!data.notePath) return
		data.notePath = undefined
		this.save(data)
	}

	/** 删除某本书的全部批注数据与自动备份（书籍文件由调用方处理） */
	delete(vaultPath: string): void {
		const id = this.bookId(vaultPath)
		this.cache.delete(id)
		void (async () => {
			try {
				await this.io.remove(this.fileFor(id))
			} catch (e) {
				console.error('[Grove Reader] 删除批注数据失败', e)
			}
			try {
				await this.io.removeDir(this.backupsDir(id))
			} catch {
				// 没有备份目录是常态
			}
		})()
	}

	/** 记录「这个对象这次保存时有哪些批注/书签」，供下一次保存对比出删除项 */
	#rememberKnown(data: BookData): void {
		this.known.set(data, {
			annotations: new Set(data.annotations.map(item => item.id)),
			bookmarks: new Set((data.bookmarks ?? []).map(item => item.id)),
		})
	}

	/**
	 * 对比同一个数据对象上一次保存的已知 id：本次少掉的批注/书签就是用户删掉的，补一条墓碑。
	 * 视图层不用逐处改删除逻辑，统一在这里兜底；没见过的对象只建立基线，不产生墓碑。
	 */
	#recordTombstones(data: BookData): void {
		const known = this.known.get(data)
		if (!known) return
		const now = Date.now()
		const currentAnnotations = new Set(data.annotations.map(item => item.id))
		const deadAnnotations = { ...(data.deletedAnnotations ?? {}) }
		let annotationsChanged = false
		for (const oldId of known.annotations) {
			if (currentAnnotations.has(oldId) || deadAnnotations[oldId]) continue
			deadAnnotations[oldId] = now
			annotationsChanged = true
		}
		if (annotationsChanged) data.deletedAnnotations = deadAnnotations
		const currentBookmarks = new Set((data.bookmarks ?? []).map(item => item.id))
		const deadBookmarks = { ...(data.deletedBookmarks ?? {}) }
		let bookmarksChanged = false
		for (const oldId of known.bookmarks) {
			if (currentBookmarks.has(oldId) || deadBookmarks[oldId]) continue
			deadBookmarks[oldId] = now
			bookmarksChanged = true
		}
		if (bookmarksChanged) data.deletedBookmarks = deadBookmarks
	}

	#enqueue(id: string, data: BookData): void {
		const prev = this.writes.get(id) ?? Promise.resolve()
		const next = prev
			.catch(() => undefined)
			.then(() => this.#persist(id, data))
			.catch(e => {
				// 保存永不抛出（iCloud/杀软锁文件是常态环境），错误经回调上报
				this.onError?.(e instanceof Error ? e : new Error(String(e)))
			})
		this.writes.set(id, next)
		void next.finally(() => {
			if (this.writes.get(id) === next) this.writes.delete(id)
		})
	}

	async #persist(id: string, data: BookData): Promise<void> {
		await this.io.mkdir(this.booksDir)
		const file = this.fileFor(id)
		const tmp = `${file}.tmp`
		const text = JSON.stringify(data, null, 2)
		await this.io.write(tmp, text)
		if (await this.io.exists(file)) await this.#maybeBackup(id, file)
		try {
			await this.io.rename(tmp, file)
		} catch {
			// iCloud 同步/杀软可能锁定目标导致 rename 被拒（EPERM）：
			// 降级为拷贝写入（失去原子性但保证数据落盘）
			try {
				await this.io.copy(tmp, file)
				await this.io.remove(tmp)
			} catch (copyErr) {
				try {
					await this.io.remove(tmp)
				} catch {
					// ignore
				}
				throw copyErr
			}
		}
		this.lastWritten.set(id, text)
	}

	#normalize(data: BookData): void {
		if (!Array.isArray(data.annotations)) data.annotations = []
		for (const a of data.annotations) {
			if (typeof a.text !== 'string') (a as unknown as { text: string }).text = String((a as unknown as { text?: unknown }).text ?? '')
		}
		// 书签是后加的字段：旧数据没有，补空数组；坏的条目直接丢掉
		if (!Array.isArray(data.bookmarks)) data.bookmarks = []
		else data.bookmarks = data.bookmarks.filter(b => b && typeof b.cfi === 'string' && typeof b.id === 'string')
		// 删除墓碑：清掉过期与坏值，空对象不落盘
		const deadAnnotations = pruneTombstones(data.deletedAnnotations)
		if (Object.keys(deadAnnotations).length) data.deletedAnnotations = deadAnnotations
		else delete data.deletedAnnotations
		const deadBookmarks = pruneTombstones(data.deletedBookmarks)
		if (Object.keys(deadBookmarks).length) data.deletedBookmarks = deadBookmarks
		else delete data.deletedBookmarks
		if (typeof data.version !== 'number') data.version = DATA_VERSION
		if (typeof data.title !== 'string') data.title = ''
		if (typeof data.author !== 'string') data.author = ''
		// 与书架一致：洗掉下载站前缀/截图后缀/OCR 标记，并去掉标题尾部的作者括号
		if (data.title) data.title = stripTitleAuthor(cleanBookTitle(stripNumericTitlePrefix(data.title)), data.author)
		if (typeof data.templateId !== 'string' || !data.templateId) delete data.templateId
		// 手动阅读状态只认四个值；手改坏的数据当作未设置
		if (data.readingStatus && !['want', 'reading', 'done', 'unread'].includes(data.readingStatus)) {
			delete data.readingStatus
		}
	}

	/** 在内存里按 bookPath / 唯一文件名找回旧 ID 的数据，并把它挂到新 ID 下 */
	#recoverInCache(id: string, vaultPath: string): BookData | null {
		let exactKey: string | null = null
		const byName: string[] = []
		for (const [key, data] of this.cache) {
			if (typeof data.bookPath !== 'string') continue
			if (data.bookPath === vaultPath) {
				exactKey = key
				break
			}
			if (basenameOf(data.bookPath) === basenameOf(vaultPath)) byName.push(key)
		}
		const chosen = exactKey ?? (byName.length === 1 ? byName[0] : null)
		if (!chosen) return null
		const data = this.cache.get(chosen)
		if (!data) return null
		this.cache.delete(chosen)
		data.bookPath = vaultPath
		this.cache.set(id, data)
		// 文件改名放到后台，读路径不等 IO
		void (async () => {
			try {
				await this.io.rename(this.fileFor(chosen), this.fileFor(id))
			} catch {
				// 旧文件可能已被移走，不影响内存数据
			}
			this.save(data)
		})()
		return data
	}

	async #readWithRepair(id: string, file: string): Promise<BookData | null> {
		try {
			return JSON.parse(await this.io.read(file)) as BookData
		} catch {
			// 主文件损坏：移开留档，再尝试从最新备份恢复
			try {
				await this.io.rename(file, `${file}.corrupt-${Date.now()}`)
			} catch {
				// ignore
			}
			for (const backup of await this.#listBackups(id)) {
				try {
					const data = JSON.parse(await this.io.read(backup)) as BookData
					await this.io.write(file, JSON.stringify(data, null, 2))
					return data
				} catch {
					continue
				}
			}
			return null
		}
	}

	async #listBackups(id: string): Promise<string[]> {
		try {
			const listed = await this.io.list(this.backupsDir(id))
			return listed.files.filter(f => f.endsWith('.json')).sort().reverse()
		} catch {
			return []
		}
	}

	/** 清理进程被杀留下的陈旧 .tmp（写入后被杀会残留在 books 目录）；只动一天以上的，避免误删正在写的 */
	async #cleanStaleTmp(): Promise<void> {
		try {
			const listed = await this.io.list(this.booksDir)
			const now = Date.now()
			for (const file of listed.files) {
				if (!file.endsWith('.tmp')) continue
				try {
					const stat = await this.io.stat(file)
					if (stat && now - stat.mtime > 24 * 60 * 60 * 1000) await this.io.remove(file)
				} catch {
					// ignore
				}
			}
		} catch {
			// 目录不存在
		}
	}

	async #maybeBackup(id: string, file: string): Promise<void> {
		if (this.maxBackups <= 0) return
		const backups = await this.#listBackups(id)
		const latest = backups[0]
		if (latest) {
			try {
				const stat = await this.io.stat(latest)
				if (stat && Date.now() - stat.mtime < BACKUP_INTERVAL_MS) return
			} catch {
				// 备份文件状态异常则继续写新备份
			}
		}
		await this.io.mkdir(this.backupsDir(id))
		await this.io.copy(file, joinPath(this.backupsDir(id), `${Date.now()}.json`))
		const after = await this.#listBackups(id)
		for (const stale of after.slice(this.maxBackups)) {
			try {
				await this.io.remove(stale)
			} catch {
				// ignore
			}
		}
	}
}
