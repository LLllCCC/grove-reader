import { setIcon } from 'obsidian'
import { HIGHLIGHT_COLORS } from './types'

/**
 * 批注操作菜单（TXT 与 EPUB 共用同一套外观）。
 * 用自绘 DOM 而不是 Obsidian 原生 Menu：原生菜单项只能放单色图标，
 * 没法把「色圆 + 颜色名」并排显示，用户看不出每个选项到底是什么颜色。
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
}

let currentMenu: HTMLElement | null = null
let outsideHandler: ((e: MouseEvent) => void) | null = null

export function closeAnnMenu(): void {
	if (currentMenu) {
		currentMenu.remove()
		currentMenu = null
	}
	if (outsideHandler) {
		document.removeEventListener('mousedown', outsideHandler, true)
		outsideHandler = null
	}
}

export function showAnnMenu(
	ev: { clientX: number; clientY: number },
	activeColor: string,
	actions: AnnMenuActions,
	options: { colorsLayout?: 'row' | 'column' } = {},
): void {
	closeAnnMenu()

	const menu = document.createElement('div')
	menu.className = 'grove-ann-menu'
	menu.addEventListener('mousedown', e => e.stopPropagation())

	const colors = document.createElement('div')
	colors.className = 'grove-ann-menu-colors'
	if (options.colorsLayout === 'column') colors.classList.add('is-column')
	for (const c of HIGHLIGHT_COLORS) {
		const item = document.createElement('div')
		item.className = 'grove-ann-menu-color'
		if (c.key === activeColor) item.addClass('is-active')
		item.title = `改为${c.name}色`
		const dot = document.createElement('span')
		dot.className = 'grove-ann-menu-dot'
		dot.style.backgroundColor = c.css
		const name = document.createElement('span')
		name.className = 'grove-ann-menu-color-name'
		name.textContent = c.name
		item.append(dot, name)
		item.addEventListener('click', () => {
			closeAnnMenu()
			actions.onChangeColor(c.key)
		})
		colors.appendChild(item)
	}
	menu.appendChild(colors)

	const separator = document.createElement('div')
	separator.className = 'grove-ann-menu-sep'
	menu.appendChild(separator)

	const rows: Array<{ icon: string; label: string; run: () => void }> = [
		{ icon: 'message-square', label: '编辑评论', run: actions.onEditComment },
		{ icon: 'copy', label: '复制原文', run: actions.onCopyText },
	]
	if (actions.onMakeCard) rows.push({ icon: 'image', label: '生成书摘卡', run: actions.onMakeCard })
	if (actions.onSendToCanvas) rows.push({ icon: 'layout-dashboard', label: '发送到 Canvas', run: actions.onSendToCanvas })
	rows.push({ icon: 'trash-2', label: '删除批注', run: actions.onDelete })
	for (const row of rows) {
		const item = document.createElement('div')
		item.className = 'grove-ann-menu-item'
		const icon = document.createElement('span')
		icon.className = 'grove-ann-menu-icon'
		setIcon(icon, row.icon)
		const label = document.createElement('span')
		label.className = 'grove-ann-menu-label'
		label.textContent = row.label
		item.append(icon, label)
		item.addEventListener('click', () => {
			closeAnnMenu()
			row.run()
		})
		menu.appendChild(item)
	}

	document.body.appendChild(menu)
	const rect = menu.getBoundingClientRect()
	const x = Math.min(Math.max(8, ev.clientX), Math.max(8, window.innerWidth - rect.width - 8))
	const y = Math.min(Math.max(8, ev.clientY), Math.max(8, window.innerHeight - rect.height - 8))
	menu.style.left = `${Math.round(x)}px`
	menu.style.top = `${Math.round(y)}px`

	currentMenu = menu
	outsideHandler = (e: MouseEvent): void => {
		if (currentMenu && !currentMenu.contains(e.target as Node)) closeAnnMenu()
	}
	// 延迟挂监听，避免触发本次点击的同一事件立刻关掉
	window.setTimeout(() => {
		if (outsideHandler) document.addEventListener('mousedown', outsideHandler, true)
	}, 0)
}
