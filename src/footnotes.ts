/**
 * EPUB 脚注：识别脚注引用链接、从目标节点截出脚注正文。
 * 识别部分是纯函数（便于 smoke 覆盖），DOM 提取只在阅读视图里调用。
 */

const EPUB_NS = 'http://www.idpf.org/2007/ops'

const REF_TYPES = ['noteref', 'biblioref', 'glossref']
const REF_ROLES = ['doc-noteref', 'doc-biblioref', 'doc-glossref']
const NOTE_TYPES = ['footnote', 'endnote', 'rearnote', 'note', 'biblioentry', 'glossdef']
const NOTE_ROLES = ['doc-footnote', 'doc-endnote', 'doc-note', 'doc-biblioentry', 'definition']

export interface FootnoteLinkFacts {
	/** 已按章节相对路径解析过的 href（foliate link 事件里的 detail.href） */
	href?: string | null
	/** epub:type，原始空格分隔串 */
	epubType?: string | null
	role?: string | null
	/** 链接文字，如 [1] */
	text?: string | null
	/** 链接是否包在 sup 里（或自身是 sup） */
	isSuper?: boolean
}

const wordsOf = (value?: string | null): string[] => (value ?? '').split(/\s+/).filter(Boolean)

export function fragmentOf(href?: string | null): string {
	if (!href) return ''
	const i = href.indexOf('#')
	return i < 0 ? '' : href.slice(i + 1).trim()
}

export function hasFragment(href?: string | null): boolean {
	return fragmentOf(href) !== ''
}

/** 形如 [1] / （12） / 1 / ① / * / † 的标号文字 */
export function isMarkerLikeText(text?: string | null): boolean {
	const t = (text ?? '').replace(/\s+/g, '')
	if (!t) return false
	if (/^[\[(（【〔]\s*\d{1,3}(?:[-–—]\d{1,3})?\s*[\]）】〕]$/.test(t)) return true
	if (/^\d{1,3}[.、]?$/.test(t)) return true
	if (/^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]$/.test(t)) return true
	return /^[*＊†‡§¶]+$/.test(t)
}

/** 片段名像脚注：note1 / note1n / fn-2 / footnote_3 / endnote4 / n12 */
export function hasNoteFragment(href?: string | null): boolean {
	const frag = fragmentOf(href)
	if (!frag) return false
	if (/^\d{1,3}$/.test(frag)) return true
	return /(?:^|[-_.])(?:fn|fnote|foot|footnote|note|endnote|noteref|n|ref|zhu|zhushi)[-_.]?\d+(?:[-_.]?\w+)?$/i.test(frag)
}

/** 显式声明了 noteref（epub:type / role）的链接 */
export function isExplicitNoteref(facts: FootnoteLinkFacts): boolean {
	const types = wordsOf(facts.epubType)
	const roles = wordsOf(facts.role)
	return REF_TYPES.some(t => types.includes(t)) || REF_ROLES.some(r => roles.includes(r))
}

export function isBacklink(facts: FootnoteLinkFacts): boolean {
	const types = wordsOf(facts.epubType)
	const roles = wordsOf(facts.role)
	return types.includes('backlink') || roles.includes('doc-backlink')
}

/**
 * 是否该按「脚注引用」处理。
 * 显式 noteref 一律算；没有标注的书用启发式：
 * 链接文字是 [1]/1/① 这类标号，且片段名像 note1 或纯数字。
 */
export function looksLikeFootnoteRef(facts: FootnoteLinkFacts): boolean {
	if (!hasFragment(facts.href)) return false
	if (isBacklink(facts)) return false
	if (isExplicitNoteref(facts)) return true
	if (!isMarkerLikeText(facts.text)) return false
	if (hasNoteFragment(facts.href)) return true
	// <sup><a href="#1">1</a></sup>：上标 + 纯数字片段
	const frag = fragmentOf(facts.href)
	return !!facts.isSuper && /^\d{1,3}$/.test(frag)
}

export function epubTypesOf(el: Element): string {
	return el.getAttributeNS?.(EPUB_NS, 'type') ?? el.getAttribute?.('epub:type') ?? ''
}

export function footnoteFactsFrom(el: Element, href: string): FootnoteLinkFacts {
	const parent = el.parentElement
	return {
		href,
		epubType: epubTypesOf(el),
		role: el.getAttribute('role'),
		text: el.textContent ?? '',
		isSuper: el.matches('sup') || !!parent?.matches('sup, .sup, .Ssup'),
	}
}

/** 引用是否本来就处在脚注区（如注释章末尾的 [1] 回链），这时应交给 foliate 正常跳转 */
export function isInsideNoteBlock(el: Element): boolean {
	for (let node: Element | null = el; node; node = node.parentElement) {
		if (node === node.ownerDocument?.body) break
		const types = wordsOf(epubTypesOf(node))
		const roles = wordsOf(node.getAttribute('role'))
		if (NOTE_TYPES.some(t => types.includes(t)) || NOTE_ROLES.some(r => roles.includes(r))) return true
		const cls = node.getAttribute('class') ?? ''
		if (/(^|\s)(footnote|fnote|endnote|noteref|note|zhushi|zhu)(\s|$)/i.test(cls)) return true
	}
	return false
}

const INLINE_TAGS = new Set(['A', 'SPAN', 'SUP', 'SUB', 'EM', 'STRONG', 'I', 'B', 'SMALL', 'BIG', 'CODE', 'U', 'S', 'MARK', 'FONT'])
const BLOCK_TAGS = new Set(['P', 'LI', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DT', 'TD', 'TH', 'SECTION', 'DIV', 'ARTICLE', 'FIGCAPTION'])

/** 从锚点向上找到承载整条脚注正文的块级元素 */
export function blockForNote(el: Element): Element {
	let node: Element = el
	while (node.parentElement && INLINE_TAGS.has(node.tagName.toUpperCase())) node = node.parentElement
	if (BLOCK_TAGS.has(node.tagName.toUpperCase())) return node
	return node
}

const BLOCK_FOR_TEXT = new Set([
	'P', 'DIV', 'LI', 'DD', 'DT', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'ASIDE', 'FIGCAPTION',
	'UL', 'OL', 'TABLE', 'TR', 'TD', 'TH', 'BODY',
	'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
])

/** 脚注正文转纯文本：块级元素之间空一行，去掉开头的标号与回链 */
export function footnoteTextFrom(root: Element): string {
	const clone = root.cloneNode(true) as Element
	const links = clone.querySelectorAll('a')
	for (let i = 0; i < links.length; i++) {
		const a = links[i]
		const types = wordsOf(epubTypesOf(a))
		const roles = wordsOf(a.getAttribute('role'))
		if (types.includes('backlink') || roles.includes('doc-backlink') || isMarkerLikeText(a.textContent)) a.remove()
	}
	const parts: string[] = []
	const walk = (node: Node): void => {
		if (node.nodeType === 3) {
			parts.push(node.nodeValue ?? '')
			return
		}
		if (node.nodeType !== 1) return
		const el = node as Element
		const tag = el.tagName.toUpperCase()
		if (tag === 'BR') {
			parts.push('\n')
			return
		}
		if (tag === 'SCRIPT' || tag === 'STYLE') return
		const block = BLOCK_FOR_TEXT.has(tag)
		if (block) parts.push('\n')
		for (let i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i])
		if (block) parts.push('\n')
	}
	walk(clone)
	return parts
		.join('')
		.replace(/\u00a0/g, ' ')
		.split(/\n+/)
		.map(line => line.replace(/[ \t]+/g, ' ').trim())
		.filter(Boolean)
		.join('\n\n')
}
