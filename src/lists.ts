import { PlatformIO, joinPath, readJsonFile, writeJsonFile } from './platformIO'
import { randomId } from './util'

// ------------------------------------------------------------------
// 书单：书架内的分组。一本书最多属于一个书单（类似文件夹），
// 归属按书籍路径记录，存于插件数据目录 data/lists.json
// ------------------------------------------------------------------

export interface BookList {
	id: string
	name: string
}

interface ListsFile {
	version: number
	lists: BookList[]
	/** 书籍路径 → 书单 id；不在任何书单的书籍不记录 */
	members: Record<string, string>
}

export class ListsStore {
	private file: string
	private data: ListsFile = { version: 1, lists: [], members: {} }
	private saveTimer: ReturnType<typeof setTimeout> | null = null
	private queue: Promise<void> = Promise.resolve()

	constructor(
		rootDir: string,
		private io: PlatformIO,
	) {
		this.file = joinPath(rootDir, 'data', 'lists.json')
	}

	async load(): Promise<void> {
		const parsed = await readJsonFile<ListsFile>(this.io, this.file)
		if (parsed && Array.isArray(parsed.lists) && parsed.members && typeof parsed.members === 'object') {
			this.data = parsed
		}
	}

	lists(): BookList[] {
		return this.data.lists
	}

	listIdOf(path: string): string | undefined {
		return this.data.members[path]
	}

	create(name: string): BookList {
		const list: BookList = { id: randomId(), name }
		this.data.lists.push(list)
		this.saveSoon()
		return list
	}

	rename(id: string, name: string): void {
		const list = this.data.lists.find(l => l.id === id)
		if (list) {
			list.name = name
			this.saveSoon()
		}
	}

	remove(id: string): void {
		this.data.lists = this.data.lists.filter(l => l.id !== id)
		for (const [p, lid] of Object.entries(this.data.members)) {
			if (lid === id) delete this.data.members[p]
		}
		this.saveSoon()
	}

	/** listId 传 null 表示移出所有书单 */
	setMember(path: string, listId: string | null): void {
		if (listId) this.data.members[path] = listId
		else delete this.data.members[path]
		this.saveSoon()
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
				console.error('[Grove Reader] 书单数据写入失败', e)
			})
	}

	async flush(): Promise<void> {
		await this.queue
	}
}
