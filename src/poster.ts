import { t } from './i18n'

/** 阅读海报：把统计渲染成一张 1080×1440 的 PNG（不依赖 DOM，smoke 之外只在阅读统计弹窗调用）。 */

export interface PosterDay {
	day: string
	seconds: number
}

export interface PosterBook {
	title: string
	seconds: number
}

export interface PosterInput {
	/** 生成日期（本地） */
	date: Date
	todaySeconds: number
	totalSeconds: number
	streakCurrent: number
	streakLongest: number
	activeDays: number
	checkins: number
	days: PosterDay[]
	books: PosterBook[]
}

export function posterFileName(date = new Date()): string {
	const p = (n: number): string => String(n).padStart(2, '0')
	return `阅读海报-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.png`
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${Math.max(0, Math.round(seconds))} 秒`
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return `${minutes} 分钟`
	return `${(minutes / 60).toFixed(1)} 小时`
}

/** 画一张阅读海报；调用方负责 toBlob 与写盘 */
export function renderReadingPoster(input: PosterInput): HTMLCanvasElement {
	const W = 1080
	const H = 1440
	const canvas = document.createElement('canvas')
	canvas.width = W
	canvas.height = H
	const ctx = canvas.getContext('2d')
	if (!ctx) return canvas

	const bg = ctx.createLinearGradient(0, 0, W, H)
	bg.addColorStop(0, '#1b1b22')
	bg.addColorStop(0.55, '#23232c')
	bg.addColorStop(1, '#15151b')
	ctx.fillStyle = bg
	ctx.fillRect(0, 0, W, H)

	// 右上角光晕
	const glow = ctx.createRadialGradient(W * 0.82, H * 0.12, 20, W * 0.82, H * 0.12, 460)
	glow.addColorStop(0, 'rgba(122, 162, 247, 0.28)')
	glow.addColorStop(1, 'rgba(122, 162, 247, 0)')
	ctx.fillStyle = glow
	ctx.fillRect(0, 0, W, H)

	const accent = '#8ab4ff'
	const muted = 'rgba(224, 228, 240, 0.62)'
	const text = '#eef1f8'
	const pad = 88

	ctx.textBaseline = 'alphabetic'
	ctx.fillStyle = accent
	ctx.font = '600 30px "PingFang SC", "Microsoft YaHei", sans-serif'
	ctx.fillText('GROVE READER', pad, 128)
	ctx.fillStyle = text
	ctx.font = '700 64px "PingFang SC", "Microsoft YaHei", sans-serif'
	ctx.fillText(t('阅读海报'), pad, 208)
	ctx.fillStyle = muted
	ctx.font = '400 26px "PingFang SC", "Microsoft YaHei", sans-serif'
	const dateLabel = input.date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
	ctx.fillText(dateLabel, pad, 256)

	// 主数字：连续阅读
	ctx.fillStyle = text
	ctx.font = '800 168px "PingFang SC", "Microsoft YaHei", sans-serif'
	ctx.fillText(String(input.streakCurrent), pad, 456)
	const streakWidth = ctx.measureText(String(input.streakCurrent)).width
	ctx.fillStyle = muted
	ctx.font = '500 36px "PingFang SC", "Microsoft YaHei", sans-serif'
	ctx.fillText(t('天连续阅读'), pad + streakWidth + 20, 456)
	ctx.font = '400 24px "PingFang SC", "Microsoft YaHei", sans-serif'
	ctx.fillText(`最长 ${input.streakLongest} 天 · 累计打卡 ${input.checkins} 天`, pad + streakWidth + 20, 500)

	// 三块统计
	const stats: Array<[string, string]> = [
		[t('今日阅读'), formatDuration(input.todaySeconds)],
		[t('累计阅读'), formatDuration(input.totalSeconds)],
		[t('活跃天数'), `${input.activeDays} 天`],
	]
	const boxY = 570
	const boxW = (W - pad * 2 - 24 * 2) / 3
	stats.forEach(([label, value], i) => {
		const x = pad + i * (boxW + 24)
		ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'
		roundRect(ctx, x, boxY, boxW, 150, 18)
		ctx.fill()
		ctx.fillStyle = muted
		ctx.font = '400 24px "PingFang SC", "Microsoft YaHei", sans-serif'
		ctx.fillText(label, x + 26, boxY + 52)
		ctx.fillStyle = text
		ctx.font = '700 42px "PingFang SC", "Microsoft YaHei", sans-serif'
		ctx.fillText(value, x + 26, boxY + 112)
	})

	// 最近 14 天柱状图
	const chartY = 820
	ctx.fillStyle = muted
	ctx.font = '500 28px "PingFang SC", "Microsoft YaHei", sans-serif'
	ctx.fillText(t('最近 14 天'), pad, chartY)
	const days = input.days.slice(-14)
	const max = Math.max(1, ...days.map(d => d.seconds))
	const chartH = 220
	const barW = (W - pad * 2 - (days.length - 1) * 12) / Math.max(1, days.length)
	days.forEach((d, i) => {
		const x = pad + i * (barW + 12)
		const h = Math.max(6, Math.round((d.seconds / max) * chartH))
		ctx.fillStyle = d.seconds > 0 ? accent : 'rgba(255, 255, 255, 0.10)'
		roundRect(ctx, x, chartY + 40 + (chartH - h), barW, h, 8)
		ctx.fill()
	})

	// 读得最多的书
	const topBooks = input.books.slice(0, 3)
	if (topBooks.length) {
		ctx.fillStyle = muted
		ctx.font = '500 28px "PingFang SC", "Microsoft YaHei", sans-serif'
		ctx.fillText(t('读得最多'), pad, 1160)
		topBooks.forEach((book, i) => {
			const y = 1210 + i * 62
			ctx.fillStyle = 'rgba(255, 255, 255, 0.06)'
			roundRect(ctx, pad, y - 34, W - pad * 2, 52, 12)
			ctx.fill()
			ctx.fillStyle = text
			ctx.font = '400 26px "PingFang SC", "Microsoft YaHei", sans-serif'
			const title = book.title.length > 22 ? `${book.title.slice(0, 22)}…` : book.title
			ctx.fillText(title, pad + 20, y)
			ctx.fillStyle = muted
			ctx.font = '400 24px "PingFang SC", "Microsoft YaHei", sans-serif'
			const dur = formatDuration(book.seconds)
			const dw = ctx.measureText(dur).width
			ctx.fillText(dur, W - pad - 20 - dw, y)
		})
	}

	ctx.fillStyle = 'rgba(224, 228, 240, 0.42)'
	ctx.font = '400 22px "PingFang SC", "Microsoft YaHei", sans-serif'
	ctx.fillText(t('由 Grove Reader 生成'), pad, H - 64)
	return canvas
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	ctx.beginPath()
	ctx.moveTo(x + r, y)
	ctx.arcTo(x + w, y, x + w, y + h, r)
	ctx.arcTo(x + w, y + h, x, y + h, r)
	ctx.arcTo(x, y + h, x, y, r)
	ctx.arcTo(x, y, x + w, y, r)
	ctx.closePath()
}
