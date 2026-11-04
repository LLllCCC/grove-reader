import fs from 'node:fs'
import path from 'node:path'
import { BookData, DATA_VERSION } from './types'
import { basenameOf, bookIdFor, cleanBookTitle, stripNumericTitlePrefix, stripTitleAuthor } from './util'

const BACKUP_INTERVAL_MS = 10 * 60 * 1000

/**
 * 批注数据存储：每本书一个 JSON 文件，写入采用「临时文件 + 原子重命名」，
 * 覆盖前按时间间隔滚动备份，主文件损坏时自动从备份恢复。
 */
export class BookStore {
	/** 保存失败时的回调（主进程用于弹 Notice） */
	onError?: (e: Error) => void

	constructor(
		public rootDir: string,
		public maxBackups: number,
	) {}

	private get booksDir(): string {
		return path.join(this.rootDir, 'data', 'books')
	}

	private fileFor(id: string): string {
		return path.join(this.booksDir, `${id}.json`)
	}

	private backupsDir(id: string): string {
		return path.join(this.rootDir, 'data', 'backups', id)
	}

	bookId(vaultPath: string): string {
		return bookIdFor(vaultPath)
	}

	fresh(vaultPath: string): BookData {
		return { version: DATA_VERSION, bookPath: vaultPath, title: '', author: '', annotations: [] }
	}

	load(vaultPath: string): BookData {
		const id = this.bookId(vaultPath)
		fs.mkdirSync(this.booksDir, { recursive: true })
		this.#cleanStaleTmp()
		let file = this.fileFor(id)
		if (!fs.existsSync(file)) {
			// 书被移动/重命名后 bookId 变了：按 bookPath 扫描找回旧数据
			const recovered = this.#recoverByBookPath(id, vaultPath)
			if (recovered) file = recovered
		}
		if (fs.existsSync(file)) {
			const data = this.#readWithRepair(id, file)
			if (data) {
				if (data.bookPath !== vaultPath) data.bookPath = vaultPath
				this.#normalize(data)
				return data
			}
		}
		return this.fresh(vaultPath)
	}

	getPathForBookId(id: string): string | null {
		const file = this.fileFor(id)
		if (!fs.existsSync(file)) return null
		try {
			const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { bookPath?: unknown }
			return typeof data?.bookPath === 'string' ? data.bookPath : null
		} catch {
			return null
		}
	}

	hasDataFor(vaultPath: string): boolean {
		return fs.existsSync(this.fileFor(this.bookId(vaultPath)))
	}

	/** 书改名/移动后把批注 JSON 迁到新路径 ID 下；新旧任一侧缺数据或新路径已有数据则不动 */
	migrateData(oldPath: string, newPath: string): void {
		const oldId = this.bookId(oldPath)
		const newId = this.bookId(newPath)
		if (oldId === newId) return
		const oldFile = this.fileFor(oldId)
		const newFile = this.fileFor(newId)
		if (!fs.existsSync(oldFile) || fs.existsSync(newFile)) return
		try {
			fs.renameSync(oldFile, newFile)
			const data = this.#readWithRepair(newId, newFile)
			if (data) {
				data.bookPath = newPath
				this.#saveInner(data)
			}
		} catch (e) {
			console.error('[Grove Reader] 批注数据迁移失败', e)
		}
	}

	save(data: BookData): void {
		try {
			this.#saveInner(data)
		} catch (e) {
			// 保存永不抛出（iCloud/杀软锁文件是常态环境），错误经回调上报
			this.onError?.(e instanceof Error ? e : new Error(String(e)))
		}
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
		try {
			fs.rmSync(this.fileFor(id), { force: true })
		} catch (e) {
			console.error('[Grove Reader] 删除批注数据失败', e)
		}
		try {
			fs.rmSync(this.backupsDir(id), { recursive: true, force: true })
		} catch {
			// 没有备份目录是常态
		}
	}

	#saveInner(data: BookData): void {
		this.#normalize(data)
		const id = this.bookId(data.bookPath)
		fs.mkdirSync(this.booksDir, { recursive: true })
		const file = this.fileFor(id)
		const tmp = `${file}.tmp`
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
		if (fs.existsSync(file)) this.#maybeBackup(id, file)
		try {
			fs.renameSync(tmp, file)
		} catch {
			// iCloud 同步/杀软可能锁定目标导致 rename 被拒（EPERM）：
			// 降级为拷贝写入（失去原子性但保证数据落盘）
			try {
				fs.copyFileSync(tmp, file)
				fs.rmSync(tmp, { force: true })
			} catch (copyErr) {
				try {
					fs.rmSync(tmp, { force: true })
				} catch {
					// ignore
				}
				throw copyErr
			}
		}
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

	#recoverByBookPath(id: string, vaultPath: string): string | null {
		let exact: string | null = null
		const byName: string[] = []
		try {
			for (const name of fs.readdirSync(this.booksDir)) {
				if (!name.endsWith('.json')) continue
				const candidate = path.join(this.booksDir, name)
				try {
					const data = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { bookPath?: unknown }
					if (typeof data?.bookPath !== 'string') continue
					if (data.bookPath === vaultPath) {
						exact = candidate
						break
					}
					if (basenameOf(data.bookPath) === basenameOf(vaultPath)) byName.push(candidate)
				} catch {
					// 跳过无法解析的文件
				}
			}
		} catch {
			return null
		}
		// 文件名匹配仅在唯一命中时使用，避免误认领
		const chosen = exact ?? (byName.length === 1 ? byName[0] : null)
		if (!chosen) return null
		try {
			const target = this.fileFor(id)
			fs.renameSync(chosen, target)
			return target
		} catch {
			return null
		}
	}

	#readWithRepair(id: string, file: string): BookData | null {
		try {
			return JSON.parse(fs.readFileSync(file, 'utf-8')) as BookData
		} catch {
			// 主文件损坏：移开留档，再尝试从最新备份恢复
			try {
				fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
			} catch {
				// ignore
			}
			for (const backup of this.#listBackups(id)) {
				try {
					const data = JSON.parse(fs.readFileSync(backup, 'utf-8')) as BookData
					fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
					return data
				} catch {
					continue
				}
			}
			return null
		}
	}

	#listBackups(id: string): string[] {
		try {
			const dir = this.backupsDir(id)
			return fs.readdirSync(dir)
				.filter(n => n.endsWith('.json'))
				.sort()
				.reverse()
				.map(n => path.join(dir, n))
		} catch {
			return []
		}
	}

	/** 清理进程被杀留下的陈旧 .tmp（写入后被杀会残留在 books 目录）；只动一天以上的，避免误删正在写的 */
	#cleanStaleTmp(): void {
		try {
			const now = Date.now()
			for (const name of fs.readdirSync(this.booksDir)) {
				if (!name.endsWith('.tmp')) continue
				const p = path.join(this.booksDir, name)
				try {
					if (now - fs.statSync(p).mtimeMs > 24 * 60 * 60 * 1000) fs.rmSync(p, { force: true })
				} catch {
					// ignore
				}
			}
		} catch {
			// 目录不存在
		}
	}

	#maybeBackup(id: string, file: string): void {
		if (this.maxBackups <= 0) return
		const backups = this.#listBackups(id)
		const latest = backups[0]
		if (latest) {
			try {
				if (Date.now() - fs.statSync(latest).mtimeMs < BACKUP_INTERVAL_MS) return
			} catch {
				// 备份文件状态异常则继续写新备份
			}
		}
		fs.mkdirSync(this.backupsDir(id), { recursive: true })
		fs.copyFileSync(file, path.join(this.backupsDir(id), `${Date.now()}.json`))
		for (const stale of this.#listBackups(id).slice(this.maxBackups)) {
			try {
				fs.unlinkSync(stale)
			} catch {
				// ignore
			}
		}
	}
}
