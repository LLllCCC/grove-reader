import { Annotation } from './types'
import { randomId, truncate } from './util'

/**
 * Obsidian Canvas 文件（.canvas）是一份 JSON：nodes + edges。
 * 这里只处理文本卡片，不碰用户已有的连线和分组。
 */

export interface CanvasNode {
	id: string
	type: 'text' | 'file' | 'group' | 'link'
	text?: string
	x: number
	y: number
	width: number
	height: number
	color?: string
	[k: string]: unknown
}

export interface CanvasDoc {
	nodes: CanvasNode[]
	edges: Array<Record<string, unknown>>
}

/** 高亮色 → Canvas 卡片色（1 红 / 2 橙 / 3 黄 / 4 绿 / 5 青 / 6 紫） */
const CANVAS_COLOR: Record<string, string> = {
	red: '1',
	yellow: '3',
	green: '4',
	blue: '5',
	purple: '6',
}

export function canvasColor(key: string): string | undefined {
	return CANVAS_COLOR[key]
}

export function emptyCanvas(): CanvasDoc {
	return { nodes: [], edges: [] }
}

/** 解析已有画布；格式不对就抛错，由调用方给可读提示，不要静默清空 */
export function parseCanvas(raw: string): CanvasDoc {
	const parsed = JSON.parse(raw) as Partial<CanvasDoc>
	if (!parsed || typeof parsed !== 'object') throw new Error('不是有效的画布文件')
	return {
		nodes: Array.isArray(parsed.nodes) ? (parsed.nodes as CanvasNode[]) : [],
		edges: Array.isArray(parsed.edges) ? parsed.edges : [],
	}
}

/** 卡片抬头用短书名：遇到括号/冒号就截断，避免整段副标题挤满第一行 */
export function shortTitle(title: string): string {
	const cut = title.split(/[（(【\[:：|—]/)[0].trim()
	const base = cut || title.trim()
	return truncate(base, 24)
}

/** 卡片正文：书名/章节 → 引用 → 评论 → 回笔记与回原文 */
export function buildCardText(a: Annotation, bookTitle: string, noteLink?: string): string {
	const name = shortTitle(bookTitle)
	const head = a.chapter ? `**${name}** · ${a.chapter}` : `**${name}**`
	const lines = [head, '']
	const quote = a.text
		.split(/\r?\n/)
		.map(l => l.trim())
		.filter(Boolean)
	if (quote.length) lines.push(...quote.map(l => `> ${l}`))
	const note = (a.note ?? '').trim()
	if (note) lines.push('', note)
	if (noteLink) lines.push('', noteLink)
	return lines.join('\n')
}

/** 按字数估个高度：中文一行约 24 字，避免长摘录被卡片裁掉大半 */
export function estimateHeight(text: string, width: number): number {
	const perLine = Math.max(12, Math.floor(width / 14))
	let lines = 0
	for (const raw of text.split(/\r?\n/)) {
		const len = raw.trim().length
		lines += Math.max(1, Math.ceil(len / perLine))
	}
	const height = 70 + lines * 22 + 40
	return Math.max(200, Math.min(460, Math.round(height / 10) * 10))
}

export interface CardSpec {
	text: string
	color?: string
}

/** 在现有内容下方按 3 列网格追加卡片，返回新增的节点数 */
export function appendCards(doc: CanvasDoc, cards: CardSpec[]): number {
	if (!cards.length) return 0
	const cols = 3
	const width = 340
	const gapX = 40
	const gapY = 30

	const nodes = doc.nodes
	const startY = nodes.length
		? Math.max(...nodes.map(n => (Number(n.y) || 0) + (Number(n.height) || 0))) + 80
		: 0
	const startX = nodes.length ? Math.min(...nodes.map(n => Number(n.x) || 0)) : 0

	// 每行的高度取该行最高的一张，行与行之间不留空
	const rowHeights: number[] = []
	cards.forEach((c, i) => {
		const row = Math.floor(i / cols)
		rowHeights[row] = Math.max(rowHeights[row] ?? 0, estimateHeight(c.text, width))
	})
	const rowY: number[] = []
	for (let r = 0; r < rowHeights.length; r++) rowY[r] = (rowY[r - 1] ?? startY - gapY) + (rowHeights[r - 1] ?? 0) + gapY
	cards.forEach((c, i) => {
		const col = i % cols
		const row = Math.floor(i / cols)
		const height = rowHeights[row] ?? 240
		const node: CanvasNode = {
			id: randomId(),
			type: 'text',
			text: c.text,
			x: startX + col * (width + gapX),
			y: rowY[row],
			width,
			height,
		}
		if (c.color) node.color = c.color
		nodes.push(node)
	})
	return cards.length
}

export function serializeCanvas(doc: CanvasDoc): string {
	return `${JSON.stringify({ nodes: doc.nodes, edges: doc.edges }, null, '\t')}\n`
}
