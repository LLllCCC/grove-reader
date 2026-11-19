/**
 * 查词弹窗：结合书中原文让 AI 给释义，可修改后加入该书生词本；
 * 也可把当前词条复制成 Anki 可导入的两列 CSV。
 */
import { App, Modal, Notice, TFile, normalizePath } from 'obsidian'
import type GroveReaderPlugin from './main'
import { hintFor, isAiConfigured, lookupWord, type AiConfig } from './ai'
import { appendVocabEntry, vocabAnkiCsv, vocabFilePath, type VocabEntry } from './vocab'
import { t } from './i18n'

const NOT_CONFIGURED = '还没有配置 AI。请到 设置 → 阅读与笔记 → AI 解释 填入接口地址、模型与 API Key（推荐智谱 GLM-4-Flash，免费）'

export interface WordLookupContext {
	bookTitle: string
	bookPath: string
	chapter?: string
	cfi?: string
	/** 选中的原文，作为语境一起发给模型 */
	context?: string
}

export class WordLookupModal extends Modal {
	private meaning = ''
	private busy = false
	private inputEl!: HTMLInputElement
	private resultEl!: HTMLTextAreaElement
	private statusEl!: HTMLElement
	private lookupBtn!: HTMLButtonElement
	private saveBtn!: HTMLButtonElement

	constructor(
		app: App,
		private plugin: GroveReaderPlugin,
		word: string,
		private ctx: WordLookupContext,
	) {
		super(app)
		this.meaning = ''
		this.word = word.trim().slice(0, 60)
	}

	private word: string

	onOpen(): void {
		this.contentEl.empty()
		this.modalEl.addClass('grove-vocab-modal')
		this.contentEl.createEl('h3', { text: t('查词') })
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: t("结合《{p0}》里的原文语境查词；释义可以直接修改，再存入这本书的生词本。", { p0: this.ctx.bookTitle }),
		})

		const row = this.contentEl.createDiv('grove-vocab-word-row')
		row.createSpan('grove-vocab-label').setText(t('单词 / 短语'))
		this.inputEl = row.createEl('input', {
			type: 'text',
			cls: 'grove-vocab-input',
			attr: { placeholder: t('输入要查的词') },
		})
		this.inputEl.value = this.word
		this.inputEl.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault()
				void this.#lookup()
			}
		})

		this.statusEl = this.contentEl.createDiv('grove-vocab-status')
		this.resultEl = this.contentEl.createEl('textarea', {
			cls: 'grove-vocab-result',
			attr: { placeholder: t('释义会显示在这里，可直接修改'), rows: '6' },
		})

		const buttons = this.contentEl.createDiv('modal-button-container')
		this.lookupBtn = buttons.createEl('button', { text: t('查询'), cls: 'mod-cta' })
		this.lookupBtn.addEventListener('click', () => void this.#lookup())
		this.saveBtn = buttons.createEl('button', { text: t('加入生词本') })
		this.saveBtn.addEventListener('click', () => void this.#save())
		const csvBtn = buttons.createEl('button', { text: t('复制 Anki CSV') })
		csvBtn.addEventListener('click', () => void this.#copyCsv())
		const close = buttons.createEl('button', { text: t('关闭') })
		close.addEventListener('click', () => this.close())

		if (isAiConfigured(this.#cfg)) void this.#lookup()
		else this.#status(t(NOT_CONFIGURED))
	}

	get #cfg(): AiConfig {
		const s = this.plugin.settings
		return { baseUrl: s.aiBaseUrl ?? '', apiKey: s.aiApiKey ?? '', model: s.aiModel ?? '' }
	}

	#status(text: string): void {
		this.statusEl.setText(text)
	}

	async #lookup(): Promise<void> {
		if (this.busy) return
		const word = this.inputEl.value.trim()
		if (!word) {
			this.#status(t('先输入要查的词'))
			return
		}
		this.word = word
		if (!isAiConfigured(this.#cfg)) {
			this.#status(t(NOT_CONFIGURED))
			return
		}
		this.busy = true
		this.lookupBtn.disabled = true
		this.saveBtn.disabled = true
		this.#status(t('查询中…'))
		try {
			this.meaning = await lookupWord(this.#cfg, word, this.ctx.context ?? '')
			this.resultEl.value = this.meaning
			this.#status(t('已生成，可修改后加入生词本'))
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e)
			this.#status(`查询失败：${message}${hintFor(message)}`)
		} finally {
			this.busy = false
			this.lookupBtn.disabled = false
			this.saveBtn.disabled = false
		}
	}

	#entry(): VocabEntry {
		return {
			word: this.word,
			meaning: this.resultEl.value.trim() || this.meaning,
			context: this.ctx.context,
			bookTitle: this.ctx.bookTitle,
			bookPath: this.ctx.bookPath,
			chapter: this.ctx.chapter,
			cfi: this.ctx.cfi,
			createdAt: Date.now(),
		}
	}

	async #save(): Promise<void> {
		const word = this.inputEl.value.trim()
		if (!word) {
			this.#status(t('先输入要查的词'))
			return
		}
		this.word = word
		const entry = this.#entry()
		const folder = (this.plugin.settings.notesFolder?.trim() || '阅读笔记').replace(/\\/g, '/').replace(/\/+$/, '')
		const path = normalizePath(vocabFilePath(folder, this.ctx.bookTitle))
		const dir = path.split('/').slice(0, -1).join('/')
		try {
			if (dir && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir)
			const file = this.app.vault.getAbstractFileByPath(path)
			const existing = file instanceof TFile ? await this.app.vault.read(file) : null
			const result = appendVocabEntry(existing, entry)
			if (!result.added) {
				new Notice(t('Grove Reader：生词本里已经有这个词了'))
				return
			}
			if (file instanceof TFile) await this.app.vault.modify(file, result.markdown)
			else await this.app.vault.create(path, result.markdown)
			new Notice(t("Grove Reader：已加入 {p0}", { p0: path }))
			this.close()
		} catch (e) {
			this.#status(`保存失败：${e instanceof Error ? e.message : String(e)}`)
		}
	}

	async #copyCsv(): Promise<void> {
		const entry = this.#entry()
		if (!entry.word) {
			this.#status(t('先输入要查的词'))
			return
		}
		try {
			await navigator.clipboard.writeText(vocabAnkiCsv(entry))
			new Notice(t('Grove Reader：已复制 Anki CSV'))
		} catch {
			this.#status(t('复制失败：剪贴板不可用'))
		}
	}

	onClose(): void {
		this.contentEl.empty()
	}
}
