/**
 * 阅读工具栏的共享动作区（颜色 / 评论 / 外观 / AI / 笔记 / 书签 / 批注列表）。
 *
 * EPUB/MOBI/AZW3/FB2/CBZ 的 ReaderView 与 TXT 的 TextView 原先各写一份，
 * 已经长歪过一次。这里只抽「动作按钮」，TOC/进度条/编码选择等视图特有控件
 * 仍留在各自视图里；PDF 的缩放/翻页栏也另行处理。
 *
 * 按钮可切「图标 / 文字」两种形态（设置 → 阅读 → 工具栏样式）。
 */
import { setIcon } from 'obsidian'
import { createColorControls } from './colorMenu'
import { normalizeToolbarOrder } from './types'

export interface ReaderActionHandlers {
	onColor: (color: string) => void
	onComment: () => void
	/** 手机端划词 AI（解释 / 翻译 / 摘要）；桌面走划选弹条，不传 */
	onSelectionAi?: (anchor: HTMLElement) => void
	onAppearance: () => void
	onAsk: () => void
	onGuide: () => void
	onNote: () => void
	onBookmark: () => void
	onSidebar: () => void
}

export interface ReaderActionOptions {
	/** 是否支持文字划选；CBZ 图片书为 false */
	text: boolean
	/** 是否显示「AI 解释/翻译/摘要」按钮（手机端划选弹条被隐藏时用） */
	selectionAi?: boolean
	/** 是否显示外观面板按钮 */
	appearance: boolean
	bookmark: boolean
	sidebar: boolean
	/** 图标按钮或文字按钮 */
	style?: 'icon' | 'text'
	/** 手机颜色菜单的默认色 key */
	defaultColor?: string
	/** 需要隐藏的动作（中文短名） */
	hidden?: string[]
	/** 动作按钮顺序（中文短名）；不传＝默认顺序 */
	order?: string[]
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
	const textMode = options.style === 'text'
	const hidden = new Set(options.hidden ?? [])
	const actionBtn = (
		label: string,
		icon: string,
		short: string,
		onClick: (e: MouseEvent) => void,
		cls = 'clickable-icon grove-icon-btn',
	): HTMLButtonElement => {
		const btn = toolbar.createEl('button', {
			cls: textMode ? `${cls} grove-text-btn` : cls,
			attr: { 'aria-label': label, title: label },
		})
		if (textMode) btn.setText(short)
		else setIcon(btn, icon)
		btn.addEventListener('click', onClick)
		return btn
	}

	if (options.text) {
		const colorWrap = toolbar.createSpan('grove-text-action')
		refs.colorMenuClose = createColorControls(colorWrap, handlers.onColor, options.defaultColor)
		if (!hidden.has('评论')) {
			actionBtn('为划选文字添加评论', 'message-square-plus', '评论', () => handlers.onComment(), 'clickable-icon grove-icon-btn grove-text-action')
		}
		if (options.selectionAi && handlers.onSelectionAi) {
			actionBtn('AI 解释 / 翻译 / 摘要（先划选一段文字）', 'languages', 'AI', e => {
				e.stopPropagation()
				handlers.onSelectionAi?.(e.currentTarget as HTMLElement)
			}, 'clickable-icon grove-icon-btn grove-text-action')
		}
	}

	toolbar.createDiv('grove-flex-spacer')

	const specs: Record<string, { enabled: boolean; render: () => void }> = {
		外观: {
			enabled: options.text && options.appearance,
			render: () => {
				const btn = actionBtn('阅读外观（字体 / 背景 / 行距）', 'type', '外观', e => {
					e.stopPropagation()
					handlers.onAppearance()
				}, 'clickable-icon grove-icon-btn grove-text-action')
				btn.addClass('grove-appear-button')
			},
		},
		'AI 问答': {
			enabled: options.text,
			render: () => actionBtn('AI 全书问答', 'sparkles', 'AI 问答', () => handlers.onAsk(), 'clickable-icon grove-icon-btn grove-text-action'),
		},
		导读: {
			enabled: options.text,
			render: () => actionBtn('AI 按章导读', 'list-tree', '导读', () => handlers.onGuide(), 'clickable-icon grove-icon-btn grove-text-action'),
		},
		笔记: {
			enabled: options.text,
			render: () => actionBtn('生成 / 更新阅读笔记', 'file-text', '笔记', () => handlers.onNote(), 'clickable-icon grove-icon-btn grove-text-action'),
		},
		书签: {
			enabled: options.bookmark,
			render: () => {
				refs.bookmarkBtn = actionBtn(
					'书签：标记 / 取消当前位置',
					'bookmark',
					'书签',
					() => handlers.onBookmark(),
					'clickable-icon grove-icon-btn grove-bookmark-btn',
				)
			},
		},
		批注: {
			enabled: options.sidebar,
			render: () => actionBtn('批注列表', 'list', '批注', () => handlers.onSidebar()),
		},
	}

	for (const name of normalizeToolbarOrder(options.order)) {
		const spec = specs[name]
		if (!spec?.enabled || hidden.has(name)) continue
		spec.render()
	}

	return refs
}
