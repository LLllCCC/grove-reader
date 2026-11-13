import { App, Modal, Notice, setIcon } from 'obsidian'
import type GroveReaderPlugin from './main'
import type { ReaderEngine } from './engine/types'
import { hintFor, isAiConfigured, summarizeGuideSection, type AiConfig } from './ai'
import { confirmAsync } from './modals'
import {
	GUIDE_TEXT_CHARS,
	guidePromptText,
	loadGuide,
	planGuideUnits,
	removeGuide,
	resumableGuideItems,
	saveGuide,
	type GuideDoc,
} from './guide'

const NOT_CONFIGURED =
	'还没有配置 AI。请到 设置 → 阅读 → AI 解释 填入接口地址、模型与 API Key（推荐智谱 GLM-4-Flash，免费）'

/**
 * AI 按章导读：
 * 按章节（EPUB 节 / TXT 章 / PDF 页组）逐章生成 2-4 句导读，结果按书落盘，
 * 点其中一章就跳回原文。只有点「生成导读」时才会消耗 API。
 */
export class GuideModal extends Modal {
	private doc: GuideDoc | null = null
	private loaded = false
	private building = false
	private progress = ''
	private buildToken = 0
	private progressEl: HTMLElement | null = null
	private listEl: HTMLElement | null = null

	constructor(app: App, private readonly plugin: GroveReaderPlugin, private readonly view: ReaderEngine) {
		super(app)
	}

	onOpen(): void {
		this.modalEl.addClass('grove-guide-modal-shell')
		this.contentEl.addClass('grove-guide-modal')
		void this.#load()
	}

	onClose(): void {
		this.buildToken++
		this.modalEl.removeClass('grove-guide-modal-shell')
		this.contentEl.empty()
	}

	get #bookId(): string {
		return this.plugin.store.bookId(this.view.bookPath)
	}

	get #cfg(): AiConfig {
		const s = this.plugin.settings
		return { baseUrl: s.aiBaseUrl ?? '', apiKey: s.aiApiKey ?? '', model: s.aiModel ?? '' }
	}

	async #load(): Promise<void> {
		this.doc = await loadGuide(this.plugin.io, this.plugin.getDataRoot(), this.#bookId)
		this.loaded = true
		this.#render()
	}

	#render(): void {
		const root = this.contentEl
		root.empty()

		const head = root.createDiv('grove-guide-head')
		const icon = head.createSpan('grove-guide-icon')
		setIcon(icon, 'list-tree')
		head.createSpan('grove-guide-title').setText('AI 按章导读')
		head.createSpan('grove-guide-book').setText(this.view.bookTitle || '未命名')

		const status = root.createDiv('grove-guide-status')
		if (!this.loaded) status.setText('正在读取导读…')
		else if (!this.doc) status.setText('还没有生成导读。生成后会按章节各写 2-4 句，点其中一章可以跳回原文。')
		else {
			const when = new Date(this.doc.updatedAt || this.doc.createdAt)
				.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
			const state = this.doc.status === 'ready' ? '' : '（上次未完成）'
			status.setText(`已生成 ${this.doc.items.length} 章导读${state} · 更新于 ${when}`)
		}

		const actions = root.createDiv('grove-guide-actions')
		const resumable = this.doc?.status === 'partial' && this.doc.items.length > 0
		const build = actions.createEl('button', {
			text: this.doc ? (resumable ? '继续生成' : '重新生成') : '生成导读',
			cls: 'mod-cta',
		})
		build.disabled = this.building || !this.loaded
		build.addEventListener('click', () => void this.#build())
		if (this.doc) {
			const del = actions.createEl('button', { text: '删除导读' })
			del.disabled = this.building
			del.addEventListener('click', () => void this.#delete())
		}
		if (this.building) {
			const cancel = actions.createEl('button', { text: '取消', cls: 'mod-warning' })
			cancel.addEventListener('click', () => {
				this.buildToken++
				this.building = false
				this.progress = ''
				this.#render()
				new Notice('Grove Reader：已取消，下次点「继续生成」可接着写')
			})
		}
		this.progressEl = root.createDiv('grove-guide-progress')
		this.progressEl.setText(this.building ? this.progress || '准备中…' : '')

		if (!isAiConfigured(this.#cfg)) {
			root.createDiv('grove-guide-hint').setText(NOT_CONFIGURED)
		}

		this.listEl = root.createDiv('grove-guide-list')
		this.#renderList()
	}

	#renderList(): void {
		const list = this.listEl
		if (!list) return
		list.empty()
		if (this.building && !this.doc?.items.length) {
			list.createDiv('grove-guide-empty').setText('正在读取正文并规划章节…')
			return
		}
		if (!this.doc?.items.length) {
			if (this.loaded) list.createDiv('grove-guide-empty').setText('生成后，每一章的导读会列在这里。')
			return
		}
		for (const item of this.doc.items) {
			const row = list.createDiv('grove-guide-item')
			const top = row.createDiv('grove-guide-item-head')
			top.createSpan('grove-guide-item-label').setText(item.label || `第 ${item.index + 1} 章`)
			const jump = top.createSpan('grove-guide-item-jump')
			jump.setText('回到原文')
			row.createDiv('grove-guide-item-text').setText(item.summary || '（这一章还没生成）')
			row.addEventListener('click', () => {
				this.view.jumpTo(item.cfi, { chapter: item.label, pct: item.pct })
				this.close()
			})
		}
	}

	#updateProgress(text: string): void {
		this.progress = text
		this.progressEl?.setText(text)
	}

	async #build(): Promise<void> {
		const cfg = this.#cfg
		if (!isAiConfigured(cfg)) {
			new Notice(`Grove Reader：${NOT_CONFIGURED}`, 8000)
			return
		}
		const token = ++this.buildToken
		this.building = true
		this.#render()
		try {
			this.#updateProgress('正在读取正文…')
			const sections = await this.view.extractAiSections((done, total) => {
				if (token === this.buildToken) this.#updateProgress(`正在读取正文 ${done}/${total}`)
			})
			if (token !== this.buildToken) return
			if (!sections.length) {
				new Notice('Grove Reader：没有提取到正文文字（扫描版 PDF 可能没有文字层）')
				return
			}
			const planned = planGuideUnits(sections)
			if (!planned.length) {
				new Notice('Grove Reader：正文太短，没有可生成导读的内容')
				return
			}
			const reuse = resumableGuideItems(this.doc, planned)
			const remaining = planned.length - reuse.length
			const title = this.view.bookTitle || '未命名'
			const long = planned.filter(item => item.chars > GUIDE_TEXT_CHARS).length
			const message = reuse.length
				? `《${title}》共 ${planned.length} 章，上次已完成 ${reuse.length} 章；继续生成剩余 ${remaining} 章（约 ${remaining} 次 AI 请求，使用你自己的 API Key）。继续吗？`
				: `将为《${title}》的 ${planned.length} 章生成导读（约 ${planned.length} 次 AI 请求，使用你自己的 API Key${long ? `；其中 ${long} 章较长，只取头尾` : ''}）。继续吗？`
			const ok = await confirmAsync(this.app, message, reuse.length ? '继续生成' : '开始生成')
			if (!ok || token !== this.buildToken) return
			const now = Date.now()
			const doc: GuideDoc = reuse.length
				? {
					...this.doc!,
					bookPath: this.view.bookPath,
					title,
					updatedAt: now,
					status: 'partial',
					items: reuse.slice(),
				}
				: {
					version: 1,
					bookPath: this.view.bookPath,
					title,
					createdAt: now,
					updatedAt: now,
					status: 'partial',
					items: [],
				}
			this.doc = doc
			this.#renderList()
			for (let i = doc.items.length; i < planned.length; i++) {
				if (token !== this.buildToken) {
					doc.status = 'partial'
					doc.updatedAt = Date.now()
					await saveGuide(this.plugin.io, this.plugin.getDataRoot(), this.#bookId, doc)
					return
				}
				const unit = planned[i]
				this.#updateProgress(`正在写第 ${i + 1}/${planned.length} 章：${unit.label}`)
				const summary = await summarizeGuideSection(cfg, title, unit.label, guidePromptText(unit.text))
				doc.items.push({
					index: unit.index,
					label: unit.label,
					summary,
					chars: unit.chars,
					cfi: unit.cfi,
					pct: unit.pct,
				})
				doc.updatedAt = Date.now()
				await saveGuide(this.plugin.io, this.plugin.getDataRoot(), this.#bookId, doc)
				this.#renderList()
			}
			doc.status = 'ready'
			doc.updatedAt = Date.now()
			await saveGuide(this.plugin.io, this.plugin.getDataRoot(), this.#bookId, doc)
			new Notice(`Grove Reader：导读已生成（${doc.items.length} 章）`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			new Notice(`Grove Reader：生成导读失败（${msg}${hintFor(msg)}）`, 8000)
			if (this.doc) {
				this.doc.status = 'partial'
				this.doc.updatedAt = Date.now()
				await saveGuide(this.plugin.io, this.plugin.getDataRoot(), this.#bookId, this.doc).catch(() => undefined)
			}
		} finally {
			if (token === this.buildToken) {
				this.building = false
				this.progress = ''
				this.#render()
			}
		}
	}

	async #delete(): Promise<void> {
		if (!this.doc) return
		const ok = await confirmAsync(this.app, '删除这本书的按章导读？下次点「生成导读」会重新生成。', '删除')
		if (!ok) return
		await removeGuide(this.plugin.io, this.plugin.getDataRoot(), this.#bookId)
		this.doc = null
		this.#render()
		new Notice('Grove Reader：已删除导读')
	}
}
