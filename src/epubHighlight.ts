/**
 * EPUB 高亮绘制：马克笔样式（下半段色带 + 底部细线）或整行色块。
 *
 * 不直接改 vendored 的 foliate overlayer，而是把 draw 回调传进去，
 * 这样 `npm run foliate:baseline` 不用跟着变。
 */

export interface HighlightRect {
	left: number
	top: number
	width: number
	height: number
}

export interface HighlightBand {
	x: number
	y: number
	width: number
	height: number
	opacity: number
	kind: 'wash' | 'line' | 'block'
}

/** 计算一条文字矩形上的高亮色带（纯函数，smoke 可测） */
export function highlightBands(
	rect: HighlightRect,
	style: 'wash' | 'block' = 'wash',
	vertical = false,
	lineWidth = 1,
): HighlightBand[] {
	const { left, top, width, height } = rect
	if (style === 'block') {
		return [{ x: left, y: top, width, height, opacity: 0.3, kind: 'block' }]
	}
	if (vertical) {
		// 竖排：色带在右半段，细线在右边缘
		const washWidth = width * 0.5
		return [
			{ x: left + width - washWidth, y: top, width: washWidth, height, opacity: 0.28, kind: 'wash' },
			{ x: left + width - lineWidth, y: top, width: lineWidth, height, opacity: 0.9, kind: 'line' },
		]
	}
	// 横排：色带占下半段，细线贴底
	const washHeight = height * 0.5
	return [
		{ x: left, y: top + height - washHeight, width, height: washHeight, opacity: 0.28, kind: 'wash' },
		{ x: left, y: top + height - lineWidth, width, height: lineWidth, opacity: 0.9, kind: 'line' },
	]
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function svg(tag: string): SVGElement {
	return document.createElementNS(SVG_NS, tag)
}

export interface EpubHighlightOptions {
	color?: string
	style?: 'wash' | 'block'
	vertical?: boolean
	lineWidth?: number
}

/** 传给 foliate 的 draw 回调：返回一个 `<g>`，由 overlayer 塞进 SVG */
export function drawEpubHighlight(
	rects: ArrayLike<HighlightRect>,
	options: EpubHighlightOptions = {},
): Element {
	const { color = '#ffe066', style = 'wash', vertical = false, lineWidth = 1 } = options
	const g = svg('g')
	g.setAttribute('fill', color)
	for (let i = 0; i < rects.length; i++) {
		for (const band of highlightBands(rects[i], style, vertical, lineWidth)) {
			const rect = svg('rect')
			rect.setAttribute('x', String(band.x))
			rect.setAttribute('y', String(band.y))
			rect.setAttribute('width', String(band.width))
			rect.setAttribute('height', String(band.height))
			rect.setAttribute('opacity', String(band.opacity))
			g.append(rect)
		}
	}
	return g
}
