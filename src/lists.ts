import fs from 'node:fs'
import pathModule from 'node:path'
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
	private saveTimer: NodeJS.Timeout | null = null

	constructor(rootDir: string) {
		this.file = pathModule.join(rootDir, 'data', 'lists.json')
	}

	load(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as ListsFile
			if (parsed && Array.isArray(parsed.lists) && parsed.members && typeof parsed.members === 'object') {
				this.data = parsed
			}
		} catch {
			// 首次或损坏时使用空数据
		}
	}

	lists(): BookList[] {
		return this.data.lists
	}

	listIdOf(path: string): string | undefined {
		return this.data.members[path]
	}

	memberCount(id: string): number {
		let n = 0
		for (const lid of Object.values(this.data.members)) if (lid === id) n++
		return n
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
		try {
			fs.mkdirSync(pathModule.dirname(this.file), { recursive: true })
			const tmp = `${this.file}.tmp`
			fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf-8')
			fs.renameSync(tmp, this.file)
		} catch (e) {
			console.error('[Grove Reader] 书单数据写入失败', e)
		}
	}
}
