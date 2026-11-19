/**
 * 书摘卡出图：把一条批注画成 1080px 宽的 PNG（canvas 2D，无第三方依赖）。
 * 断行与文件名是纯函数，便于 smoke 覆盖；渲染只在有 DOM 的渲染进程里调用。
 */
import { colorCss } from './types'
import { shortTitle } from './canvas'
import { truncate } from './util'
import { t } from './i18n'

export interface QuoteCardInput {
	text: string
	note?: string
	bookTitle: string
	author?: string
	chapter?: string
	color?: string
	date?: number
}

const CARD_WIDTH = 540
const PADDING = 36
/** 2× 输出：截图/分享时文字不糊 */
const SCALE = 2

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/
/** 不能出现在行首的标点 */
const NO_START = /^[，。、；：？！）》」』】〕〉…—,.;:!?)\]}%℃'"”’]$/
/** 不能出现在行尾的开括号（用于断行时把下一个字带下来） */
const NO_END = /^[（《「『【〔〈([{'"“‘]$/

function cssVar(el: HTMLElement, name: string, fallback: string): string {
	const value = getComputedStyle(el).getPropertyValue(name).trim()
	return value || fallback
}

function tokenize(text: string): string[] {
	const tokens: string[] = []
	let word = ''
	const flush = (): void => {
		if (word) {
			tokens.push(word)
			word = ''
		}
	}
	for (const ch of Array.from(text)) {
		if (/\s/.test(ch)) {
			flush()
			tokens.push(' ')
		} else if (CJK.test(ch) || NO_START.test(ch) || NO_END.test(ch)) {
			flush()
			tokens.push(ch)
		} else word += ch
	}
	flush()
	return tokens
}

function wrapParagraph(text: string, maxWidth: number, measure: (s: string) => number): string[] {
	const lines: string[] = []
	let line = ''
	const commit = (): void => {
		lines.push(line.replace(/\s+$/, ''))
		line = ''
	}
	for (const token of tokenize(text)) {
		if (token === ' ') {
			if (!line) continue
			if (measure(line + ' ') > maxWidth) commit()
			else line += ' '
			continue
		}
		if (!line) {
			// 行首禁则：标点不另起一行，贴回上一行末尾（允许轻微超出）
			if (NO_START.test(token) && lines.length) lines[lines.length - 1] += token
			else line = token
			continue
		}
		if (measure(line + token) <= maxWidth) {
			line += token
			continue
		}
		if (NO_START.test(token)) {
			line += token
			commit()
			continue
		}
		commit()
		line = token
	}
	if (line.trim()) lines.push(line.replace(/\s+$/, ''))
	return lines
}

/**
 * 中英混排断行：中文逐字断，英文/数字整词断，标点不做行首。
 * 返回值里空字符串表示原文的段落间隔。
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
	const out: string[] = []
	for (const para of text.replace(/\r/g, '').split('\n')) {
		const trimmed = para.trim()
		if (!trimmed) {
			if (out.length && out[out.length - 1] !== '') out.push('')
			continue
		}
		out.push(...wrapParagraph(trimmed, maxWidth, measure))
	}
	while (out.length && out[out.length - 1] === '') out.pop()
	return out
}

/** 文件名：书摘卡-短书名-20261113-153012.png */
export function quoteCardFileName(bookTitle: string, date: number): string {
	const d = new Date(date)
	const pad = (n: number): string => String(n).padStart(2, '0')
	const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
	return `书摘卡-${shortTitle(bookTitle || '未命名')}-${stamp}.png`
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	const radius = Math.min(r, w / 2, h / 2)
	ctx.beginPath()
	ctx.moveTo(x + radius, y)
	ctx.lineTo(x + w - radius, y)
	ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
	ctx.lineTo(x + w, y + h - radius)
	ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
	ctx.lineTo(x + radius, y + h)
	ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
	ctx.lineTo(x, y + radius)
	ctx.quadraticCurveTo(x, y, x + radius, y)
	ctx.closePath()
}

export function renderQuoteCard(input: QuoteCardInput): HTMLCanvasElement {
	const body = document.body
	const bg = cssVar(body, '--background-primary', '#ffffff')
	const fg = cssVar(body, '--text-normal', '#1f1f23')
	const muted = cssVar(body, '--text-muted', '#8a8a90')
	const border = cssVar(body, '--background-modifier-border', '#dcdce0')
	const accent = colorCss(input.color ?? 'yellow')
	const family = getComputedStyle(body).fontFamily || 'sans-serif'

	const meter = document.createElement('canvas').getContext('2d')
	if (!meter) throw new Error(t('无法创建画布'))
	const quoteSize = 22
	const quoteLine = 36
	const noteSize = 16
	const noteLine = 26

	meter.font = `${quoteSize}px ${family}`
	const quoteLines = wrapText(input.text.trim(), CARD_WIDTH - PADDING * 2, s => meter.measureText(s).width)
	const note = (input.note ?? '').trim()
	meter.font = `${noteSize}px ${family}`
	const noteLines = note ? wrapText(note, CARD_WIDTH - PADDING * 2 - 16, s => meter.measureText(s).width) : []

	const date = new Date(input.date ?? Date.now())
	const pad = (n: number): string => String(n).padStart(2, '0')
	const dateText = `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
	const head = shortTitle(input.bookTitle || '未命名')
	const chapter = truncate((input.chapter ?? '').trim(), 16)
	const author = truncate((input.author ?? '').trim(), 24)

	const headerH = 24
	const quoteTop = PADDING + headerH + 18
	const quoteH = quoteLines.length * quoteLine
	const noteTop = quoteTop + quoteH + (noteLines.length ? 22 : 0)
	const noteH = noteLines.length * noteLine
	const footerH = 18
	const height = Math.max(260, noteTop + noteH + 26 + footerH + PADDING)

	const canvas = document.createElement('canvas')
	canvas.width = CARD_WIDTH * SCALE
	canvas.height = Math.round(height * SCALE)
	const ctx = canvas.getContext('2d')
	if (!ctx) throw new Error(t('无法创建画布'))
	ctx.scale(SCALE, SCALE)

	ctx.fillStyle = bg
	roundRectPath(ctx, 0.5, 0.5, CARD_WIDTH - 1, height - 1, 16)
	ctx.fill()
	ctx.strokeStyle = border
	ctx.lineWidth = 1
	ctx.stroke()

	// 顶部：高亮色圆点 + 短书名，右侧章节
	ctx.fillStyle = accent
	ctx.beginPath()
	ctx.arc(PADDING + 4, PADDING + 9, 4, 0, Math.PI * 2)
	ctx.fill()
	ctx.textBaseline = 'middle'
	ctx.textAlign = 'left'
	ctx.font = `500 14px ${family}`
	ctx.fillStyle = muted
	ctx.fillText(head, PADDING + 16, PADDING + 9)
	if (chapter) {
		ctx.textAlign = 'right'
		ctx.font = `12px ${family}`
		ctx.fillText(chapter, CARD_WIDTH - PADDING, PADDING + 9)
		ctx.textAlign = 'left'
	}

	// 引文：左侧色条 + 正文
	ctx.fillStyle = accent
	ctx.fillRect(PADDING - 14, quoteTop + 2, 3, Math.max(quoteH - 8, 18))
	ctx.textBaseline = 'top'
	ctx.fillStyle = fg
	ctx.font = `${quoteSize}px ${family}`
	quoteLines.forEach((line, i) => ctx.fillText(line, PADDING, quoteTop + i * quoteLine))

	// 评论：细色条 + 弱化文字
	if (noteLines.length) {
		ctx.fillStyle = accent
		ctx.fillRect(PADDING, noteTop, 2, noteH - 6)
		ctx.fillStyle = muted
		ctx.font = `${noteSize}px ${family}`
		noteLines.forEach((line, i) => ctx.fillText(line, PADDING + 16, noteTop + i * noteLine))
	}

	// 页脚：作者 / 日期
	const footerY = height - PADDING - footerH
	ctx.strokeStyle = border
	ctx.lineWidth = 1
	ctx.beginPath()
	ctx.moveTo(PADDING, footerY - 10.5)
	ctx.lineTo(CARD_WIDTH - PADDING, footerY - 10.5)
	ctx.stroke()
	ctx.font = `12px ${family}`
	ctx.fillStyle = muted
	ctx.textBaseline = 'middle'
	if (author) ctx.fillText(author, PADDING, footerY + 9)
	ctx.textAlign = 'right'
	ctx.fillText(dateText, CARD_WIDTH - PADDING, footerY + 9)
	ctx.textAlign = 'left'

	return canvas
}
