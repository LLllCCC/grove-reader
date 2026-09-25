import fs from 'node:fs'
import path from 'node:path'

export interface StatsDay {
	/** 当日累计阅读秒数 */
	seconds: number
	/** 当日翻页/换节次数 */
	pages: number
}

export interface StatsBook {
	/** 累计阅读秒数 */
	seconds: number
	/** 累计翻页/换节次数 */
	pages: number
	/** 按日（本地时区 YYYY-MM-DD）明细 */
	days: Record<string, StatsDay>
	/** 最近一次阅读时间戳 */
	lastRead: number
}

interface StatsFile {
	version: 1
	books: Record<string, StatsBook>
}

export function todayKey(d = new Date()): string {
	const p = (n: number): string => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 阅读统计存储：data/stats.json，按书记录累计时长/翻页数与按日明细。
 * 写入采用与其他存储一致的防抖 + 临时文件原子重命名。
 */
export class StatsStore {
	private data: StatsFile = { version: 1, books: {} }
	private saveTimer: NodeJS.Timeout | null = null

	constructor(private file: string) {}

	load(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as StatsFile
			if (parsed && typeof parsed === 'object' && parsed.books && typeof parsed.books === 'object') {
				this.data = parsed
			}
		} catch {
			// 首次或损坏时使用空数据
		}
	}

	book(bookPath: string): StatsBook {
		let b = this.data.books[bookPath]
		if (!b) {
			b = { seconds: 0, pages: 0, days: {}, lastRead: 0 }
			this.data.books[bookPath] = b
		}
		return b
	}

	/** 记一次采样：阅读了 seconds 秒、翻了 pages 页 */
	record(bookPath: string, seconds: number, pages: number, now = Date.now()): void {
		const day = todayKey(new Date(now))
		const b = this.book(bookPath)
		b.seconds += seconds
		b.pages += pages
		const d = b.days[day] ?? { seconds: 0, pages: 0 }
		d.seconds += seconds
		d.pages += pages
		b.days[day] = d
		b.lastRead = now
		this.saveSoon()
	}

	sortedBooks(): Array<[string, StatsBook]> {
		return Object.entries(this.data.books).sort((a, b) => b[1].lastRead - a[1].lastRead)
	}

	/** 最近 n 天（含今天，旧的在前）的合并日统计 */
	recentDays(n: number, now = new Date()): Array<{ day: string; seconds: number; pages: number }> {
		const out: Array<{ day: string; seconds: number; pages: number }> = []
		for (let i = n - 1; i >= 0; i--) {
			const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
			const key = todayKey(d)
			let seconds = 0
			let pages = 0
			for (const b of Object.values(this.data.books)) {
				const s = b.days[key]
				if (s) {
					seconds += s.seconds
					pages += s.pages
				}
			}
			out.push({ day: key, seconds, pages })
		}
		return out
	}

	private saveSoon(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer)
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null
			this.saveNow()
		}, 2000)
	}

	/** 同步写入：文件只有几 KB 且 2s 防抖，不值得为它占用线程池 */
	saveNow(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer)
			this.saveTimer = null
		}
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true })
			const tmp = `${this.file}.tmp`
			fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf-8')
			fs.renameSync(tmp, this.file)
		} catch (e) {
			console.error('[Grove Reader] 阅读统计写入失败', e)
		}
	}
}
