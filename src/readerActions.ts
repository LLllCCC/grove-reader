/**
 * 阅读工具栏的共享动作区（颜色 / 评论 / 外观 / AI / 笔记 / 书签 / 批注列表）。
 *
 * EPUB/MOBI/AZW3/FB2/CBZ 的 ReaderView 与 TXT 的 TextView 原先各写一份，
 * 已经长歪过一次。这里只抽「动作按钮」，TOC/进度条/编码选择等视图特有控件
 * 仍留在各自视图里；PDF 的缩放/翻页栏也另行处理。
 */
import { setIcon } from 'obsidian'
import { createColorControls } from './colorMenu'

export interface ReaderActionHandlers {
	onColor: (color: string) => void
	onComment: () => void
	onAppearance: () => void
	onAsk: () => void
	onNote: () => void
	onBookmark: () => void
	onSidebar: () => void
}

export interface ReaderActionOptions {
	/** 是否支持文字划选；CBZ 图片书为 false */
	text: boolean
	/** 是否显示外观面板按钮 */
	appearance: boolean
	bookmark: boolean
	sidebar: boolean
}

export interface ReaderActionRefs {
	colorMenuClose: (() => void) | null
	bookmarkBtn: HTMLButtonElement | null
}

export function createReaderActions(
	toolbar: HTMLElement,
	handlers: ReaderActionHandlers,
	options: ReaderActionOptions,
): ReaderActionRefs {
	const refs: ReaderActionRefs = { colorMenuClose: null, bookmarkBtn: null }
	const iconBtn = (
		label: string,
		icon: string,
		onClick: (e: MouseEvent) => void,
		cls = 'clickable-icon grove-icon-btn',
	): HTMLButtonElement => {
		const btn = toolbar.createEl('button', { cls, attr: { 'aria-label': label } })
		setIcon(btn, icon)
		btn.addEventListener('click', onClick)
		return btn
	}

	if (options.text) {
		const colorWrap = toolbar.createSpan('grove-text-action')
		refs.colorMenuClose = createColorControls(colorWrap, handlers.onColor)
		iconBtn('为划选文字添加评论', 'message-square-plus', () => handlers.onComment(), 'clickable-icon grove-icon-btn grove-text-action')
	}

	toolbar.createDiv('grove-flex-spacer')

	if (options.text && options.appearance) {
		const btn = iconBtn('阅读外观（字体 / 背景 / 行距）', 'type', e => {
			e.stopPropagation()
			handlers.onAppearance()
		}, 'clickable-icon grove-icon-btn grove-text-action')
		btn.addClass('grove-appear-button')
	}
	if (options.text) {
		iconBtn('AI 全书问答', 'sparkles', () => handlers.onAsk(), 'clickable-icon grove-icon-btn grove-text-action')
		iconBtn('生成 / 更新阅读笔记', 'file-text', () => handlers.onNote(), 'clickable-icon grove-icon-btn grove-text-action')
	}
	if (options.bookmark) {
		refs.bookmarkBtn = iconBtn(
			'书签：标记 / 取消当前位置',
			'bookmark',
			() => handlers.onBookmark(),
			'clickable-icon grove-icon-btn grove-bookmark-btn',
		)
	}
	if (options.sidebar) {
		iconBtn('批注列表', 'list', () => handlers.onSidebar())
	}

	return refs
}
