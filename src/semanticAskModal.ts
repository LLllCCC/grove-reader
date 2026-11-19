/**
 * 跨书语义问答：把全库语义检索命中的正文段落交给聊天模型，要求按书名/章节标注出处。
 *
 * 入口在全库搜索的语义结果下方；问答本身不重新检索，材料就是用户刚看到的那批段落。
 */
import { App, Modal, Notice, setIcon } from 'obsidian'
import type GroveReaderPlugin from './main'
import { answerMultiBookQuestion, hintFor, isAiConfigured, type AiConfig, type MultiBookMaterial } from './ai'
import type { LibraryBookResult } from './librarySearch'
import { t } from './i18n'

const NOT_CONFIGURED = '还没有配置 AI。请到 设置 → 阅读 → AI 解释 填入接口地址、模型与 API Key（推荐智谱 GLM-4-Flash，免费）'
/** 一次最多交给模型多少段材料，避免 prompt 过长 */
const MAX_MATERIALS = 12

interface AskExchange {
	question: string
	answer: string
	books: string[]
}

export class SemanticAskModal extends Modal {
	private question: string
	private asking = false
	private token = 0
	private exchanges: AskExchange[] = []
	private answerEl: HTMLElement | null = null

	constructor(
		app: App,
		private plugin: GroveReaderPlugin,
		private results: LibraryBookResult[],
		initialQuestion: string,
	) {
		super(app)
		this.question = initialQuestion
	}

	onOpen(): void {
		this.modalEl.addClass('grove-ask-modal-shell')
		this.contentEl.addClass('grove-ask-modal')
		this.#render()
	}

	onClose(): void {
		this.token++
		this.modalEl.removeClass('grove-ask-modal-shell')
		this.contentEl.empty()
	}

	get #cfg(): AiConfig {
		const s = this.plugin.settings
		return { baseUrl: s.aiBaseUrl ?? '', apiKey: s.aiApiKey ?? '', model: s.aiModel ?? '' }
	}

	/** 把语义结果摊平成模型材料；同一段只取一次，最多 MAX_MATERIALS 段 */
	#materials(): MultiBookMaterial[] {
		const out: MultiBookMaterial[] = []
		const seen = new Set<string>()
		for (const book of this.results) {
			for (const hit of book.hits) {
				const preview = (hit.before || hit.fallbackText || '').replace(/\s+/g, ' ').trim()
				if (!preview) continue
				const key = `${book.bookPath}\n${preview}`
				if (seen.has(key)) continue
				seen.add(key)
				out.push({
					book: book.title,
					chapter: hit.chapter.split(' · 相似度')[0] || '',
					summary: '',
					preview,
				})
				if (out.length >= MAX_MATERIALS) return out
			}
		}
		return out
	}

	#render(): void {
		const root = this.contentEl
		root.empty()
		const materials = this.#materials()
		const bookCount = new Set(materials.map(item => item.book)).size

		const head = root.createDiv('grove-ask-head')
		const icon = head.createSpan('grove-ask-icon')
		setIcon(icon, 'sparkles')
		head.createSpan('grove-ask-title').setText(t('跨书语义问答'))
		head.createSpan('grove-ask-book').setText(`${bookCount} 本书 · ${materials.length} 段材料`)

		const status = root.createDiv('grove-ask-status')
		status.setText(materials.length
			? t('材料来自刚才的语义检索结果；回答会标注书名与章节，不会编造材料之外的内容。')
			: t('这次检索没有可用的语义段落，先换个问法或为书建立索引。'))

		const cfg = this.#cfg
		if (!isAiConfigured(cfg)) root.createDiv('grove-ask-hint').setText(t(NOT_CONFIGURED))

		const askRow = root.createDiv('grove-ask-input-row')
		const input = askRow.createEl('textarea', {
			cls: 'grove-ask-input',
			attr: { rows: '2', placeholder: t('例如：这几本书对「习惯养成」的看法有什么不同？') },
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
		const ask = askRow.createEl('button', { text: this.asking ? t('思考中…') : t('提问'), cls: 'mod-cta' })
		ask.disabled = this.asking || !materials.length || !isAiConfigured(cfg)
		ask.addEventListener('click', () => void this.#ask())

		this.answerEl = root.createDiv('grove-ask-answer')
		for (const ex of this.exchanges) {
			const block = this.answerEl.createDiv('grove-ask-turn')
			block.createDiv('grove-ask-q').setText(ex.question)
			const body = block.createDiv('grove-ask-a')
			for (const para of ex.answer.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
				body.createEl('p', { text: para })
			}
			block.createDiv('grove-ask-refs-label').setText(t('参考：{list}', { list: ex.books.join(t('、')) }))
		}
		if (this.asking) this.answerEl.createDiv('grove-ask-loading').setText(t('正在根据这些段落生成回答…'))
	}

	async #ask(): Promise<void> {
		const question = this.question.trim()
		if (!question) {
			new Notice(t('Grove Reader：先输入问题'))
			return
		}
		const cfg = this.#cfg
		if (!isAiConfigured(cfg)) {
			new Notice(t('Grove Reader：{hint}', { hint: t(NOT_CONFIGURED) }), 8000)
			return
		}
		const materials = this.#materials()
		if (!materials.length) return
		const token = ++this.token
		this.asking = true
		this.#render()
		try {
			const answer = await answerMultiBookQuestion(cfg, question, materials)
			if (token !== this.token) return
			this.exchanges.push({
				question,
				answer,
				books: [...new Set(materials.map(item => item.book))],
			})
		} catch (e) {
			if (token !== this.token) return
			const msg = e instanceof Error ? e.message : String(e)
			this.exchanges.push({
				question,
				answer: `调用失败：${msg}${hintFor(msg)}`,
				books: [...new Set(materials.map(item => item.book))],
			})
		} finally {
			if (token === this.token) {
				this.asking = false
				this.#render()
				this.answerEl?.scrollIntoView({ block: 'end' })
			}
		}
	}
}
