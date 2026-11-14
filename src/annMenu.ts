import { Menu, type MenuItem } from 'obsidian'
import { HIGHLIGHT_COLORS } from './types'

/**
 * 批注操作菜单（TXT / EPUB / PDF 共用）。
 * 用 Obsidian 原生菜单，和 EPUB 现有交互保持一致：
 * 「编辑评论」「更改颜色」（色圆子菜单）「生成书摘卡」「发送到 Canvas」「复制原文」「删除批注」。
 */

export interface AnnMenuActions {
	onEditComment: () => void
	onChangeColor: (color: string) => void
	onCopyText: () => void
	onDelete: () => void
	/** 有值时才显示「发送到 Canvas」 */
	onSendToCanvas?: () => void
	/** 有值时才显示「生成书摘卡」 */
	onMakeCard?: () => void
	/** 有值时才显示「加入今日复习」 */
	onReviewToday?: () => void
	/** 已经排在今天：菜单项显示「已在今日复习」并禁用 */
	reviewScheduled?: boolean
}

export function showAnnMenu(
	position: { x: number; y: number },
	activeColor: string,
	actions: AnnMenuActions,
): void {
	const menu = new Menu()
	menu.addItem(item => item.setTitle('编辑评论').setIcon('message-square').onClick(actions.onEditComment))
	menu.addItem(item => {
		// setSubmenu 运行时存在但未包含在官方类型定义中
		const sub = (item.setTitle('更改颜色').setIcon('palette') as unknown as { setSubmenu(): Menu }).setSubmenu()
		for (const c of HIGHLIGHT_COLORS) {
			sub.addItem((ci: MenuItem) => {
				ci.setTitle(c.name).onClick(() => actions.onChangeColor(c.key))
				// 原生菜单图标只能是单色，这里直接往菜单项里塞一个彩色圆点
				const dom = (ci as unknown as { dom?: HTMLElement }).dom
				if (dom) {
					const dot = dom.createSpan({ cls: 'grove-menu-color-dot' })
					dot.style.backgroundColor = c.css
					if (c.key === activeColor) dot.addClass('is-active')
				}
			})
		}
	})
	menu.addSeparator()
	if (actions.onMakeCard) {
		menu.addItem(item => item.setTitle('生成书摘卡').setIcon('image').onClick(actions.onMakeCard!))
	}
	if (actions.onSendToCanvas) {
		menu.addItem(item => item.setTitle('发送到 Canvas').setIcon('layout-dashboard').onClick(actions.onSendToCanvas!))
	}
	if (actions.onReviewToday) {
		menu.addItem(item => {
			item.setTitle(actions.reviewScheduled ? '已在今日复习' : '加入今日复习').setIcon('repeat')
			if (actions.reviewScheduled) item.setDisabled(true)
			else item.onClick(actions.onReviewToday!)
		})
	}
	menu.addItem(item => item.setTitle('复制原文').setIcon('copy').onClick(actions.onCopyText))
	menu.addItem(item => item.setTitle('删除批注').setIcon('trash-2').onClick(actions.onDelete))
	menu.showAtPosition(position)
}
