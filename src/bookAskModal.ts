import { App, Modal, Notice, setIcon } from 'obsidian'
import type GroveReaderPlugin from './main'
import type { ReaderView } from './readerView'
import type { PdfView } from './pdfView'
import type { TextView } from './textView'
import { answerBookQuestion, hintFor, isAiConfigured, summarizePortraitChunk, type AiConfig } from './ai'
import {
	chunkSections,
	loadPortrait,
	pickChunks,
	previewOf,
	removePortrait,
	savePortrait,
	tokenizeQuery,
	type PortraitChunk,
	type PortraitDoc,
	type SourceSection,
} from './portrait'

type AskView = ReaderView | PdfView | TextView

const NOT_CONFIGURED =
	'还没有配置 AI。请到 设置 → 阅读 → AI 解释 填入接口地址、模型与 API Key（推荐智谱 GLM-4-Flash，免费）'

function confirmAsync(app: App, message: string, okText = '继续'): Promise<boolean> {
	return new Promise(resolve => {
		const modal = new Modal(app)
		let answered = false
		modal.onOpen = (): void => {
			modal.contentEl.empty()
			modal.contentEl.createEl('h3', { text: '确认操作' })
			modal.contentEl.createEl('p', { text: message })
			const buttons = modal.contentEl.createDiv('modal-button-container')
			const ok = buttons.createEl('button', { text: okText, cls: 'mod-cta' })
			ok.addEventListener('click', () => {
				answered = true
				resolve(true)
				modal.close()
			})
			const cancel = buttons.createEl('button', { text: '取消' })
			cancel.addEventListener('click', () => {
				answered = true
				resolve(false)
				modal.close()
			})
		}
		modal.onClose = (): void => {
			if (!answered) resolve(false)
		}
		modal.open()
	})
}

/**
 * AI 全书问答（压缩要点版）：
 * 先把全书按约 6000 字切块并让 AI 各写 1-3 句要点，提问时按关键词挑出最相关的块再问。
 * 索引存在 <数据目录>/portraits/<书 id>.json，只有点「建立索引」时才会消耗 API。
 */
export class BookAskModal extends Modal {
	private portrait: PortraitDoc | null = null
	private loaded = false
	private building = false
	private asking = false
	private progress = ''
	private question = ''
	private answer = ''
	private refs: PortraitChunk[] = []
	private buildToken = 0
	private askToken = 0
	private progressEl: HTMLElement | null = null
	private answerEl: HTMLElement | null = null

	constructor(app: App, private readonly plugin: GroveReaderPlugin, private readonly view: AskView) {
		super(app)
	}

	onOpen(): void {
		this.modalEl.addClass('grove-ask-modal-shell')
		this.contentEl.addClass('grove-ask-modal')
		void this.#load()
	}

	onClose(): void {
		this.buildToken++
		this.askToken++
		this.modalEl.removeClass('grove-ask-modal-shell')
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
		this.portrait = await loadPortrait(this.plugin.io, this.plugin.getDataRoot(), this.#bookId)
		this.loaded = true
		this.#render()
	}

	#render(): void {
		const root = this.contentEl
		root.empty()

		const head = root.createDiv('grove-ask-head')
		const icon = head.createSpan('grove-ask-icon')
		setIcon(icon, 'sparkles')
		head.createSpan('grove-ask-title').setText('AI 全书问答')
		head.createSpan('grove-ask-book').setText(this.view.bookTitle || '未命名')

		const status = root.createDiv('grove-ask-status')
		if (!this.loaded) status.setText('正在读取索引…')
		else if (!this.portrait) status.setText('尚未建立索引。建立后会按约 6000 字一段生成要点，提问时先检索要点再回答。')
		else {
			const when = new Date(this.portrait.updatedAt || this.portrait.createdAt)
				.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
			const state = this.portrait.status === 'ready' ? '' : '（上次未完成）'
			status.setText(`已建立 ${this.portrait.chunks.length} 段要点${state} · 更新于 ${when}`)
		}

		const actions = root.createDiv('grove-ask-actions')
		const build = actions.createEl('button', {
			text: this.portrait ? '重建索引' : '建立索引',
			cls: 'mod-cta',
		})
		build.disabled = this.building || !this.loaded
		build.addEventListener('click', () => void this.#buildIndex())
		if (this.portrait) {
			const del = actions.createEl('button', { text: '删除索引' })
			del.disabled = this.building
			del.addEventListener('click', () => void this.#deleteIndex())
		}
		if (this.building) {
			const cancel = actions.createEl('button', { text: '取消', cls: 'mod-warning' })
			cancel.addEventListener('click', () => {
				this.buildToken++
				this.building = false
				this.progress = ''
				this.#render()
				new Notice('Grove Reader：已取消，下次可继续重建索引')
			})
		}
		this.progressEl = root.createDiv('grove-ask-progress')
		this.progressEl.setText(this.building ? this.progress || '准备中…' : '')

		if (!isAiConfigured(this.#cfg)) {
			root.createDiv('grove-ask-hint').setText(NOT_CONFIGURED)
		}

		const askRow = root.createDiv('grove-ask-input-row')
		const input = askRow.createEl('textarea', {
			cls: 'grove-ask-input',
			attr: { rows: '2', placeholder: '针对这本书提问，例如：作者的核心观点是什么？' },
		})
		input.value = this.question
		input.addEventListener('input', () => {
			this.question = input.value
		})
		input.addEventListener('keydown', ev => {
			if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
				ev.preventDefault()
				void this.#ask()
			}
		})
		const ask = askRow.createEl('button', { text: this.asking ? '思考中…' : '提问', cls: 'mod-cta' })
		ask.disabled = this.asking || this.building || !this.portrait?.chunks.length
		ask.addEventListener('click', () => void this.#ask())

		const answer = root.createDiv('grove-ask-answer')
		this.answerEl = answer
		if (this.asking) {
			answer.createDiv('grove-ask-loading').setText('正在检索要点并生成回答…')
		} else if (this.answer) {
			for (const para of this.answer.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
				answer.createEl('p', { text: para })
			}
		} else if (this.loaded && this.portrait?.chunks.length) {
			answer.createDiv('grove-ask-empty').setText('索引已就绪，输入问题后按「提问」（Ctrl+Enter 也可以）。')
		}
		if (this.refs.length && !this.asking) {
			const refs = root.createDiv('grove-ask-refs')
			refs.createSpan('grove-ask-refs-label').setText('参考')
			for (const ref of this.refs) {
				const chip = refs.createSpan('grove-ask-ref')
				chip.setText(ref.chapter || '正文')
				chip.setAttribute('title', ref.summary)
			}
		}
	}

	#updateProgress(text: string): void {
		this.progress = text
		this.progressEl?.setText(text)
	}

	async #buildIndex(): Promise<void> {
		const cfg = this.#cfg
		if (!isAiConfigured(cfg)) {
			new Notice(`Grove Reader：${NOT_CONFIGURED}`, 8000)
			return
		}
		const token = ++this.buildToken
		this.building = true
		this.answer = ''
		this.refs = []
		this.#render()
		try {
			this.#updateProgress('正在读取正文…')
			const extract = (this.view as unknown as {
				extractAiSections: (cb?: (done: number, total: number) => void) => Promise<SourceSection[]>
			}).extractAiSections
			const sections = await extract.call(this.view, (done, total) => {
				if (token === this.buildToken) this.#updateProgress(`正在读取正文 ${done}/${total}`)
			})
			if (token !== this.buildToken) return
			if (!sections.length) {
				new Notice('Grove Reader：没有提取到正文文字（扫描版 PDF 可能没有文字层）')
				return
			}
			const chunks = chunkSections(sections)
			if (!chunks.length) {
				new Notice('Grove Reader：正文太短，没有可建立索引的内容')
				return
			}
			const ok = await confirmAsync(
				this.app,
				`将为《${this.view.bookTitle || '未命名'}》建立 ${chunks.length} 段要点（约 ${chunks.length} 次 AI 请求，使用你自己的 API Key）。继续吗？`,
				'开始建立',
			)
			if (!ok || token !== this.buildToken) return
			const doc: PortraitDoc = {
				version: 1,
				bookPath: this.view.bookPath,
				title: this.view.bookTitle || '未命名',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				status: 'partial',
				chunks: [],
			}
			this.portrait = doc
			for (let i = 0; i < chunks.length; i++) {
				if (token !== this.buildToken) {
					doc.status = 'partial'
					doc.updatedAt = Date.now()
					await savePortrait(this.plugin.io, this.plugin.getDataRoot(), this.#bookId, doc)
					return
				}
				this.#updateProgress(`正在生成要点 ${i + 1}/${chunks.length}…`)
				const summary = await summarizePortraitChunk(cfg, doc.title, chunks[i].chapter, chunks[i].text)
				doc.chunks.push({
					index: i,
					chapter: chunks[i].chapter,
					summary,
					preview: previewOf(chunks[i].text),
					chars: chunks[i].text.length,
				})
				doc.updatedAt = Date.now()
				await savePortrait(this.plugin.io, this.plugin.getDataRoot(), this.#bookId, doc)
			}
			doc.status = 'ready'
			doc.updatedAt = Date.now()
			await savePortrait(this.plugin.io, this.plugin.getDataRoot(), this.#bookId, doc)
			new Notice(`Grove Reader：要点索引已建立（${doc.chunks.length} 段）`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			new Notice(`Grove Reader：建立索引失败（${msg}${hintFor(msg)}）`, 8000)
			if (this.portrait) {
				this.portrait.status = 'partial'
				this.portrait.updatedAt = Date.now()
				await savePortrait(this.plugin.io, this.plugin.getDataRoot(), this.#bookId, this.portrait).catch(() => undefined)
			}
		} finally {
			if (token === this.buildToken) {
				this.building = false
				this.progress = ''
				this.#render()
			}
		}
	}

	async #ask(): Promise<void> {
		const question = this.question.trim()
		if (!question) {
			new Notice('Grove Reader：先输入问题')
			return
		}
		if (!this.portrait?.chunks.length) {
			new Notice('Grove Reader：先建立全书要点索引')
			return
		}
		const cfg = this.#cfg
		if (!isAiConfigured(cfg)) {
			new Notice(`Grove Reader：${NOT_CONFIGURED}`, 8000)
			return
		}
		const token = ++this.askToken
		this.asking = true
		this.answer = ''
		this.refs = pickChunks(tokenizeQuery(question), this.portrait.chunks, 5)
		this.#render()
		const target = this.answerEl
		try {
			const answer = await answerBookQuestion(cfg, this.view.bookTitle || '未命名', question, this.refs)
			if (token !== this.askToken) return
			this.answer = answer
		} catch (e) {
			if (token !== this.askToken) return
			const msg = e instanceof Error ? e.message : String(e)
			this.answer = `调用失败：${msg}${hintFor(msg)}`
		} finally {
			if (token === this.askToken) {
				this.asking = false
				this.#render()
				this.answerEl?.scrollIntoView({ block: 'nearest' })
				void target
			}
		}
	}

	async #deleteIndex(): Promise<void> {
		if (!this.portrait) return
		const ok = await confirmAsync(this.app, '删除这本书的要点索引？下次提问前需要重新建立。', '删除')
		if (!ok) return
		await removePortrait(this.plugin.io, this.plugin.getDataRoot(), this.#bookId)
		this.portrait = null
		this.answer = ''
		this.refs = []
		this.#render()
		new Notice('Grove Reader：已删除要点索引')
	}
}
