/**
 * 全库正文搜索：书架里所有书的正文（TXT / EPUB 系 / PDF）一起搜。
 *
 * 与「全局批注检索」分开：那个只搜已经划过的句子，这里搜原文。
 * 用户主动触发，按书顺序扫描；可停止，结果按书分组，点击回原文。
 */
import { App, Modal, Notice, setIcon } from 'obsidian'
import type * as pdfjsLib from 'pdfjs-dist'
import type GroveReaderPlugin from './main'
import { decodeTextBuffer } from './textCodec'
import { isShelfExt } from './types'
import { basenameOf, cleanBookTitle } from './util'
import { pdfItemsToText, type PdfTextItem } from './pdfText'
import type { GroveLinkTarget } from './wikilink'
import { hintFor, isAiConfigured } from './ai'
import { SemanticAskModal } from './semanticAskModal'
import { embedForSearch, embeddingProviderLabel, isLocalEmbedding, resolveEmbedding } from './embedding'
import { confirmAsync } from './modals'
import {
	booksNeedingVectorIndex,
	buildVectorIndex,
	semanticSearchLibrary,
} from './semanticSearch'
import { t } from './i18n'

// pdf.worker 被 import 时会自注册 globalThis.pdfjsWorker，与 Obsidian 原生 PDF 视图冲突
delete (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker

export interface SectionText {
	label: string
	text: string
	/** TXT：该节在全文中的起始偏移；其他格式为 0 */
	start: number
	/** PDF：页码 */
	page?: number
}

export interface BookText {
	kind: 'ebook' | 'txt' | 'pdf'
	sections: SectionText[]
}

interface RawHit {
	before: string
	mid: string
	after: string
	/** 传给阅读器的降级定位 */
	fallbackText: string
	chapter: string
	pct?: number
	cfi: string
}

export interface LibraryBookResult {
	bookPath: string
	title: string
	hits: RawHit[]
	/** 本书命中总数（可能大于 hits.length，后者按上限截断） */
	total: number
	error?: string
}

const MAX_HITS_PER_BOOK = 40
const MAX_HITS_TOTAL = 400
const CHAPTER_RE =
	/^(?:第[0-9零一二三四五六七八九十百千万两〇○]{1,12}[章节回卷部篇]|序章|楔子|引子|尾声|后记|番外)[\s\u3000]*\S{0,40}$/

function normalizeSpace(text: string): string {
	return text.replace(/\s+/g, ' ').trim()
}

function findRanges(text: string, query: string, max: number): Array<{ start: number; end: number }> {
	const hay = text.toLowerCase()
	const needle = query.toLowerCase()
	const out: Array<{ start: number; end: number }> = []
	let from = 0
	while (out.length < max) {
		const i = hay.indexOf(needle, from)
		if (i < 0) break
		out.push({ start: i, end: i + needle.length })
		from = i + Math.max(1, needle.length)
	}
	return out
}

function makeHit(text: string, start: number, end: number, chapter: string, cfi: string, pct?: number): RawHit {
	const radius = 36
	const a = Math.max(0, start - radius)
	const b = Math.min(text.length, end + radius)
	const before = (a > 0 ? '…' : '') + normalizeSpace(text.slice(a, start))
	const mid = normalizeSpace(text.slice(start, end))
	const after = normalizeSpace(text.slice(end, b)) + (b < text.length ? '…' : '')
	return {
		before,
		mid,
		after,
		fallbackText: normalizeSpace(text.slice(start, Math.min(text.length, start + 60))),
		chapter,
		pct,
		cfi,
	}
}

// ---------------------------------------------------------------------------
// TXT
// ---------------------------------------------------------------------------

function splitTxtSections(text: string): SectionText[] {
	const lines = text.split('\n')
	const starts: Array<{ label: string; offset: number }> = []
	let offset = 0
	for (const line of lines) {
		const trimmed = line.trim()
		if (trimmed && trimmed.length <= 60 && CHAPTER_RE.test(trimmed)) {
			starts.push({ label: trimmed.replace(/\s+/g, ' '), offset })
		}
		offset += line.length + 1
	}
	if (!starts.length) return [{ label: t('正文'), text, start: 0 }]
	if (starts[0].offset > 0) starts.unshift({ label: t('正文'), offset: 0 })
	const out: SectionText[] = []
	for (let i = 0; i < starts.length; i++) {
		const from = starts[i].offset
		const to = starts[i + 1]?.offset ?? text.length
		out.push({ label: starts[i].label, text: text.slice(from, to), start: from })
	}
	return out
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

interface PdfTextDoc {
	numPages: number
	getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }>; cleanup(): void }>
	destroy(): Promise<void>
}

async function extractPdf(plugin: GroveReaderPlugin, bytes: ArrayBuffer): Promise<BookText> {
	let worker: InstanceType<typeof pdfjsLib.PDFWorker> | null = null
	let doc: PdfTextDoc | null = null
	try {
		// 社区版不含 PDF：不解析正文，也不把 pdfjs 打进产物
		const lib: typeof import('pdfjs-dist') | null = __COMMUNITY_BUILD__ ? null : await import('pdfjs-dist')
		if (!lib) return { kind: 'pdf', sections: [] }
		const workerSrc = await plugin.resolvePdfWorkerSrc()
		if (workerSrc) (lib.GlobalWorkerOptions as unknown as { workerSrc: string }).workerSrc = workerSrc
		worker = new lib.PDFWorker()
		await worker.promise
		delete (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker
		const params: Record<string, unknown> = { data: new Uint8Array(bytes), worker }
		// 与 PDF 阅读视图同一套资源读取方式：worker 发 FetchBinaryData 回主线程，
		// 由插件从库内读 CMap/wasm/标准字体；否则中文 PDF 的 getTextContent 会拿不到字。
		params.useWorkerFetch = false
		params.wasmUrl = 'wasm/'
		params.cMapUrl = 'cmaps/'
		params.standardFontDataUrl = 'standard_fonts/'
		params.cMapPacked = true
		params.BinaryDataFactory = class {
			async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
				const dir = kind === 'wasmUrl' ? 'wasm' : kind === 'standardFontDataUrl' ? 'standard_fonts' : 'cmaps'
				return plugin.readPdfjsAsset(`${dir}/${filename}`)
			}
		}
		doc = (await lib.getDocument(params as Parameters<typeof lib.getDocument>[0]).promise) as unknown as PdfTextDoc
		if (!doc) return { kind: 'pdf', sections: [] }
		const sections: SectionText[] = []
		for (let n = 1; n <= doc.numPages; n++) {
			try {
				const page = await doc.getPage(n)
				const content = await page.getTextContent()
				const text = pdfItemsToText(content.items ?? [])
				if (text) sections.push({ label: `第 ${n} 页`, text, start: 0, page: n })
				page.cleanup()
			} catch {
				// 单页失败跳过
			}
			if (n % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0))
		}
		return { kind: 'pdf', sections }
	} finally {
		try {
			await doc?.destroy()
		} catch {
			// ignore
		}
		try {
			worker?.destroy()
		} catch {
			// ignore
		}
	}
}

// ---------------------------------------------------------------------------
// EPUB / MOBI / AZW3 / FB2 / FBZ / CBZ
// ---------------------------------------------------------------------------

interface EbookLike {
	toc?: Array<{ label?: string; href?: string; subitems?: unknown[] }>
	sections?: Array<{ createDocument?: () => Promise<Document> }>
	resolveHref?: (href: string) => { index?: number } | null
}

function tocLabels(book: EbookLike): Map<number, string> {
	const map = new Map<number, string>()
	const walk = (items: Array<{ label?: string; href?: string; subitems?: unknown[] }>): void => {
		for (const item of items) {
			if (item.href && item.label && book.resolveHref) {
				try {
					const resolved = book.resolveHref(item.href)
					if (typeof resolved?.index === 'number') map.set(resolved.index, item.label.trim())
				} catch {
					// ignore
				}
			}
			if (Array.isArray(item.subitems)) walk(item.subitems as typeof items)
		}
	}
	walk(book.toc ?? [])
	return map
}

async function extractEbook(path: string, bytes: ArrayBuffer): Promise<BookText> {
	const { makeBook } = await import('../lib/foliate-js/view.js')
	const file = new File([bytes], basenameOf(path))
	const book = (await makeBook(file)) as EbookLike
	const labels = tocLabels(book)
	const sections: SectionText[] = []
	const list = book.sections ?? []
	for (let i = 0; i < list.length; i++) {
		const section = list[i]
		if (!section?.createDocument) continue
		try {
			const doc = await section.createDocument()
			const text = normalizeSpace(doc?.body?.textContent ?? '')
			if (text) sections.push({ label: labels.get(i) || `第 ${i + 1} 节`, text, start: 0 })
		} catch {
			// 单节失败跳过
		}
		if (i % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0))
	}
	return { kind: 'ebook', sections }
}

/** 统一取某本书的正文（TXT / PDF / 电子书），语义索引与字面搜索共用 */
export async function extractBookText(
	plugin: GroveReaderPlugin,
	path: string,
	bytes?: ArrayBuffer,
): Promise<BookText> {
	const data = bytes ?? await plugin.readBookBytes(path)
	const ext = path.split('.').pop()?.toLowerCase() ?? ''
	if (ext === 'txt') {
		const decoded = decodeTextBuffer(data)
		return { kind: 'txt', sections: splitTxtSections(decoded.text) }
	}
	if (ext === 'pdf') return extractPdf(plugin, data)
	return extractEbook(path, data)
}

// ---------------------------------------------------------------------------
// 搜索入口
// ---------------------------------------------------------------------------

export interface LibrarySearchOptions {
	onProgress?: (done: number, total: number, title: string) => void
	shouldStop?: () => boolean
}

export async function searchLibrary(
	plugin: GroveReaderPlugin,
	query: string,
	options: LibrarySearchOptions = {},
): Promise<LibraryBookResult[]> {
	const q = query.trim()
	if (!q) return []
	const books = plugin.shelfCache.entries()
		.filter(([path]) => isShelfExt(path.split('.').pop()?.toLowerCase() ?? ''))
		.map(([path, entry]) => ({ path, title: entry.title || cleanBookTitle(basenameOf(path)) }))
		.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
	const out: LibraryBookResult[] = []
	let totalHits = 0
	for (let i = 0; i < books.length; i++) {
		if (options.shouldStop?.() || totalHits >= MAX_HITS_TOTAL) break
		const book = books[i]
		options.onProgress?.(i, books.length, book.title)
		let extracted: BookText | null = null
		try {
			extracted = await extractBookText(plugin, book.path)
		} catch (e) {
			out.push({ bookPath: book.path, title: book.title, hits: [], total: 0, error: e instanceof Error ? e.message : String(e) })
			continue
		}
		if (options.shouldStop?.()) break
		const hits: RawHit[] = []
		let total = 0
		for (let s = 0; s < extracted.sections.length; s++) {
			const section = extracted.sections[s]
			const ranges = findRanges(section.text, q, MAX_HITS_PER_BOOK - hits.length)
			if (!ranges.length) continue
			total += ranges.length
			for (const r of ranges) {
				const start = section.start + r.start
				const end = section.start + r.end
				const cfi = extracted.kind === 'txt'
					? `txt:${start}-${end}`
					: extracted.kind === 'pdf'
						? `page:${section.page ?? 1}`
						: ''
				const pct = extracted.kind === 'ebook'
					? (s + 1) / Math.max(1, extracted.sections.length)
					: undefined
				hits.push(makeHit(section.text, r.start, r.end, section.label, cfi, pct))
				if (hits.length >= MAX_HITS_PER_BOOK) break
			}
			if (hits.length >= MAX_HITS_PER_BOOK) break
		}
		if (hits.length) {
			out.push({ bookPath: book.path, title: book.title, hits, total })
			totalHits += hits.length
		}
		if (i % 2 === 0) await new Promise(resolve => setTimeout(resolve, 0))
	}
	options.onProgress?.(books.length, books.length, '')
	return out
}

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------

export class LibrarySearchModal extends Modal {
	private inputEl!: HTMLInputElement
	private statusEl!: HTMLElement
	private resultsEl!: HTMLElement
	private running = false
	private token = 0
	private semanticEl!: HTMLInputElement

	constructor(app: App, private readonly plugin: GroveReaderPlugin) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.modalEl.addClass('grove-library-search-modal')
		this.contentEl.createEl('h3', { text: t('全库搜索') })
		const row = this.contentEl.createDiv('grove-library-search-row')
		this.inputEl = row.createEl('input', {
			cls: 'grove-library-search-input',
			attr: { type: 'search', placeholder: t('在全部书的正文中搜索（含 PDF）…') },
		})
		const searchBtn = row.createEl('button', { cls: 'mod-cta', text: t('搜索') })
		searchBtn.addEventListener('click', () => void this.#run())
		const stopBtn = row.createEl('button', { text: t('停止') })
		stopBtn.addEventListener('click', () => {
			if (!this.running) return
			this.token++
			this.running = false
			this.statusEl.setText(t('已停止'))
		})
		this.inputEl.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault()
				void this.#run()
			}
		})
		this.statusEl = this.contentEl.createDiv('grove-library-search-status')
		this.statusEl.setText(`准备搜索 ${this.plugin.shelfCache.entries().length} 本书`)
		const semantic = this.contentEl.createEl('label', { cls: 'grove-library-search-semantic' })
		this.semanticEl = semantic.createEl('input', { type: 'checkbox' })
		const runtime = resolveEmbedding(this.plugin)
		semantic.createSpan({
			text: t("语义检索（向量 · {p0}）", { p0: embeddingProviderLabel(runtime.provider) }),
		})
		if (!isLocalEmbedding(runtime) && (!runtime.baseUrl || !runtime.apiKey)) {
			this.semanticEl.disabled = true
			semantic.addClass('is-disabled')
			semantic.setAttribute('title', t('当前向量服务缺少接口地址或 Key，请到 设置 → AI 解释 配置，或切到「本地」'))
		}
		this.resultsEl = this.contentEl.createDiv('grove-library-search-results')
		window.setTimeout(() => this.inputEl.focus(), 50)
	}

	onClose(): void {
		this.token++
		this.running = false
		this.contentEl.empty()
	}

	async #run(): Promise<void> {
		if (this.running) return
		const query = this.inputEl.value.trim()
		if (!query) {
			new Notice(t('Grove Reader：请输入要搜索的文字'))
			return
		}
		const token = ++this.token
		this.running = true
		this.resultsEl.empty()
		this.statusEl.setText(t('正在准备…'))
		const semantic = !!this.semanticEl?.checked
		let books: LibraryBookResult[] | null = null
		if (semantic) {
			try {
				books = await this.#runSemantic(query, token)
			} catch (e) {
				if (token !== this.token) return
				this.running = false
				const msg = e instanceof Error ? e.message : String(e)
				const localHint = isLocalEmbedding(resolveEmbedding(this.plugin))
					? ''
					: t('；可在 设置 → AI 解释 → 向量服务 切到「本地（离线）」直接使用')
				this.statusEl.setText(`语义检索失败：${msg}${hintFor(msg)}${localHint}`)
				new Notice(t("Grove Reader：语义检索失败（{p0}{p1}{p2}）", { p0: msg, p1: hintFor(msg), p2: localHint }), 8000)
				return
			}
			if (!books) {
				if (token === this.token) {
					this.running = false
					this.statusEl.setText(t('已取消'))
				}
				return
			}
		} else {
			books = await searchLibrary(this.plugin, query, {
				shouldStop: () => token !== this.token,
				onProgress: (done, total, title) => {
					if (token !== this.token) return
					this.statusEl.setText(title ? t('正在搜索 {i} / {total} · {title}', { i: done + 1, total, title }) : t('已完成 {n} 本', { n: total }))
				},
			})
		}
		if (token !== this.token || !books) return
		this.running = false
		const hitCount = books.reduce((sum, b) => sum + b.hits.length, 0)
		this.statusEl.setText(hitCount
			? `${semantic ? t('语义匹配') : t('找到')} ${hitCount} 处，来自 ${books.length} 本书`
			: semantic ? t('没有语义相近的段落。可以换个说法，或先为书建立索引') : t('没有找到匹配内容'))
		this.#renderResults(books, semantic, query)
	}

	/** 语义检索：先补齐缺失索引（要确认），再嵌入查询并排序；取消返回 null */
	async #runSemantic(query: string, token: number): Promise<LibraryBookResult[] | null> {
		const embed = resolveEmbedding(this.plugin)
		// 远端服务先用一句话探一下：欠费/模型名写错时直接报错，别让用户白等整库提取
		if (!isLocalEmbedding(embed)) {
			this.statusEl.setText(t('正在检查嵌入接口…'))
			await embedForSearch(embed, [t('索引测试')], 1)
		}
		const missing = await booksNeedingVectorIndex(this.plugin, embed)
		if (token !== this.token) return null
		if (missing.length) {
			const stale = missing.filter(book => book.reason === 'stale').length
			const detail = stale
				? `（其中 ${stale} 本原书在建索引后改过，需要重建）`
				: ''
			const ok = await confirmAsync(
				this.app,
				`有 ${missing.length} 本书还没有可用的语义索引${detail}。建立索引会把正文按约 1600 字切块并调用嵌入接口（按书长度分多次请求，使用你自己的 API Key）。现在建立吗？`,
				t('建立并搜索'),
			)
			if (!ok || token !== this.token) return null
			let done = 0
			const failed: string[] = []
			for (const book of missing) {
				if (token !== this.token) return null
				this.statusEl.setText(`建立索引 ${done + 1} / ${missing.length} · ${book.title}`)
				let reused = 0
				try {
					await buildVectorIndex(this.plugin, book.path, embed, {
						shouldStop: () => token !== this.token,
						onReuse: n => {
							reused = n
						},
						onProgress: (n, total) => {
							if (token !== this.token) return
							const reuseLabel = reused ? `，复用 ${reused}` : ''
							this.statusEl.setText(`建立索引 ${done + 1} / ${missing.length} · ${book.title}（${n}/${total} 块${reuseLabel}）`)
						},
					})
					if (reused && token === this.token) {
						this.statusEl.setText(`建立索引 ${done + 1} / ${missing.length} · ${book.title}（复用 ${reused} 块，只嵌改动段）`)
					}
				} catch (e) {
					if (token !== this.token) return null
					console.error(t('[Grove Reader] 建语义索引失败'), book.path, e)
					failed.push(book.title)
				}
				done++
			}
			if (failed.length) {
				new Notice(t("Grove Reader：{p0} 本书索引失败（{p1}）", { p0: failed.length, p1: failed.slice(0, 3).join('、') }), 8000)
			}
			if (token !== this.token) return null
			this.statusEl.setText(t('索引就绪，正在检索…'))
		}
		return semanticSearchLibrary(this.plugin, query, embed, {
			shouldStop: () => token !== this.token,
			onProgress: (done, total, title) => {
				if (token !== this.token) return
				this.statusEl.setText(title ? `正在比对 ${done + 1} / ${total} · ${title}` : `已完成 ${total} 本`)
			},
		})
	}

	#renderResults(books: LibraryBookResult[], semantic = false, query = ''): void {
		this.resultsEl.empty()
		if (!books.length) {
			this.resultsEl.createDiv('grove-ann-empty').setText(t('没有找到匹配内容。换一个更短的关键词试试。'))
			return
		}
		for (const book of books) {
			const group = this.resultsEl.createDiv('grove-library-search-group')
			const head = group.createDiv('grove-library-search-group-head')
			const icon = head.createSpan('grove-library-search-icon')
			setIcon(icon, 'book-open')
			head.createSpan('grove-library-search-title').setText(book.title)
			head.createSpan('grove-library-search-count').setText(`${book.hits.length} 处`)
			if (book.error) {
				group.createDiv('grove-ann-empty').setText(`读取失败：${book.error}`)
				continue
			}
			for (const hit of book.hits) {
				const item = group.createDiv('grove-library-search-hit')
				item.dataset.book = book.bookPath
				item.dataset.cfi = hit.cfi
				item.dataset.chapter = hit.chapter
				const chapter = item.createDiv('grove-library-search-chapter')
				chapter.setText(hit.chapter)
				const text = item.createDiv('grove-library-search-text')
				text.createSpan().setText(hit.before)
				if (hit.mid) text.createEl('mark').setText(hit.mid)
				text.createSpan().setText(hit.after)
				item.addEventListener('click', () => {
					this.close()
					// TXT/PDF 的 cfi 已经足够精确；只有电子书没有 CFI，才走三级降级
					const fallback: GroveLinkTarget | undefined = hit.cfi
						? undefined
						: {
							text: hit.fallbackText,
							chapter: hit.chapter,
							pct: hit.pct,
						}
					void this.plugin.openBookByPath(book.bookPath, hit.cfi || undefined, fallback)
				})
			}
		}
		// 语义结果下方给一个「拿去问 AI」的出口；材料就是当前这批段落，不会再检索一次
		if (semantic && books.some(book => book.hits.length)) {
			const row = this.resultsEl.createDiv('grove-library-ask-row')
			const s = this.plugin.settings
			if (isAiConfigured({ baseUrl: s.aiBaseUrl ?? '', apiKey: s.aiApiKey ?? '', model: s.aiModel ?? '' })) {
				const ask = row.createEl('button', { text: t('就这些段落问 AI'), cls: 'mod-cta' })
				ask.addEventListener('click', () => {
					new SemanticAskModal(this.app, this.plugin, books, query).open()
				})
			} else {
				row.createDiv('grove-library-ask-hint')
					.setText(t('配置 AI 后可就这些段落提问（设置 → 阅读 → AI 解释）'))
			}
		}
	}
}
