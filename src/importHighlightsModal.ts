/**
 * 导入外部标注：粘贴或选库内文件，自动识别 Kindle / Readwise / 微信读书格式，
 * 预览匹配结果（含重复数）后写入对应书籍的批注数据。
 */
import { App, Modal, Notice, SuggestModal, TFile } from 'obsidian'
import type GroveReaderPlugin from './main'
import { scanBookFolders } from './bookshelf'
import {
	buildImportedAnnotations,
	detectHighlightFormat,
	matchImportedHighlights,
	parseHighlightText,
	type HighlightFormat,
	type ImportBookTarget,
	type ImportedHighlight,
} from './importHighlights'
import { IMPORT_SOURCE_LABELS, isShelfExt, type Annotation } from './types'
import { basenameOf, cleanBookTitle } from './util'

const FORMAT_LABELS: Record<HighlightFormat, string> = {
	kindle: 'Kindle My Clippings',
	readwise: 'Readwise CSV',
	weread: '微信读书 Markdown',
}

const TEXT_EXTS = new Set(['txt', 'csv', 'md'])
const MAX_FILE_BYTES = 8 * 1024 * 1024

interface PlanGroup {
	bookPath: string
	bookTitle: string
	annotations: Annotation[]
	duplicates: number
}

interface ImportPlan {
	format: HighlightFormat
	total: number
	groups: PlanGroup[]
	unmatched: ImportedHighlight[]
}

class TextFileSuggestModal extends SuggestModal<TFile> {
	constructor(
		app: App,
		private files: TFile[],
		private pick: (file: TFile) => void,
	) {
		super(app)
		this.setPlaceholder('选择 My Clippings.txt / Readwise CSV / 微信读书 Markdown')
	}

	getSuggestions(query: string): TFile[] {
		const q = query.trim().toLowerCase()
		return this.files.filter(f => !q || f.path.toLowerCase().includes(q)).slice(0, 50)
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.createDiv({ text: file.basename })
		el.createDiv({ cls: 'setting-item-description', text: file.path })
	}

	onChooseSuggestion(file: TFile): void {
		this.pick(file)
	}
}

export class ImportHighlightsModal extends Modal {
	private textEl!: HTMLTextAreaElement
	private statusEl!: HTMLElement
	private previewEl!: HTMLElement
	private importBtn!: HTMLButtonElement
	private plan: ImportPlan | null = null
	private previewTimer: number | null = null

	constructor(
		app: App,
		private plugin: GroveReaderPlugin,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.modalEl.addClass('grove-import-modal')
		this.contentEl.createEl('h3', { text: '导入外部标注' })
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: '支持 Kindle 的 My Clippings.txt、Readwise 导出的 CSV、微信读书 Markdown（引用行）。按书名/作者匹配库内书籍，重复的摘录会自动跳过。',
		})

		const pickRow = this.contentEl.createDiv('grove-import-pick-row')
		pickRow.createSpan('grove-import-pick-label').setText('或从库内文件读取：')
		const pickBtn = pickRow.createEl('button', { text: '选择文件…' })
		pickBtn.addEventListener('click', () => this.#pickFile())

		this.textEl = this.contentEl.createEl('textarea', {
			cls: 'grove-import-input',
			attr: { rows: '9', placeholder: '把 My Clippings.txt / Readwise CSV / 微信读书 Markdown 的内容粘贴到这里…' },
		})
		this.textEl.addEventListener('input', () => this.#schedulePreview())

		this.statusEl = this.contentEl.createDiv('grove-import-status')
		this.statusEl.setText('粘贴文本或从库内选择文件后会自动识别格式。')
		this.previewEl = this.contentEl.createDiv('grove-import-preview')

		const buttons = this.contentEl.createDiv('modal-button-container')
		this.importBtn = buttons.createEl('button', { text: '导入', cls: 'mod-cta' })
		this.importBtn.disabled = true
		this.importBtn.addEventListener('click', () => void this.#runImport())
		const close = buttons.createEl('button', { text: '取消' })
		close.addEventListener('click', () => this.close())
	}

	onClose(): void {
		if (this.previewTimer != null) window.clearTimeout(this.previewTimer)
		this.contentEl.empty()
	}

	#pickFile(): void {
		const files = this.app.vault
			.getFiles()
			.filter(f => TEXT_EXTS.has(f.extension.toLowerCase()) && f.stat.size <= MAX_FILE_BYTES)
			.sort((a, b) => a.path.localeCompare(b.path))
		if (!files.length) {
			this.statusEl.setText('库里没有可读取的 .txt / .csv / .md 文件。')
			return
		}
		new TextFileSuggestModal(this.app, files, file => {
			void this.app.vault.read(file).then(text => {
				this.textEl.value = text
				this.#preview()
			}).catch(e => {
				this.statusEl.setText(`读取失败：${e instanceof Error ? e.message : String(e)}`)
			})
		}).open()
	}

	#schedulePreview(): void {
		if (this.previewTimer != null) window.clearTimeout(this.previewTimer)
		this.previewTimer = window.setTimeout(() => {
			this.previewTimer = null
			this.#preview()
		}, 250)
	}

	#bookTargets(): ImportBookTarget[] {
		const all = this.app.vault.getFiles().map(f => f.path)
		const folders = this.plugin.settings.scanFolders ?? []
		const paths = new Set<string>()
		for (const p of folders.length ? scanBookFolders(folders, all) : all.filter(p => isShelfExt(p.split('.').pop() ?? ''))) {
			paths.add(p)
		}
		// 有批注数据的书即使不在扫描目录里也允许导入（用户手动加进来的书）
		for (const p of this.plugin.store.listBookPaths()) paths.add(p)
		const out: ImportBookTarget[] = []
		for (const path of paths) {
			const data = this.plugin.store.load(path)
			out.push({
				path,
				title: (data.title || '').trim() || cleanBookTitle(basenameOf(path)),
				author: data.author,
			})
		}
		return out
	}

	#preview(): void {
		this.previewEl.empty()
		this.plan = null
		this.importBtn.disabled = true
		this.importBtn.setText('导入')
		const text = this.textEl.value
		if (!text.trim()) {
			this.statusEl.setText('粘贴文本或从库内选择文件后会自动识别格式。')
			return
		}
		const format = detectHighlightFormat(text)
		if (!format) {
			this.statusEl.setText('没识别出格式。支持 Kindle My Clippings.txt、Readwise CSV、微信读书 Markdown。')
			return
		}
		const highlights = parseHighlightText(text, format)
		if (!highlights.length) {
			this.statusEl.setText(`识别为 ${FORMAT_LABELS[format]}，但没有解析到划线。`)
			return
		}
		const match = matchImportedHighlights(highlights, this.#bookTargets())
		const groups: PlanGroup[] = []
		for (const group of match.matched) {
			const data = this.plugin.store.load(group.bookPath)
			const built = buildImportedAnnotations(group.highlights, data.annotations, format)
			if (built.annotations.length) {
				groups.push({
					bookPath: group.bookPath,
					bookTitle: group.bookTitle,
					annotations: built.annotations,
					duplicates: built.duplicates,
				})
			}
		}
		const total = groups.reduce((sum, g) => sum + g.annotations.length, 0)
		const duplicates = groups.reduce((sum, g) => sum + g.duplicates, 0)
		this.statusEl.setText(
			`识别为 ${FORMAT_LABELS[format]} · ${highlights.length} 条划线`
			+ (duplicates ? `，其中 ${duplicates} 条书里已有` : ''),
		)
		for (const group of groups) {
			const row = this.previewEl.createDiv('grove-import-book')
			row.createSpan('grove-import-book-title').setText(`《${group.bookTitle}》`)
			row.createSpan('grove-import-book-count').setText(
				group.duplicates
					? `可导入 ${group.annotations.length} 条（跳过重复 ${group.duplicates} 条）`
					: `可导入 ${group.annotations.length} 条`,
			)
		}
		if (match.unmatched.length) {
			const titles = new Map<string, number>()
			for (const h of match.unmatched) titles.set(h.bookTitle, (titles.get(h.bookTitle) ?? 0) + 1)
			const names = [...titles.entries()].slice(0, 6).map(([title, n]) => `《${title}》${n} 条`).join('、')
			const rest = titles.size > 6 ? ` 等 ${titles.size} 本` : ''
			this.previewEl.createDiv('grove-import-unmatched').setText(`未匹配到库内书籍：${names}${rest}`)
		}
		if (!total) {
			this.statusEl.setText(`识别为 ${FORMAT_LABELS[format]}，但没有需要导入的新划线。`)
			return
		}
		this.plan = { format, total, groups, unmatched: match.unmatched }
		this.importBtn.setText(`导入 ${total} 条`)
		this.importBtn.disabled = false
	}

	async #runImport(): Promise<void> {
		const plan = this.plan
		if (!plan) return
		this.importBtn.disabled = true
		let written = 0
		const touched: string[] = []
		try {
			for (const group of plan.groups) {
				const data = this.plugin.store.load(group.bookPath)
				data.annotations.push(...group.annotations)
				if (!data.title) data.title = group.bookTitle
				this.plugin.store.save(data)
				written += group.annotations.length
				touched.push(group.bookPath)
			}
		} catch (e) {
			this.statusEl.setText(`写入失败：${e instanceof Error ? e.message : String(e)}`)
			this.importBtn.disabled = false
			return
		}
		if (!written) {
			new Notice('Grove Reader：没有可导入的标注')
			this.close()
			return
		}
		this.plugin.oplog.add(
			'导入外部标注',
			`${IMPORT_SOURCE_LABELS[plan.format] ?? plan.format}；${written} 条 / ${touched.length} 本`,
		)
		this.plugin.refreshOpenReaders(touched)
		new Notice(`Grove Reader：已导入 ${written} 条标注（${touched.length} 本书）`)
		this.close()
	}
}
