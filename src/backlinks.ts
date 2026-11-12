// 引用页签：侧栏里列出「哪些笔记引了这本书」。
// 数据来自 Obsidian 的 metadataCache——笔记里每条摘录都是指向书文件的
// `[[书路径#grove-cfi=…|⤴ 回原文]]` 双链，解析回来就是「某笔记在某章引了这本书」。
// 不读笔记正文、不扫目录：resolvedLinks 一次扫描 + 命中源再查缓存，几千条笔记也是毫秒级。
import { App, LinkCache, setIcon } from 'obsidian'
import { basenameOf, compareCfi } from './util'
import { parseGroveHref } from './wikilink'
import type { GroveLinkTarget } from './wikilink'
export { filterBacklinkGroupsByCfi } from './backlinkFilter'

/** 一条引用：某笔记里的一个摘录双链 */
export interface ExcerptBacklink {
	sourcePath: string
	noteTitle: string
	link: LinkCache
	target: GroveLinkTarget
	chapter: string
}

/** 同笔记同章节的多条引用合并成一行，方便看「谁引了多少」 */
export interface ExcerptBacklinkRow {
	sourcePath: string
	noteTitle: string
	chapter: string
	count: number
	/** 该笔记在这一章里的所有链接位置，跳转用第一条 */
	links: LinkCache[]
	snippet: string
	target: GroveLinkTarget
}

export interface ExcerptBacklinkGroup {
	chapter: string
	rows: ExcerptBacklinkRow[]
}

const UNKNOWN_CHAPTER = '未指明章节'

/** 扫全库的引用：按章节分组、同笔记同章节合并，组内按 cfi 排序 */
export function collectExcerptBacklinks(app: App, bookPath: string): ExcerptBacklinkGroup[] {
	const key = bookPath.trim()
	const groups = new Map<string, Map<string, ExcerptBacklinkRow>>()
	if (!key) return []
	const resolved = app.metadataCache.resolvedLinks ?? {}
	for (const src of Object.keys(resolved)) {
		if (!src.toLowerCase().endsWith('.md')) continue
		if (!resolved[src]?.[key]) continue
		const links = app.metadataCache.getCache(src)?.links ?? []
		for (const link of links) {
			const raw = typeof link?.link === 'string' ? link.link : ''
			if (!raw.includes('grove-')) continue
			const parsed = parseGroveHref(raw)
			if (!parsed || parsed.vaultPath !== key) continue
			const chapter = parsed.target.chapter?.trim() || UNKNOWN_CHAPTER
			let byNote = groups.get(chapter)
			if (!byNote) {
				byNote = new Map()
				groups.set(chapter, byNote)
			}
			const row = byNote.get(src)
			if (row) {
				row.count++
				row.links.push(link)
			} else {
				byNote.set(src, {
					sourcePath: src,
					noteTitle: basenameOf(src).replace(/\.md$/i, ''),
					chapter,
					count: 1,
					links: [link],
					snippet: parsed.target.text ?? '',
					target: parsed.target,
				})
			}
		}
	}
	const out: ExcerptBacklinkGroup[] = []
	for (const [chapter, byNote] of groups) {
		const rows = [...byNote.values()].sort((a, b) => a.noteTitle.localeCompare(b.noteTitle, 'zh'))
		out.push({ chapter, rows })
	}
	// 章节按书内位置排（cfi 数字段比较；txt 与 epub 各自成一套，比较只发生在同本书内）
	const firstCfi = (g: ExcerptBacklinkGroup): string => {
		for (const row of g.rows) {
			for (const link of row.links) {
				const parsed = parseGroveHref(typeof link.link === 'string' ? link.link : '')
				if (parsed?.target.cfi) return parsed.target.cfi
			}
		}
		return g.rows[0]?.target.cfi ?? ''
	}
	out.sort((a, b) => {
		const ca = firstCfi(a)
		const cb = firstCfi(b)
		if (ca && cb) return compareCfi(ca, cb)
		if (a.chapter === UNKNOWN_CHAPTER) return 1
		if (b.chapter === UNKNOWN_CHAPTER) return -1
		return a.chapter.localeCompare(b.chapter, 'zh')
	})
	return out
}

export interface CitationSectionHandle {
	el: HTMLElement
	update(groups: ExcerptBacklinkGroup[], handlers: CitationHandlers): void
}

export interface CitationHandlers {
	onJump: (row: ExcerptBacklinkRow) => void
}

/**
 * 侧栏里的可折叠「引用」区：谁在引用这本书、引了哪些章。
 * 复用书签区的样式与交互（折叠状态只在内存里）。
 */
export function createCitationSection(
	parent: HTMLElement,
	opts: { startCollapsed?: boolean; title?: string; emptyText?: string } = {},
): CitationSectionHandle {
	const startCollapsed = opts.startCollapsed ?? false
	const title = opts.title ?? '引用'
	const emptyText = opts.emptyText ?? '还没有笔记引用这本书。在笔记里写一条 [[书#grove-cfi=…]] 摘录双链，这里就会列出来。'
	const el = parent.createDiv('grove-bm-section grove-cite-section')
	const head = el.createDiv('grove-bm-head')
	const chev = head.createSpan('grove-bm-chev')
	setIcon(chev, startCollapsed ? 'chevron-right' : 'chevron-down')
	head.createSpan('grove-bm-title').setText(title)
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

	const update = (groups: ExcerptBacklinkGroup[], handlers: CitationHandlers): void => {
		const noteCount = new Set(groups.flatMap(g => g.rows.map(r => r.sourcePath))).size
		count.setText(noteCount ? `${noteCount}` : '0')
		body.empty()
		if (!groups.length) {
			body.createDiv('grove-ann-empty').setText(emptyText)
			return
		}
		for (const group of groups) {
			const g = body.createDiv('grove-cite-group')
			g.createDiv('grove-cite-chapter').setText(group.chapter)
			for (const row of group.rows) {
				const item = g.createDiv('grove-bm-item')
				const main = item.createDiv('grove-bm-main')
				const label = main.createDiv('grove-bm-label')
				label.setText(row.count > 1 ? `${row.noteTitle} ×${row.count}` : row.noteTitle)
				label.addEventListener('click', () => handlers.onJump(row))
				if (row.snippet) {
					const snippet = main.createDiv('grove-bm-text')
					snippet.setText(row.snippet)
					snippet.addEventListener('click', () => handlers.onJump(row))
				}
				const actions = item.createDiv('grove-bm-actions')
				const jump = actions.createEl('button', { cls: 'clickable-icon grove-mini-btn', attr: { 'aria-label': '打开这条笔记' } })
				setIcon(jump, 'arrow-up-left')
				jump.addEventListener('click', () => handlers.onJump(row))
			}
		}
	}

	return { el, update }
}
