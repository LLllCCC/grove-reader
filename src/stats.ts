import { PlatformIO, readJsonFile, writeJsonFile } from './platformIO'

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

/** 采样节拍：15 秒一跳 */
export const STATS_TICK_MS = 15_000
/** 超过这么久没有任何交互，就不算在读书（接电话、吃饭、睡着） */
export const STATS_IDLE_MS = 60_000

/**
 * 这一拍该记多少秒。
 *
 * 记的是**这一拍的长度**，不是「距上次交互过了多久」。早先写成
 * `min(TICK, now - lastActive)`：翻页频繁时（每 2–5 秒一次）每个 15 秒
 * 采样只加 2–5 秒，一小时真实阅读能少记成十几分钟。
 *
 * 另外两条保险：
 *  - 距上次交互 ≥ IDLE 就记 0（开着书去吃饭不至于记成读了 40 分钟）；
 *  - 单拍最多按 2×TICK 计：系统休眠/标签页被挂起后回来，不能把整段空档补上。
 *
 * 纯函数，方便直接跑断言。
 */
export function accrueTick(input: {
	now: number
	lastTickAt: number
	lastActive: number
	idleMs?: number
	tickMs?: number
}): number {
	const idle = input.idleMs ?? STATS_IDLE_MS
	const tick = input.tickMs ?? STATS_TICK_MS
	const span = input.now - input.lastTickAt
	if (!Number.isFinite(span) || span <= 0) return 0
	if (!Number.isFinite(input.now) || !Number.isFinite(input.lastActive)) return 0
	if (input.now - input.lastActive >= idle) return 0
	return Math.round(Math.min(span, tick * 2) / 1000)
}

/**
 * 阅读统计存储：data/stats.json，按书记录累计时长/翻页数与按日明细。
 * 读：启动时 `await load()` 一次读进内存；写：防抖后异步原子落盘。
 */
export class StatsStore {
	private data: StatsFile = { version: 1, books: {} }
	private saveTimer: ReturnType<typeof setTimeout> | null = null
	private queue: Promise<void> = Promise.resolve()

	constructor(
		private file: string,
		private io: PlatformIO,
	) {}

	async load(): Promise<void> {
		const parsed = await readJsonFile<StatsFile>(this.io, this.file)
		if (parsed && typeof parsed === 'object' && parsed.books && typeof parsed.books === 'object') {
			this.data = parsed
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

	/** 恢复回收站时写回统计 */
	setBook(bookPath: string, data: StatsBook): void {
		this.data.books[bookPath] = data
		this.saveSoon()
	}

	/** 删除某本书的阅读统计（删书时调用） */
	remove(bookPath: string): void {
		if (this.data.books[bookPath]) {
			delete this.data.books[bookPath]
			this.saveSoon()
		}
	}

	/** 只读查询：书没有统计数据时返回 undefined，不会像 book() 那样凭空建档 */
	peek(bookPath: string): StatsBook | undefined {
		return this.data.books[bookPath]
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

	/** 所有书的按日合并统计（只含有记录的日期） */
	dailyTotals(): Map<string, StatsDay> {
		const out = new Map<string, StatsDay>()
		for (const book of Object.values(this.data.books)) {
			for (const [day, stat] of Object.entries(book.days ?? {})) {
				const current = out.get(day) ?? { seconds: 0, pages: 0 }
				current.seconds += stat.seconds
				current.pages += stat.pages
				out.set(day, current)
			}
		}
		return out
	}

	/** 连续阅读天数（今天没读时从昨天往前算）与历史最长连续天数 */
	streak(now = new Date()): { current: number; longest: number; activeDays: number } {
		const totals = this.dailyTotals()
		const active = [...totals.entries()]
			.filter(([, stat]) => stat.seconds > 0)
			.map(([day]) => day)
			.sort()
		const activeSet = new Set(active)
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
		if (!activeSet.has(todayKey(start))) start.setDate(start.getDate() - 1)
		let current = 0
		for (let d = new Date(start); activeSet.has(todayKey(d)); d.setDate(d.getDate() - 1)) {
			current++
		}
		let longest = 0
		let run = 0
		let prev: Date | null = null
		for (const day of active) {
			const date = new Date(`${day}T00:00:00`)
			if (prev && Math.round((date.getTime() - prev.getTime()) / 86_400_000) === 1) run++
			else run = 1
			if (run > longest) longest = run
			prev = date
		}
		return { current, longest, activeDays: active.length }
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

	/** 排队写盘；同一实例的写入严格串行 */
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
				console.error('[Grove Reader] 阅读统计写入失败', e)
			})
	}

	/** 等待所有排队写入落盘 */
	async flush(): Promise<void> {
		await this.queue
	}
}
