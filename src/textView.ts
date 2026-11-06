import { ItemView, Notice, ViewStateResult, WorkspaceLeaf } from 'obsidian'
import type GroveReaderPlugin from './main'
import { basenameOf, cleanBookTitle } from './util'
import { decodeTextBuffer, paginateText, TextViewState, VIEW_TYPE_GROVE_TEXT } from './textCodec'

export { VIEW_TYPE_GROVE_TEXT } from './textCodec'

export class TextView extends ItemView {
	bookPath = ''
	private bytes: ArrayBuffer | null = null
	private pages: string[] = ['']
	private page = 0
	private encoding = 'auto'
	private detected = ''
	private warning: string | undefined
	private title = 'TXT'
	private loadingPath = ''
	private bodyEl: HTMLElement | null = null
	private toolbarEl: HTMLElement | null = null

	constructor(leaf: WorkspaceLeaf, private plugin: GroveReaderPlugin) {
		super(leaf)
	}

	getViewType(): string {
		return VIEW_TYPE_GROVE_TEXT
	}

	getDisplayText(): string {
		return this.title || 'TXT'
	}

	getIcon(): string {
		return 'file-text'
	}

	async setState(state: unknown, result?: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as TextViewState
		if (s.bookPath && s.bookPath !== this.bookPath) {
			this.bookPath = s.bookPath
			this.encoding = 'auto'
			this.page = 0
		}
		await super.setState(state, result ?? { history: false })
		if (this.bodyEl && this.bookPath) await this.#load()
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty()
		this.contentEl.addClass('grove-text-view')
		this.bodyEl = this.contentEl.createDiv('grove-text-body')
		if (this.bookPath) await this.#load()
		else this.#renderEmpty('没有指定要打开的 TXT 文件')
	}

	async #load(): Promise<void> {
		const path = this.bookPath
		if (!path || this.loadingPath === path) return
		this.loadingPath = path
		this.#renderEmpty('正在读取…')
		try {
			const bytes = await this.plugin.readBookBytes(path)
			if (this.loadingPath !== path) return
			this.bytes = bytes
			this.title = this.plugin.shelfCache.get(path)?.title || cleanBookTitle(basenameOf(path))
			this.#decodeAndRender()
		} catch (e) {
			this.#renderEmpty(`读取失败：${e instanceof Error ? e.message : String(e)}`)
		} finally {
			if (this.loadingPath === path) this.loadingPath = ''
		}
	}

	#decodeAndRender(): void {
		if (!this.bytes) return
		const decoded = decodeTextBuffer(this.bytes, this.encoding)
		this.detected = decoded.encoding
		this.warning = decoded.warning
		this.pages = paginateText(decoded.text)
		this.page = Math.min(this.page, this.pages.length - 1)
		this.#render(this.warning)
	}

	#renderEmpty(message: string): void {
		if (!this.bodyEl) return
		this.bodyEl.empty()
		this.toolbarEl = null
		this.bodyEl.createDiv('grove-text-empty').setText(message)
	}

	#render(warning?: string): void {
		if (!this.bodyEl) return
		this.bodyEl.empty()
		const toolbar = this.bodyEl.createDiv('grove-text-toolbar')
		this.toolbarEl = toolbar
		toolbar.createDiv('grove-text-title').setText(this.title)
		toolbar.createDiv('grove-text-meta').setText(
			`编码 ${this.detected.toUpperCase()} · ${this.pages.length} 页${warning ? ` · ${warning}` : ''}`,
		)

		const encodingWrap = toolbar.createDiv('grove-text-encoding')
		encodingWrap.createSpan({ text: '编码' })
		const select = encodingWrap.createEl('select', { cls: 'dropdown' })
		for (const [value, label] of [
			['auto', '自动'],
			['utf-8', 'UTF-8'],
			['gb18030', 'GB18030 / GBK'],
			['big5', 'Big5'],
			['utf-16le', 'UTF-16 LE'],
			['utf-16be', 'UTF-16 BE'],
		]) select.createEl('option', { value, text: label })
		select.value = this.encoding
		select.addEventListener('change', () => {
			this.encoding = select.value
			this.page = 0
			this.#decodeAndRender()
			new Notice(`${this.plugin.manifest.name}：编码已切换为 ${select.value === 'auto' ? '自动' : select.value}`)
		})

		if (this.pages.length > 1) {
			const pager = toolbar.createDiv('grove-text-pager')
			const prev = pager.createEl('button', { text: '上一页' })
			prev.disabled = this.page <= 0
			prev.addEventListener('click', () => this.#goPage(this.page - 1))
			const current = pager.createEl('input', {
				cls: 'grove-text-page-input',
				attr: { type: 'number', min: '1', max: String(this.pages.length), value: String(this.page + 1) },
			})
			current.addEventListener('change', () => {
				const n = Number.parseInt(current.value, 10)
				if (Number.isFinite(n)) this.#goPage(n - 1)
			})
			pager.createSpan({ text: `/ ${this.pages.length}` })
			const next = pager.createEl('button', { text: '下一页' })
			next.disabled = this.page >= this.pages.length - 1
			next.addEventListener('click', () => this.#goPage(this.page + 1))
		}

		const pre = this.bodyEl.createEl('pre', { cls: 'grove-text-content' })
		pre.setText(this.pages[this.page] ?? '')
		pre.scrollTop = 0
	}

	#goPage(page: number): void {
		this.page = Math.max(0, Math.min(this.pages.length - 1, page))
		this.#render(this.warning)
	}

	async onClose(): Promise<void> {
		this.contentEl.empty()
	}
}
