// 书签：只记位置，不含原文（与划线批注分开存）。
// 三视图共用这里的构造与渲染，各自的「当前位置」「跳转」由视图自己提供。
import { setIcon } from 'obsidian'
import type { Bookmark } from './types'
import { randomId } from './util'

export interface BookmarkHandlers {
	onJump: (b: Bookmark) => void
	onDelete: (b: Bookmark) => void
}

export function makeBookmark(cfi: string, label?: string, text?: string): Bookmark {
	return {
		id: randomId(),
		cfi,
		label: label?.trim() || undefined,
		text: text?.trim().replace(/\s+/g, ' ').slice(0, 80) || undefined,
		createdAt: Date.now(),
	}
}

/** 同一位置只留一个书签：cfi 完全相同就算同一处 */
export function findBookmarkIndex(list: Bookmark[], cfi: string): number {
	return list.findIndex(b => b.cfi === cfi)
}

function formatDay(ts: number): string {
	const d = new Date(ts)
	const mm = String(d.getMonth() + 1).padStart(2, '0')
	const dd = String(d.getDate()).padStart(2, '0')
	return `${mm}-${dd}`
}

export interface BookmarkSectionHandle {
	el: HTMLElement
	/** 重新渲染列表（会更新计数与空状态） */
	update(list: Bookmark[], handlers: BookmarkHandlers): void
}

/**
 * 在侧栏里造一个可折叠的「书签」区。
 * 折叠状态只在内存里（跟着视图实例走），不写进设置——它不是需要记住的偏好。
 */
export function createBookmarkSection(parent: HTMLElement, startCollapsed = false): BookmarkSectionHandle {
	const el = parent.createDiv('grove-bm-section')
	const head = el.createDiv('grove-bm-head')
	const chev = head.createSpan('grove-bm-chev')
	setIcon(chev, startCollapsed ? 'chevron-right' : 'chevron-down')
	head.createSpan('grove-bm-title').setText('书签')
	const count = head.createSpan('grove-bm-count')
	count.setText('0')
	const body = el.createDiv('grove-bm-body')
	let collapsed = startCollapsed
	if (collapsed) body.addClass('grove-hidden')

	head.addEventListener('click', () => {
		collapsed = !collapsed
		body.toggleClass('grove-hidden', collapsed)
		setIcon(chev, collapsed ? 'chevron-right' : 'chevron-down')
	})

	const update = (list: Bookmark[], handlers: BookmarkHandlers): void => {
		count.setText(String(list.length))
		body.empty()
		if (!list.length) {
			body.createDiv('grove-ann-empty').setText('暂无书签。点工具栏的书签按钮记下当前位置。')
			return
		}
		// 新加的排前面
		for (const b of [...list].sort((x, y) => y.createdAt - x.createdAt)) {
			const item = body.createDiv('grove-bm-item')
			const main = item.createDiv('grove-bm-main')
			const label = main.createDiv('grove-bm-label')
			label.setText(b.label || '未命名位置')
			label.addEventListener('click', () => handlers.onJump(b))
			if (b.text) {
				const snippet = main.createDiv('grove-bm-text')
				snippet.setText(b.text)
				snippet.addEventListener('click', () => handlers.onJump(b))
			}
			item.createSpan('grove-bm-time').setText(formatDay(b.createdAt))
			const actions = item.createDiv('grove-bm-actions')
			const jump = actions.createEl('button', { cls: 'clickable-icon grove-mini-btn', attr: { 'aria-label': '跳到书签位置' } })
			setIcon(jump, 'arrow-up-left')
			jump.addEventListener('click', () => handlers.onJump(b))
			const del = actions.createEl('button', { cls: 'clickable-icon grove-mini-btn', attr: { 'aria-label': '删除书签' } })
			setIcon(del, 'trash-2')
			del.addEventListener('click', () => handlers.onDelete(b))
		}
	}

	return { el, update }
}
