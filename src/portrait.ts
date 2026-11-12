/**
 * AI 全书问答的「压缩要点」索引。
 * 分块、检索、提示词都是纯函数，便于 smoke；读写走 PlatformIO，存在 <数据目录>/portraits/<书 id>.json。
 */
import type { PlatformIO } from './platformIO'
import { joinPath, writeJsonFile } from './platformIO'

export interface SourceSection {
	label: string
	text: string
}

export interface TextChunk {
	chapter: string
	text: string
}

export interface PortraitChunk {
	index: number
	chapter: string
	summary: string
	preview: string
	chars: number
}

export interface PortraitDoc {
	version: 1
	bookPath: string
	title: string
	createdAt: number
	updatedAt: number
	status: 'ready' | 'partial'
	chunks: PortraitChunk[]
}

/** 每块目标字数；书太大时按总字数放大，保证总块数不失控 */
export const CHUNK_CHARS = 6000
/** 单本书最多生成多少块要点（约 72 万字以内不用放大） */
export const MAX_CHUNKS = 120

const STOP_WORDS = new Set([
	'的', '了', '是', '在', '和', '与', '有', '我', '你', '他', '她', '它', '们', '这', '那', '哪',
	'什么', '怎么', '为什么', '如何', '哪些', '一个', '一种', '这个', '那个', '可以', '是否', '请问',
	'请', '问', '吗', '呢', '吧', '啊', '书', '书里', '书中', '作者', '这段', '这一', '关于',
])

/** 文本规范化：统一换行、压缩空白，保留段落 */
export function normalizeText(text: string): string {
	return String(text ?? '')
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t\u00a0]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

/** 在 room 以内找一个尽量自然的断点：段落 > 句号 > 硬切 */
function cutPoint(text: string, room: number): number {
	if (room >= text.length) return text.length
	const window = text.slice(0, room)
	const para = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'))
	if (para > room * 0.5) return para
	const sentence = Math.max(
		window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
		window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
	)
	if (sentence > room * 0.5) return sentence + 1
	return room
}

/**
 * 把各节正文合并成固定大小的块，尽量在段落/句子处断开。
 * 章节标签取块开头所在节的标签，跨节合并时足够定位。
 */
export function chunkSections(sections: SourceSection[], maxChars = CHUNK_CHARS): TextChunk[] {
	const parts = sections
		.map(s => ({ label: (s.label ?? '').trim() || '正文', text: normalizeText(s.text) }))
		.filter(s => !!s.text)
	const total = parts.reduce((n, s) => n + s.text.length, 0)
	if (!total) return []
	const size = Math.max(1200, maxChars, Math.ceil(total / MAX_CHUNKS))
	const chunks: TextChunk[] = []
	let buf = ''
	let label = ''
	const flush = (): void => {
		const text = buf.trim()
		if (text) chunks.push({ chapter: label || '正文', text })
		buf = ''
	}
	for (const part of parts) {
		let rest = part.text
		while (rest) {
			if (!buf) label = part.label
			const room = size - buf.length
			if (room <= 0) {
				flush()
				continue
			}
			if (rest.length <= room) {
				buf += (buf ? '\n\n' : '') + rest
				rest = ''
				continue
			}
			const cut = cutPoint(rest, room)
			buf += (buf ? '\n\n' : '') + rest.slice(0, cut).trimEnd()
			rest = rest.slice(cut).trimStart()
			flush()
		}
	}
	flush()
	return chunks
}

/** 查询词：中文二元组 + 英文/数字整词；去掉常见虚词，最多 12 个 */
export function tokenizeQuery(query: string): string[] {
	const text = String(query ?? '').toLowerCase()
	const terms = new Set<string>()
	for (const word of text.match(/[a-z0-9][a-z0-9._-]*/g) ?? []) {
		if (word.length >= 2 && !STOP_WORDS.has(word)) terms.add(word)
	}
	for (const run of text.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
		if (run.length <= 4 && !STOP_WORDS.has(run)) terms.add(run)
		for (let i = 0; i + 1 < run.length; i++) {
			const bigram = run.slice(i, i + 2)
			if (!STOP_WORDS.has(bigram)) terms.add(bigram)
		}
	}
	return [...terms].slice(0, 12)
}

function countOf(haystack: string, needle: string): number {
	if (!needle) return 0
	let count = 0
	let from = 0
	while (count < 20) {
		const at = haystack.indexOf(needle, from)
		if (at < 0) break
		count++
		from = at + needle.length
	}
	return count
}

export function scoreChunk(terms: string[], chunk: PortraitChunk): number {
	const summary = (chunk.summary ?? '').toLowerCase()
	const preview = (chunk.preview ?? '').toLowerCase()
	const chapter = (chunk.chapter ?? '').toLowerCase()
	let score = 0
	for (const term of terms) {
		score += countOf(summary, term) * 3
		score += countOf(preview, term)
		score += countOf(chapter, term)
	}
	return score
}

/** 取最相关的块；一个词都没命中时均匀抽样，保证「这本书讲什么」也能回答 */
export function pickChunks(terms: string[], chunks: PortraitChunk[], limit = 5): PortraitChunk[] {
	if (!chunks.length) return []
	const scored = chunks.map(chunk => ({ chunk, score: scoreChunk(terms, chunk) }))
	const hits = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
	if (hits.length) return hits.map(x => x.chunk)
	const n = Math.min(limit, chunks.length)
	return Array.from({ length: n }, (_, i) => chunks[Math.round((i * (chunks.length - 1)) / Math.max(1, n - 1))])
}

export function previewOf(text: string, max = 360): string {
	const line = normalizeText(text).replace(/\s+/g, ' ').trim()
	return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * 续建：上次中途取消/失败时，前面已生成的块可以直接复用。
 * 只认「partial + 下标连续 + 章节/长度/预览都对得上」的前缀；书改过就从头重建，
 * 避免把旧摘要安到新正文上。
 */
export function resumableChunks(doc: PortraitDoc | null, chunks: TextChunk[]): PortraitChunk[] {
	if (!doc || doc.status !== 'partial' || !doc.chunks.length || !chunks.length) return []
	const reusable: PortraitChunk[] = []
	const limit = Math.min(doc.chunks.length, chunks.length)
	for (let i = 0; i < limit; i++) {
		const old = doc.chunks[i]
		const next = chunks[i]
		if (!old || old.index !== i) break
		if (old.chapter !== next.chapter) break
		if (old.chars !== next.text.length) break
		if (old.preview !== previewOf(next.text)) break
		reusable.push(old)
	}
	return reusable
}

/** 全书问答的提示词：只依据检索到的要点与摘录，要求带章节依据 */
export function buildAskPrompt(bookTitle: string, question: string, chunks: PortraitChunk[]): string {
	const materials = chunks.map((chunk, i) => {
		const head = `[${i + 1}] ${chunk.chapter || '正文'}`
		const summary = `要点：${chunk.summary || '（无）'}`
		const preview = chunk.preview ? `摘录：${chunk.preview}` : ''
		return [head, summary, preview].filter(Boolean).join('\n')
	}).join('\n\n')
	return [
		`你是《${bookTitle || '未命名'}》的阅读助手。下面是从全书要点索引里检索到的材料。`,
		'',
		materials || '（没有检索到相关材料）',
		'',
		'请只依据上面的材料回答，不要编造。材料没有提到就直说「书中这部分没有提到」。',
		'回答用中文：先给结论，再用 1-3 条依据（标注章节），总长度控制在 400 字以内。',
		'',
		`问题：${question.trim()}`,
	].join('\n')
}

export function portraitPath(dataRoot: string, bookId: string): string {
	return joinPath(dataRoot, 'portraits', `${bookId}.json`)
}

export async function loadPortrait(io: PlatformIO, dataRoot: string, bookId: string): Promise<PortraitDoc | null> {
	if (!bookId) return null
	const path = portraitPath(dataRoot, bookId)
	try {
		if (!(await io.exists(path))) return null
		const raw = JSON.parse(await io.read(path)) as PortraitDoc
		if (!raw || raw.version !== 1 || !Array.isArray(raw.chunks)) return null
		return raw
	} catch {
		return null
	}
}

export async function savePortrait(io: PlatformIO, dataRoot: string, bookId: string, doc: PortraitDoc): Promise<void> {
	if (!bookId) return
	await writeJsonFile(io, portraitPath(dataRoot, bookId), doc)
}

export async function removePortrait(io: PlatformIO, dataRoot: string, bookId: string): Promise<void> {
	if (!bookId) return
	try {
		await io.remove(portraitPath(dataRoot, bookId))
	} catch {
		// 不存在就算了
	}
}

/** 书改名/移动时把索引迁到新 id 下，并更新里面的 bookPath */
export async function movePortrait(
	io: PlatformIO,
	dataRoot: string,
	fromId: string,
	toId: string,
	newBookPath?: string,
): Promise<void> {
	if (!fromId || !toId || fromId === toId) return
	const doc = await loadPortrait(io, dataRoot, fromId)
	if (!doc) return
	if (newBookPath) doc.bookPath = newBookPath
	doc.updatedAt = Date.now()
	await savePortrait(io, dataRoot, toId, doc)
	await removePortrait(io, dataRoot, fromId)
}
