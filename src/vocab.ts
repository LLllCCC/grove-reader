/**
 * 生词本：每条生词写成独立小节，按词去重；支持导出 Anki 可导入的两列 CSV。
 * 纯函数，方便 smoke 直接测。
 */
import { jumpLink } from './notes'
import { bookIdFor, sanitizeFileName } from './util'

export interface VocabEntry {
	word: string
	meaning: string
	/** 书中原文（可选） */
	context?: string
	bookTitle: string
	bookPath: string
	chapter?: string
	cfi?: string
	createdAt: number
}

/** 生词本文件夹（库内相对路径） */
export function vocabFolder(notesFolder: string): string {
	const base = (notesFolder || '阅读笔记').replace(/\\/g, '/').replace(/\/+$/, '')
	return `${base}/生词本`
}

/** 每本书一份：`<书名> 生词本.md` */
export function vocabFileName(bookTitle: string): string {
	return `${sanitizeFileName(bookTitle || '未命名')} 生词本.md`
}

export function vocabFilePath(notesFolder: string, bookTitle: string): string {
	return `${vocabFolder(notesFolder)}/${vocabFileName(bookTitle)}`
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function oneLine(value: string): string {
	return value.replace(/\s*\n+\s*/g, '；').trim()
}

/** 书名已经带《》时不再重复包一层 */
function bookLabel(title: string): string {
	const value = (title || '').trim() || '未命名'
	return /^《.*》$/.test(value) ? value : `《${value}》`
}

/** 把 AI 的三行输出拆成独立条目；用户自由输入的释义保持一行一项 */
function meaningLines(meaning: string): string[] {
	const lines = (meaning ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
	if (!lines.length) return ['- **释义**：（待补充）']
	const out: string[] = []
	for (const line of lines) {
		const m = /^(释义|词性|例句|用法|解释)\s*[：:]\s*(.*)$/.exec(line)
		if (m) out.push(`- **${m[1]}**：${m[2] || '（待补充）'}`)
		else if (!out.length) out.push(`- **释义**：${line}`)
		else out.push(`- ${line}`)
	}
	return out
}

/** 单条生词的 Markdown 块 */
export function vocabEntryMarkdown(entry: VocabEntry): string {
	const lines = [`## ${entry.word.trim()}`, '', ...meaningLines(entry.meaning)]
	if (entry.context?.trim()) lines.push(`- **原文**：${oneLine(entry.context)}`)
	const where = [bookLabel(entry.bookTitle)]
	if (entry.chapter?.trim()) where.push(entry.chapter.trim())
	if (entry.cfi) where.push(jumpLink(bookIdFor(entry.bookPath), entry.cfi))
	lines.push(`- **位置**：${where.join(' · ')}`)
	lines.push(`- **添加**：${new Date(entry.createdAt).toISOString().slice(0, 10)}`)
	return lines.join('\n')
}

/** 追加一条；同名词已存在时不重复写 */
export function appendVocabEntry(existing: string | null, entry: VocabEntry): { markdown: string; added: boolean } {
	const word = entry.word.trim()
	const markdown = existing ?? `# ${bookLabel(entry.bookTitle)}生词本\n`
	if (!word) return { markdown, added: false }
	const has = new RegExp(`^##\\s+${escapeRegExp(word)}\\s*$`, 'm').test(markdown)
	if (has) return { markdown, added: false }
	const block = vocabEntryMarkdown(entry)
	return { markdown: `${markdown.replace(/\s+$/, '')}\n\n${block}\n`, added: true }
}

/** Anki / 抽认卡软件可直接导入的两列 CSV */
export function vocabAnkiCsv(entry: VocabEntry): string {
	const field = (value: string): string => `"${value.replace(/"/g, '""')}"`
	const back = [entry.meaning.trim()]
	if (entry.context?.trim()) back.push(`原文：${oneLine(entry.context)}`)
	if (entry.chapter?.trim()) back.push(`章节：${entry.chapter.trim()}`)
	return `${field(entry.word.trim())},${field(back.join('\n'))}`
}

/** 解析已有生词本里的词条（用于"已有多少词"统计） */
export function parseVocabWords(markdown: string): string[] {
	const out: string[] = []
	for (const line of markdown.split(/\r?\n/)) {
		const m = /^##\s+(.+?)\s*$/.exec(line)
		if (m) out.push(m[1])
	}
	return out
}
