// 书架 PDF 封面：渲染首页为小尺寸 JPEG，并读取元数据标题/作者。
// 与 pdfView 相同的主线程 worker 方案（MessageChannel + PDFWorker{port}），
// 但自包含且单次调用即建即毁，不持有任何长期资源。
import './pdfjsPolyfill'
import * as pdfjsLib from 'pdfjs-dist'

// pdf.worker 模块被 import 时会自注册 globalThis.pdfjsWorker，
// 毒化 Obsidian 原生 PDF 视图（版本冲突），必须立即清除
delete (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker

interface ThumbViewport {
	width: number
	height: number
}

interface ThumbPage {
	getViewport(params: { scale: number }): ThumbViewport
	render(params: { canvasContext: CanvasRenderingContext2D; viewport: ThumbViewport }): { promise: Promise<void> }
	cleanup(): void
}

interface ThumbDoc {
	numPages: number
	getPage(n: number): Promise<ThumbPage>
	getMetadata(): Promise<{ info?: { Title?: string; Author?: string } }>
	destroy(): Promise<void>
}

export type AssetUrlGetter = (rel: string) => string | null

export interface PdfShelfInfo {
	/** 首页 JPEG；渲染失败为 null（调用方回退文字占位封面） */
	cover: Blob | null
	title?: string
	author?: string
}

/**
 * 打开 PDF 并提取书架所需信息：首页缩略图 + 元数据标题/作者。
 * 任何一步失败都不抛出——cover 为 null、title/author 缺省，由调用方兜底。
 */
export async function readPdfShelfInfo(
	bytes: ArrayBuffer,
	targetWidth: number,
	assetUrlGetter: AssetUrlGetter | null,
): Promise<PdfShelfInfo> {
	let worker: InstanceType<typeof pdfjsLib.PDFWorker> | null = null
	let doc: ThumbDoc | null = null
	try {
		const workerSrc = assetUrlGetter?.('pdf.worker.mjs')
		if (workerSrc) { (pdfjsLib.GlobalWorkerOptions as unknown as { workerSrc: string }).workerSrc = workerSrc }
		worker = new pdfjsLib.PDFWorker()
		await worker.promise
		delete (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker

		const params: Record<string, unknown> = { data: new Uint8Array(bytes), worker }
		const wasmUrl = assetUrlGetter?.('wasm/')
		if (wasmUrl) {
			// 扫描版整页图片（JBIG2/JPX）解码必需
			params.wasmUrl = wasmUrl
			params.cMapUrl = assetUrlGetter?.('cmaps/')
			params.cMapPacked = true
			params.standardFontDataUrl = assetUrlGetter?.('standard_fonts/')
		}
		doc = (await pdfjsLib.getDocument(params as Parameters<typeof pdfjsLib.getDocument>[0]).promise) as unknown as ThumbDoc

		const [page, meta] = await Promise.all([
			doc.getPage(1),
			doc.getMetadata().catch(() => undefined),
		])
		const vp1 = page.getViewport({ scale: 1 })
		// 只缩小不放大
		const scale = Math.min(1, targetWidth / vp1.width)
		const vp = page.getViewport({ scale })
		const canvas = document.createElement('canvas')
		canvas.width = Math.max(1, Math.floor(vp.width))
		canvas.height = Math.max(1, Math.floor(vp.height))
		const ctx = canvas.getContext('2d')
		let cover: Blob | null = null
		if (ctx) {
			await page.render({ canvasContext: ctx, viewport: vp }).promise
			cover = await new Promise<Blob | null>(resolve =>
				canvas.toBlob(b => resolve(b), 'image/jpeg', 0.82))
			if (cover && cover.size === 0) cover = null
		}

		const info = meta?.info
		const title = info?.Title?.trim() || undefined
		const author = info?.Author?.trim() || undefined
		return { cover, title: title || undefined, author: author || undefined }
	} catch (e) {
		console.error('[Grove Reader] 读取 PDF 封面/元数据失败', e)
		return { cover: null }
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
