/**
 * PDF++ 链接兼容。
 *
 * PDF++ 写的链接不是本插件的子路径，而是把定位塞在文件名的 hash 里：
 *   `[[书.pdf#page=12&selection=34,56,78,90&color=yellow|别名]]`
 * 这种链接被 Obsidian 自己处理时只会打开 PDF 第一页，所以点击要在 main.ts
 * 捕获阶段接过来，转到 Grove 的 PDF 视图并落到对应页/框选。
 *
 * 两种坐标都认：
 *   - `rect=` 里的 0..1 小数按归一化矩形（l,t,w,h）处理，和本插件 `r=` 同义；
 *   - `selection=` 及大于 1 的数值按 PDF 用户空间的点坐标（left,top,right,bottom，
 *     原点在左下角）处理，等页面渲染出来后再换算成归一化坐标。
 */
import type { PdfPointRect, PdfRect } from './wikilink'

export interface PdfPlusLink {
	/** 链接里写的书籍路径（已解码，未解析成库内绝对路径） */
	bookPath: string
	page: number
	/** 0..1 归一化矩形 */
	rects?: PdfRect[]
	/** 页面点坐标，需要页宽高才能归一化 */
	pointRects?: PdfPointRect[]
}

const MAX_RECTS = 12

function decode(v: string): string {
	try {
		return decodeURIComponent(v)
	} catch {
		return v
	}
}

function numbers(v: string): number[] {
	return v.split(',').map(Number).map(n => (Number.isFinite(n) ? n : NaN))
}

/**
 * 解析一条指向 PDF 的链接（不带 `!` 嵌入前缀）。
 * 不是 PDF++ 形态（没有 `#page=` 或不是 pdf）返回 null，调用方原样放行。
 */
export function parsePdfPlusHref(raw: string): PdfPlusLink | null {
	let href = (raw ?? '').trim()
	if (!href || href.startsWith('obsidian://')) return null
	// 外部网址原样交给系统浏览器
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) return null
	if (href.startsWith('!')) href = href.slice(1)
	const hashAt = href.indexOf('#')
	if (hashAt <= 0) return null
	const path = decode(href.slice(0, hashAt)).trim()
	const hash = href.slice(hashAt + 1)
	if (!/\.pdf$/i.test(path)) return null
	if (!/(^|&)page=/i.test(hash)) return null

	let page = 0
	const rects: PdfRect[] = []
	const pointRects: PdfPointRect[] = []
	for (const part of hash.split('&')) {
		const eq = part.indexOf('=')
		if (eq <= 0) continue
		const key = part.slice(0, eq).toLowerCase()
		const value = decode(part.slice(eq + 1))
		if (key === 'page') {
			const n = Number.parseInt(value, 10)
			if (Number.isFinite(n) && n > 0) page = n
			continue
		}
		if (key !== 'rect' && key !== 'selection') continue
		const nums = numbers(value)
		if (nums.length !== 4 || nums.some(n => !Number.isFinite(n))) continue
		const [a, b, c, d] = nums
		const looksNormalized = key === 'rect' && nums.every(n => Math.abs(n) <= 1) && c > 0 && d > 0
		if (looksNormalized) {
			if (rects.length < MAX_RECTS) rects.push({ l: a, t: b, w: c, h: d })
			continue
		}
		// 点坐标：selection 是 l,t,r,b；大数值的 rect 按 l,t,w,h 补齐成 l,t,r,b
		const left = Math.min(a, c)
		const right = Math.max(a, c)
		const top = b
		const bottom = key === 'rect' ? b + d : d
		if (right - left <= 0 || Math.abs(bottom - top) <= 0) continue
		if (pointRects.length < MAX_RECTS) pointRects.push({ l: left, t: Math.min(top, bottom), r: right, b: Math.max(top, bottom) })
	}
	if (!page) return null
	return {
		bookPath: path,
		page,
		rects: rects.length ? rects : undefined,
		pointRects: pointRects.length ? pointRects : undefined,
	}
}
