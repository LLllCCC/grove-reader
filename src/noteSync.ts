import { Annotation, BookData } from './types'
import { NOTE_BEGIN, NOTE_END } from './notes'

/** 生成区里每条批注末尾的块引用：`… ^grove-3f2a9c` */
const BLOCK_LINE_RE = /\s\^grove-([0-9A-Za-z_-]+)\s*$/

export interface NoteEntry {
	id: string
	/** 引用块拼回来的摘录（换行已还原） */
	text: string
	/** `%% … %%` 里的评论 */
	note: string
	/**
	 * 条目里是否真的有 %% 注释块。
	 * 没有时无法区分「用户清空了评论」和「模板根本不输出评论」，
	 * 这种条目不参与评论回写，只进 skipped。
	 */
	hasNoteBlock: boolean
	/** 条目结束行（1 起，含生成区起始标记行），用于报错定位 */
	line: number
}

export interface SyncChange {
	id: string
	field: 'text' | 'note'
	from: string
	to: string
}

export interface SyncPlan {
	changes: SyncChange[]
	/** 笔记里找不到对应条目的批注：只提示，不自动删除数据 */
	missing: Annotation[]
	/** 笔记里出现、批注数据里没有的块 id（手写条目或串书） */
	unknown: string[]
	/** 有评论但条目没有 %% 块，无法判断是否被清空 */
	skipped: string[]
	entries: number
}

/**
 * 只解析 GROVE:BEGIN/END 之间的生成区。
 * 区间外的内容属于用户手写，一律不看，避免把别处的 `^grove-` 误当批注。
 */
export function parseNoteEntries(markdown: string): NoteEntry[] {
	const begin = markdown.indexOf(NOTE_BEGIN)
	const end = markdown.lastIndexOf(NOTE_END)
	if (begin < 0 || end <= begin) return []
	const region = markdown.slice(begin + NOTE_BEGIN.length, end)
	const lines = region.split(/\r?\n/)
	const out: NoteEntry[] = []
	let from = 0
	for (let i = 0; i < lines.length; i++) {
		const m = BLOCK_LINE_RE.exec(lines[i])
		if (!m) continue
		out.push(readBlock(m[1], lines.slice(from, i), i + 1))
		from = i + 1
	}
	return out
}

function readBlock(id: string, lines: string[], line: number): NoteEntry {
	// 一个条目里可能出现多段引用：笔记顶部的 [!info] 信息框、以及真正的摘录。
	// 只认「最后一段非 callout 引用」当摘录，避免把信息框吃进正文。
	const runs: string[][] = []
	let current: string[] | null = null
	const note: string[] = []
	let inComment = false
	let hasNoteBlock = false
	for (const raw of lines) {
		const trimmed = raw.trim()
		if (trimmed === '%%') {
			if (inComment) inComment = false
			else {
				inComment = true
				hasNoteBlock = true
			}
			current = null
			continue
		}
		if (inComment) {
			note.push(raw)
			continue
		}
		if (trimmed.startsWith('>')) {
			if (!current) {
				current = []
				runs.push(current)
			}
			// 模板在行间插 `>` 作为空引用行，还原时丢掉空行即可；
			// 原文里的行内格式（粗体/代码）原样保留，比较也按原文比
			const content = trimmed.replace(/^>\s?/, '')
			if (content.trim()) current.push(content)
			continue
		}
		// 标题、回跳链接、空行都会结束当前引用块
		current = null
	}
	const quote = [...runs].reverse().find(r => r.length && !r[0].startsWith('[!')) ?? []
	return { id, text: quote.join('\n'), note: note.join('\n').trim(), hasNoteBlock, line }
}

/** 模板用 `>` 空行分隔段落，回读时拿不到原始空行；比较前先抹平空行差异 */
export function normalizeExcerpt(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map(l => l.trim())
		.filter(Boolean)
		.join('\n')
}

/** 比对笔记与批注数据；只产出「有明确改动」的项，缺条目只记录不删数据 */
export function planSync(data: BookData, markdown: string): SyncPlan {
	const entries = parseNoteEntries(markdown)
	const byId = new Map<string, NoteEntry>()
	for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e)

	const changes: SyncChange[] = []
	const missing: Annotation[] = []
	const skipped: string[] = []

	for (const a of data.annotations) {
		const entry = byId.get(a.id)
		if (!entry) {
			missing.push(a)
			continue
		}
		byId.delete(a.id)

		const newText = entry.text.trim()
		if (newText && normalizeExcerpt(newText) !== normalizeExcerpt(a.text ?? '')) {
			changes.push({ id: a.id, field: 'text', from: a.text ?? '', to: newText })
		}
		const storedNote = (a.note ?? '').trim()
		if (entry.hasNoteBlock) {
			if (entry.note !== storedNote) {
				changes.push({ id: a.id, field: 'note', from: a.note ?? '', to: entry.note })
			}
		} else if (storedNote) {
			// 模板没输出 %% 或用户删掉了整块：不猜意图
			skipped.push(a.id)
		}
	}

	return { changes, missing, unknown: [...byId.keys()], skipped, entries: entries.length }
}

/** 应用选中的改动，返回真正改到的条数 */
export function applySync(data: BookData, changes: SyncChange[]): number {
	const now = Date.now()
	let n = 0
	for (const c of changes) {
		const a = data.annotations.find(x => x.id === c.id)
		if (!a) continue
		if (c.field === 'text') a.text = c.to
		else a.note = c.to
		a.updatedAt = now
		n++
	}
	return n
}
