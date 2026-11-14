import { Annotation, BookData, HIGHLIGHT_COLORS, colorName } from './types'
import { todayKey } from './stats'
import { normalizeReview } from './review'
import { basenameOf, bookIdFor, cleanBookTitle, stripTitleAuthor } from './util'

export interface SearchDoc {
	bookPath: string
	bookTitle: string
	author: string
	bookId: string
	notePath?: string
	bookExists: boolean
	annotation: Annotation
}

export interface SearchOptions {
	/** 只看有评论的批注 */
	onlyNotes?: boolean
}

/**
 * 全局批注索引直接由 BookStore 的内存数据生成，不再扫 data/books 目录：
 * 移动端没有 Node fs，而且启动时已经全部载入内存，没必要再读一遍盘。
 */
export function buildSearchIndex(books: BookData[], bookExists: (path: string) => boolean): SearchDoc[] {
	const docs: SearchDoc[] = []
	for (const data of books) {
		const bookPath = typeof data.bookPath === 'string' ? data.bookPath : ''
		if (!bookPath) continue
		const author = typeof data.author === 'string' ? data.author : ''
		const bookTitle = stripTitleAuthor(
			cleanBookTitle((typeof data.title === 'string' && data.title.trim()) || basenameOf(bookPath).replace(/\.[^.]+$/, '')),
			author,
		)
		const bookId = bookIdFor(bookPath)
		const exists = bookExists(bookPath)
		for (const raw of Array.isArray(data.annotations) ? data.annotations : []) {
			if (!raw || typeof raw.text !== 'string') continue
			const annotation: Annotation = {
				...raw,
				id: typeof raw.id === 'string' ? raw.id : '',
				cfi: typeof raw.cfi === 'string' ? raw.cfi : '',
				color: typeof raw.color === 'string' ? raw.color : 'yellow',
				note: typeof raw.note === 'string' ? raw.note : '',
				chapter: typeof raw.chapter === 'string' ? raw.chapter : '',
				createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
				updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
			}
			docs.push({ bookPath, bookTitle, author, bookId, notePath: data.notePath, bookExists: exists, annotation })
		}
	}
	return docs
}

export function searchDocs(docs: SearchDoc[], query: string, options: SearchOptions = {}): SearchDoc[] {
	const terms = normalizeTerms(query)
	if (!terms.length) return []
	const hits = docs.filter(doc => {
		const a = doc.annotation
		if (options.onlyNotes && !(a.note ?? '').trim()) return false
		const haystack = [a.text, a.note ?? '', a.chapter ?? '', doc.bookTitle, doc.author]
			.join('\n')
			.toLowerCase()
		return terms.every(term => haystack.includes(term))
	})
	return hits.sort((a, b) => {
		const ta = Math.max(a.annotation.updatedAt || 0, a.annotation.createdAt || 0)
		const tb = Math.max(b.annotation.updatedAt || 0, b.annotation.createdAt || 0)
		if (tb !== ta) return tb - ta
		return a.bookTitle.localeCompare(b.bookTitle, 'zh-CN')
	})
}

export function normalizeTerms(query: string): string[] {
	return query
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
}

// ------------------------------------------------------------------
// 导出：先筛再导（范围 / 书 / 章节 / 颜色 / 今天），Markdown 支持分组
// ------------------------------------------------------------------

export type ExportGroupBy = 'book' | 'chapter' | 'color'

export const EXPORT_GROUP_LABELS: Record<ExportGroupBy, string> = {
	book: '按书',
	chapter: '按章',
	color: '按颜色',
}

export interface ExportOptions {
	/** results = 只导当前检索命中；all = 全部批注。调用方决定传入哪份数据 */
	source?: 'results' | 'all'
	/** 只看今天新建或改过的批注 */
	todayOnly?: boolean
	/** 只导这本书（bookPath）；空 = 全部 */
	bookPath?: string
	/** 只导这个章节；空 = 全部 */
	chapter?: string
	/** 颜色 key；空 = 全部颜色 */
	colors?: string[]
	onlyNotes?: boolean
	groupBy?: ExportGroupBy
	/** Markdown 内容开关；CSV 始终输出完整列 */
	includeComment?: boolean
	includeLink?: boolean
	includeMeta?: boolean
}

export type ResolvedExportOptions = Required<ExportOptions>

export function resolveExportOptions(options: Partial<ExportOptions> = {}): ResolvedExportOptions {
	return {
		source: options.source === 'all' ? 'all' : 'results',
		todayOnly: options.todayOnly === true,
		bookPath: options.bookPath ?? '',
		chapter: options.chapter ?? '',
		colors: Array.isArray(options.colors) ? options.colors.filter(Boolean) : [],
		onlyNotes: options.onlyNotes === true,
		groupBy: options.groupBy === 'chapter' || options.groupBy === 'color' ? options.groupBy : 'book',
		includeComment: options.includeComment !== false,
		includeLink: options.includeLink !== false,
		includeMeta: options.includeMeta !== false,
	}
}

export function isToday(ms: number, now = Date.now()): boolean {
	if (!ms) return false
	return todayKey(new Date(ms)) === todayKey(new Date(now))
}

/** 按导出选项筛批注；source 由调用方先决定数据来源，这里不再处理 */
export function filterExportDocs(docs: SearchDoc[], options: Partial<ExportOptions> = {}): SearchDoc[] {
	const opts = resolveExportOptions(options)
	return docs.filter(doc => {
		const a = doc.annotation
		if (opts.onlyNotes && !(a.note ?? '').trim()) return false
		if (opts.bookPath && doc.bookPath !== opts.bookPath) return false
		if (opts.chapter && (a.chapter ?? '') !== opts.chapter) return false
		if (opts.colors.length && !opts.colors.includes(a.color)) return false
		if (opts.todayOnly) {
			const at = Math.max(a.updatedAt || 0, a.createdAt || 0)
			if (!isToday(at)) return false
		}
		return true
	})
}

export interface ExportGroup {
	key: string
	title: string
	/** 书名分组时放作者行；其他分组留空 */
	subtitle: string
	docs: SearchDoc[]
}

/** 按书 / 章节 / 颜色分组；组顺序跟着批注第一次出现的顺序 */
export function groupExportDocs(docs: SearchDoc[], groupBy: ExportGroupBy = 'book'): ExportGroup[] {
	const groups = new Map<string, ExportGroup>()
	for (const doc of docs) {
		const a = doc.annotation
		let key: string
		let title: string
		let subtitle = ''
		if (groupBy === 'chapter') {
			const chapter = (a.chapter ?? '').trim() || '未分章'
			key = `${doc.bookPath}\u0000${chapter}`
			title = `《${doc.bookTitle}》${doc.bookExists ? '' : '（原文件缺失）'} · ${chapter}`
		} else if (groupBy === 'color') {
			key = a.color || 'yellow'
			title = colorName(key)
		} else {
			key = doc.bookPath || doc.bookTitle
			title = `《${doc.bookTitle}》${doc.bookExists ? '' : '（原文件缺失）'}`
			subtitle = doc.author ? `*${doc.author}*` : ''
		}
		let group = groups.get(key)
		if (!group) {
			group = { key, title, subtitle, docs: [] }
			groups.set(key, group)
		}
		group.docs.push(doc)
	}
	return [...groups.values()]
}

export function exportMarkdown(docs: SearchDoc[], query: string, options: Partial<ExportOptions> = {}): string {
	const opts = resolveExportOptions(options)
	const now = new Date()
	const stamp = formatDate(now)
	const heading = query.trim() ? `批注检索：${query.trim()}` : '批注导出'
	const lines: string[] = [
		'---',
		`title: ${JSON.stringify(heading)}`,
		'tags:',
		'  - Grove-Reader',
		'  - 批注检索',
		'  - 批注导出',
		`created: ${JSON.stringify(stamp)}`,
		`query: ${JSON.stringify(query.trim())}`,
		`count: ${docs.length}`,
		`group: ${JSON.stringify(EXPORT_GROUP_LABELS[opts.groupBy])}`,
		'---',
		'',
		`# ${heading}`,
		'',
		`> 结果 ${docs.length} 条 · 导出 ${stamp}`,
		'',
	]
	for (const group of groupExportDocs(docs, opts.groupBy)) {
		if (opts.groupBy === 'color') lines.push(`## ${group.title}（${group.docs.length} 条）`)
		else lines.push(`## ${group.title}`)
		if (group.subtitle) lines.push(group.subtitle)
		lines.push('')
		for (const doc of group.docs) {
			const a = doc.annotation
			const meta: string[] = []
			const chapter = (a.chapter ?? '').trim()
			// 按颜色分组时标题只有颜色，条目里必须带上书名才能分辨
			if (opts.groupBy === 'color') meta.push(`《${doc.bookTitle}》`)
			if (opts.includeMeta) {
				if (opts.groupBy !== 'chapter' && chapter) meta.push(chapter)
				if (a.cfi.startsWith('page:')) meta.push(`第 ${a.cfi.slice(5)} 页`)
				if (opts.groupBy !== 'color') meta.push(colorName(a.color))
			}
			if (meta.length) lines.push(`- **${meta.join(' · ')}**`)
			else lines.push('-')
			const quote = a.text.split('\n').map(line => `  > ${line}`).join('\n')
			lines.push(quote)
			if (opts.includeComment && a.note?.trim()) {
				lines.push(`  **评论：** ${a.note.trim().split('\n').join('\n  ')}`)
			}
			if (opts.includeLink && doc.bookExists && doc.bookId) {
				lines.push(`  [↩ 回原文](${jumpUrl(doc.bookId, a.cfi)})`)
			}
			lines.push('')
		}
	}
	return lines.join('\n')
}

export function exportCsv(docs: SearchDoc[]): string {
	const rows = [[
		'书名', '作者', '章节', '位置', '颜色', '划线', '评论', '原文件', '回跳链接',
		'复习到期', '间隔(天)', '难度', '复习次数', '忘记次数', '上次复习',
	]]
	for (const doc of docs) {
		const a = doc.annotation
		const review = normalizeReview(a.review)
		rows.push([
			doc.bookTitle,
			doc.author,
			a.chapter ?? '',
			a.cfi.startsWith('page:') ? `第 ${a.cfi.slice(5)} 页` : a.cfi,
			colorName(a.color),
			a.text,
			a.note ?? '',
			doc.bookExists ? '在' : '缺失',
			doc.bookExists && doc.bookId ? jumpUrl(doc.bookId, a.cfi) : '',
			review ? isoDate(review.due) : '',
			review ? String(review.interval) : '',
			review ? review.ease.toFixed(2) : '',
			review ? String(review.reps) : '',
			review ? String(review.lapses) : '',
			review?.last ? isoDate(review.last) : '',
		])
	}
	return rows.map(row => row.map(csvField).join(',')).join('\r\n')
}

/** 本地时区的 YYYY-MM-DD（CSV 里给人看，不用 UTC 免得跨天） */
function isoDate(ts: number): string {
	const d = new Date(ts)
	const p = (n: number): string => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function colorDot(color: string): string {
	return HIGHLIGHT_COLORS.find(c => c.key === color)?.css ?? HIGHLIGHT_COLORS[0].css
}

function jumpUrl(bookId: string, cfi: string): string {
	return `obsidian://grove?book=${encodeURIComponent(bookId)}&cfi=${encodeURIComponent(cfi)}`
}

function csvField(value: string): string {
	return `"${value.replace(/"/g, '""')}"`
}

function formatDate(date: Date): string {
	const p = (n: number): string => String(n).padStart(2, '0')
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}
