/**
 * PDF 页缩略图：点一页跳到那一页。
 *
 * 只渲染视口附近的缩略图（IntersectionObserver + 最多两个并发），
 * 几百页的扫描件也不会一打开就全量解码。
 */
import { App, Modal } from 'obsidian'

export interface PdfThumbDoc {
	numPages: number
	getPage(n: number): Promise<{
		getViewport(params: { scale: number }): { width: number; height: number }
		render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void>; cancel(): void }
	}>
}

interface ThumbJob {
	n: number
	canvas: HTMLCanvasElement
}

export class PdfThumbnailsModal extends Modal {
	private readonly tasks = new Set<{ cancel(): void }>()
	private readonly queue: ThumbJob[] = []
	private active = 0
	private closed = false

	constructor(
		app: App,
		private readonly pdfDoc: PdfThumbDoc,
		private readonly current: number,
		private readonly onPick: (page: number) => void,
	) {
		super(app)
	}

	onOpen(): void {
		this.modalEl.addClass('grove-pdf-thumbs-modal')
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: '页缩略图' })
		const grid = this.contentEl.createDiv('grove-pdf-thumbs')
		const observer = new IntersectionObserver(entries => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue
				const btn = entry.target as HTMLElement
				observer.unobserve(btn)
				const n = Number(btn.dataset.page)
				const canvas = btn.querySelector('canvas')
				if (canvas && Number.isFinite(n)) this.#enqueue(n, canvas)
			}
		}, { root: grid, rootMargin: '200px 0px' })

		for (let n = 1; n <= this.pdfDoc.numPages; n++) {
			const btn = grid.createEl('button', {
				cls: `grove-pdf-thumb${n === this.current ? ' is-current' : ''}`,
				attr: { type: 'button', 'data-page': String(n), 'aria-label': `第 ${n} 页` },
			})
			btn.createEl('canvas')
			btn.createSpan('grove-pdf-thumb-label').setText(String(n))
			btn.addEventListener('click', () => {
				this.onPick(n)
				this.close()
			})
			observer.observe(btn)
		}
	}

	onClose(): void {
		this.closed = true
		for (const task of this.tasks) {
			try {
				task.cancel()
			} catch {
				// ignore
			}
		}
		this.tasks.clear()
		this.queue.length = 0
		this.contentEl.empty()
	}

	#enqueue(n: number, canvas: HTMLCanvasElement): void {
		if (this.closed) return
		this.queue.push({ n, canvas })
		void this.#drain()
	}

	async #drain(): Promise<void> {
		while (!this.closed && this.active < 2 && this.queue.length) {
			const job = this.queue.shift()!
			this.active++
			void this.#render(job).finally(() => {
				this.active--
				void this.#drain()
			})
		}
	}

	async #render(job: ThumbJob): Promise<void> {
		try {
			const page = await this.pdfDoc.getPage(job.n)
			if (this.closed) return
			const base = page.getViewport({ scale: 1 })
			const scale = Math.min(0.4, 180 / Math.max(1, base.width))
			const vp = page.getViewport({ scale })
			job.canvas.width = Math.max(1, Math.floor(vp.width))
			job.canvas.height = Math.max(1, Math.floor(vp.height))
			const ctx = job.canvas.getContext('2d')
			if (!ctx) return
			const task = page.render({ canvasContext: ctx, viewport: vp })
			this.tasks.add(task)
			await task.promise
			this.tasks.delete(task)
		} catch {
			// 关闭弹窗/页面被清理时取消属正常路径
		}
	}
}
