import { BookData, DATA_VERSION } from './types'
import { PlatformIO, baseName, joinPath, stripExt } from './platformIO'
import { basenameOf, bookIdFor, cleanBookTitle, stripNumericTitlePrefix, stripTitleAuthor } from './util'

const BACKUP_INTERVAL_MS = 10 * 60 * 1000

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
		// 内容和刚写下去的一模一样 → 这条 modify 是我们自己造成的，不必刷新界面
		if (this.lastWritten.get(id) === raw) return false
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
		this.cache.set(id, data)
		this.lastWritten.set(id, raw)
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
		this.cache.set(id, data)
		this.#enqueue(id, data)
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
		if (typeof data.version !== 'number') data.version = DATA_VERSION
		if (typeof data.title !== 'string') data.title = ''
		if (typeof data.author !== 'string') data.author = ''
		// 与书架一致：洗掉下载站前缀/截图后缀/OCR 标记，并去掉标题尾部的作者括号
		if (data.title) data.title = stripTitleAuthor(cleanBookTitle(stripNumericTitlePrefix(data.title)), data.author)
		if (typeof data.templateId !== 'string' || !data.templateId) delete data.templateId
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
