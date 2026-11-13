/**
 * 外部标注导入：解析 Kindle `My Clippings.txt`、Readwise CSV、微信读书 Markdown，
 * 按书名/作者匹配到库内书籍，规范化文本去重后转成 Grove 批注。
 * 纯函数，方便 smoke 直接测。
 */
import type { Annotation } from './types'
import { randomId } from './util'

export type HighlightFormat = 'kindle' | 'readwise' | 'weread'

export interface ImportedHighlight {
	bookTitle: string
	author?: string
	chapter?: string
	text: string
	note?: string
	/** 外部来源里的位置串 */
	location?: string
	color?: string
}

export interface ImportBookTarget {
	path: string
	title: string
	author?: string
}

export interface MatchedHighlightGroup {
	bookPath: string
	bookTitle: string
	highlights: ImportedHighlight[]
}

export interface HighlightMatchResult {
	matched: MatchedHighlightGroup[]
	unmatched: ImportedHighlight[]
}

// ------------------------------------------------------------------
// 通用
// ------------------------------------------------------------------

/** RFC 4180 风格的 CSV：支持引号包裹的逗号与换行 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = []
	let row: string[] = []
	let field = ''
	let quoted = false
	const src = text.replace(/^\uFEFF/, '')
	for (let i = 0; i < src.length; i++) {
		const ch = src[i]
		if (quoted) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"'
					i++
				} else {
					quoted = false
				}
			} else {
				field += ch
			}
			continue
		}
		if (ch === '"') {
			quoted = true
			continue
		}
		if (ch === ',') {
			row.push(field)
			field = ''
			continue
		}
		if (ch === '\r') continue
		if (ch === '\n') {
			row.push(field)
			rows.push(row)
			row = []
			field = ''
			continue
		}
		field += ch
	}
	if (field || row.length) {
		row.push(field)
		rows.push(row)
	}
	return rows.filter(r => r.some(c => c.trim() !== ''))
}

/** 按内容特征识别格式；识别不了返回 null */
export function detectHighlightFormat(text: string): HighlightFormat | null {
	const t = text.replace(/^\uFEFF/, '').trim()
	if (!t) return null
	const firstLine = t.split(/\r?\n/, 1)[0] ?? ''
	// Readwise CSV 的表头最稳，先认它：Highlight,Book Title,Book Author,...
	if (firstLine.includes(',') && /highlight/i.test(firstLine) && /(book|title|author)/i.test(firstLine)) {
		return 'readwise'
	}
	if (/^={5,}\s*$/m.test(t) && /(Your Highlight|Your Note|标注|笔记|书签)/i.test(t)) return 'kindle'
	if (/^#{1,2}\s+\S/m.test(t) && /^>\s?/m.test(t)) return 'weread'
	// 有些微信读书导出没有书名标题，只有章节标题 + 引用
	if (/^##+\s+\S/m.test(t) && /^>\s?/m.test(t)) return 'weread'
	return null
}

/** 书名归一化：去书名号/空白/标点，末尾的作者括号也去掉 */
export function normalizeBookTitle(value: string): string {
	return (value || '')
		.replace(/[《》「」『』“”‘’"']/g, '')
		.replace(/[（(][^（()）]{1,30}[)）]\s*$/, '')
		.replace(/[\s\u3000]/g, '')
		.replace(/[:：,，.。!！?？·•\-—_/\\|]/g, '')
		.toLowerCase()
}

/** 摘录归一化：只用于「是不是同一条」判断，不改变写入内容 */
export function normalizeHighlightText(text: string): string {
	return (text || '')
		.replace(/\s+/g, '')
		.replace(/[.,;:!?'"“”‘’、，。；：！？…—–\-_()（）[\]【】《》]/g, '')
		.toLowerCase()
}

// ------------------------------------------------------------------
// Kindle My Clippings.txt
// ------------------------------------------------------------------

function splitKindleTitle(line: string): { title: string; author?: string } {
	const m = /^(.*?)\s*[（(]([^（()）]{1,60})[)）]\s*$/.exec(line.trim())
	if (m && m[1].trim()) return { title: m[1].trim(), author: m[2].trim() }
	return { title: line.trim() }
}

function kindleLocation(meta: string): string | undefined {
	const loc = /(?:Location|位置)\s*#?\s*([\d]+(?:-[\d]+)?)/i.exec(meta)
	if (loc) return `位置 ${loc[1]}`
	const page = /(?:page|第)\s*(\d+)\s*(?:页)?/i.exec(meta)
	if (page) return `第 ${page[1]} 页`
	return undefined
}

export function parseKindleClippings(text: string): ImportedHighlight[] {
	const blocks = text.replace(/^\uFEFF/, '').split(/\r?\n={5,}\s*(?:\r?\n|$)/)
	const out: ImportedHighlight[] = []
	let last: ImportedHighlight | null = null
	for (const block of blocks) {
		const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
		if (!lines.length) continue
		const titleLine = lines[0]
		const metaAt = lines.findIndex(l => /^[-—–]\s*/.test(l))
		const meta = metaAt >= 0 ? lines[metaAt] : ''
		const body = lines.slice(metaAt >= 0 ? metaAt + 1 : 1).join('\n').trim()
		if (!body) continue
		if (/Bookmark|书签/i.test(meta)) continue
		const { title, author } = splitKindleTitle(titleLine)
		const location = kindleLocation(meta)
		if (/Your Note|笔记|Note on/i.test(meta)) {
			// 笔记紧跟同位置的高亮：合并成评论；找不到对应高亮就丢弃（没有正文可定位）
			if (last && normalizeBookTitle(last.bookTitle) === normalizeBookTitle(title) && last.location === location) {
				last.note = [last.note, body].filter(Boolean).join('\n')
			}
			continue
		}
		const item: ImportedHighlight = { bookTitle: title, author, text: body, location }
		last = item
		out.push(item)
	}
	return out.filter(h => h.text.trim())
}

// ------------------------------------------------------------------
// Readwise CSV
// ------------------------------------------------------------------

const READWISE_COLORS: Record<string, string> = {
	yellow: 'yellow',
	blue: 'blue',
	pink: 'red',
	red: 'red',
	purple: 'purple',
	orange: 'yellow',
	green: 'green',
}

export function parseReadwiseCsv(text: string): ImportedHighlight[] {
	const rows = parseCsv(text)
	if (rows.length < 2) return []
	const header = rows[0].map(h => h.trim().toLowerCase())
	const col = (...names: string[]): number => {
		for (const name of names) {
			const i = header.indexOf(name)
			if (i >= 0) return i
		}
		return -1
	}
	const iText = col('highlight', 'text', 'highlighted text')
	const iTitle = col('book title', 'title', 'book')
	if (iText < 0 || iTitle < 0) return []
	const iAuthor = col('book author', 'author')
	const iNote = col('note', 'notes')
	const iChapter = col('chapter', 'section')
	const iLocation = col('location')
	const iColor = col('color')
	const out: ImportedHighlight[] = []
	for (const row of rows.slice(1)) {
		const body = (row[iText] ?? '').trim()
		const title = (row[iTitle] ?? '').trim()
		if (!body || !title) continue
		const rawColor = (row[iColor] ?? '').trim().toLowerCase()
		out.push({
			bookTitle: title,
			author: iAuthor >= 0 ? (row[iAuthor] ?? '').trim() || undefined : undefined,
			chapter: iChapter >= 0 ? (row[iChapter] ?? '').trim() || undefined : undefined,
			text: body,
			note: iNote >= 0 ? (row[iNote] ?? '').trim() || undefined : undefined,
			location: iLocation >= 0 ? (row[iLocation] ?? '').trim() || undefined : undefined,
			color: READWISE_COLORS[rawColor],
		})
	}
	return out
}

// ------------------------------------------------------------------
// 微信读书 Markdown
// ------------------------------------------------------------------

export function parseWereadMarkdown(text: string): ImportedHighlight[] {
	const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
	const out: ImportedHighlight[] = []
	let bookTitle = ''
	let author = ''
	let chapter = ''
	let buf: string[] = []
	const flush = (): void => {
		const body = buf.join('\n').trim()
		buf = []
		if (body) out.push({ bookTitle, author: author || undefined, chapter: chapter || undefined, text: body })
	}
	for (const raw of lines) {
		const line = raw.replace(/\s+$/, '')
		const h1 = /^#\s+(.+)$/.exec(line)
		const h2 = /^##+\s+(.+)$/.exec(line)
		if (h1 && !bookTitle) {
			flush()
			bookTitle = h1[1].trim().replace(/^[《「]|[》」]$/g, '')
			continue
		}
		if (h2) {
			flush()
			chapter = h2[1].trim()
			continue
		}
		const meta = /^(?:作者|Author|Book Author)\s*[：:]\s*(.+)$/i.exec(line)
		if (meta && !author) {
			author = meta[1].trim()
			continue
		}
		if (/^>\s?/.test(line)) {
			buf.push(line.replace(/^>\s?/, ''))
			continue
		}
		const note = /^(?:想法|点评|笔记|Note)\s*[：:]\s*(.+)$/i.exec(line)
		if (note && out.length) {
			const target = out[out.length - 1]
			target.note = [target.note, note[1].trim()].filter(Boolean).join('\n')
			continue
		}
		if (!line.trim()) flush()
	}
	flush()
	return out.filter(h => h.text.trim())
}

// ------------------------------------------------------------------
// 匹配与去重
// ------------------------------------------------------------------

function scoreMatch(highlight: ImportedHighlight, book: ImportBookTarget): number {
	const a = normalizeBookTitle(highlight.bookTitle)
	const b = normalizeBookTitle(book.title)
	if (!a || !b) return 0
	let score = 0
	if (a === b) score = 100
	else if (a.length >= 2 && b.includes(a)) score = 60
	else if (b.length >= 2 && a.includes(b)) score = 55
	else return 0
	const authorA = normalizeBookTitle(highlight.author ?? '')
	const authorB = normalizeBookTitle(book.author ?? '')
	if (authorA && authorB && (authorA === authorB || authorA.includes(authorB) || authorB.includes(authorA))) score += 15
	return score
}

/** 把一组导入标注按书名/作者匹配到库内书籍；匹配不上的留在 unmatched */
export function matchImportedHighlights(highlights: ImportedHighlight[], books: ImportBookTarget[]): HighlightMatchResult {
	const groups = new Map<string, ImportedHighlight[]>()
	for (const h of highlights) {
		const key = `${normalizeBookTitle(h.bookTitle)}|${normalizeBookTitle(h.author ?? '')}`
		const list = groups.get(key)
		if (list) list.push(h)
		else groups.set(key, [h])
	}
	const matched: MatchedHighlightGroup[] = []
	const unmatched: ImportedHighlight[] = []
	for (const list of groups.values()) {
		let best: ImportBookTarget | null = null
		let bestScore = 0
		for (const book of books) {
			const score = scoreMatch(list[0], book)
			if (score > bestScore) {
				bestScore = score
				best = book
			}
		}
		if (best && bestScore >= 50) {
			matched.push({ bookPath: best.path, bookTitle: best.title, highlights: list })
		} else {
			unmatched.push(...list)
		}
	}
	// 同一本书可能来自多组（例如一组带作者、一组没带）：合并成一本，避免预览重复、重复读写
	const merged: MatchedHighlightGroup[] = []
	const byPath = new Map<string, MatchedHighlightGroup>()
	for (const group of matched) {
		const existing = byPath.get(group.bookPath)
		if (existing) existing.highlights.push(...group.highlights)
		else {
			const item = { ...group, highlights: [...group.highlights] }
			byPath.set(item.bookPath, item)
			merged.push(item)
		}
	}
	return { matched: merged, unmatched }
}

/** 生成一条待写入的批注；cfi 留空，靠摘录原文回跳 */
export function importedAnnotation(highlight: ImportedHighlight, source: HighlightFormat, now = Date.now()): Annotation {
	return {
		id: randomId(),
		cfi: '',
		text: highlight.text.trim(),
		color: highlight.color ?? 'yellow',
		note: highlight.note?.trim() || undefined,
		chapter: highlight.chapter?.trim() || undefined,
		location: highlight.location?.trim() || undefined,
		source,
		createdAt: now,
		updatedAt: now,
	}
}

export interface BuildAnnotationsResult {
	annotations: Annotation[]
	duplicates: number
}

/** 去掉书里已有（以及本批重复）的摘录，剩下的转成批注 */
export function buildImportedAnnotations(
	highlights: ImportedHighlight[],
	existing: Annotation[],
	source: HighlightFormat,
	now = Date.now(),
): BuildAnnotationsResult {
	const seen = new Set(existing.map(a => normalizeHighlightText(a.text)))
	const annotations: Annotation[] = []
	let duplicates = 0
	for (const h of highlights) {
		const key = normalizeHighlightText(h.text)
		if (!key) continue
		if (seen.has(key)) {
			duplicates++
			continue
		}
		seen.add(key)
		annotations.push(importedAnnotation(h, source, now))
	}
	return { annotations, duplicates }
}

/** 统一入口：按格式解析 */
export function parseHighlightText(text: string, format: HighlightFormat): ImportedHighlight[] {
	if (format === 'kindle') return parseKindleClippings(text)
	if (format === 'readwise') return parseReadwiseCsv(text)
	return parseWereadMarkdown(text)
}
