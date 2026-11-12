import { isAbsolutePath, randomId } from './util'
import { dirName, joinPath, readJsonFile, PlatformIO } from './platformIO'
import type { ShelfEntry } from './bookshelf'
import type { StatsBook } from './stats'

export interface TrashEntry {
	id: string
	deletedAt: number
	title: string
	bookPath: string
	notePath?: string
	dataFile?: string
	cover?: string
	shelfEntry?: ShelfEntry | null
	statsEntry?: StatsBook | null
	listId?: string
	size: number
	files: {
		book?: string
		note?: string
		data?: string
		cover?: string
	}
}

export interface TrashInput {
	title: string
	bookPath: string
	notePath?: string
	dataFile?: string
	cover?: string
	shelfEntry?: ShelfEntry | null
	statsEntry?: StatsBook | null
	listId?: string
}

const RETENTION_DAYS = 30

/** 取扩展名（含点）；没有扩展名时返回空串 */
function extOf(p: string): string {
	const base = p.replace(/\\/g, '/').split('/').pop() ?? ''
	const i = base.lastIndexOf('.')
	return i > 0 ? base.slice(i) : ''
}

/**
 * 插件内回收站：删书时把原文件、阅读笔记、批注 JSON、封面一起移到
 * data/.trash/<id>/，保留 30 天，可恢复或永久删除。
 *
 * 走 PlatformIO（桌面 Node fs / 手机 vault.adapter），所以手机端也能用。
 * 手机端所有路径都是库内相对路径，移动会在库内 rename，不会跨盘。
 */
export class TrashStore {
	private root: string

	constructor(
		private dataRoot: string,
		private io: PlatformIO,
		/** 桌面端为库根绝对路径；手机端传空串（路径本身就是库内相对路径） */
		private vaultPath = '',
	) {
		// 放在书库根目录的隐藏文件夹里：和书库同盘（移动是瞬时 rename），
		// 又不会被 Obsidian 文件列表索引成大文件
		this.root = joinPath(dataRoot, '.trash')
	}

	rootPath(): string {
		return this.root
	}

	async list(): Promise<TrashEntry[]> {
		let folders: string[] = []
		try {
			const listed = await this.io.list(this.root)
			folders = listed.folders
		} catch {
			return []
		}
		const entries: TrashEntry[] = []
		for (const dir of folders) {
			const entry = await readJsonFile<TrashEntry>(this.io, joinPath(dir, 'manifest.json'))
			if (entry && entry.id && entry.bookPath) entries.push(entry)
		}
		return entries.sort((a, b) => b.deletedAt - a.deletedAt)
	}

	/** 把一批文件移入回收站；任一步失败会尽量回滚 */
	async move(input: TrashInput): Promise<TrashEntry> {
		const id = `${Date.now()}-${randomId()}`
		const dir = joinPath(this.root, id)
		await this.io.mkdir(dir)
		const files: TrashEntry['files'] = {}
		const moved: Array<[string, string]> = []
		let size = 0

		const moveOne = async (src: string, destName: string): Promise<boolean> => {
			if (!(await this.io.exists(src))) return false
			try {
				const st = await this.io.stat(src)
				if (st) size += st.size
			} catch {
				// 大小只用于展示
			}
			const dst = joinPath(dir, destName)
			await this.moveFile(src, dst)
			moved.push([src, dst])
			if (destName.startsWith('book')) files.book = destName
			else if (destName.startsWith('note')) files.note = destName
			else if (destName.startsWith('cover')) files.cover = destName
			else files.data = destName
			return true
		}

		try {
			await moveOne(this.resolve(input.bookPath), `book${extOf(input.bookPath)}`)
			if (input.notePath) await moveOne(this.resolve(input.notePath), 'note.md')
			if (input.dataFile) await moveOne(joinPath(this.dataRoot, 'data', 'books', input.dataFile), 'data.json')
			if (input.cover) await moveOne(joinPath(this.dataRoot, 'data', 'covers', input.cover), `cover${extOf(input.cover)}`)
			const entry: TrashEntry = {
				id,
				deletedAt: Date.now(),
				title: input.title,
				bookPath: input.bookPath,
				notePath: input.notePath,
				dataFile: input.dataFile,
				cover: input.cover,
				shelfEntry: input.shelfEntry ?? null,
				statsEntry: input.statsEntry ?? null,
				listId: input.listId,
				size,
				files,
			}
			await this.io.write(joinPath(dir, 'manifest.json'), JSON.stringify(entry, null, 2))
			return entry
		} catch (e) {
			for (const [src, dst] of moved.reverse()) {
				try {
					await this.moveFile(dst, src)
				} catch {
					// 回滚失败时保留现场，错误信息里说明
				}
			}
			try {
				await this.io.removeDir(dir)
			} catch {
				// ignore
			}
			throw e
		}
	}

	/** 恢复到原路径；目标已存在时抛错，避免覆盖 */
	async restore(id: string): Promise<TrashEntry> {
		const dir = joinPath(this.root, id)
		const entry = await readJsonFile<TrashEntry>(this.io, joinPath(dir, 'manifest.json'))
		if (!entry) throw new Error('回收站记录已损坏，无法恢复')
		const bookTarget = this.resolve(entry.bookPath)
		const noteTarget = entry.notePath ? this.resolve(entry.notePath) : ''
		const dataTarget = entry.dataFile ? joinPath(this.dataRoot, 'data', 'books', entry.dataFile) : ''
		const coverTarget = entry.cover ? joinPath(this.dataRoot, 'data', 'covers', entry.cover) : ''

		if (entry.files.book && (await this.io.exists(bookTarget))) throw new Error('原位置已有同名书籍文件，请先移走再恢复')
		if (entry.files.note && noteTarget && (await this.io.exists(noteTarget))) throw new Error('原位置已有同名笔记，请先移走再恢复')
		if (entry.files.data && dataTarget && (await this.io.exists(dataTarget))) throw new Error('这本书已有新的批注数据，请先备份再恢复')

		const moved: Array<[string, string]> = []
		let coverRestored = false
		try {
			if (entry.files.book) {
				const from = joinPath(dir, entry.files.book)
				await this.moveFile(from, bookTarget)
				moved.push([from, bookTarget])
			}
			if (entry.files.note && noteTarget) {
				const from = joinPath(dir, entry.files.note)
				await this.moveFile(from, noteTarget)
				moved.push([from, noteTarget])
			}
			if (entry.files.data && dataTarget) {
				const from = joinPath(dir, entry.files.data)
				await this.moveFile(from, dataTarget)
				moved.push([from, dataTarget])
			}
			if (entry.files.cover && coverTarget) {
				const from = joinPath(dir, entry.files.cover)
				if (await this.io.exists(coverTarget)) {
					// 已有同名封面时以现有为准，不覆盖；书架仍指向这个名字
					await this.io.remove(from)
					coverRestored = true
				} else {
					await this.moveFile(from, coverTarget)
					moved.push([from, coverTarget])
					coverRestored = true
				}
			}
		} catch (e) {
			for (const [src, dst] of moved.reverse()) {
				try {
					await this.moveFile(dst, src)
				} catch {
					// 保留现场
				}
			}
			throw e
		}

		await this.io.removeDir(dir)
		if (!coverRestored) {
			delete entry.files.cover
			if (entry.shelfEntry) delete entry.shelfEntry.cover
		}
		return entry
	}

	async purge(id: string): Promise<void> {
		const dir = joinPath(this.root, id)
		// Windows 上刚移进来的文件可能还被索引/杀软占着，直接删会报 ENOTEMPTY：
		// 等一拍重试两次再放弃，避免用户点「永久删除」当场看到失败
		for (let attempt = 0; ; attempt++) {
			try {
				await this.io.removeDir(dir)
				return
			} catch (e) {
				if (attempt >= 2) throw e
				await new Promise(resolve => setTimeout(resolve, 120))
			}
		}
	}

	async empty(): Promise<number> {
		let folders: string[] = []
		try {
			folders = (await this.io.list(this.root)).folders
		} catch {
			return 0
		}
		let count = 0
		for (const dir of folders) {
			try {
				await this.io.removeDir(dir)
				count++
			} catch {
				// 跳过占用中的文件
			}
		}
		return count
	}

	async purgeExpired(days = RETENTION_DAYS): Promise<number> {
		const cutoff = Date.now() - days * 86_400_000
		let count = 0
		for (const entry of await this.list()) {
			if (entry.deletedAt < cutoff) {
				try {
					await this.purge(entry.id)
					count++
				} catch {
					// 下次再试
				}
			}
		}
		return count
	}

	retentionDays(): number {
		return RETENTION_DAYS
	}

	/** 同盘 rename；跨盘（EXDEV）或手机端 adapter 不支持时降级为复制后删除 */
	private async moveFile(src: string, dst: string): Promise<void> {
		const parent = dirName(dst)
		if (parent) await this.io.mkdir(parent)
		try {
			await this.io.rename(src, dst)
			return
		} catch {
			await this.io.copy(src, dst)
			await this.io.remove(src)
		}
	}

	private resolve(p: string): string {
		return isAbsolutePath(p) || !this.vaultPath ? p : joinPath(this.vaultPath, p)
	}
}
