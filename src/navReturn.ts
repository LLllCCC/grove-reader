// 跳转后的「返回原位置」胶囊：三个视图共用。
// 只在"明确跳转"（目录、批注、搜索命中、笔记回跳）时调用，
// 翻页/滚动不调用——否则每翻一页都挂一条提示。
import { setIcon } from 'obsidian'

export interface JumpReturnOptions {
	/** 起点章节名之类的短标签，没有就显示「已跳转」 */
	label?: string
	/** 点「返回」时执行 */
	back: () => void
}

/**
 * 每个视图持有一个实例（不要用模块级单例：同时开两本书会互相顶掉）。
 * host 用函数是因为视图重建 DOM 后胶囊要挂到新的宿主上。
 */
export class JumpReturnBar {
	private el: HTMLElement | null = null

	constructor(private readonly host: () => HTMLElement | null) {}

	show(options: JumpReturnOptions): void {
		this.hide()
		const host = this.host()
		if (!host) return
		const bar = host.createDiv('grove-jump-return')
		const icon = bar.createSpan('grove-jump-return-icon')
		setIcon(icon, 'corner-up-left')
		const label = options.label?.trim()
		bar.createSpan('grove-jump-return-text').setText(label ? `从「${label}」跳过来` : '已跳转')
		const back = bar.createEl('button', { cls: 'grove-jump-return-btn', text: '返回' })
		back.addEventListener('click', () => {
			this.hide()
			options.back()
		})
		const close = bar.createEl('button', { cls: 'grove-jump-return-close' })
		setIcon(close, 'x')
		close.addEventListener('click', () => this.hide())
		this.el = bar
	}

	hide(): void {
		this.el?.remove()
		this.el = null
	}

	get visible(): boolean {
		return this.el !== null
	}
}
