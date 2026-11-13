/**
 * 全库语义检索：用嵌入向量按意思找段落。
 *
 * 索引按书建（`<数据目录>/vectors/<书 id>.json`），第一次搜索前需要建索引；
 * 建索引会把整本正文按 ~1600 字切块并逐块取嵌入，属于要花用户 API 额度的操作。
 */
import type GroveReaderPlugin from './main'
import { embedForSearch, type EmbeddingRuntime } from './embedding'
import { extractBookText, type LibraryBookResult } from './librarySearch'
import { isShelfExt } from './types'
import { basenameOf, cleanBookTitle, isAbsolutePath } from './util'
import {
	chunkHash,
	decodeVector,
	dotProduct,
	encodeVector,
	loadVectorDoc,
	planVectorChunks,
	planVectorReuse,
	previewOfChunk,
	saveVectorDoc,
	unitVector,
	vectorDocIsStale,
	type VectorDoc,
} from './vectorIndex'

/** 相似度低于这个值就不进结果，避免「什么都沾一点」 */
const MIN_SCORE = 0.22
/** 每本书最多展示几段 */
const HITS_PER_BOOK = 4

export interface BuildOptions {
	onProgress?: (done: number, total: number, title: string) => void
	/** 本次重建从旧索引复用了多少块（总块数一起给出，方便界面显示） */
	onReuse?: (reused: number, total: number) => void
	shouldStop?: () => boolean
}

export function vectorDocIsUsable(doc: VectorDoc | null, embed: EmbeddingRuntime): doc is VectorDoc {
	return !!doc && doc.model === embed.docModel && doc.dims > 0 && doc.chunks.length > 0
}

/** 只在当前扫描文件夹内的书（书架缓存里可能还有已移除的旧条目） */
function shelfBooks(plugin: GroveReaderPlugin): Array<{ path: string; title: string }> {
	const folders = (plugin.settings.scanFolders ?? [])
		.map(folder => folder.replace(/\\/g, '/').replace(/\/+$/, ''))
		.filter(Boolean)
	const under = (path: string): boolean => {
		if (!folders.length) return true
		const p = path.replace(/\\/g, '/')
		return folders.some(folder => isAbsolutePath(folder)
			? p.startsWith(folder)
			: p === folder || p.startsWith(`${folder}/`))
	}
	return plugin.shelfCache.entries()
		.filter(([path]) => isShelfExt(path.split('.').pop()?.toLowerCase() ?? '') && under(path))
		.map(([path, entry]) => ({ path, title: entry.title || cleanBookTitle(basenameOf(path)) }))
		.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
}

/** 为一本书建向量索引，返回落盘后的 doc */
export async function buildVectorIndex(
	plugin: GroveReaderPlugin,
	bookPath: string,
	embed: EmbeddingRuntime,
	options: BuildOptions = {},
): Promise<VectorDoc> {
	const stat = await plugin.statBook(bookPath)
	const extracted = await extractBookText(plugin, bookPath)
	const planned = planVectorChunks(extracted.sections, extracted.kind)
	if (!planned.length) throw new Error('没有提取到正文文字（扫描版 PDF 可能没有文字层）')
	const hashes = planned.map(piece => chunkHash(piece.text))
	const bookId = plugin.store.bookId(bookPath)
	const existing = await loadVectorDoc(plugin.io, plugin.getDataRoot(), bookId)
	const plan = planVectorReuse(existing, hashes, embed.docModel)
	// 旧向量维度和当前索引对不上时不能复用（模型名相同但服务端换了维度的情况）
	const vectors: Array<Float32Array | number[] | null> = plan.vectors.map(encoded => {
		if (!encoded) return null
		const vector = decodeVector(encoded)
		return vector.length === existing?.dims ? vector : null
	})
	const reuseCount = vectors.filter(item => item !== null).length
	options.onReuse?.(reuseCount, planned.length)

	const todo: number[] = []
	for (let i = 0; i < vectors.length; i++) if (!vectors[i]) todo.push(i)
	const batchSize = 16
	let embedded = 0
	for (let i = 0; i < todo.length; i += batchSize) {
		if (options.shouldStop?.()) throw new Error('已停止')
		const batch = todo.slice(i, i + batchSize)
		const got = await embedForSearch(embed, batch.map(index => planned[index].text), batch.length)
		if (got.length !== batch.length) throw new Error('嵌入返回条数不一致')
		batch.forEach((index, k) => {
			vectors[index] = got[k]
		})
		embedded += batch.length
		options.onProgress?.(embedded, todo.length, '正在生成向量')
	}
	const filled = vectors.map(vector => vector ?? [])
	const dims = filled[0]?.length ?? 0
	if (!dims) throw new Error('嵌入返回空向量')
	const title = plugin.shelfCache.get(bookPath)?.title || cleanBookTitle(basenameOf(bookPath))
	const now = Date.now()
	const doc: VectorDoc = {
		version: 1,
		bookPath,
		title,
		model: embed.docModel,
		dims,
		createdAt: now,
		updatedAt: now,
		sourceMtime: stat?.mtime,
		sourceSize: stat?.size,
		chunks: planned.map((piece, i) => ({
			label: piece.label,
			start: piece.start,
			cfi: piece.cfi,
			pct: planned.length > 1 ? i / (planned.length - 1) : 0,
			page: piece.page,
			preview: previewOfChunk(piece.text),
			vector: encodeVector(unitVector(filled[i] ?? [])),
			hash: hashes[i],
		})),
	}
	await saveVectorDoc(plugin.io, plugin.getDataRoot(), bookId, doc)
	return doc
}

/** 查询：对每本已有可用索引的书取最相似的几段，按书分组返回 */
export async function semanticSearchLibrary(
	plugin: GroveReaderPlugin,
	query: string,
	embed: EmbeddingRuntime,
	options: BuildOptions = {},
): Promise<LibraryBookResult[]> {
	const q = query.trim()
	if (!q) return []
	const [queryVector] = await embedForSearch(embed, [q], 1)
	if (!queryVector?.length) throw new Error('查询向量为空')
	const unit = unitVector(queryVector)
	const books = shelfBooks(plugin)
	// 离线词法向量的余弦整体偏低，阈值单独放低；远端语义模型仍用 0.22
	const minScore = embed.provider === 'local' ? 0.08 : MIN_SCORE
	const out: Array<{ result: LibraryBookResult; best: number }> = []
	for (let i = 0; i < books.length; i++) {
		if (options.shouldStop?.()) break
		const book = books[i]
		options.onProgress?.(i, books.length, book.title)
		const doc = await loadVectorDoc(plugin.io, plugin.getDataRoot(), plugin.store.bookId(book.path))
		if (!vectorDocIsUsable(doc, embed) || doc.dims !== unit.length) continue
		const scored = doc.chunks
			.map(chunk => ({ chunk, score: dotProduct(unit, decodeVector(chunk.vector)) }))
			.filter(item => item.score >= minScore)
			.sort((a, b) => b.score - a.score)
			.slice(0, HITS_PER_BOOK)
		if (!scored.length) continue
		out.push({
			best: scored[0].score,
			result: {
				bookPath: book.path,
				title: doc.title || book.title,
				total: scored.length,
				hits: scored.map(({ chunk, score }) => ({
					before: chunk.preview,
					mid: '',
					after: '',
					fallbackText: chunk.preview,
					chapter: `${chunk.label} · 相似度 ${Math.round(score * 100)}%`,
					pct: chunk.pct,
					cfi: chunk.cfi,
				})),
			},
		})
	}
	options.onProgress?.(books.length, books.length, '')
	return out.sort((a, b) => b.best - a.best).map(item => item.result)
}

export type VectorIndexState = 'ready' | 'missing' | 'model' | 'stale'

export interface VectorIndexRow {
	path: string
	title: string
	doc: VectorDoc | null
	state: VectorIndexState
}

/** 索引总览：每本书的索引是否存在、是否换了模型、原书是否改过 */
export async function vectorIndexOverview(
	plugin: GroveReaderPlugin,
	embed: EmbeddingRuntime,
): Promise<VectorIndexRow[]> {
	const rows: VectorIndexRow[] = []
	for (const book of shelfBooks(plugin)) {
		const doc = await loadVectorDoc(plugin.io, plugin.getDataRoot(), plugin.store.bookId(book.path))
		let state: VectorIndexState
		if (!doc || doc.dims <= 0 || !doc.chunks.length) {
			state = 'missing'
		} else if (doc.model !== embed.docModel) {
			state = 'model'
		} else {
			const stat = await plugin.statBook(book.path)
			state = vectorDocIsStale(doc, stat) ? 'stale' : 'ready'
		}
		rows.push({ ...book, doc, state })
	}
	return rows
}

/** 书架里还没有可用索引（缺失 / 换模型 / 原书已改）的书 */
export async function booksNeedingVectorIndex(
	plugin: GroveReaderPlugin,
	embed: EmbeddingRuntime,
): Promise<Array<{ path: string; title: string; reason: 'missing' | 'model' | 'stale' }>> {
	const rows = await vectorIndexOverview(plugin, embed)
	return rows
		.filter(row => row.state !== 'ready')
		.map(row => ({ path: row.path, title: row.title, reason: row.state as 'missing' | 'model' | 'stale' }))
}
