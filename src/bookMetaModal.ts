/**
 * 书架 AI 元数据补全：读正文开头，让聊天模型给作者 / 分类 / 一句话简介。
 *
 * 只填空白字段，不覆盖手填内容；预览可改，保存后写进批注数据与书架缓存，
 * 并记录哪些字段来自 AI，书籍信息弹窗里会标「AI 生成」。
 */
import { App, Modal, Notice } from 'obsidian'
import type GroveReaderPlugin from './main'
import { chatCompletion, hintFor, isAiConfigured, type AiConfig } from './ai'
import { parseMetaSuggestion, type MetaSuggestion } from './bookMeta'
import { extractBookText } from './librarySearch'
import { basenameOf, cleanBookTitle } from './util'
import { t } from './i18n'

const NOT_CONFIGURED = '还没有配置 AI。请到 设置 → 阅读 → AI 解释 填入接口地址、模型与 API Key（推荐智谱 GLM-4-Flash，免费）'
const SAMPLE_CHARS = 3000

type MetaField = 'author' | 'category' | 'intro'

export class BookMetaModal extends Modal {
	private generating = false
	private error = ''
	private token = 0
	private suggestion: MetaSuggestion = { author: '', category: '', intro: '' }
	private values: Record<MetaField, string>
	private dirty = new Set<MetaField>()
	private statusEl: HTMLElement | null = null
	private formEl: HTMLElement | null = null
	private badges: Partial<Record<MetaField, HTMLElement>> = {}

	constructor(
		app: App,
		private plugin: GroveReaderPlugin,
		private bookPath: string,
		private onSaved?: () => void,
	) {
		super(app)
		const entry = plugin.shelfCache.get(bookPath) ?? {}
		const data = plugin.store.load(bookPath)
		this.values = {
			author: entry.author ?? data.author ?? '',
			category: entry.category ?? data.category ?? '',
			intro: entry.intro ?? data.intro ?? '',
		}
	}

	onOpen(): void {
		this.contentEl.empty()
		this.modalEl.addClass('grove-meta-modal')
		this.contentEl.createEl('h3', { text: t('AI 补全书籍信息') })
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: t('读取书名与正文开头，生成作者、分类和一句话简介。只填空字段，不覆盖已有内容；保存前可以改。'),
		})
		this.statusEl = this.contentEl.createDiv('grove-meta-status')
		this.formEl = this.contentEl.createDiv('grove-meta-form')
		void this.#generate()
	}

	onClose(): void {
		this.token++
		this.contentEl.empty()
	}

	get #cfg(): AiConfig {
		const s = this.plugin.settings
		return { baseUrl: s.aiBaseUrl ?? '', apiKey: s.aiApiKey ?? '', model: s.aiModel ?? '' }
	}

	async #generate(): Promise<void> {
		if (this.generating) return
		const cfg = this.#cfg
		if (!isAiConfigured(cfg)) {
			this.#renderForm()
			return
		}
		const token = ++this.token
		this.generating = true
		this.error = ''
		this.#renderForm()
		try {
			this.#status(t('正在读取正文…'))
			const extracted = await extractBookText(this.plugin, this.bookPath)
			const sample = extracted.sections
				.map(section => section.text)
				.join('\n')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, SAMPLE_CHARS)
			if (token !== this.token) return
			this.#status(t('正在让 AI 读这本书…'))
			const title = this.plugin.shelfCache.get(this.bookPath)?.title
				|| cleanBookTitle(basenameOf(this.bookPath).replace(/\.[^.]+$/, ''))
			const answer = await chatCompletion(cfg, [
				{
					role: 'system',
					content: t('你是一位图书信息整理助手。只根据提供的书名和正文片段判断，不确定就留空，不要编造。'),
				},
				{
					role: 'user',
					content: [
						`书名：${title}`,
						'',
						`正文开头：${sample || t('（没有提取到正文）')}`,
						'',
						t('请返回 JSON，不要 Markdown 代码块：'),
						t('{"author":"作者，不确定就留空","category":"2-4 个字的分类","intro":"一句话简介，40 字以内"}'),
					].join('\n'),
				},
			], { temperature: 0.2, maxTokens: 300 })
			if (token !== this.token) return
			this.suggestion = parseMetaSuggestion(answer)
			for (const field of ['author', 'category', 'intro'] as MetaField[]) {
				if (!this.values[field] && this.suggestion[field]) this.values[field] = this.suggestion[field]
			}
		} catch (e) {
			if (token !== this.token) return
			this.error = e instanceof Error ? e.message : String(e)
		} finally {
			if (token === this.token) {
				this.generating = false
				this.#renderForm()
			}
		}
	}

	#status(text: string): void {
		this.statusEl?.setText(text)
	}

	#isAiField(field: MetaField): boolean {
		return !!this.suggestion[field] && this.values[field] === this.suggestion[field] && !this.dirty.has(field)
	}

	#renderForm(): void {
		if (!this.formEl) return
		this.formEl.empty()
		this.badges = {}
		if (this.generating) this.#status(t('正在生成建议…'))
		else if (this.error) this.#status(`生成失败：${this.error}${hintFor(this.error)}`)
		else if (!isAiConfigured(this.#cfg)) this.#status(NOT_CONFIGURED)
		else this.#status(t('建议已生成，确认或修改后保存'))
		if (!isAiConfigured(this.#cfg)) {
			this.formEl.createDiv('grove-meta-hint').setText(t('也可以先手动填写下面的空白字段。'))
		}

		const entry = this.plugin.shelfCache.get(this.bookPath) ?? {}
		const data = this.plugin.store.load(this.bookPath)
		const existing: Record<MetaField, string> = {
			author: entry.author ?? data.author ?? '',
			category: entry.category ?? data.category ?? '',
			intro: entry.intro ?? data.intro ?? '',
		}

		const renderField = (field: MetaField, label: string, multiline = false): void => {
			const row = this.formEl!.createDiv('grove-meta-field')
			const head = row.createDiv('grove-meta-label')
			head.createSpan().setText(label)
			const badge = head.createSpan('grove-meta-ai')
			this.badges[field] = badge
			if (existing[field]) {
				head.createSpan({ cls: 'grove-meta-locked', text: t('已有内容，不覆盖') })
			} else if (this.#isAiField(field)) {
				badge.setText(t('AI 生成'))
			}
			const input = multiline
				? row.createEl('textarea', { cls: 'grove-comment-input', attr: { rows: '3' } })
				: row.createEl('input', { type: 'text', cls: 'grove-folder-input' })
			input.value = this.values[field]
			input.disabled = !!existing[field]
			input.placeholder = field === 'intro' ? t('一句话简介，40 字以内') : ''
			input.addEventListener('input', () => {
				this.values[field] = input.value
				this.dirty.add(field)
				badge.setText('')
			})
		}
		renderField('author', t('作者'))
		renderField('category', t('分类'))
		renderField('intro', t('一句话简介'), true)

		const buttons = this.formEl.createDiv('modal-button-container')
		const regen = buttons.createEl('button', { text: this.generating ? t('生成中…') : t('重新生成') })
		regen.disabled = this.generating || !isAiConfigured(this.#cfg)
		regen.addEventListener('click', () => void this.#generate())
		const save = buttons.createEl('button', { text: t('保存'), cls: 'mod-cta' })
		save.addEventListener('click', () => this.#save(existing))
		const cancel = buttons.createEl('button', { text: t('取消') })
		cancel.addEventListener('click', () => this.close())
	}

	#save(existing: Record<MetaField, string>): void {
		const entry = this.plugin.shelfCache.get(this.bookPath) ?? {}
		const data = this.plugin.store.load(this.bookPath)
		const values: Record<MetaField, string> = {
			author: (this.values.author ?? '').trim(),
			category: (this.values.category ?? '').trim(),
			intro: (this.values.intro ?? '').trim(),
		}
		const aiMeta = { ...(data.aiMeta ?? {}) }
		let changed = false
		for (const field of ['author', 'category', 'intro'] as MetaField[]) {
			if (existing[field] || !values[field]) continue
			data[field] = values[field]
			changed = true
			const ai = this.#isAiField(field)
			if (ai) aiMeta[field] = true
			else delete aiMeta[field]
		}
		if (!changed) {
			new Notice(t('Grove Reader：没有需要保存的空白字段'))
			this.close()
			return
		}
		if (Object.keys(aiMeta).length) {
			aiMeta.at = Date.now()
			data.aiMeta = aiMeta
		} else {
			delete data.aiMeta
		}
		this.plugin.store.save(data)
		this.plugin.shelfCache.set(this.bookPath, {
			...entry,
			author: entry.author || data.author || undefined,
			category: entry.category || data.category || undefined,
			intro: entry.intro || data.intro || undefined,
		})
		this.plugin.shelfCache.saveNow()
		new Notice(t('Grove Reader：书籍信息已保存'))
		this.onSaved?.()
		this.close()
	}
}
