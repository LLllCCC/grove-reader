import { Annotation, BookData, colorName } from './types'
import { compareCfi, encodeParam, truncate } from './util'
import { canLinkBook, snippetOf, wikilinkFor } from './wikilink'
import { currentLocale, t } from './i18n'

export const NOTE_BEGIN = '<!-- GROVE:BEGIN 由 Grove Reader 生成，重新生成时会覆盖此区间内的内容 -->'
export const NOTE_END = '<!-- GROVE:END -->'

export const DEFAULT_TEMPLATE_PATH = 'Grove Reader/阅读笔记/Grove 笔记模板.md'

/** 从笔记回跳原文的协议链接，由 main.ts 中注册的 obsidian://grove 处理（旧格式，保留兼容） */
export function jumpLink(bookId: string, cfi: string): string {
	return `[↩ 回原文](obsidian://grove?book=${encodeParam(bookId)}&cfi=${encodeParam(cfi)})`
}

/** 摘录回跳链接的样式：双链（可进图谱/反向链接）或旧版协议链接 */
export type ExcerptLinkStyle = 'wikilink' | 'protocol'

export interface NoteLinkOptions {
	style?: ExcerptLinkStyle
}

/**
 * 决定这次生成用哪种链接。
 * 自动刷新（force=false）时不让旧笔记悄悄换格式——路线图定的策略是
 * 「新笔记用双链、旧笔记保持不动」，用户点「生成/更新笔记」或「刷新全部笔记」
 * 才算明确表态（force=true），那时跟随设置。
 */
export function resolveExcerptLinkStyle(
	configured: ExcerptLinkStyle,
	existing: string | null,
	force: boolean,
): ExcerptLinkStyle {
	if (force || configured === 'protocol' || !existing) return configured
	const begin = existing.indexOf(NOTE_BEGIN)
	const end = existing.lastIndexOf(NOTE_END)
	const region = begin >= 0 && end > begin ? existing.slice(begin, end) : existing
	// 旧笔记里只有 obsidian:// 链接，还没有任何双链 → 继续用协议链接
	return region.includes('](obsidian://grove?') && !region.includes('#grove-cfi=') ? 'protocol' : configured
}

// ------------------------------------------------------------------
// 模板上下文
// ------------------------------------------------------------------

export interface TemplateAnnotation {
	/** 全书序号（1 起） */
	index: number
	text: string
	/** 已格式化的引用块（多行时行间插入空引用行，兼容严格换行） */
	textQuote: string
	note: string
	chapter: string
	color: string
	colorName: string
	/** 当前设置下的回跳链接（默认双链；库外书或关掉双链时是 obsidian:// 链接） */
	jumpLink: string
	/** 永远是 obsidian:// 协议链接，供自定义模板两种都写时使用 */
	protocolLink: string
	/** 双链形态；书在库外时为空串 */
	wikiLink: string
	/** 摘录首行净化截断，适合做标题 */
	excerptHeading: string
	/** 稳定块 id（配合 ^ 使用） */
	blockId: string
	date: string
	/** PDF 批注的页码（电子书为 null，渲染为空） */
	page: number | null
}

export interface TemplateChapter {
	chapter: string
	count: number
	annotations: TemplateAnnotation[]
}

/** 书签只有位置，没有摘录与评论；字段按批注的同名含义给，模板写法保持一致 */
export interface TemplateBookmark {
	/** 章节名 / 「第 N 页」；没取到位置名时为「未命名位置」 */
	label: string
	/** 加书签时那一段的开头（可能为空） */
	text: string
	/** 当前设置下的回跳链接 */
	jumpLink: string
	/** 永远是 obsidian:// 协议链接 */
	protocolLink: string
	/** 双链形态；书在库外时为空串 */
	wikiLink: string
	date: string
	/** PDF 页码（电子书为 null，渲染为空） */
	page: number | null
}

export interface TemplateContext {
	title: string
	author: string
	bookId: string
	bookPath: string
	count: number
	bookmarkCount: number
	date: string
	chapters: TemplateChapter[]
	bookmarks: TemplateBookmark[]
}

function cleanHeading(text: string, max: number): string {
	const first = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] ?? ''
	const clean = first.replace(/^[#\s]+/, '').replace(/[`]/g, '').replace(/\s+/g, ' ').trim()
	return truncate(clean || '（无标题）', max)
}

function quoteBlockOf(text: string): string {
	const lines = text
		.split(/\r?\n/)
		.map(l => l.trim())
		.filter(l => l.length > 0)
	return (lines.length ? lines : ['（空摘录）']).map(l => `> ${l}`).join('\n>\n')
}

function sortAnnotations(list: Annotation[]): Annotation[] {
	return [...list].sort((x, y) => {
		const ix = x.sectionIndex ?? Number.MAX_SAFE_INTEGER
		const iy = y.sectionIndex ?? Number.MAX_SAFE_INTEGER
		if (ix !== iy) return ix - iy
		return compareCfi(x.cfi, y.cfi)
	})
}

/** 书签的 PDF 页码从 `page:N` 里取；电子书 / TXT 返回 null */
function pageOfCfi(cfi: string): number | null {
	const m = /^page:(\d+)$/.exec((cfi ?? '').trim())
	return m ? Number(m[1]) : null
}

export function buildTemplateContext(data: BookData, bookId: string, opts: NoteLinkOptions = {}): TemplateContext {
	const sorted = sortAnnotations(data.annotations)
	const style = opts.style ?? 'wikilink'
	const chapters: TemplateChapter[] = []
	const index = new Map<string, TemplateChapter>()
	let i = 0
	for (const a of sorted) {
		i++
		const key = (a.chapter ?? '').trim() || '未命名章节'
		let group = index.get(key)
		if (!group) {
			group = { chapter: cleanHeading(key, 80), count: 0, annotations: [] }
			index.set(key, group)
			chapters.push(group)
		}
		group.count++
		const protocol = jumpLink(bookId, a.cfi)
		// 指向书文件的双链：带上摘录前 24 字与章节名，CFI 失效时靠它们降级
		const wiki = canLinkBook(data.bookPath)
			? wikilinkFor(
				data.bookPath,
				{
					cfi: a.cfi,
					text: snippetOf(a.text),
					chapter: key === '未命名章节' ? undefined : key,
					// PDF 带上框选矩形，回跳能精确到句；电子书没有 pdf 字段
					pdfRects: a.pdf?.rects,
				},
				'↩ 回原文',
			)
			: ''
		group.annotations.push({
			index: i,
			text: a.text,
			textQuote: quoteBlockOf(a.text),
			note: (a.note ?? '').trim(),
			chapter: group.chapter,
			color: a.color,
			colorName: colorName(a.color),
			jumpLink: style === 'wikilink' && wiki ? wiki : protocol,
			protocolLink: protocol,
			wikiLink: wiki,
			excerptHeading: cleanHeading(a.text || '（空摘录）', 30),
			blockId: `grove-${a.id}`,
			date: new Date(a.createdAt || Date.now()).toLocaleDateString('zh-CN'),
			page: a.pdf?.page ?? null,
		})
	}
	// 书签按书中位置排序（不是按添加时间），和批注的阅读顺序一致
	const bookmarks: TemplateBookmark[] = [...(data.bookmarks ?? [])]
		.sort((x, y) => compareCfi(x.cfi, y.cfi))
		.map(b => {
			const protocol = jumpLink(bookId, b.cfi)
			const wiki = canLinkBook(data.bookPath)
				? wikilinkFor(
					data.bookPath,
					{ cfi: b.cfi, text: snippetOf(b.text ?? ''), chapter: b.label },
					'↩ 回原文',
				)
				: ''
			return {
				label: cleanHeading((b.label ?? '').trim() || '未命名位置', 60),
				text: (b.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
				jumpLink: style === 'wikilink' && wiki ? wiki : protocol,
				protocolLink: protocol,
				wikiLink: wiki,
				date: new Date(b.createdAt || Date.now()).toLocaleDateString('zh-CN'),
				page: pageOfCfi(b.cfi),
			}
		})
	return {
		title: data.title || '未命名',
		author: data.author || '未知',
		bookId,
		bookPath: data.bookPath,
		count: sorted.length,
		bookmarkCount: bookmarks.length,
		date: new Date().toLocaleString('zh-CN', { hour12: false }),
		chapters,
		bookmarks,
	}
}

// ------------------------------------------------------------------
// 迷你模板引擎：{{变量}}、{{#each 列表}}…{{/each}}、{{#if 变量}}…{{/if}}
// 变量沿作用域链查找；each 的循环项是一个对象，其字段在内层可用
// ------------------------------------------------------------------

type Token =
	| { type: 'text'; value: string }
	| { type: 'var'; path: string }
	| { type: 'each'; arg: string; children: Token[] }
	| { type: 'if'; arg: string; children: Token[] }

const TAG_SOURCE = /\{\{\s*(#each\s+([A-Za-z_][\w.]*)|\/(each|if)|#if\s+([A-Za-z_][\w.]*)|([A-Za-z_][\w.]*))\s*\}\}/g

export function parseTemplate(src: string): Token[] {
	const { tokens, closed } = parseSegment(src, undefined)
	if (!closed) throw new Error('模板存在未闭合的标签')
	return tokens
}

function parseSegment(src: string, stop: 'each' | 'if' | undefined): { tokens: Token[]; rest: string; closed: boolean } {
	const re = new RegExp(TAG_SOURCE.source, 'g')
	const tokens: Token[] = []
	let rest = src
	for (;;) {
		re.lastIndex = 0 // rest 每轮都会被重新切片，必须归零，否则解析错位
		const m = re.exec(rest)
		if (!m) {
			if (rest) tokens.push({ type: 'text', value: rest })
			// 到达输入末尾：顶层视为正常结束；块内说明闭合标签缺失
			return { tokens, rest: '', closed: !stop }
		}
		if (m.index > 0) tokens.push({ type: 'text', value: rest.slice(0, m.index) })
		rest = rest.slice(m.index + m[0].length)
		const tag = m[1]
		if (tag.startsWith('#each')) {
			const inner = parseSegment(rest, 'each')
			if (!inner.closed) throw new Error('模板存在未闭合的 {{#each}}')
			tokens.push({ type: 'each', arg: m[2]!, children: inner.tokens })
			rest = inner.rest
		} else if (tag.startsWith('#if')) {
			const inner = parseSegment(rest, 'if')
			if (!inner.closed) throw new Error('模板存在未闭合的 {{#if}}')
			tokens.push({ type: 'if', arg: m[4]!, children: inner.tokens })
			rest = inner.rest
		} else if (tag.startsWith('/')) {
			const kind = m[3] as 'each' | 'if'
			if (!stop) throw new Error(`模板出现了多余的 {{/${kind}}}`)
			if (kind !== stop) throw new Error(`模板标签不匹配：{{/${kind}}}`)
			return { tokens, rest, closed: true }
		} else {
			tokens.push({ type: 'var', path: m[5]! })
		}
	}
}

function lookup(scopes: Record<string, unknown>[], path: string): unknown {
	for (let i = scopes.length - 1; i >= 0; i--) {
		if (path in scopes[i]) return scopes[i][path]
	}
	return undefined
}

function evalTokens(tokens: Token[], scopes: Record<string, unknown>[]): string {
	let out = ''
	for (const t of tokens) {
		if (t.type === 'text') {
			out += t.value
		} else if (t.type === 'var') {
			const v = lookup(scopes, t.path)
			out += v == null ? '' : String(v)
		} else if (t.type === 'each') {
			const arr = lookup(scopes, t.arg)
			if (Array.isArray(arr)) {
				for (const item of arr) {
					scopes.push(item && typeof item === 'object' ? (item as Record<string, unknown>) : { this: item })
					out += evalTokens(t.children, scopes)
					scopes.pop()
				}
			}
		} else {
			if (lookup(scopes, t.arg)) out += evalTokens(t.children, scopes)
		}
	}
	return out
}

/** 语法错误时抛异常，由调用方决定回退策略 */
export function renderNoteTemplate(template: string, ctx: TemplateContext): string {
	const tokens = parseTemplate(template)
	const rendered = evalTokens(tokens, [ctx as unknown as Record<string, unknown>])
	return rendered.replace(/^\n+/, '').replace(/\s+$/, '')
}

// ------------------------------------------------------------------
// 内置默认模板：书名 → 章节 → 摘录（每条批注一个三级标题，可在大纲中显示）
// ------------------------------------------------------------------

/**
 * 内置笔记模板。按当前界面语言生成，{{...}} 占位符由模板引擎解析，
 * 因此这里不能用 t() 的 {name} 插值写法，只能拼在占位符两侧。
 */
export function defaultNoteTemplate(): string {
	const en = currentLocale() === 'en'
	const open = en ? '(' : '（'
	const close = en ? ')' : '）'
	return `# {{title}}

> [!info] ${t('阅读信息')}
> - ${t('作者：')}{{author}}
> - ${t('高亮批注：')}{{count}}${t(' 条')}
> - ${t('最近更新：')}{{date}}

{{#if bookmarkCount}}
## ${t('书签')}

{{#each bookmarks}}
- {{label}}{{#if text}} — {{text}}{{/if}}${open}{{date}}${close}{{jumpLink}}
{{/each}}

{{/if}}
{{#each chapters}}
## {{chapter}}

{{#each annotations}}
### {{excerptHeading}}

{{textQuote}}
{{#if note}}
%%
{{note}}
%%
{{/if}}

{{jumpLink}} ^{{blockId}}

{{/each}}
{{/each}}`
}

// ------------------------------------------------------------------
// 笔记组装：模板只负责标记区间内的内容，区间外（用户手写）原样保留
// ------------------------------------------------------------------

function yamlSafe(value: string): string {
	// JSON 字符串本身是合法的 YAML 双引号标量：反斜杠、引号、换行都会被正确转义
	return JSON.stringify(value)
}

/** 额外写进 frontmatter 的统计字段，供 Dataview / Bases 查询 */
export interface NoteExtraFields {
	annotations?: number
	format?: string
	/** 0–100 */
	progress?: number
	/** 想读 / 在读 / 读完 */
	status?: string
	seconds?: number
	/** 毫秒时间戳，写成 YYYY-MM-DD */
	lastRead?: number
	/** 首次/读完日期（YYYY-MM-DD）；取阅读统计里最早与最晚的阅读日 */
	started?: string
	finished?: string
	publisher?: string
	/** 个人评分 1–5 */
	rating?: number
	isbn?: string
	/** 封面图的双链写法；供 Bases 卡片视图取图 */
	cover?: string
}

/** 插件维护的 frontmatter 字段表：重建与增量刷新都按这张表走，避免两处规则漂移 */
function metaEntries(data: BookData, bookId: string, extra?: NoteExtraFields): Array<[string, string]> {
	const entries: Array<[string, string]> = [
		['title', yamlSafe(data.title || '未命名')],
		['author', yamlSafe(data.author || '')],
		['grove-book', bookId],
	]
	if (!extra) return entries
	if (typeof extra.annotations === 'number') entries.push(['grove_annotations', String(extra.annotations)])
	if (extra.format) entries.push(['grove_format', yamlSafe(extra.format)])
	if (typeof extra.progress === 'number') {
		const p = Math.max(0, Math.min(100, Math.round(extra.progress)))
		entries.push(['grove_progress', String(p)])
	}
	if (extra.status) entries.push(['grove_status', yamlSafe(extra.status)])
	if (extra.started) entries.push(['grove_started', extra.started])
	if (extra.finished) entries.push(['grove_finished', extra.finished])
	if (typeof extra.seconds === 'number') entries.push(['grove_seconds', String(Math.max(0, Math.round(extra.seconds)))])
	if (typeof extra.lastRead === 'number' && extra.lastRead > 0) {
		entries.push(['grove_last_read', new Date(extra.lastRead).toISOString().slice(0, 10)])
	}
	if (extra.publisher) entries.push(['grove_publisher', yamlSafe(extra.publisher)])
	if (typeof extra.rating === 'number' && extra.rating > 0) {
		entries.push(['grove_rating', String(Math.min(5, Math.max(1, Math.round(extra.rating))))])
	}
	if (extra.isbn) entries.push(['grove_isbn', yamlSafe(extra.isbn)])
	if (extra.cover) entries.push(['grove_cover', yamlSafe(extra.cover)])
	return entries
}

/** 0.28.0 早期用连字符命名，Dataview 会把它当减法；刷新时顺手清掉这些旧键 */
const LEGACY_META_KEYS = [
	'grove-annotations',
	'grove-format',
	'grove-progress',
	'grove-status',
	'grove-seconds',
	'grove-last-read',
	'grove-publisher',
]

/** 插件维护的统计键；刷新时若新表里已没有该键（如取消「读完」后的 finished），要把旧行删掉 */
const MANAGED_META_KEYS = [
	'grove_annotations',
	'grove_format',
	'grove_progress',
	'grove_status',
	'grove_started',
	'grove_finished',
	'grove_seconds',
	'grove_last_read',
	'grove_publisher',
	'grove_rating',
	'grove_isbn',
	'grove_cover',
]

function frontmatter(data: BookData, bookId: string, extra?: NoteExtraFields): string {
	return ['---', ...metaEntries(data, bookId, extra).map(([k, v]) => `${k}: ${v}`), '---'].join('\n')
}

/** 更新已有笔记 frontmatter 里插件维护的字段（缺的补上，用户自己加的字段不动） */
function refreshFrontmatter(existing: string, data: BookData, bookId: string, extra?: NoteExtraFields): string {
	const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(existing)
	if (!m || m.index == null) return existing
	const set = (lines: string[], key: string, value: string): string[] => {
		const i = lines.findIndex(l => l.startsWith(`${key}:`))
		if (i >= 0) lines[i] = `${key}: ${value}`
		return lines
	}
	let lines = (m[1] ?? '').split(/\r?\n/)
	// 去掉旧命名的统计键（连字符在 Dataview 里会被解析成减法）
	lines = lines.filter(l => !LEGACY_META_KEYS.some(k => l.startsWith(`${k}:`)))
	const entries = metaEntries(data, bookId, extra)
	// 只有拿到完整统计时才清理：没传 extra 的调用方并不知道这些键是否已失效
	if (extra) {
		const present = new Set(entries.map(([key]) => key))
		// 状态从「读完」改回去时，删除已不再成立的日期键，别把旧完成日期留在笔记里
		lines = lines.filter(l => !MANAGED_META_KEYS.some(k => !present.has(k) && l.startsWith(`${k}:`)))
	}
	// 已有键原地替换，缺的键追加在末尾；顺序稳定，不会每次刷新都改动文本
	for (const [key, value] of entries) {
		if (lines.some(l => l.startsWith(`${key}:`))) lines = set(lines, key, value)
		else lines.push(`${key}: ${value}`)
	}
	return existing.slice(0, m.index) + `---\n${lines.join('\n')}\n---` + existing.slice(m.index + m[0].length)
}

/**
 * 生成完整笔记内容。
 * - template 为 null/空/解析失败：使用内置默认模板。
 * - existing 为 null：新建文件（带 frontmatter）。
 * - 已有标记区间：只覆盖区间内内容；无标记的既有文件在末尾追加。
 */
export function buildNote(
	data: BookData,
	bookId: string,
	existing: string | null,
	template?: string | null,
	extra?: NoteExtraFields,
	link: NoteLinkOptions = {},
): string {
	const tpl = template && template.trim() ? template : defaultNoteTemplate()
	let body: string
	try {
		body = renderNoteTemplate(tpl, buildTemplateContext(data, bookId, link))
	} catch (e) {
		console.error('[Grove Reader] 笔记模板渲染失败，使用默认模板', e)
		body = renderNoteTemplate(defaultNoteTemplate(), buildTemplateContext(data, bookId, link))
	}
	const inner = `${NOTE_BEGIN}\n\n${body}\n\n${NOTE_END}`

	if (existing == null || existing.trim() === '') {
		return `${frontmatter(data, bookId, extra)}\n\n${inner}\n`
	}
	// 已有笔记：先同步插件维护的 frontmatter 字段，再替换标记区间
	existing = refreshFrontmatter(existing, data, bookId, extra)
	const begin = existing.indexOf(NOTE_BEGIN)
	// 用最后一个 END：END 标记被误删时按「BEGIN 之后全是生成区」处理，
	// 否则每次刷新都会在末尾追加一整块重复内容
	const end = begin >= 0 ? existing.lastIndexOf(NOTE_END) : -1
	if (begin >= 0 && end > begin) {
		const before = existing.slice(0, begin).replace(/\n+$/, '')
		const after = existing.slice(end + NOTE_END.length).replace(/^\n+/, '')
		const head = before ? `${before}\n\n${inner}` : inner
		return after ? `${head}\n\n${after}\n` : `${head}\n`
	}
	if (begin >= 0) {
		const before = existing.slice(0, begin).replace(/\n+$/, '')
		return `${before}\n\n${inner}\n`
	}
	return `${existing.replace(/\n+$/, '')}\n\n${inner}\n`
}

// ------------------------------------------------------------------
// 增量追加：只把新批注插进对应章节，不重写整个生成区
// ------------------------------------------------------------------

export interface AppendAnnotationsResult {
	markdown: string
	appended: number
}

/** 生成区里一行的块 id：`… ^grove-xxx` */
const BLOCK_LINE_RE = /\^grove-([0-9A-Za-z_-]+)\s*$/

function blockIdsInRegion(region: string): Set<string> {
	const ids = new Set<string>()
	for (const line of region.split(/\r?\n/)) {
		const m = BLOCK_LINE_RE.exec(line)
		if (m) ids.add(m[1])
	}
	return ids
}

interface RenderedBlock {
	chapter: string
	block: string
}

/** 从「只含新批注」的渲染结果里按块 id 取出章节标题与整块文本 */
function extractBlocks(markdown: string): Map<string, RenderedBlock> {
	const out = new Map<string, RenderedBlock>()
	const begin = markdown.indexOf(NOTE_BEGIN)
	const end = markdown.lastIndexOf(NOTE_END)
	if (begin < 0 || end <= begin) return out
	const lines = markdown.slice(begin + NOTE_BEGIN.length, end).split(/\r?\n/)
	let chapter = ''
	for (let i = 0; i < lines.length; i++) {
		if (/^##\s+/.test(lines[i])) chapter = lines[i].trim()
		const m = BLOCK_LINE_RE.exec(lines[i])
		if (!m) continue
		let start = i
		while (start > 0) {
			const prev = lines[start - 1]
			if (BLOCK_LINE_RE.test(prev) || /^##\s+/.test(prev)) break
			start--
		}
		while (start < i && lines[start].trim() === '') start++
		out.set(m[1], { chapter, block: lines.slice(start, i + 1).join('\n').trimEnd() })
	}
	return out
}

/** 把一块内容插到生成区里对应章节的末尾；找不到章节就新建一节 */
function insertBlock(markdown: string, chapter: string, block: string): string | null {
	if (!chapter) return null
	const begin = markdown.indexOf(NOTE_BEGIN)
	const end = markdown.lastIndexOf(NOTE_END)
	if (begin < 0 || end <= begin) return null
	const region = markdown.slice(begin + NOTE_BEGIN.length, end)
	// 章节标题后可能被编辑器补过空格，匹配时容忍行尾空白
	const headingRe = new RegExp(`\\n${chapter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\n`)
	const hit = headingRe.exec(region)
	if (!hit) {
		const body = region.replace(/\s+$/, '')
		return `${markdown.slice(0, begin + NOTE_BEGIN.length)}${body}\n\n${chapter}\n\n${block}\n\n${markdown.slice(end)}`
	}
	const after = hit.index + hit[0].length
	const next = region.indexOf('\n## ', after)
	const cut = next < 0 ? region.replace(/\s+$/, '').length : next
	const before = region.slice(0, cut).replace(/\s+$/, '')
	const tail = region.slice(cut).replace(/^\s+/, '')
	return `${markdown.slice(0, begin + NOTE_BEGIN.length)}${before}\n\n${block}\n\n${tail ? `${tail}\n\n` : ''}${markdown.slice(end)}`
}

/**
 * 新增批注的增量写法：已有笔记里缺哪些批注，就只用同一模板渲染这些批注，
 * 再插到各自章节末尾。这样不会重写整个生成区，用户在生成区里的手写内容也能留下。
 * 模板结构对不上（生成区里没有任何块 id、没有章节标题等）时返回 null，调用方退回整段重写。
 */
export function appendAnnotationBlocks(
	existing: string,
	data: BookData,
	bookId: string,
	template?: string | null,
	link: NoteLinkOptions = {},
	extra?: NoteExtraFields,
): AppendAnnotationsResult | null {
	const begin = existing.indexOf(NOTE_BEGIN)
	const end = existing.lastIndexOf(NOTE_END)
	if (begin < 0 || end <= begin) return null
	const ids = blockIdsInRegion(existing.slice(begin + NOTE_BEGIN.length, end))
	// 生成区里一个块都没有：可能是旧笔记或换了不含块 id 的模板，别冒险追加重复内容
	if (!ids.size) return null
	const missing = data.annotations.filter(a => a?.id && !ids.has(a.id))
	if (!missing.length) return null

	const partial: BookData = { ...data, annotations: missing, bookmarks: [] }
	const rendered = buildNote(partial, bookId, null, template, undefined, link)
	const blocks = extractBlocks(rendered)
	if (blocks.size !== missing.length) return null

	let out = refreshFrontmatter(existing, data, bookId, extra)
	let appended = 0
	for (const a of missing) {
		const spec = blocks.get(a.id)
		if (!spec) return null
		const next = insertBlock(out, spec.chapter, spec.block)
		if (!next) return null
		out = next
		appended++
	}
	return { markdown: out, appended }
}
