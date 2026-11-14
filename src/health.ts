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

export interface OrphanPortrait {
	file: string
	bookPath: string
	title: string
}

export interface VectorIssue {
	file: string
	bookPath: string
	title: string
	/** broken＝文件损坏/缺字段；orphan＝原书已不存在 */
	reason: 'broken' | 'orphan'
}

/** 间隔重复排期里的坏值（手改 JSON、旧版本写坏、跨端合并异常都可能出现） */
export interface ReviewIssue {
	file: string
	bookPath: string
	title: string
	annotationId: string
	reason: string
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
	/** AI 要点索引对应的书已不存在（或没有批注数据） */
	orphanPortraits: OrphanPortrait[]
	/** 语义索引损坏，或对应的书已不存在 */
	vectorIssues: VectorIssue[]
	/** 复习排期坏值：下次复习时会自动覆盖，也可用命令重置 */
	reviewIssues: ReviewIssue[]
}

/** 检查一条批注的 review 字段，返回问题描述；没问题或没有该字段时返回 null */
function reviewProblem(raw: unknown): string | null {
	if (raw === undefined) return null
	if (!raw || typeof raw !== 'object') return 'review 字段不是对象'
	const rev = raw as Record<string, unknown>
	const due = rev.due
	const interval = rev.interval
	const ease = rev.ease
	if (typeof due !== 'number' || !Number.isFinite(due) || due <= 0) return '到期时间无效'
	if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0 || interval > 3650) return '间隔无效'
	if (typeof ease !== 'number' || !Number.isFinite(ease) || ease < 1.29 || ease > 3.01) return '难度系数越界'
	return null
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
		orphanPortraits: [],
		vectorIssues: [],
		reviewIssues: [],
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
		if (Array.isArray(data.annotations)) {
			for (const raw of data.annotations) {
				const item = (raw ?? {}) as Record<string, unknown>
				const problem = reviewProblem(item.review)
				if (!problem) continue
				report.reviewIssues.push({
					file,
					bookPath,
					title,
					annotationId: typeof item.id === 'string' ? item.id : '',
					reason: problem,
				})
			}
		}
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

	// AI 要点索引：书 id 没有对应批注数据，或 bookPath 已不存在，都算孤儿
	const portraitsDir = joinPath(dataRoot, 'portraits')
	try {
		const portraitFiles = (await io.list(portraitsDir)).files.filter(f => f.endsWith('.json'))
		for (const full of portraitFiles) {
			const file = full.replace(/\\/g, '/').split('/').pop() ?? full
			const id = file.slice(0, -5)
			const doc = await readJsonFile<{ bookPath?: unknown; title?: unknown }>(io, full)
			const bookPath = typeof doc?.bookPath === 'string' ? doc.bookPath : ''
			const title = typeof doc?.title === 'string' ? doc.title : ''
			const hasData = ids.has(id)
			const bookOk = bookPath ? await exists(bookPath) : false
			if (!hasData || !bookOk) report.orphanPortraits.push({ file, bookPath, title })
		}
	} catch {
		// 没有索引目录
	}

	// 语义索引：坏文件或原书已不存在；损坏的会让检索一直跳过它
	const vectorsDir = joinPath(dataRoot, 'vectors')
	try {
		const vectorFiles = (await io.list(vectorsDir)).files.filter(f => f.endsWith('.json'))
		for (const full of vectorFiles) {
			const file = full.replace(/\\/g, '/').split('/').pop() ?? full
			const doc = await readJsonFile<{ bookPath?: unknown; title?: unknown; chunks?: unknown; dims?: unknown }>(io, full)
			if (!doc || !Array.isArray(doc.chunks) || !doc.chunks.length || typeof doc.dims !== 'number' || doc.dims <= 0) {
				report.vectorIssues.push({ file, bookPath: '', title: '', reason: 'broken' })
				continue
			}
			const bookPath = typeof doc.bookPath === 'string' ? doc.bookPath : ''
			const bookOk = bookPath ? await exists(bookPath) : false
			if (!bookOk) {
				report.vectorIssues.push({
					file,
					bookPath,
					title: typeof doc.title === 'string' ? doc.title : '',
					reason: 'orphan',
				})
			}
		}
	} catch {
		// 还没有向量索引
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
		+ report.orphanPortraits.length + report.vectorIssues.length
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
