import { Notice, setIcon } from 'obsidian'
import { AiConfig, explainSelection, isAiConfigured } from './ai'
import { truncate } from './util'

const NOT_CONFIGURED =
	'Grove Reader：还没有配置 AI。设置 → 阅读 → AI 解释 里填入接口地址与 API Key（推荐智谱 GLM-4-Flash，免费）'

/** 常见失败给一句可执行的补救提示，不要只丢网络层错误码 */
function hintFor(message: string): string {
	if (/net::|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|Failed to fetch|ECONNREFUSED/i.test(message)) {
		return '（检查接口地址是否写错、网络是否可达）'
	}
	if (/\b401\b|\b403\b|invalid.*api.*key|unauthorized/i.test(message)) {
		return '（API Key 无效或没有该模型的权限）'
	}
	if (/\b429\b|rate limit/i.test(message)) return '（请求太频繁或额度用尽，稍后再试）'
	return ''
}

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
		if (!isAiConfigured(cfg)) {
			new Notice(NOT_CONFIGURED, 8000)
			return
		}
		this.show(text, anchor)
		try {
			this.fill(await explainSelection(cfg, text))
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			this.fill(`调用失败：${msg}${hintFor(msg)}`, true)
		}
	}

	show(sourceText: string, anchor?: DOMRect): void {
		this.hide()
		const panel = document.body.createDiv('grove-ai-panel')
		const head = panel.createDiv('grove-ai-head')
		const icon = head.createSpan('grove-ai-icon')
		setIcon(icon, 'sparkles')
		head.createSpan('grove-ai-title').setText('AI 解释')
		const close = head.createEl('button', { cls: 'grove-ai-close', attr: { 'aria-label': '关闭' } })
		setIcon(close, 'x')
		close.addEventListener('click', () => this.hide())
		panel.createDiv('grove-ai-source').setText(truncate(sourceText.replace(/\s+/g, ' '), 80))
		const body = panel.createDiv('grove-ai-body')
		body.setText('思考中…')
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
