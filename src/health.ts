import fs from 'node:fs'
import pathModule from 'node:path'
import { isAbsolutePath } from './util'

export interface MissingBook {
	file: string
	bookPath: string
	title: string
	annotations: number
}

export interface MissingNote {
	file: string
	bookPath: string
	notePath: string
	title: string
}

export interface HealthReport {
	jsonCount: number
	annotationCount: number
	missingBooks: MissingBook[]
	missingNotes: MissingNote[]
	duplicates: Array<{ bookPath: string; files: string[] }>
	staleShelf: string[]
	staleLists: string[]
	staleStats: string[]
	brokenNoteIds: Array<{ note: string; id: string }>
}

function resolve(vaultBase: string, p: string): string {
	return isAbsolutePath(p) ? p : pathModule.join(vaultBase, p)
}

function walkMarkdown(dir: string, out: string[] = []): string[] {
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = pathModule.join(dir, entry.name)
			if (entry.isDirectory()) walkMarkdown(full, out)
			else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
		}
	} catch {
		// 目录不存在
	}
	return out
}

/**
 * 只读体检：检查批注 JSON、笔记、书架缓存、书单、统计之间的引用是否还对得上。
 * 不修改任何文件；清理动作由调用方决定。
 */
export function buildHealthReport(vaultBase: string, dataRoot: string, notesFolder: string): HealthReport {	const booksDir = pathModule.join(dataRoot, 'data', 'books')
	const report: HealthReport = {
		jsonCount: 0,
		annotationCount: 0,
		missingBooks: [],
		missingNotes: [],
		duplicates: [],
		staleShelf: [],
		staleLists: [],
		staleStats: [],
		brokenNoteIds: [],
	}

	const ids = new Set<string>()
	const paths = new Map<string, string[]>()
	let jsonNames: string[] = []
	try {
		jsonNames = fs.readdirSync(booksDir).filter(n => n.endsWith('.json'))
	} catch {
		return report
	}

	for (const file of jsonNames) {
		ids.add(file.slice(0, -5))
		let data: Record<string, unknown>
		try {
			data = JSON.parse(fs.readFileSync(pathModule.join(booksDir, file), 'utf-8')) as Record<string, unknown>
		} catch {
			continue
		}
		report.jsonCount++
		const bookPath = typeof data.bookPath === 'string' ? data.bookPath : ''
		const title = typeof data.title === 'string' ? data.title : ''
		const annotations = Array.isArray(data.annotations) ? data.annotations.length : 0
		report.annotationCount += annotations
		if (bookPath) {
			const list = paths.get(bookPath) ?? []
			list.push(file)
			paths.set(bookPath, list)
		}
		if (!bookPath || !fs.existsSync(resolve(vaultBase, bookPath))) {
			report.missingBooks.push({ file, bookPath, title, annotations })
		}
		const notePath = typeof data.notePath === 'string' ? data.notePath : ''
		if (notePath && !fs.existsSync(resolve(vaultBase, notePath))) {
			report.missingNotes.push({ file, bookPath, notePath, title })
		}
	}

	for (const [bookPath, files] of paths) {
		if (files.length > 1) report.duplicates.push({ bookPath, files })
	}

	const shelfPath = pathModule.join(dataRoot, 'data', 'shelf.json')
	try {
		const shelf = JSON.parse(fs.readFileSync(shelfPath, 'utf-8')) as { entries?: Record<string, unknown> }
		for (const key of Object.keys(shelf.entries ?? {})) {
			if (!fs.existsSync(resolve(vaultBase, key))) report.staleShelf.push(key)
		}
	} catch {
		// 没有书架缓存
	}

	const listsPath = pathModule.join(dataRoot, 'data', 'lists.json')
	try {
		const lists = JSON.parse(fs.readFileSync(listsPath, 'utf-8')) as { members?: Record<string, unknown> }
		for (const key of Object.keys(lists.members ?? {})) {
			if (!fs.existsSync(resolve(vaultBase, key))) report.staleLists.push(key)
		}
	} catch {
		// 没有书单
	}

	const statsPath = pathModule.join(dataRoot, 'data', 'stats.json')
	try {
		const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8')) as { books?: Record<string, unknown> }
		for (const key of Object.keys(stats.books ?? {})) {
			if (!fs.existsSync(resolve(vaultBase, key))) report.staleStats.push(key)
		}
	} catch {
		// 没有统计
	}

	const notesRoot = notesFolder ? pathModule.join(vaultBase, notesFolder) : ''
	if (notesRoot) {
		for (const note of walkMarkdown(notesRoot)) {
			let text = ''
			try {
				text = fs.readFileSync(note, 'utf-8')
			} catch {
				continue
			}
			const line = text.split('\n').find(l => l.startsWith('grove-book:'))
			if (!line) continue
			const id = line.slice('grove-book:'.length).trim()
			if (id && !ids.has(id)) {
				report.brokenNoteIds.push({ note: pathModule.basename(note), id })
			}
		}
	}

	return report
}

/** 可安全清理的失效引用数：书架/书单/统计 + 原书仍在的失效笔记路径 */
export function healthCleanupCount(report: HealthReport, vaultBase: string): number {
	const notes = report.missingNotes.filter(n => n.bookPath && fs.existsSync(resolve(vaultBase, n.bookPath))).length
	return report.staleShelf.length + report.staleLists.length + report.staleStats.length + notes
}
