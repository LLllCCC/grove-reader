/**
 * 朗读用的纯文本工具：断句、文本节点 → Range、当前句高亮与滚动。
 * 不依赖 Obsidian，smoke 可以直接测。
 */

export interface TtsSentence {
	text: string
	/** 句子在文档里的范围；取不到时为空（仍会朗读，只是不标色） */
	range?: Range
	doc?: Document
}

const HIGHLIGHT_NAME = 'grove-tts'
const TERMINATORS = new Set(['。', '！', '？', '!', '?', '…', '；', ';'])
const CLOSERS = new Set(['”', '’', '」', '』', '】', '）', ')', ']', '"', '\''])

export interface SentenceSpan {
	start: number
	end: number
	text: string
}

/** 中文标点/换行/英文句点断句；过长的句子再按逗号、顿号切开 */
export function splitSentenceSpans(text: string, maxLen = 180): SentenceSpan[] {
	const spans: SentenceSpan[] = []
	let start = 0
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		let cut = false
		if (TERMINATORS.has(ch)) {
			let j = i + 1
			while (j < text.length && (text[j] === '…' || text[j] === '。')) j++
			while (j < text.length && CLOSERS.has(text[j])) j++
			i = j - 1
			cut = true
		} else if (ch === '\n') {
			cut = true
		} else if (ch === '.' && !/[0-9]/.test(text[i - 1] ?? '') && /[\s"”’]/.test(text[i + 1] ?? '')) {
			cut = true
		}
		if (cut) {
			pushSpan(text, start, i + 1, maxLen, spans)
			start = i + 1
		}
	}
	pushSpan(text, start, text.length, maxLen, spans)
	return spans
}

function pushSpan(text: string, start: number, end: number, maxLen: number, out: SentenceSpan[]): void {
	while (start < end && /\s/.test(text[start])) start++
	while (end > start && /\s/.test(text[end - 1])) end--
	if (end <= start) return
	if (!/[\p{L}\p{N}]/u.test(text.slice(start, end))) return
	if (end - start <= maxLen) {
		out.push({ start, end, text: text.slice(start, end) })
		return
	}
	let cut = start
	while (cut < end) {
		let next = Math.min(end, cut + maxLen)
		if (next < end) {
			const window = text.slice(cut, next)
			const at = Math.max(
				window.lastIndexOf('，'),
				window.lastIndexOf('、'),
				window.lastIndexOf(','),
				window.lastIndexOf(' '),
			)
			// 切点太靠前就不硬切逗号，避免产出只有几个字的碎句
			if (at > maxLen * 0.4) next = cut + at + 1
		}
		let s = cut
		let e = next
		while (s < e && /\s/.test(text[s])) s++
		while (e > s && /\s/.test(text[e - 1])) e--
		if (e > s) out.push({ start: s, end: e, text: text.slice(s, e) })
		cut = next
	}
}

interface TextNodeRef {
	node: Text
	start: number
	end: number
}

/** 把 root 下的文本节点拼成一条长文本，并按句子映射回 Range */
export function sentenceRanges(doc: Document, root: Node, keep?: (node: Text) => boolean): TtsSentence[] {
	const nodes: TextNodeRef[] = []
	const BLOCK = 'p, div, h1, h2, h3, h4, h5, h6, li, blockquote, section, article, header, footer, td, th, figcaption'
	let full = ''
	let lastBlock: Element | null = null
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: (n: Node): number => {
			const t = n as Text
			if (!t.data.trim()) return NodeFilter.FILTER_REJECT
			const parent = t.parentElement
			if (parent?.closest('script, style, noscript, [hidden], nav')) return NodeFilter.FILTER_REJECT
			if (keep && !keep(t)) return NodeFilter.FILTER_REJECT
			return NodeFilter.FILTER_ACCEPT
		},
	})
	let next: Node | null
	while ((next = walker.nextNode())) {
		const t = next as Text
		// 段落/标题之间补一个换行，避免相邻块拼成一句；行内标签（em/strong）不补
		const block = t.parentElement?.closest(BLOCK) ?? null
		if (full && block !== lastBlock) full += '\n'
		lastBlock = block
		const start = full.length
		full += t.data
		nodes.push({ node: t, start, end: full.length })
	}
	if (!nodes.length) return []
	const out: TtsSentence[] = []
	for (const span of splitSentenceSpans(full)) {
		const range = rangeForSpan(doc, nodes, span.start, span.end)
		out.push({ text: span.text, range, doc })
	}
	return out
}

function locate(nodes: TextNodeRef[], offset: number): { node: Text; local: number } | null {
	if (!nodes.length) return null
	let lo = 0
	let hi = nodes.length - 1
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1
		if (nodes[mid].start <= offset) lo = mid
		else hi = mid - 1
	}
	const ref = nodes[lo]
	return { node: ref.node, local: Math.max(0, Math.min(ref.end - ref.start, offset - ref.start)) }
}

function rangeForSpan(doc: Document, nodes: TextNodeRef[], start: number, end: number): Range | undefined {
	const a = locate(nodes, start)
	const b = locate(nodes, Math.max(start, end))
	if (!a || !b) return undefined
	try {
		const range = doc.createRange()
		range.setStart(a.node, a.local)
		range.setEnd(b.node, b.local)
		return range
	} catch {
		return undefined
	}
}

interface HighlightWindow extends Window {
	Highlight?: new (...ranges: Range[]) => unknown
	CSS?: { highlights?: Map<string, unknown> }
}

function ensureHighlightStyle(doc: Document): void {
	if (doc === document) return
	if (doc.getElementById('grove-tts-style')) return
	const style = doc.createElement('style')
	style.id = 'grove-tts-style'
	style.textContent = '::highlight(grove-tts) { background-color: rgba(255, 196, 0, 0.45); color: inherit; }'
	;(doc.head ?? doc.documentElement).appendChild(style)
}

/** 标出当前句；range 为空时清除 */
export function applyTtsHighlight(doc: Document | null | undefined, range: Range | undefined): void {
	const win = doc?.defaultView as HighlightWindow | null | undefined
	if (!win) return
	const map = win.CSS?.highlights
	if (!range) {
		map?.delete(HIGHLIGHT_NAME)
		return
	}
	ensureHighlightStyle(doc!)
	const Ctor = win.Highlight
	if (!Ctor || !map) return
	try {
		map.set(HIGHLIGHT_NAME, new Ctor(range))
	} catch {
		// 个别 WebView 的 Highlight 构造器不接受跨节点 Range，跳过标色即可
	}
}

/** 把当前句滚进容器视野（TXT / PDF 用；EPUB 交给翻页） */
export function scrollRangeIntoView(range: Range | undefined, container: HTMLElement): void {
	if (!range) return
	const rect = range.getBoundingClientRect()
	if (!rect.width && !rect.height) return
	const box = container.getBoundingClientRect()
	if (rect.top >= box.top + 8 && rect.bottom <= box.bottom - 8) return
	const delta = rect.top - box.top - Math.max(16, box.height * 0.3)
	container.scrollTop += delta
}
