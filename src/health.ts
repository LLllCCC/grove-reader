import { cleanBookTitle, isAbsolutePath, stripTitleAuthor } from './util'
import { joinPath, PlatformIO, readJsonFile } from './platformIO'

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
	/** 原书还在、只是笔记被挪走/删掉了——这类才算可安全清理 */
	bookExists: boolean
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

/** 只读体检：检查批注 JSON、笔记、书架缓存、书单、统计之间的引用是否还对得上。
 *  走 PlatformIO，桌面与手机同一套逻辑（手机端 vaultPath 传空串，路径本身是库内相对路径）。 */
export async function buildHealthReport(
	io: PlatformIO,
	vaultPath: string,
	dataRoot: string,
	notesFolder: string,
): Promise<HealthReport> {
	const booksDir = joinPath(dataRoot, 'data', 'books')
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

	const resolve = (p: string): string => (vaultPath && !isAbsolutePath(p) ? joinPath(vaultPath, p) : p)
	const exists = async (p: string): Promise<boolean> => {
		if (!p) return false
		try {
			return await io.exists(resolve(p))
		} catch {
			return false
		}
	}

	const ids = new Set<string>()
	const paths = new Map<string, string[]>()
	let jsonNames: string[] = []
	try {
		const listed = await io.list(booksDir)
		jsonNames = listed.files.filter(f => f.endsWith('.json'))
	} catch {
		return report
	}

	for (const full of jsonNames) {
		const file = full.replace(/\\/g, '/').split('/').pop() ?? full
		ids.add(file.slice(0, -5))
		const data = await readJsonFile<Record<string, unknown>>(io, full)
		if (!data) continue
		report.jsonCount++
		const bookPath = typeof data.bookPath === 'string' ? data.bookPath : ''
		const author = typeof data.author === 'string' ? data.author : ''
		const title = typeof data.title === 'string' ? stripTitleAuthor(cleanBookTitle(data.title), author) : ''
		const annotations = Array.isArray(data.annotations) ? data.annotations.length : 0
		report.annotationCount += annotations
		if (bookPath) {
			const list = paths.get(bookPath) ?? []
			list.push(file)
			paths.set(bookPath, list)
		}
		const bookOk = await exists(bookPath)
		if (!bookPath || !bookOk) {
			report.missingBooks.push({ file, bookPath, title, annotations })
		}
		const notePath = typeof data.notePath === 'string' ? data.notePath : ''
		if (notePath && !(await exists(notePath))) {
			report.missingNotes.push({ file, bookPath, notePath, title, bookExists: bookOk })
		}
	}

	for (const [bookPath, files] of paths) {
		if (files.length > 1) report.duplicates.push({ bookPath, files })
	}

	const shelf = await readJsonFile<{ entries?: Record<string, unknown> }>(io, joinPath(dataRoot, 'data', 'shelf.json'))
	for (const key of Object.keys(shelf?.entries ?? {})) {
		if (!(await exists(key))) report.staleShelf.push(key)
	}

	const lists = await readJsonFile<{ members?: Record<string, unknown> }>(io, joinPath(dataRoot, 'data', 'lists.json'))
	for (const key of Object.keys(lists?.members ?? {})) {
		if (!(await exists(key))) report.staleLists.push(key)
	}

	const stats = await readJsonFile<{ books?: Record<string, unknown> }>(io, joinPath(dataRoot, 'data', 'stats.json'))
	for (const key of Object.keys(stats?.books ?? {})) {
		if (!(await exists(key))) report.staleStats.push(key)
	}

	if (notesFolder) {
		for (const note of await walkMarkdown(io, joinPath(vaultPath, notesFolder))) {
			let text = ''
			try {
				text = await io.read(note)
			} catch {
				continue
			}
			const line = text.split('\n').find(l => l.startsWith('grove-book:'))
			if (!line) continue
			const id = line.slice('grove-book:'.length).trim()
			if (id && !ids.has(id)) {
				report.brokenNoteIds.push({ note: note.replace(/\\/g, '/').split('/').pop() ?? note, id })
			}
		}
	}

	return report
}

/** 可安全清理的失效引用数：书架/书单/统计 + 原书仍在的失效笔记路径 */
export function healthCleanupCount(report: HealthReport): number {
	const notes = report.missingNotes.filter(n => n.bookExists).length
	return report.staleShelf.length + report.staleLists.length + report.staleStats.length + notes
}

async function walkMarkdown(io: PlatformIO, dir: string, out: string[] = []): Promise<string[]> {
	if (!dir) return out
	let listed: { files: string[]; folders: string[] }
	try {
		listed = await io.list(dir)
	} catch {
		return out
	}
	for (const f of listed.files) {
		if (f.endsWith('.md')) out.push(f)
	}
	for (const sub of listed.folders) await walkMarkdown(io, sub, out)
	return out
}
