import { Annotation, BookData, colorName } from './types'
import { compareCfi, encodeParam, truncate } from './util'

export const NOTE_BEGIN = '<!-- GROVE:BEGIN 由 Grove Reader 生成，重新生成时会覆盖此区间内的内容 -->'
export const NOTE_END = '<!-- GROVE:END -->'

export const DEFAULT_TEMPLATE_PATH = '阅读笔记/Grove 笔记模板.md'

/** 从笔记回跳原文的协议链接，由 main.ts 中注册的 obsidian://grove 处理 */
export function jumpLink(bookId: string, cfi: string): string {
	return `[⤴ 回原文](obsidian://grove?book=${encodeParam(bookId)}&cfi=${encodeParam(cfi)})`
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
	jumpLink: string
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

export interface TemplateContext {
	title: string
	author: string
	bookId: string
	bookPath: string
	count: number
	date: string
	chapters: TemplateChapter[]
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

export function buildTemplateContext(data: BookData, bookId: string): TemplateContext {
	const sorted = sortAnnotations(data.annotations)
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
		group.annotations.push({
			index: i,
			text: a.text,
			textQuote: quoteBlockOf(a.text),
			note: (a.note ?? '').trim(),
			chapter: group.chapter,
			color: a.color,
			colorName: colorName(a.color),
			jumpLink: jumpLink(bookId, a.cfi),
			excerptHeading: cleanHeading(a.text || '（空摘录）', 30),
			blockId: `grove-${a.id}`,
			date: new Date(a.createdAt || Date.now()).toLocaleDateString('zh-CN'),
			page: a.pdf?.page ?? null,
		})
	}
	return {
		title: data.title || '未命名',
		author: data.author || '未知',
		bookId,
		bookPath: data.bookPath,
		count: sorted.length,
		date: new Date().toLocaleString('zh-CN', { hour12: false }),
		chapters,
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

export const DEFAULT_NOTE_TEMPLATE = `# {{title}}

> [!info] 阅读信息
> - 作者：{{author}}
> - 高亮批注：{{count}} 条
> - 最近更新：{{date}}

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

// ------------------------------------------------------------------
// 笔记组装：模板只负责标记区间内的内容，区间外（用户手写）原样保留
// ------------------------------------------------------------------

function yamlSafe(value: string): string {
	// JSON 字符串本身是合法的 YAML 双引号标量：反斜杠、引号、换行都会被正确转义
	return JSON.stringify(value)
}

function frontmatter(data: BookData, bookId: string): string {
	return [
		'---',
		`title: ${yamlSafe(data.title || '未命名')}`,
		`author: ${yamlSafe(data.author || '')}`,
		`grove-book: ${bookId}`,
		'---',
	].join('\n')
}

/** 更新已有笔记 frontmatter 里插件维护的三个字段；没有该字段或无 frontmatter 就不动 */
function refreshFrontmatter(existing: string, data: BookData, bookId: string): string {
	const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(existing)
	if (!m || m.index == null) return existing
	const set = (lines: string[], key: string, value: string): string[] => {
		const i = lines.findIndex(l => l.startsWith(`${key}:`))
		if (i >= 0) lines[i] = `${key}: ${value}`
		return lines
	}
	let lines = (m[1] ?? '').split(/\r?\n/)
	lines = set(lines, 'title', yamlSafe(data.title || '未命名'))
	lines = set(lines, 'author', yamlSafe(data.author || ''))
	lines = set(lines, 'grove-book', bookId)
	return existing.slice(0, m.index) + `---\n${lines.join('\n')}\n---` + existing.slice(m.index + m[0].length)
}

/**
 * 生成完整笔记内容。
 * - template 为 null/空/解析失败：使用内置默认模板。
 * - existing 为 null：新建文件（带 frontmatter）。
 * - 已有标记区间：只覆盖区间内内容；无标记的既有文件在末尾追加。
 */
export function buildNote(data: BookData, bookId: string, existing: string | null, template?: string | null): string {
	const tpl = template && template.trim() ? template : DEFAULT_NOTE_TEMPLATE
	let body: string
	try {
		body = renderNoteTemplate(tpl, buildTemplateContext(data, bookId))
	} catch (e) {
		console.error('[Grove Reader] 笔记模板渲染失败，使用默认模板', e)
		body = renderNoteTemplate(DEFAULT_NOTE_TEMPLATE, buildTemplateContext(data, bookId))
	}
	const inner = `${NOTE_BEGIN}\n\n${body}\n\n${NOTE_END}`

	if (existing == null || existing.trim() === '') {
		return `${frontmatter(data, bookId)}\n\n${inner}\n`
	}
	// 已有笔记：先同步插件维护的 frontmatter 字段，再替换标记区间
	existing = refreshFrontmatter(existing, data, bookId)
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
