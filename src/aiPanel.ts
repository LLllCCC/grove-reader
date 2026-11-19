import { Notice, setIcon } from 'obsidian'
import { AiConfig, hintFor, isAiConfigured, transformSelection, type SelectionAiTask } from './ai'
import { truncate } from './util'
import { t } from './i18n'

const NOT_CONFIGURED =
	t('Grove Reader：还没有配置 AI。设置 → 阅读 → AI 解释 里填入接口地址与 API Key（推荐智谱 GLM-4-Flash，免费）')

/**
 * 划词解释浮层。EPUB / TXT 共用一套 DOM 与定位逻辑：
 * 先开面板显示「思考中」，请求回来再填内容，失败落到错误态，不会静默消失。
 */
export class AiPanel {
	private el: HTMLElement | null = null
	private closer: ((ev: MouseEvent) => void) | null = null

	constructor(private readonly onClose?: () => void) {}

	get isOpen(): boolean {
		return !!this.el
	}

	/** 调 AI 并填进浮层；未配置在调用前就提示，避免出现空面板 */
	async explain(cfg: AiConfig, text: string, anchor?: DOMRect): Promise<void> {
		await this.run(cfg, text, 'explain', anchor)
	}

	/** 解释 / 翻译 / 摘要共用一套浮层 */
	async run(cfg: AiConfig, text: string, task: SelectionAiTask, anchor?: DOMRect): Promise<void> {
		if (!isAiConfigured(cfg)) {
			new Notice(NOT_CONFIGURED, 8000)
			return
		}
		const title = task === 'translate' ? t('AI 翻译') : task === 'summarize' ? t('AI 摘要') : t('AI 解释')
		this.show(text, anchor, title)
		try {
			this.fill(await transformSelection(cfg, text, task))
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			this.fill(`调用失败：${msg}${hintFor(msg)}`, true)
		}
	}

	show(sourceText: string, anchor?: DOMRect, title = t('AI 解释')): void {
		this.hide()
		const panel = document.body.createDiv('grove-ai-panel')
		const head = panel.createDiv('grove-ai-head')
		const icon = head.createSpan('grove-ai-icon')
		setIcon(icon, 'sparkles')
		head.createSpan('grove-ai-title').setText(title)
		const close = head.createEl('button', { cls: 'grove-ai-close', attr: { 'aria-label': t('关闭') } })
		setIcon(close, 'x')
		close.addEventListener('click', () => this.hide())
		panel.createDiv('grove-ai-source').setText(truncate(sourceText.replace(/\s+/g, ' '), 80))
		const body = panel.createDiv('grove-ai-body')
		body.setText(t('思考中…'))
		body.addClass('is-loading')

		document.body.appendChild(panel)
		const size = panel.getBoundingClientRect()
		const anchorLeft = anchor ? anchor.left : window.innerWidth / 2 - size.width / 2
		const anchorTop = anchor ? anchor.bottom + 8 : 120
		const left = Math.min(Math.max(8, anchorLeft), Math.max(8, window.innerWidth - size.width - 8))
		let top = anchorTop
		if (top + size.height > window.innerHeight - 8) top = Math.max(8, (anchor?.top ?? 200) - size.height - 8)
		panel.style.left = `${Math.round(left)}px`
		panel.style.top = `${Math.round(top)}px`
		this.el = panel

		this.closer = (ev: MouseEvent): void => {
			if (this.el && !this.el.contains(ev.target as Node)) this.hide()
		}
		window.setTimeout(() => {
			if (this.closer) document.addEventListener('mousedown', this.closer, true)
		}, 0)
	}

	fill(content: string, isError = false): void {
		if (!this.el) return
		const body = this.el.querySelector('.grove-ai-body') as HTMLElement | null
		if (!body) return
		body.removeClass('is-loading')
		body.toggleClass('is-error', isError)
		body.setText(content)
	}

	hide(): void {
		if (this.closer) {
			document.removeEventListener('mousedown', this.closer, true)
			this.closer = null
		}
		if (this.el) {
			this.el.remove()
			this.el = null
			this.onClose?.()
		}
	}
}
