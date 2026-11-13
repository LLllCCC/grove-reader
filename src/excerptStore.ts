/**
 * 划词「存为摘录 / 存为名词」的纯函数部分。
 * 文件读写放在 excerptNote.ts（那边才 import obsidian），smoke 可以直接测这里。
 */
import { sanitizeFileName } from './util'

export type ExcerptMode = 'quote' | 'term'

export interface ExcerptEntry {
	bookTitle: string
	chapter?: string
	text: string
	/** 回跳链接（wikilink 或 markdown 链接），可为空 */
	link?: string
	mode: ExcerptMode
}

export function excerptFileName(bookTitle: string): string {
	return `${sanitizeFileName(displayTitle(bookTitle) || '未命名')} 摘录.md`
}

/** 书名本身可能已带《》，再包一层会变成《《…》》 */
function displayTitle(title: string): string {
	const t = (title ?? '').trim()
	const m = /^《(.+)》$/.exec(t)
	return (m ? m[1] : t).trim()
}

/** 单条摘录的 Markdown（纯函数，便于 smoke） */
export function excerptMarkdown(entry: ExcerptEntry, date = new Date()): string {
	const day = date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
	const title = displayTitle(entry.bookTitle) || '未命名'
	const source = [`《${title}》`, entry.chapter?.trim(), day].filter(Boolean).join(' · ')
	const text = entry.text.trim()
	if (!text) return ''
	if (entry.mode === 'term') {
		const oneLine = text.replace(/\s+/g, ' ')
		return `- **${oneLine}**${entry.chapter ? `（${entry.chapter.trim()}）` : ''}${entry.link ? ` ${entry.link}` : ''}`
	}
	const lines = text.split(/\r?\n/).map(line => `> ${line}`.trimEnd())
	return `${lines.join('\n')}\n>\n> —— ${source}${entry.link ? ` · ${entry.link}` : ''}\n`
}

function excerptDocHeader(bookTitle: string): string {
	const title = displayTitle(bookTitle) || '未命名'
	return [
		'---',
		`book: "${title.replace(/"/g, "'")}"`,
		'tags:',
		'  - 阅读/摘录',
		'---',
		'',
		`# 《${title}》摘录`,
		'',
		'> 由 Grove Reader 的划词「存为摘录 / 存为名词」追加，按时间倒序往下写。',
		'',
	].join('\n')
}

/** 新建摘录文件时的完整初始内容（纯函数，便于 smoke） */
export function excerptDocMarkdown(bookTitle: string): string {
	return excerptDocHeader(bookTitle)
}

