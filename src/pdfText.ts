/**
 * PDF 文字层拼接：pdf.js 的 item 是按绘制顺序的碎片。
 * 中文按字拆，硬补空格会变成「中 文 阅 读」；西文 item 之间又常常需要空格。
 * 这里按相邻字符是否 CJK 决定补不补空格，`hasEOL` 当作分隔。
 */
export interface PdfTextItem {
	str?: string
	hasEOL?: boolean
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/

export function pdfItemsToText(items: PdfTextItem[]): string {
	let out = ''
	for (const item of items) {
		const s = item.str ?? ''
		if (!s) continue
		if (!out) {
			out = s
		} else if (item.hasEOL) {
			// 中文排版在行末断句很常见：两侧都是 CJK 时不补空格，避免「不要把这 三个字」
			const prev = out[out.length - 1] ?? ''
			const next = s[0] ?? ''
			out += CJK.test(prev) && CJK.test(next) ? s : ` ${s}`
		} else {
			const prev = out[out.length - 1] ?? ''
			const next = s[0] ?? ''
			out += CJK.test(prev) || CJK.test(next) ? s : ` ${s}`
		}
	}
	return out.replace(/\s+/g, ' ').trim()
}
