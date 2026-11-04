import fs from 'node:fs'
import pathModule from 'node:path'

export interface OpEntry {
	at: number
	action: string
	detail: string
}

const MAX_ENTRIES = 200

/**
 * 关键操作记录：只记删除书籍、清空批注、恢复隐藏、备份失败等低频但重要的动作，
 * 不记翻页、搜索这类高频事件。最多保留 200 条，写入 data/oplog.json。
 */
export class OpLog {
	private file: string
	private entries: OpEntry[] = []
	private timer: NodeJS.Timeout | null = null

	constructor(rootDir: string) {
		this.file = pathModule.join(rootDir, 'data', 'oplog.json')
	}

	load(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as OpEntry[]
			if (Array.isArray(parsed)) {
				this.entries = parsed
					.filter(e => e && typeof e.at === 'number' && typeof e.action === 'string')
					.slice(-MAX_ENTRIES)
			}
		} catch {
			// 首次或损坏时使用空记录
		}
	}

	add(action: string, detail: string): void {
		this.entries.push({ at: Date.now(), action, detail })
		if (this.entries.length > MAX_ENTRIES) {
			this.entries.splice(0, this.entries.length - MAX_ENTRIES)
		}
		this.#saveSoon()
	}

	/** 最新的在前 */
	list(): OpEntry[] {
		return [...this.entries].reverse()
	}

	clear(): void {
		this.entries = []
		this.saveNow()
	}

	private #saveSoon(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => {
			this.timer = null
			this.saveNow()
		}, 800)
	}

	saveNow(): void {
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = null
		}
		try {
			fs.mkdirSync(pathModule.dirname(this.file), { recursive: true })
			const tmp = `${this.file}.tmp`
			fs.writeFileSync(tmp, JSON.stringify(this.entries), 'utf-8')
			fs.renameSync(tmp, this.file)
		} catch (e) {
			console.error('[Grove Reader] 操作记录写入失败', e)
		}
	}
}
