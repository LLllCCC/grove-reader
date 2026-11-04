import fs from 'node:fs'
import pathModule from 'node:path'
import { Annotation, HIGHLIGHT_COLORS, colorName } from './types'
import { bookIdFor, cleanBookTitle, isAbsolutePath } from './util'

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

export function buildSearchIndex(dataRoot: string, vaultBase: string): SearchDoc[] {
	const booksDir = pathModule.join(dataRoot, 'data', 'books')
	let names: string[] = []
	try {
		names = fs.readdirSync(booksDir).filter(n => n.endsWith('.json'))
	} catch {
		return []
	}
	const docs: SearchDoc[] = []
	for (const name of names) {
		let data: {
			bookPath?: string
			title?: string
			author?: string
			notePath?: string
			annotations?: Annotation[]
		}
		try {
			data = JSON.parse(fs.readFileSync(pathModule.join(booksDir, name), 'utf-8'))
		} catch {
			continue
		}
		const bookPath = typeof data.bookPath === 'string' ? data.bookPath : ''
		const abs = bookPath ? (isAbsolutePath(bookPath) ? bookPath : pathModule.join(vaultBase, bookPath)) : ''
		const bookExists = !!abs && fs.existsSync(abs)
		const bookTitle = cleanBookTitle((typeof data.title === 'string' && data.title.trim())
			|| (bookPath ? pathModule.basename(bookPath).replace(/\.[^.]+$/, '') : '未命名'))
		const author = typeof data.author === 'string' ? data.author : ''
		const bookId = bookPath ? bookIdFor(bookPath) : ''
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
			docs.push({
				bookPath,
				bookTitle,
				author,
				bookId,
				notePath: data.notePath,
				bookExists,
				annotation,
			})
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

export function exportMarkdown(docs: SearchDoc[], query: string): string {
	const now = new Date()
	const stamp = formatDate(now)
	const lines: string[] = [
		'---',
		`title: ${JSON.stringify(`批注检索：${query}`)}`,
		'tags:',
		'  - Grove-Reader',
		'  - 批注检索',
		`created: ${JSON.stringify(stamp)}`,
		`query: ${JSON.stringify(query)}`,
		`count: ${docs.length}`,
		'---',
		'',
		`# 批注检索：${query}`,
		'',
		`> 结果 ${docs.length} 条 · 导出 ${stamp}`,
		'',
	]
	const groups = new Map<string, SearchDoc[]>()
	for (const doc of docs) {
		const key = doc.bookPath || doc.bookTitle
		const list = groups.get(key) ?? []
		list.push(doc)
		groups.set(key, list)
	}
	for (const [, group] of groups) {
		const first = group[0]
		lines.push(`## 《${first.bookTitle}》${first.bookExists ? '' : '（原文件缺失）'}`)
		if (first.author) lines.push(`*${first.author}*`)
		lines.push('')
		for (const doc of group) {
			const a = doc.annotation
			const where = [a.chapter, a.cfi.startsWith('page:') ? `第 ${a.cfi.slice(5)} 页` : '', colorName(a.color)]
				.filter(Boolean)
				.join(' · ')
			if (where) lines.push(`- **${where}**`)
			else lines.push('-')
			const quote = a.text.split('\n').map(line => `  > ${line}`).join('\n')
			lines.push(quote)
			if (a.note?.trim()) {
				lines.push(`  **评论：** ${a.note.trim().split('\n').join('\n  ')}`)
			}
			if (doc.bookExists && doc.bookId) {
				lines.push(`  [⤴ 回原文](${jumpUrl(doc.bookId, a.cfi)})`)
			}
			lines.push('')
		}
	}
	return lines.join('\n')
}

export function exportCsv(docs: SearchDoc[]): string {
	const rows = [['书名', '作者', '章节', '位置', '颜色', '划线', '评论', '原文件', '回跳链接']]
	for (const doc of docs) {
		const a = doc.annotation
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
		])
	}
	return rows.map(row => row.map(csvField).join(',')).join('\r\n')
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
