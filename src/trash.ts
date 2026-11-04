import fs from 'node:fs'
import pathModule from 'node:path'
import { bookIdFor, isAbsolutePath, randomId } from './util'
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

/**
 * 插件内回收站：删书时把原文件、阅读笔记、批注 JSON、封面一起移到
 * data/trash/<id>/，保留 30 天，可恢复或永久删除。
 * 这样即使 Obsidian 的删除设置是“永久删除”，插件内仍能救回来。
 */
export class TrashStore {
	private root: string
	private dataRoot: string
	private vaultBase: string

	constructor(dataRoot: string, vaultBase: string) {
		this.dataRoot = dataRoot
		// 放在书库根目录的隐藏文件夹里：和书库同盘（移动是瞬时 rename），
		// 又不会被 Obsidian 文件列表索引成大文件
		this.root = pathModule.join(dataRoot, '.trash')
		this.vaultBase = vaultBase
	}

	rootPath(): string {
		return this.root
	}

	list(): TrashEntry[] {
		let names: string[] = []
		try {
			names = fs.readdirSync(this.root)
		} catch {
			return []
		}
		const entries: TrashEntry[] = []
		for (const name of names) {
			const manifest = pathModule.join(this.root, name, 'manifest.json')
			try {
				const entry = JSON.parse(fs.readFileSync(manifest, 'utf-8')) as TrashEntry
				if (entry && entry.id && entry.bookPath) entries.push(entry)
			} catch {
				// 忽略损坏/临时目录
			}
		}
		return entries.sort((a, b) => b.deletedAt - a.deletedAt)
	}

	/** 把一批文件移入回收站；任一步失败会尽量回滚 */
	move(input: TrashInput): TrashEntry {
		const id = `${Date.now()}-${randomId()}`
		const dir = pathModule.join(this.root, id)
		fs.mkdirSync(dir, { recursive: true })
		const files: TrashEntry['files'] = {}
		const moved: Array<[string, string]> = []
		let size = 0

		const move = (src: string, destName: string): void => {
			if (!fs.existsSync(src)) return
			const dst = pathModule.join(dir, destName)
			try {
				size += fs.statSync(src).size
			} catch {
				// 大小只用于展示
			}
			moveFile(src, dst)
			moved.push([src, dst])
			files[destName.startsWith('book') ? 'book'
				: destName.startsWith('note') ? 'note'
				: destName.startsWith('cover') ? 'cover'
				: 'data'] = destName
		}

		try {
			move(this.resolve(input.bookPath), `book${pathModule.extname(input.bookPath)}`)
			if (input.notePath) move(this.resolve(input.notePath), 'note.md')
			if (input.dataFile) {
				move(pathModule.join(this.dataRoot, 'data', 'books', input.dataFile), 'data.json')
			}
			if (input.cover) {
				move(pathModule.join(this.dataRoot, 'data', 'covers', input.cover), `cover${pathModule.extname(input.cover)}`)
			}
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
			fs.writeFileSync(pathModule.join(dir, 'manifest.json'), JSON.stringify(entry, null, 2), 'utf-8')
			return entry
		} catch (e) {
			for (const [src, dst] of moved.reverse()) {
				try {
					moveFile(dst, src)
				} catch {
					// 回滚失败时保留现场，错误信息里说明
				}
			}
			fs.rmSync(dir, { recursive: true, force: true })
			throw e
		}
	}

	/** 恢复到原路径；目标已存在时抛错，避免覆盖 */
	restore(id: string): TrashEntry {
		const dir = pathModule.join(this.root, id)
		const manifest = pathModule.join(dir, 'manifest.json')
		const entry = JSON.parse(fs.readFileSync(manifest, 'utf-8')) as TrashEntry
		const bookTarget = this.resolve(entry.bookPath)
		const noteTarget = entry.notePath ? this.resolve(entry.notePath) : ''
		const dataTarget = entry.dataFile ? pathModule.join(this.dataRoot, 'data', 'books', entry.dataFile) : ''
		const coverTarget = entry.cover ? pathModule.join(this.dataRoot, 'data', 'covers', entry.cover) : ''

		if (entry.files.book && fs.existsSync(bookTarget)) throw new Error('原位置已有同名书籍文件，请先移走再恢复')
		if (entry.files.note && noteTarget && fs.existsSync(noteTarget)) throw new Error('原位置已有同名笔记，请先移走再恢复')
		if (entry.files.data && dataTarget && fs.existsSync(dataTarget)) throw new Error('这本书已有新的批注数据，请先备份再恢复')

		const moved: Array<[string, string]> = []
		let coverRestored = false
		try {
			if (entry.files.book) {
				moveFile(pathModule.join(dir, entry.files.book), bookTarget)
				moved.push([pathModule.join(dir, entry.files.book), bookTarget])
			}
			if (entry.files.note && noteTarget) {
				moveFile(pathModule.join(dir, entry.files.note), noteTarget)
				moved.push([pathModule.join(dir, entry.files.note), noteTarget])
			}
			if (entry.files.data && dataTarget) {
				moveFile(pathModule.join(dir, entry.files.data), dataTarget)
				moved.push([pathModule.join(dir, entry.files.data), dataTarget])
			}
			if (entry.files.cover && coverTarget) {
				if (fs.existsSync(coverTarget)) {
					// 已有同名封面时以现有为准，不覆盖；书架仍指向这个名字
					fs.rmSync(pathModule.join(dir, entry.files.cover), { force: true })
					coverRestored = true
				} else {
					moveFile(pathModule.join(dir, entry.files.cover), coverTarget)
					moved.push([pathModule.join(dir, entry.files.cover), coverTarget])
					coverRestored = true
				}
			}
		} catch (e) {
			for (const [src, dst] of moved.reverse()) {
				try {
					moveFile(dst, src)
				} catch {
					// 保留现场
				}
			}
			throw e
		}

		fs.rmSync(dir, { recursive: true, force: true })
		if (!coverRestored) {
			delete entry.files.cover
			if (entry.shelfEntry) delete entry.shelfEntry.cover
		}
		return entry
	}

	purge(id: string): void {
		fs.rmSync(pathModule.join(this.root, id), { recursive: true, force: true })
	}

	empty(): number {
		let names: string[] = []
		try {
			names = fs.readdirSync(this.root)
		} catch {
			return 0
		}
		let count = 0
		for (const name of names) {
			try {
				fs.rmSync(pathModule.join(this.root, name), { recursive: true, force: true })
				count++
			} catch {
				// 跳过占用中的文件
			}
		}
		return count
	}

	purgeExpired(days = RETENTION_DAYS): number {
		const cutoff = Date.now() - days * 86_400_000
		let count = 0
		for (const entry of this.list()) {
			if (entry.deletedAt < cutoff) {
				try {
					this.purge(entry.id)
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

	private resolve(p: string): string {
		return isAbsolutePath(p) ? p : pathModule.join(this.vaultBase, p)
	}
}

function moveFile(src: string, dst: string): void {
	fs.mkdirSync(pathModule.dirname(dst), { recursive: true })
	try {
		fs.renameSync(src, dst)
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code
		if (code !== 'EXDEV') throw e
		fs.copyFileSync(src, dst)
		fs.unlinkSync(src)
	}
}

export function trashDataFile(dataRoot: string, bookPath: string): string {
	return pathModule.join(dataRoot, 'data', 'books', `${bookIdFor(bookPath)}.json`)
}
