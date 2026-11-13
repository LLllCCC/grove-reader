/**
 * 向量语义索引：把整本书切成 ~1600 字的块，逐块取嵌入，存成 Base64 Float32。
 *
 * 纯函数（切块、编码、余弦）放在这里，smoke 可直接测；落盘走 PlatformIO，
 * 文件在 `<数据目录>/vectors/<书 id>.json`，和 portraits/guides 同级。
 */
import type { PlatformIO } from './platformIO'
import { joinPath, writeJsonFile } from './platformIO'
import { normalizeText, type SourceSection } from './portrait'

export interface VectorChunk {
	label: string
	/** TXT 的全文字符偏移；其他格式为 0 */
	start: number
	/** 回跳定位：txt:起-止 / page:N / 空（电子书靠 label + pct） */
	cfi: string
	pct: number
	page?: number
	/** 结果列表里展示的摘录（不含整块正文，控制索引体积） */
	preview: string
	/** Base64 编码的 Float32Array，已归一化 */
	vector: string
	/** 正文指纹；重建时用来复用没改动的块。旧索引没有这个字段，需整本重建一次 */
	hash?: string
}

export interface VectorDoc {
	version: 1
	bookPath: string
	title: string
	/** 嵌入模型名（换模型后旧索引不可比，要重建） */
	model: string
	dims: number
	createdAt: number
	updatedAt: number
	/** 建索引时原书文件的修改时间与大小，用来发现「书换了、索引还是旧的」 */
	sourceMtime?: number
	sourceSize?: number
	chunks: VectorChunk[]
}

/** 原书在建索引后被替换/改写（mtime 或大小变了） */
export function vectorDocIsStale(
	doc: Pick<VectorDoc, 'sourceMtime' | 'sourceSize'>,
	stat: { mtime: number; size: number } | null,
): boolean {
	if (!stat || !doc.sourceMtime) return false
	if (doc.sourceMtime !== stat.mtime) return true
	return typeof doc.sourceSize === 'number' && doc.sourceSize !== stat.size
}

/** 正文指纹（53 位哈希，只用于复用判断，不参与安全用途） */
export function chunkHash(text: string): string {
	let h1 = 0xdeadbeef
	let h2 = 0x41c6ce57
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i)
		h1 = Math.imul(h1 ^ ch, 2654435761)
		h2 = Math.imul(h2 ^ ch, 1597334677)
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
	return `${text.length.toString(36)}-${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`
}

export interface VectorReusePlan {
	/** 与传入的 hashes 一一对应；null 表示这一块需要重新嵌入 */
	vectors: Array<string | null>
	/** 可复用的块数 */
	reused: number
}

/** 找出旧索引里能按正文指纹复用的向量；模型不同或旧索引没指纹时全部重嵌 */
export function planVectorReuse(
	doc: VectorDoc | null,
	hashes: string[],
	model: string,
): VectorReusePlan {
	const vectors: Array<string | null> = hashes.map(() => null)
	if (!doc || doc.model !== model || doc.dims <= 0 || !doc.chunks.length) return { vectors, reused: 0 }
	const byHash = new Map<string, string>()
	for (const chunk of doc.chunks) {
		if (chunk.hash && chunk.vector) byHash.set(chunk.hash, chunk.vector)
	}
	let reused = 0
	for (let i = 0; i < hashes.length; i++) {
		const vector = byHash.get(hashes[i])
		if (!vector) continue
		vectors[i] = vector
		reused++
	}
	return { vectors, reused }
}

/** 每块目标字数 */
export const VECTOR_CHUNK_CHARS = 1600
/** 摘录长度 */
const PREVIEW_CHARS = 240

export interface PlannedChunk {
	label: string
	start: number
	cfi: string
	page?: number
	text: string
}

/** 长节按段落/句号切开，保证每块不超过 maxChars */
function splitText(text: string, limit: number): Array<{ text: string; offset: number }> {
	const out: Array<{ text: string; offset: number }> = []
	let offset = 0
	let rest = text
	while (rest.length > limit) {
		const window = rest.slice(0, limit)
		let cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'))
		if (cut < limit * 0.5) {
			cut = Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'))
		}
		if (cut < limit * 0.5) cut = limit - 1
		const piece = rest.slice(0, cut + 1)
		out.push({ text: piece, offset })
		offset += piece.length
		rest = rest.slice(cut + 1)
	}
	if (rest.trim()) out.push({ text: rest, offset })
	return out
}

/** 把各节正文切成向量块（不动网络、不写盘） */
export function planVectorChunks(
	sections: SourceSection[],
	kind: 'ebook' | 'txt' | 'pdf',
	maxChars = VECTOR_CHUNK_CHARS,
): PlannedChunk[] {
	const parts = sections
		.map(s => ({
			label: (s.label ?? '').trim() || '正文',
			// TXT 的 start 是原文偏移，不能先做空白归一化，否则回跳会整体错位
			text: String(s.text ?? ''),
			start: Number((s as { start?: number }).start ?? 0),
			page: (s as { page?: number }).page,
		}))
		.filter(s => !!s.text.trim())
	if (!parts.length) return []
	const out: PlannedChunk[] = []
	for (const part of parts) {
		const pieces = part.text.length <= maxChars
			? [{ text: part.text, offset: 0 }]
			: splitText(part.text, maxChars)
		for (const piece of pieces) {
			if (!piece.text.trim()) continue
			const absStart = kind === 'txt' ? part.start + piece.offset : 0
			out.push({
				label: part.label,
				start: kind === 'txt' ? absStart : 0,
				cfi: kind === 'txt'
					? `txt:${absStart}-${absStart + piece.text.length}`
					: kind === 'pdf'
						? `page:${part.page ?? 1}`
						: '',
				page: part.page,
				text: piece.text,
			})
		}
	}
	return out
}

export function previewOfChunk(text: string, max = PREVIEW_CHARS): string {
	const line = normalizeText(text).replace(/\s+/g, ' ').trim()
	return line.length > max ? `${line.slice(0, max)}…` : line
}

/** Float32 → Base64（浏览器/手机/Obsidian 都有 btoa） */
export function encodeVector(values: ArrayLike<number>): string {
	const arr = values instanceof Float32Array ? values : new Float32Array(Array.from(values))
	const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
	let binary = ''
	const step = 0x8000
	for (let i = 0; i < bytes.length; i += step) {
		binary += String.fromCharCode(...bytes.subarray(i, i + step))
	}
	return btoa(binary)
}

export function decodeVector(encoded: string): Float32Array {
	const binary = atob(encoded)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return new Float32Array(bytes.buffer)
}

/** 归一化后余弦相似度就是点积；零向量返回 0 */
export function unitVector(values: ArrayLike<number>): Float32Array {
	const out = new Float32Array(values.length)
	let norm = 0
	for (let i = 0; i < values.length; i++) norm += values[i] * values[i]
	norm = Math.sqrt(norm)
	if (!norm) return out
	for (let i = 0; i < values.length; i++) out[i] = values[i] / norm
	return out
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
	const n = Math.min(a.length, b.length)
	let sum = 0
	for (let i = 0; i < n; i++) sum += a[i] * b[i]
	return sum
}

export function vectorPath(dataRoot: string, bookId: string): string {
	return joinPath(dataRoot, 'vectors', `${bookId}.json`)
}

export async function loadVectorDoc(io: PlatformIO, dataRoot: string, bookId: string): Promise<VectorDoc | null> {
	if (!bookId) return null
	try {
		const path = vectorPath(dataRoot, bookId)
		if (!(await io.exists(path))) return null
		const raw = JSON.parse(await io.read(path)) as VectorDoc
		if (!raw || raw.version !== 1 || !Array.isArray(raw.chunks) || !raw.dims) return null
		return raw
	} catch {
		return null
	}
}

export async function saveVectorDoc(io: PlatformIO, dataRoot: string, bookId: string, doc: VectorDoc): Promise<void> {
	if (!bookId) return
	await writeJsonFile(io, vectorPath(dataRoot, bookId), doc)
}

export async function removeVectorDoc(io: PlatformIO, dataRoot: string, bookId: string): Promise<void> {
	if (!bookId) return
	try {
		await io.remove(vectorPath(dataRoot, bookId))
	} catch {
		// 不存在就算了
	}
}

/** 书改名/移动时迁移向量索引 */
export async function moveVectorDoc(
	io: PlatformIO,
	dataRoot: string,
	fromId: string,
	toId: string,
	newBookPath?: string,
): Promise<void> {
	if (!fromId || !toId || fromId === toId) return
	const doc = await loadVectorDoc(io, dataRoot, fromId)
	if (!doc) return
	if (newBookPath) doc.bookPath = newBookPath
	doc.updatedAt = Date.now()
	await saveVectorDoc(io, dataRoot, toId, doc)
	await removeVectorDoc(io, dataRoot, fromId)
}
