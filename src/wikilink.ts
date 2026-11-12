/**
 * 摘录双链（wikilink）的生成与解析。
 *
 * 笔记里一条摘录从
 *   `[⤴ 回原文](obsidian://grove?book=…&cfi=…)`
 * 升级成
 *   `[[Grove Reader/书籍/围城.epub#grove-cfi=epubcfi(… )&t=…&c=…|⤴ 回原文]]`
 *
 * 为什么指向书文件而不是阅读笔记：笔记是插件每次重新生成的，指向自己是自引用，
 * 反向链接面板没有信息量；指向书之后「哪些笔记引了这本书」才成立，插件被关掉时
 * 点链接也能打开书（只是落不到那一句）。
 *
 * 代价（所以 obsidian:// 那条路必须留着）：
 *   - Live Preview 里链接点击由编辑器自己处理，捕获阶段拦不住时会退化为「开书」；
 *   - 子路径 Obsidian 不认识，点击必须由 main.ts 接管。
 *
 * 定位仍做三级降级，和 obsidian:// 那条路同源：
 *   CFI 精确跳 → 章节内搜原文片段 → 章节百分比。
 */
import { isAbsolutePath } from './util'

/** 子路径前缀：只有以它开头的 `#…` 才是本插件写的定位串 */
const PREFIX = 'grove-'

/** 摘录原文存进链接时的长度（前 N 字），够搜又不至于把笔记撑长 */
export const SNIPPET_LEN = 24

export interface GroveLinkTarget {
	/** 电子书范围 CFI / TXT 的 `txt:<起>-<止>` / PDF 的 `page:N` */
	cfi?: string
	/** 摘录开头若干字：CFI 失效时靠它在章节里搜 */
	text?: string
	/** 章节名（链接里的 `c=`），三级降级的第二、三级都用它 */
	chapter?: string
	/** 章节内百分比 0..1 */
	pct?: number
	/** PDF 专有：归一化到页面宽高的框选矩形（链接里的 `r=`），用于精确到句 */
	pdfRects?: PdfRect[]
}

export interface PdfRect {
	l: number
	t: number
	w: number
	h: number
}

/**
 * CFI 里会撑破 wikilink 语法的三个字符：
 * `]` 会提前闭合 `[[…]]`，`|` 是别名分隔符，`[` 会让 Obsidian 的解析歧义。
 * 只转这三个，`/` `(` `,` `:` 保持原样——CFI 本来就长，全编码没法看。
 */
export function escapeSubpath(v: string): string {
	return v.replace(/\[/g, '%5B').replace(/\]/g, '%5D').replace(/\|/g, '%7C')
}

export function unescapeSubpath(v: string): string {
	return v.replace(/%5B/gi, '[').replace(/%5D/gi, ']').replace(/%7C/gi, '|')
}

/** `decodeURIComponent` 遇到半截编码不抛错，原样退回 */
function safeDecode(v: string): string {
	try {
		return decodeURIComponent(v)
	} catch {
		return v
	}
}

/** 摘录首行压成一行并截断，用于写进链接当搜索依据 */
export function snippetOf(text: string, max = SNIPPET_LEN): string {
	const line = (text ?? '').replace(/\s+/g, ' ').trim()
	if (!line) return ''
	return line.length > max ? line.slice(0, max) : line
}

/** 定位 → 子路径串；没有任何定位字段时返回空串 */
export function buildSubpath(target: GroveLinkTarget): string {
	const parts: string[] = []
	const cfi = target.cfi?.trim()
	if (cfi) parts.push(`cfi=${escapeSubpath(cfi)}`)
	const text = snippetOf(target.text ?? '')
	if (text) parts.push(`t=${encodeURIComponent(text)}`)
	const chapter = target.chapter?.trim()
	if (chapter) parts.push(`c=${encodeURIComponent(chapter)}`)
	const rects = encodeRects(target.pdfRects)
	if (rects) parts.push(`r=${rects}`)
	if (typeof target.pct === 'number' && Number.isFinite(target.pct)) {
		const p = Math.max(0, Math.min(1, target.pct))
		parts.push(`p=${p.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`)
	}
	if (!parts.length) return ''
	return `${PREFIX}${parts.join('&')}`
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))
const round3 = (n: number): string => String(Math.round(n * 1000) / 1000)

/** 矩形压成 `l,t,w,h;l,t,w,h`；最多 8 个，避免把链接撑得过长 */
function encodeRects(rects?: PdfRect[]): string {
	if (!rects?.length) return ''
	return rects
		.slice(0, 8)
		.filter(r => Number.isFinite(r.l) && Number.isFinite(r.t) && r.w > 0 && r.h > 0)
		.map(r => [r.l, r.t, r.w, r.h].map(clamp01).map(round3).join(','))
		.join(';')
}

function parseRects(raw?: string): PdfRect[] | undefined {
	if (!raw) return undefined
	const out: PdfRect[] = []
	for (const part of raw.split(';')) {
		const nums = part.split(',').map(Number)
		if (nums.length !== 4 || nums.some(n => !Number.isFinite(n))) continue
		const [l, t, w, h] = nums
		if (w <= 0 || h <= 0) continue
		out.push({ l: clamp01(l), t: clamp01(t), w: clamp01(w), h: clamp01(h) })
	}
	return out.length ? out : undefined
}

/** 子路径串 → 定位；不是本插件的子路径返回 null */
export function parseSubpath(sub: string): GroveLinkTarget | null {
	const raw = (sub ?? '').trim()
	if (!raw.startsWith(PREFIX)) return null
	const params = new Map<string, string>()
	for (const part of raw.slice(PREFIX.length).split('&')) {
		const eq = part.indexOf('=')
		if (eq <= 0) continue
		params.set(part.slice(0, eq), part.slice(eq + 1))
	}
	const cfi = params.get('cfi')
	const text = params.get('t')
	const pdfRects = parseRects(params.get('r'))
	if (!cfi && !text && !pdfRects) return null
	const chapter = params.get('c')
	const pctRaw = params.get('p')
	const pct = pctRaw == null ? NaN : Number(pctRaw)
	return {
		cfi: cfi ? unescapeSubpath(cfi) : undefined,
		text: text ? safeDecode(text) : undefined,
		chapter: chapter ? safeDecode(chapter) : undefined,
		pct: Number.isFinite(pct) ? Math.max(0, Math.min(1, pct)) : undefined,
		pdfRects,
	}
}

/** wikilink 解析不了的四个字符：`#` 是子路径分隔符、`|` 是别名分隔符、`[` `]` 会提前闭合 */
const UNSAFE_PATH = /[#|[\]]/

/**
 * 路径里那四个字符按 URL 编码塞进 markdown 链接：书名带 `#`（如「C# 入门.pdf」）
 * 时不能硬拼 `[[路径#子路径|别名]]`，否则整条双链在 Obsidian 眼里是错位的。
 */
function encodePathForMarkdown(p: string): string {
	return p
		.replace(/%/g, '%25')
		.replace(/ /g, '%20')
		.replace(/#/g, '%23')
		.replace(/\|/g, '%7C')
		.replace(/\[/g, '%5B')
		.replace(/\]/g, '%5D')
		.replace(/\(/g, '%28')
		.replace(/\)/g, '%29')
}

/** 别名里的竖线要转义，否则 `[[…|A|B]]` 会把第二个竖线之后吞掉 */
function aliasOf(v: string): string {
	return v.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim()
}

/**
 * 这本书能不能写成双链：只有库内相对路径才行。
 * 库外书（桌面端绝对路径）没有可解析的 vault 路径，调用方应退回 obsidian:// 链接。
 */
export function canLinkBook(bookPath: string): boolean {
	const p = (bookPath ?? '').trim()
	if (!p) return false
	return !isAbsolutePath(p)
}

/**
 * 定位 + 显示文字 → `[[书路径#定位|文字]]`。
 * 书路径带 `# | [ ]` 时改走 Obsidian 也认的 markdown 链接形态。
 */
export function wikilinkFor(bookPath: string, target: GroveLinkTarget, label: string): string {
	const sub = buildSubpath(target)
	const text = aliasOf(label)
	if (!sub || !text) return ''
	const path = bookPath.trim()
	if (UNSAFE_PATH.test(path)) return `[${text}](${encodePathForMarkdown(path)}#${sub})`
	return `[[${path}#${sub}|${text}]]`
}

/**
 * PDF 页嵌入：库内书用 Obsidian 原生的 `![[书.pdf#page=N]]`；
 * 路径带 `# | [ ]` 时改走 markdown 图片链接形态。
 */
export function pdfPageEmbed(bookPath: string, page: number, label?: string): string {
	const path = bookPath.trim()
	if (!path || !Number.isFinite(page) || page < 1) return ''
	const alt = aliasOf(label ?? `第 ${page} 页`)
	if (UNSAFE_PATH.test(path)) return `![${alt}](${encodePathForMarkdown(path)}#page=${page})`
	return `![[${path}#page=${page}]]`
}

export interface ParsedGroveLink {
	/** 书在库里的相对路径 */
	vaultPath: string
	target: GroveLinkTarget
}

/**
 * 从链接地址还原定位。认三种外壳：
 *   `[[路径#grove-…|别名]]`、`[别名](路径#grove-…)`、以及 DOM 上的 `app://…/路径#grove-…`。
 * 只认自家子路径：普通笔记链接、别的插件写的锚点、obsidian:// 老链接一律返回 null。
 */
export function parseGroveHref(raw: string): ParsedGroveLink | null {
	let s = String(raw ?? '').trim()
	if (!s) return null
	// markdown 外壳 `[文字](目标)`：目标里可能带括号（CFI 形如 epubcfi(/6/4)），取到最后一个 `)`
	const md = /^\[[^\]]*\]\(([\s\S]+)\)$/.exec(s)
	if (md) s = md[1]
	if (s.startsWith('[[')) s = s.slice(2)
	if (s.endsWith(']]')) s = s.slice(0, -2)
	// 别名在 `|` 之后；`|` 在定位串里一律被编码成 %7C，所以第一个裸竖线一定是分隔符
	const bar = s.indexOf('|')
	if (bar >= 0) s = s.slice(0, bar)
	// DOM 给的是 app://obsidian.md/Grove%20Reader/…，去掉协议与主机
	const proto = /^app:\/\/[^/]+\/(.*)$/i.exec(s)
	if (proto) s = proto[1]
	if (!s) return null

	// 分隔符可能是 `#`，也可能被编码成 `%23`；`t=` 里的 `%23` 在分隔符之后，不会被误切
	let hash = s.indexOf('#')
	let sepLen = 1
	if (hash < 0) {
		hash = s.indexOf('%23')
		if (hash < 0) return null
		sepLen = 3
	}
	if (hash <= 0) return null

	const rawPath = s.slice(0, hash)
	const vaultPath = rawPath.includes('%') ? safeDecode(rawPath) : rawPath
	const target = parseSubpath(s.slice(hash + sepLen))
	if (!target) return null
	return { vaultPath, target }
}
