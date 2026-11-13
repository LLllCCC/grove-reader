import { App, Modal, Notice } from 'obsidian'
import type GroveReaderPlugin from './main'
import {
	EXPORT_GROUP_LABELS,
	exportCsv,
	exportMarkdown,
	filterExportDocs,
	type ExportGroupBy,
	type ExportOptions,
	type SearchDoc,
} from './search'
import { HIGHLIGHT_COLORS } from './types'

export interface AnnotationExportSource {
	/** 全库批注索引 */
	all: SearchDoc[]
	/** 当前检索命中的批注 */
	results: SearchDoc[]
	/** 检索词，空串表示没有检索 */
	query: string
	/** 打开时默认导出哪一份 */
	scope: 'results' | 'all'
	onlyNotes: boolean
}

const PREVIEW_LIMIT = 16_000

/**
 * 导出前筛选与预览：范围（检索结果 / 全部）、书、章节、颜色、今天、只看评论，
 * 再选分组与 Markdown 内容开关；下方实时预览最终文件，确认后才写盘。
 */
export class AnnotationExportModal extends Modal {
	private sourceScope: 'results' | 'all'
	private todayOnly = false
	private bookPath = ''
	private chapter = ''
	private colors = new Set<string>(HIGHLIGHT_COLORS.map(c => c.key))
	private groupBy: ExportGroupBy = 'book'
	private includeComment = true
	private includeLink = true
	private includeMeta = true
	private format: 'md' | 'csv' = 'md'

	private scopeButtons: Array<{ value: 'results' | 'all'; el: HTMLButtonElement }> = []
	private bookSelect!: HTMLSelectElement
	private chapterSelect!: HTMLSelectElement
	private colorChips = new Map<string, HTMLElement>()
	private groupSelect!: HTMLSelectElement
	private todayBox!: HTMLInputElement
	private notesBox!: HTMLInputElement
	private contentBoxes: Array<{ key: 'comment' | 'link' | 'meta'; el: HTMLInputElement }> = []
	private formatButtons: Array<{ value: 'md' | 'csv'; el: HTMLButtonElement }> = []
	private countEl!: HTMLElement
	private previewEl!: HTMLElement
	private exportBtn!: HTMLButtonElement
	private onlyNotes: boolean

	constructor(app: App, private plugin: GroveReaderPlugin, private src: AnnotationExportSource) {
		super(app)
		this.sourceScope = src.scope
		this.onlyNotes = src.onlyNotes
	}

	onOpen(): void {
		this.modalEl.addClass('grove-export-modal')
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h3', { text: '导出批注' })

		const total = this.src.all.length
		contentEl.createEl('p', {
			cls: 'setting-item-description grove-export-intro',
			text: this.src.query.trim()
				? `先筛选再导出，下方预览会随条件实时更新。当前检索命中 ${this.src.results.length} 条，全库 ${total} 条。`
				: `先筛选再导出，下方预览会随条件实时更新。全库 ${total} 条批注。`,
		})

		if (this.src.results.length) {
			const scopeRow = contentEl.createDiv('grove-export-scope')
			this.scopeButtons = [
				this.#scopeButton(scopeRow, 'results', `检索结果（${this.src.results.length}）`),
				this.#scopeButton(scopeRow, 'all', `全部批注（${total}）`),
			]
		}

		const grid = contentEl.createDiv('grove-export-grid')
		this.bookSelect = this.#field(grid, '书籍')
		this.bookSelect.addEventListener('change', () => {
			this.bookPath = this.bookSelect.value
			this.chapter = ''
			this.#refresh(true)
		})
		this.chapterSelect = this.#field(grid, '章节')
		this.chapterSelect.addEventListener('change', () => {
			this.chapter = this.chapterSelect.value
			this.#refresh()
		})

		const colorField = grid.createDiv('grove-export-field grove-export-colors')
		colorField.createSpan('grove-export-label').setText('颜色')
		const chips = colorField.createDiv('grove-export-color-row')
		for (const color of HIGHLIGHT_COLORS) {
			const chip = chips.createEl('button', {
				cls: 'grove-export-color',
				attr: { type: 'button', 'aria-pressed': 'true', title: `只看${color.name}色` },
			})
			chip.createSpan('grove-export-color-dot').style.background = color.css
			chip.createSpan({ text: color.name })
			chip.addEventListener('click', () => {
				if (this.colors.has(color.key)) this.colors.delete(color.key)
				else this.colors.add(color.key)
				this.#refresh()
			})
			this.colorChips.set(color.key, chip)
		}

		const toggles = grid.createDiv('grove-export-field grove-export-toggles')
		toggles.createSpan('grove-export-label').setText('条件')
		const toggleRow = toggles.createDiv('grove-export-toggle-row')
		const todayLabel = toggleRow.createEl('label', { cls: 'grove-export-check' })
		this.todayBox = todayLabel.createEl('input', { type: 'checkbox' })
		todayLabel.createSpan({ text: '仅今天' })
		this.todayBox.addEventListener('change', () => {
			this.todayOnly = this.todayBox.checked
			this.#refresh()
		})
		const notesLabel = toggleRow.createEl('label', { cls: 'grove-export-check' })
		this.notesBox = notesLabel.createEl('input', { type: 'checkbox' })
		this.notesBox.checked = this.onlyNotes
		notesLabel.createSpan({ text: '只看有评论的' })
		this.notesBox.addEventListener('change', () => {
			this.onlyNotes = this.notesBox.checked
			this.#refresh()
		})

		const optionsRow = contentEl.createDiv('grove-export-options')
		const groupField = optionsRow.createDiv('grove-export-field')
		groupField.createSpan('grove-export-label').setText('分组')
		this.groupSelect = groupField.createEl('select', { cls: 'dropdown' })
		for (const key of ['book', 'chapter', 'color'] as ExportGroupBy[]) {
			this.groupSelect.createEl('option', { value: key, text: EXPORT_GROUP_LABELS[key] })
		}
		this.groupSelect.addEventListener('change', () => {
			this.groupBy = (this.groupSelect.value as ExportGroupBy) ?? 'book'
			this.#refresh()
		})

		const contentField = optionsRow.createDiv('grove-export-field')
		contentField.createSpan('grove-export-label').setText('Markdown 内容')
		const contentRow = contentField.createDiv('grove-export-toggle-row')
		const addContent = (key: 'comment' | 'link' | 'meta', label: string): void => {
			const wrap = contentRow.createEl('label', { cls: 'grove-export-check' })
			const box = wrap.createEl('input', { type: 'checkbox' })
			box.checked = true
			wrap.createSpan({ text: label })
			box.addEventListener('change', () => {
				if (key === 'comment') this.includeComment = box.checked
				else if (key === 'link') this.includeLink = box.checked
				else this.includeMeta = box.checked
				this.#refresh()
			})
			this.contentBoxes.push({ key, el: box })
		}
		addContent('meta', '位置与颜色')
		addContent('comment', '评论')
		addContent('link', '回跳链接')

		const formatField = optionsRow.createDiv('grove-export-field')
		formatField.createSpan('grove-export-label').setText('格式')
		const formatRow = formatField.createDiv('grove-export-format')
		for (const value of ['md', 'csv'] as const) {
			const btn = formatRow.createEl('button', {
				cls: 'grove-export-format-btn',
				text: value === 'md' ? 'Markdown' : 'CSV',
				attr: { type: 'button' },
			})
			btn.addEventListener('click', () => {
				this.format = value
				this.#refresh()
			})
			this.formatButtons.push({ value, el: btn })
		}

		const previewHead = contentEl.createDiv('grove-export-preview-head')
		this.countEl = previewHead.createSpan('grove-export-count')
		previewHead.createSpan({ cls: 'grove-export-path' }).setText(this.#folderHint())
		this.previewEl = contentEl.createEl('pre', { cls: 'grove-export-preview' })

		const footer = contentEl.createDiv('modal-button-container')
		const cancel = footer.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
		this.exportBtn = footer.createEl('button', { text: '导出', cls: 'mod-cta' })
		this.exportBtn.addEventListener('click', () => void this.#doExport())

		this.#refresh(true)
	}

	#scopeButton(parent: HTMLElement, value: 'results' | 'all', text: string): { value: 'results' | 'all'; el: HTMLButtonElement } {
		const el = parent.createEl('button', { cls: 'grove-export-scope-btn', text, attr: { type: 'button' } })
		el.addEventListener('click', () => {
			if (this.sourceScope === value) return
			this.sourceScope = value
			this.bookPath = ''
			this.chapter = ''
			this.#refresh(true)
		})
		return { value, el }
	}

	/** 生成「标签 + select」，返回 select 供绑定事件 */
	#field(parent: HTMLElement, label: string): HTMLSelectElement {
		const wrap = parent.createDiv('grove-export-field')
		wrap.createSpan('grove-export-label').setText(label)
		return wrap.createEl('select', { cls: 'dropdown' })
	}

	#baseDocs(): SearchDoc[] {
		return this.sourceScope === 'all' ? this.src.all : this.src.results
	}

	#options(): ExportOptions {
		// 五个颜色全选＝不筛颜色；全都不选时给一个不存在的 key，让结果为空
		const allColors = this.colors.size === HIGHLIGHT_COLORS.length
		const colors = allColors ? [] : this.colors.size ? [...this.colors] : ['__none__']
		return {
			source: this.sourceScope,
			todayOnly: this.todayOnly,
			bookPath: this.bookPath,
			chapter: this.chapter,
			colors,
			onlyNotes: this.onlyNotes,
			groupBy: this.groupBy,
			includeComment: this.includeComment,
			includeLink: this.includeLink,
			includeMeta: this.includeMeta,
		}
	}

	#filtered(): SearchDoc[] {
		return filterExportDocs(this.#baseDocs(), this.#options())
	}

	/** 书籍/章节下拉只随来源和书籍变化，避免勾颜色时把用户选的章节重置掉 */
	#refreshSources(): void {
		const base = this.#baseDocs()
		const books = new Map<string, string>()
		for (const doc of base) {
			if (!books.has(doc.bookPath)) books.set(doc.bookPath, doc.bookTitle)
		}
		const bookOptions = [...books.entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))
		this.bookSelect.empty()
		this.bookSelect.createEl('option', { value: '', text: `全部书籍（${books.size}）` })
		for (const [path, title] of bookOptions) this.bookSelect.createEl('option', { value: path, text: title })
		if (this.bookPath && !books.has(this.bookPath)) this.bookPath = ''
		this.bookSelect.value = this.bookPath

		const chapters = new Set<string>()
		for (const doc of base) {
			if (this.bookPath && doc.bookPath !== this.bookPath) continue
			const chapter = (doc.annotation.chapter ?? '').trim()
			if (chapter) chapters.add(chapter)
		}
		const sorted = [...chapters].sort((a, b) => a.localeCompare(b, 'zh-CN'))
		this.chapterSelect.empty()
		this.chapterSelect.createEl('option', { value: '', text: `全部章节（${sorted.length}）` })
		for (const chapter of sorted) this.chapterSelect.createEl('option', { value: chapter, text: chapter })
		if (this.chapter && !chapters.has(this.chapter)) this.chapter = ''
		this.chapterSelect.value = this.chapter
	}

	#refresh(rebuildSources = false): void {
		if (rebuildSources) this.#refreshSources()
		for (const btn of this.scopeButtons) btn.el.toggleClass('is-active', btn.value === this.sourceScope)
		for (const [key, chip] of this.colorChips) {
			chip.toggleClass('is-on', this.colors.has(key))
			chip.setAttr('aria-pressed', this.colors.has(key) ? 'true' : 'false')
		}
		for (const { value, el } of this.formatButtons) el.toggleClass('is-active', value === this.format)
		this.groupSelect.value = this.groupBy
		this.todayBox.checked = this.todayOnly
		this.notesBox.checked = this.onlyNotes
		for (const { key, el } of this.contentBoxes) {
			el.checked = key === 'comment' ? this.includeComment : key === 'link' ? this.includeLink : this.includeMeta
			// CSV 固定输出全部列，内容开关只影响 Markdown
			el.disabled = this.format === 'csv'
		}

		const docs = this.#filtered()
		const base = this.#baseDocs().length
		this.countEl.setText(`符合条件 ${docs.length} 条 / 来源 ${base} 条`)
		this.exportBtn.setText(`导出（${docs.length}）`)
		this.exportBtn.disabled = docs.length === 0
		if (!docs.length) {
			this.previewEl.setText('没有符合当前筛选的批注。放宽书籍、章节、颜色或「仅今天」再试。')
			return
		}
		const content = this.format === 'md'
			? exportMarkdown(docs, this.src.query, this.#options())
			: exportCsv(docs)
		this.previewEl.setText(content.length > PREVIEW_LIMIT
			? `${content.slice(0, PREVIEW_LIMIT)}\n\n…（预览已截断，导出会写入完整内容）`
			: content)
	}

	#folderHint(): string {
		const base = (this.plugin.settings.notesFolder?.trim() || '阅读笔记').replace(/\\/g, '/').replace(/\/+$/, '')
		return `保存到 ${base}/批注检索/`
	}

	async #doExport(): Promise<void> {
		const docs = this.#filtered()
		if (!docs.length) return
		this.exportBtn.disabled = true
		try {
			await this.plugin.exportSearchResults(docs, this.src.query, this.format, this.#options())
			this.close()
		} catch (e) {
			new Notice(`导出失败：${e instanceof Error ? e.message : String(e)}`)
			this.exportBtn.disabled = false
		}
	}

	onClose(): void {
		this.contentEl.empty()
	}
}
