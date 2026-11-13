import { App, Modal, Notice, setIcon } from 'obsidian'
import type GroveReaderPlugin from './main'
import { answerMultiBookQuestion, hintFor, isAiConfigured, type AiConfig } from './ai'
import { joinPath } from './platformIO'
import { loadPortrait, pickChunks, tokenizeQuery, type PortraitDoc } from './portrait'
import { basenameOf } from './util'

const NOT_CONFIGURED =
	'还没有配置 AI。请到 设置 → 阅读 → AI 解释 填入接口地址、模型与 API Key（推荐智谱 GLM-4-Flash，免费）'

interface BookEntry {
	path: string
	title: string
	doc: PortraitDoc
}

interface Exchange {
	question: string
	answer: string
	books: string[]
}

/**
 * 多书一起问：把已建立要点索引的书列出来，勾选后跨书检索并回答。
 * 材料只取每本书命中最高的 3 段，最多 12 段，避免一次请求塞太多。
 */
export class MultiBookAskModal extends Modal {
	private books: BookEntry[] = []
	private selected = new Set<string>()
	private question = ''
	private asking = false
	private loading = true
	private exchanges: Exchange[] = []
	private askToken = 0
	private listEl: HTMLElement | null = null
	private answerEl: HTMLElement | null = null

	constructor(app: App, private readonly plugin: GroveReaderPlugin) {
		super(app)
	}

	onOpen(): void {
		this.modalEl.addClass('grove-ask-modal-shell')
		this.contentEl.addClass('grove-ask-modal')
		this.contentEl.addClass('grove-multi-ask')
		void this.#load()
	}

	onClose(): void {
		this.askToken++
		this.modalEl.removeClass('grove-ask-modal-shell')
		this.contentEl.empty()
	}

	get #cfg(): AiConfig {
		const s = this.plugin.settings
		return { baseUrl: s.aiBaseUrl ?? '', apiKey: s.aiApiKey ?? '', model: s.aiModel ?? '' }
	}

	async #load(): Promise<void> {
		const root = this.plugin.getDataRoot()
		const dir = joinPath(root, 'portraits')
		try {
			const list = await this.plugin.io.list(dir)
			for (const file of list.files) {
				if (!file.endsWith('.json') || file.endsWith('.tmp')) continue
				const id = basenameOf(file).replace(/\.json$/i, '')
				const doc = await loadPortrait(this.plugin.io, root, id)
				if (!doc?.chunks.length) continue
				this.books.push({ path: doc.bookPath, title: doc.title || basenameOf(doc.bookPath), doc })
			}
		} catch {
			// 没有 portraits 目录 = 还没有任何索引
		}
		this.books.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
		this.loading = false
		this.#render()
	}

	#render(): void {
		const root = this.contentEl
		root.empty()
		const head = root.createDiv('grove-ask-head')
		const icon = head.createSpan('grove-ask-icon')
		setIcon(icon, 'library')
		head.createSpan('grove-ask-title').setText('多书一起问')
		head.createSpan('grove-ask-book').setText(this.selected.size ? `已选 ${this.selected.size} 本` : '跨书检索要点')

		const status = root.createDiv('grove-ask-status')
		if (this.loading) status.setText('正在读取各书的要点索引…')
		else if (!this.books.length) status.setText('还没有任何书建立过要点索引。先在单本「AI 全书问答」里建立索引，再回来跨书提问。')
		else status.setText(`已建立索引的书 ${this.books.length} 本；勾选后提问，答案会按书名标注出处。`)

		if (!isAiConfigured(this.#cfg)) root.createDiv('grove-ask-hint').setText(NOT_CONFIGURED)

		if (this.books.length) {
			const tools = root.createDiv('grove-ask-tools grove-multi-tools')
			const all = tools.createEl('button', { text: '全选' })
			all.addEventListener('click', () => {
				this.selected = new Set(this.books.map(b => b.path))
				this.#render()
			})
			const none = tools.createEl('button', { text: '清空选择' })
			none.addEventListener('click', () => {
				this.selected.clear()
				this.#render()
			})
			tools.createSpan('grove-ask-tools-label').setText(`共 ${this.books.length} 本可选`)
		}

		this.listEl = root.createDiv('grove-multi-books')
		for (const book of this.books) {
			const row = this.listEl.createEl('label', { cls: 'grove-multi-book' })
			const box = row.createEl('input', { type: 'checkbox' })
			box.checked = this.selected.has(book.path)
			box.addEventListener('change', () => {
				if (box.checked) this.selected.add(book.path)
				else this.selected.delete(book.path)
				// 「提问」按钮的 disabled 是渲染时按 selected.size 算的；勾选后必须重绘，
				// 否则单选一本书按钮仍是灰的（全选按钮因为自带 #render 不受影响）。
				this.#render()
			})
			row.createSpan('grove-multi-book-title').setText(book.title)
			row.createSpan('grove-multi-book-meta').setText(`${book.doc.chunks.length} 段`)
		}

		const askRow = root.createDiv('grove-ask-input-row')
		const input = askRow.createEl('textarea', {
			cls: 'grove-ask-input',
			attr: { rows: '2', placeholder: '跨书提问，例如：这几本对「习惯养成」的看法有什么不同？' },
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
		ask.disabled = this.asking || !this.selected.size
		ask.addEventListener('click', () => void this.#ask())

		this.answerEl = root.createDiv('grove-ask-answer')
		for (const ex of this.exchanges) {
			const block = this.answerEl.createDiv('grove-ask-turn')
			block.createDiv('grove-ask-q').setText(ex.question)
			const body = block.createDiv('grove-ask-a')
			for (const para of ex.answer.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
				body.createEl('p', { text: para })
			}
			block.createDiv('grove-ask-refs-label').setText(`参考：${ex.books.join('、')}`)
		}
		if (this.asking) this.answerEl.createDiv('grove-ask-loading').setText('正在跨书检索并生成回答…')
	}

	async #ask(): Promise<void> {
		const question = this.question.trim()
		if (!question) {
			new Notice('Grove Reader：先输入问题')
			return
		}
		if (!this.selected.size) {
			new Notice('Grove Reader：先勾选至少一本书')
			return
		}
		const cfg = this.#cfg
		if (!isAiConfigured(cfg)) {
			new Notice(`Grove Reader：${NOT_CONFIGURED}`, 8000)
			return
		}
		const chosen = this.books.filter(b => this.selected.has(b.path))
		const terms = tokenizeQuery(question)
		const materials = chosen.flatMap(book =>
			pickChunks(terms, book.doc.chunks, 3).map(chunk => ({
				book: book.title,
				chapter: chunk.chapter,
				summary: chunk.summary,
				preview: chunk.preview,
			})),
		).slice(0, 12)
		const token = ++this.askToken
		this.asking = true
		this.question = ''
		this.#render()
		try {
			const answer = await answerMultiBookQuestion(cfg, question, materials)
			if (token !== this.askToken) return
			this.exchanges.push({ question, answer, books: chosen.map(b => b.title) })
		} catch (e) {
			if (token !== this.askToken) return
			const msg = e instanceof Error ? e.message : String(e)
			this.exchanges.push({
				question,
				answer: `调用失败：${msg}${hintFor(msg)}`,
				books: chosen.map(b => b.title),
			})
		} finally {
			if (token === this.askToken) {
				this.asking = false
				this.#render()
				this.answerEl?.scrollIntoView({ block: 'end' })
			}
		}
	}
}
