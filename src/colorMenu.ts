/**
 * 工具栏的高亮颜色入口。
 *
 * 桌面：保持 5 个色点，一眼可见、单击即用。
 * 手机：工具栏 44px 单行本身已经要靠横滑，5 个色点占掉约 120px；
 *       收成一个「高亮」按钮，点开后再选色。划选弹条里也有一份颜色，
 *       这里只是保留一条常驻的备用入口。
 */
import { Platform, setIcon } from 'obsidian'
import { HIGHLIGHT_COLORS } from './types'
import { t } from './i18n'

/**
 * 在工具栏里创建颜色入口。
 * 返回关闭弹层的清理函数（视图 onClose 时调用，避免游离节点留在 body 上）。
 */
export function createColorControls(
	parent: HTMLElement,
	onPick: (color: string) => void,
	defaultKey?: string,
): () => void {
	const noop = (): void => undefined
	if (!Platform.isMobile) {
		for (const c of HIGHLIGHT_COLORS) {
			const dot = parent.createEl('button', {
				cls: 'clickable-icon grove-color-dot',
				attr: { 'aria-label': t("高亮（{p0}）", { p0: c.name }) },
			})
			dot.style.backgroundColor = c.css
			dot.addEventListener('click', () => onPick(c.key))
		}
		return noop
	}

	const btn = parent.createEl('button', {
		cls: 'clickable-icon grove-icon-btn grove-color-menu-btn',
		attr: { 'aria-label': '选择高亮颜色' },
	})
	setIcon(btn, 'palette')

	let menu: HTMLElement | null = null
	const close = (): void => {
		menu?.remove()
		menu = null
		document.removeEventListener('pointerdown', outside, true)
	}
	const outside = (e: PointerEvent): void => {
		if (!menu) return
		const t = e.target
		if (t instanceof Node && (menu.contains(t) || btn.contains(t))) return
		close()
	}

	btn.addEventListener('click', e => {
		e.stopPropagation()
		if (menu) {
			close()
			return
		}
		const rect = btn.getBoundingClientRect()
		menu = document.body.createDiv('grove-color-menu')
		// 工具栏在 overflow 容器里，弹层必须挂 body；左右夹一下别出屏
		menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - HIGHLIGHT_COLORS.length * 32 - 24))}px`
		menu.style.top = `${rect.bottom + 6}px`
		// 默认色一键直达，其余颜色仍列在下面
		const fallback = HIGHLIGHT_COLORS.find(c => c.key === defaultKey) ?? HIGHLIGHT_COLORS[0]
		const quick = menu.createEl('button', { cls: 'grove-color-default' })
		quick.setText(`默认 · ${fallback.name}`)
		quick.style.setProperty('--grove-color-default', fallback.css)
		quick.addEventListener('click', ev => {
			ev.stopPropagation()
			close()
			onPick(fallback.key)
		})
		for (const c of HIGHLIGHT_COLORS) {
			const dot = menu.createEl('button', { cls: 'grove-color-dot', attr: { 'aria-label': t("高亮（{p0}）", { p0: c.name }) } })
			dot.style.backgroundColor = c.css
			dot.addEventListener('click', ev => {
				ev.stopPropagation()
				close()
				onPick(c.key)
			})
		}
		window.setTimeout(() => document.addEventListener('pointerdown', outside, true), 0)
	})

	return close
}
