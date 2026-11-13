/**
 * 阅读进度条上的章节刻度与「剩余阅读时间」估算，EPUB / TXT / PDF 三套视图共用。
 *
 * 剩余时间不依赖页数：用「已读时长 ÷ 已读比例」外推总时长，再减去已读，
 * 这样不同格式、不同字号下都能用同一套估算。
 */

/** 剩余秒数；数据不足或比例太极端时返回 null（宁可不显示，也别给离谱数字） */
export function estimateRemainingSeconds(totalSeconds: number, fraction: number): number | null {
	if (!Number.isFinite(totalSeconds) || totalSeconds < 60) return null
	if (!Number.isFinite(fraction) || fraction <= 0.005 || fraction >= 0.995) return null
	const remain = (totalSeconds / fraction) * (1 - fraction)
	if (!Number.isFinite(remain) || remain <= 0) return null
	// 上限 400 小时：书再长也不至于读这么久，超过通常说明数据异常
	return Math.min(remain, 400 * 3600)
}

/** 「25 分钟」「1 小时 20 分」「5 天」；不足 1 分钟返回空串 */
export function formatRemaining(seconds: number): string {
	const min = Math.round(seconds / 60)
	if (min < 1) return ''
	if (min < 60) return `${min} 分钟`
	const h = Math.round(min / 60)
	// 超过两天就不必报到分钟：读到这个量级，精度没有意义
	if (h >= 48) return `${Math.round(h / 24)} 天`
	const m = min % 60
	return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

/** 拼到进度文字后面，例如「 · 剩 1 小时 20 分」；没有数据时为空串 */
export function remainingSuffix(totalSeconds: number | undefined, fraction: number | undefined): string {
	if (typeof totalSeconds !== 'number' || typeof fraction !== 'number') return ''
	const remain = estimateRemainingSeconds(totalSeconds, fraction)
	if (!remain) return ''
	const text = formatRemaining(remain)
	return text ? ` · 剩 ${text}` : ''
}

/** 从「章节起始偏移」换算成 0–1 的刻度位置，过滤重复与端点 */
export function chapterFractions(offsets: number[], total: number, maxTicks = 240): number[] {
	if (!Number.isFinite(total) || total <= 0) return []
	const out: number[] = []
	for (const offset of offsets) {
		if (!Number.isFinite(offset) || offset <= 0 || offset >= total) continue
		const f = offset / total
		if (out.length && f - out[out.length - 1] < 0.002) continue
		out.push(f)
	}
	if (out.length <= maxTicks) return out
	const step = Math.ceil(out.length / maxTicks)
	return out.filter((_, i) => i % step === 0)
}

/** 章节刻度层：放在进度条容器里，绝对定位，不拦截鼠标 */
export class ProgressTicks {
	private root: HTMLElement
	private tickEls: HTMLElement[] = []
	private fractions: number[] = []

	constructor(parent: HTMLElement) {
		this.root = parent.createDiv('grove-progress-ticks')
	}

	set(fractions: number[]): void {
		this.root.empty()
		this.tickEls = []
		this.fractions = []
		for (const raw of fractions) {
			const f = Math.max(0, Math.min(1, raw))
			const tick = this.root.createDiv('grove-progress-tick')
			tick.style.left = `${(f * 100).toFixed(2)}%`
			this.tickEls.push(tick)
			this.fractions.push(f)
		}
	}

	/** 高亮「当前所在章节」的刻度（最后一个 ≤ 当前进度的刻度） */
	highlight(fraction: number): void {
		let idx = -1
		for (let i = 0; i < this.fractions.length; i++) {
			if (this.fractions[i] <= fraction + 1e-4) idx = i
		}
		this.tickEls.forEach((tick, i) => tick.toggleClass('is-current', i === idx))
	}

	clear(): void {
		this.root.empty()
		this.tickEls = []
		this.fractions = []
	}
}

/** 一本书的累计阅读秒数（没有统计时返回 undefined） */
export function readSeconds(stats: { seconds?: number } | undefined): number | undefined {
	const seconds = stats?.seconds
	return typeof seconds === 'number' && seconds > 0 ? seconds : undefined
}
