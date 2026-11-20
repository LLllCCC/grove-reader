/**
 * PDF 自带批注（Acrobat / Preview 里画的高亮、下划线、删除线、波浪线）。
 *
 * 这些注解存在 PDF 文件里，不走插件自己的批注 JSON：
 *   - 只读渲染，不写回文件，也不进批注栏/笔记；
 *   - QuadPoints 是 PDF 页面坐标（y 向上），这里统一换算成相对页面宽高的 0–1 矩形；
 *   - 字段形状按 pdf.js `getAnnotations()` 的实际输出（8 个数一组，已归一成
 *     [minX, maxY, maxX, maxY, minX, minY, maxX, minY]）。
 */

export interface NormalizedRect {
	l: number
	t: number
	w: number
	h: number
}

/** pdf.js 注解对象里本模块用得到的字段；其余字段不依赖 */
export interface PdfMarkupAnnotation {
	subtype?: unknown
	rect?: unknown
	quadPoints?: unknown
	color?: unknown
	opacity?: unknown
}

const MARKUP_SUBTYPES = new Set(['highlight', 'underline', 'squiggly', 'strikeout'])

export function markupSubtype(a: PdfMarkupAnnotation): 'highlight' | 'underline' | 'squiggly' | 'strikeout' | null {
	const s = (typeof a.subtype === 'string' ? a.subtype : '').toLowerCase()
	return MARKUP_SUBTYPES.has(s) ? (s as 'highlight' | 'underline' | 'squiggly' | 'strikeout') : null
}

function toNumbers(v: unknown): number[] {
	if (!v || typeof (v as ArrayLike<number>).length !== 'number') return []
	return Array.from(v as ArrayLike<number>, n => (typeof n === 'number' && Number.isFinite(n) ? n : 0))
}

/** pdf.js 的 color 是 0–255 的 RGB；缺省用黄色（PDF 高亮最常见的默认色） */
export function markupColorCss(a: PdfMarkupAnnotation): string {
	const c = toNumbers(a.color)
	if (c.length < 3) return 'rgb(255, 214, 10)'
	const byte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
	return `rgb(${byte(c[0])}, ${byte(c[1])}, ${byte(c[2])})`
}

/** 高亮的透明度：PDF 里的 CA 值通常 0.2–1，整体压淡一点避免盖住文字 */
export function markupOpacity(a: PdfMarkupAnnotation): number {
	const v = typeof a.opacity === 'number' && Number.isFinite(a.opacity) ? a.opacity : 0.5
	return Math.max(0.15, Math.min(0.7, v * 0.9))
}

/**
 * 注解 → 相对页面的矩形列表。
 * quadPoints 有多组时每组一个矩形（跨行高亮）；没有 quadPoints 就退回 Rect。
 * toPoint 负责把 PDF 坐标映射成视口坐标（y 向下），由调用方传 viewport 的方法。
 */
export function markupRects(
	a: PdfMarkupAnnotation,
	pageWidth: number,
	pageHeight: number,
	toPoint: (x: number, y: number) => number[],
): NormalizedRect[] {
	if (!(pageWidth > 0) || !(pageHeight > 0)) return []
	const quads: number[][] = []
	const qp = toNumbers(a.quadPoints)
	if (qp.length >= 8) {
		for (let i = 0; i + 8 <= qp.length; i += 8) quads.push(qp.slice(i, i + 8))
	} else {
		const r = toNumbers(a.rect)
		if (r.length < 4) return []
		// Rect 是 [左下 x, 左下 y, 右上 x, 右上 y]
		quads.push([r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]])
	}
	const out: NormalizedRect[] = []
	for (const q of quads) {
		let minX = Infinity
		let minY = Infinity
		let maxX = -Infinity
		let maxY = -Infinity
		for (let i = 0; i < 8; i += 2) {
			const [x, y] = toPoint(q[i], q[i + 1])
			minX = Math.min(minX, x)
			maxX = Math.max(maxX, x)
			minY = Math.min(minY, y)
			maxY = Math.max(maxY, y)
		}
		const l = Math.max(0, minX / pageWidth)
		const t = Math.max(0, minY / pageHeight)
		const r = Math.min(1, maxX / pageWidth)
		const b = Math.min(1, maxY / pageHeight)
		const w = r - l
		const h = b - t
		if (w <= 0.0005 || h <= 0.0005) continue
		out.push({ l, t, w, h })
	}
	return out
}
