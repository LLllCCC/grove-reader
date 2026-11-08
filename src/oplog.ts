import { PlatformIO, joinPath, readJsonFile, writeJsonFile } from './platformIO'

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
	private timer: ReturnType<typeof setTimeout> | null = null
	private queue: Promise<void> = Promise.resolve()

	constructor(
		rootDir: string,
		private io: PlatformIO,
	) {
		this.file = joinPath(rootDir, 'data', 'oplog.json')
	}

	async load(): Promise<void> {
		const parsed = await readJsonFile<OpEntry[]>(this.io, this.file)
		if (Array.isArray(parsed)) {
			this.entries = parsed
				.filter(e => e && typeof e.at === 'number' && typeof e.action === 'string')
				.slice(-MAX_ENTRIES)
		}
	}

	add(action: string, detail: string): void {
		const last = this.entries[this.entries.length - 1]
		// 同一个错误在 5 分钟内反复出现时只记一条，避免刷掉有用的记录
		if (last && last.action === action && last.detail === detail && Date.now() - last.at < 5 * 60_000) return
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

	#saveSoon(): void {
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
		const snapshot = [...this.entries]
		this.queue = this.queue
			.catch(() => undefined)
			.then(() => writeJsonFile(this.io, this.file, snapshot))
			.catch(e => {
				console.error('[Grove Reader] 操作记录写入失败', e)
			})
	}

	async flush(): Promise<void> {
		await this.queue
	}
}
