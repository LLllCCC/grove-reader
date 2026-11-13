/**
 * 三套阅读视图共用的侧栏骨架。
 *
 * 只负责造 DOM 与接线，批注列表怎么分组/怎么画仍由各视图决定；
 * 差异用选项表达（PDF 没有颜色筛选、多一个「本页引用」等），
 * 避免再出现三份慢慢长歪的侧栏。
 */
import { setIcon } from 'obsidian'
import { createCitationSection, type CitationSectionHandle } from '../backlinks'
import { createBookmarkSection, type BookmarkSectionHandle } from '../bookmarks'
import { HIGHLIGHT_COLORS } from '../types'

export interface ReaderSidebarHooks {
	onAddBookmark: () => void
	onSearch: (query: string) => void
	onColorFilter?: (key: string) => void
	onClearFilters?: () => void
	onToggleSort: () => void
	/** 只有配置了 collapseAll 的视图需要 */
	onToggleCollapseAll?: () => void
	onToggleMultiSelect: () => void
	onDeleteSelected: () => void
	onCancelSelect: () => void
	onRunFullTextSearch: () => void
	onClearFullTextSearch: () => void
}

export interface ReaderSidebarOptions {
	/** 初始收起：TXT 默认收起；PDF 只在手机端收起，把宽度让给页面 */
	startHidden?: boolean
	/** 是否显示颜色筛选点（PDF 不显示） */
	colorFilter?: boolean
	/** 是否显示「折叠全部」（只有 EPUB 支持） */
	collapseAll?: boolean
	searchPlaceholder: string
	sortLabels: { position: string; recent: string }
	/** 多选条放在筛选控件区内（EPUB/TXT）；PDF 直接挂在侧栏下 */
	selectBarInControls?: boolean
	fullTextResultsClass?: string
	/** 额外插在「引用」之上的引用区（PDF 的「本页引用」） */
	extraCitation?: { title: string; emptyText: string; startCollapsed?: boolean }
	hooks: ReaderSidebarHooks
}

export interface ReaderSidebar {
	el: HTMLElement
	bookmark: BookmarkSectionHandle
	citation: CitationSectionHandle
	pageCitation: CitationSectionHandle | null
	fullTextSearchEl: HTMLDetailsElement
	fullTextInput: HTMLInputElement
	fullTextStatus: HTMLElement
	fullTextResults: HTMLElement
	searchInput: HTMLInputElement
	filterDots: Map<string, HTMLElement>
	clearFilterBtn: HTMLButtonElement | null
	sortBtn: HTMLButtonElement
	collapseAllBtn: HTMLButtonElement | null
	selectBarEl: HTMLElement
	selectCountEl: HTMLElement
	listEl: HTMLElement
	/** 切到某个页签；同一时间只显示这一组内容 */
	activateTab(tab: SidebarTab): void
	/** 同步计数/清除按钮/筛选点的高亮 */
	syncFilters(query: string, color: string | null, total: number, filtered: number): void
	/** 同步排序按钮文案 */
	syncSort(mode: 'position' | 'recent'): void
}

/** 侧栏页签：书签 / 引用 / 全文搜索 / 批注 */
export type SidebarTab = 'bookmarks' | 'citations' | 'search' | 'annotations'

export function createReaderSidebar(parent: HTMLElement, options: ReaderSidebarOptions): ReaderSidebar {
	const { hooks } = options
	const el = parent.createDiv(options.startHidden ? 'grove-sidebar grove-hidden' : 'grove-sidebar')
	// 默认显示批注页签，保持「打开侧栏就看到批注」的原有行为
	el.dataset.tab = 'annotations'
	// 批注数量做成「批注」页签上的圈数字，和其他页签的计数样式一致
	let annCountEl: HTMLElement | null = null

	// 书签区放在批注区之上：它是导航，不该被下面的搜索/筛选挡住
	const bookmark = createBookmarkSection(el, { onAdd: hooks.onAddBookmark })
	const pageCitation = options.extraCitation
		? createCitationSection(el, options.extraCitation)
		: null
	const citation = createCitationSection(el)

	// 全文搜索：三视图同一套 DOM/CSS，收起时不占空间
	const fullTextSearchEl = el.createEl('details', { cls: 'grove-fulltext-search' })
	fullTextSearchEl.createEl('summary', { text: '全文搜索' })
	const fullTextControls = fullTextSearchEl.createDiv('grove-fulltext-search-controls')
	const fullTextInput = fullTextControls.createEl('input', {
		cls: 'grove-ann-search',
		attr: { type: 'search', placeholder: '输入关键词，按 Enter 搜索全书…' },
	})
	fullTextInput.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			e.preventDefault()
			hooks.onRunFullTextSearch()
		} else if (e.key === 'Escape') {
			hooks.onClearFullTextSearch()
		}
	})
	const fullTextMeta = fullTextSearchEl.createDiv('grove-fulltext-search-meta')
	const fullTextStatus = fullTextMeta.createSpan('grove-fulltext-search-status')
	fullTextStatus.setText('输入关键词后按 Enter 搜索全书')
	const clearFullText = fullTextMeta.createEl('button', {
		cls: 'grove-manage-btn',
		text: '清除',
		attr: { 'aria-label': '清除全文搜索' },
	})
	clearFullText.addEventListener('click', () => hooks.onClearFullTextSearch())
	const fullTextResults = fullTextSearchEl.createDiv(
		options.fullTextResultsClass
			? `grove-fulltext-search-results ${options.fullTextResultsClass}`
			: 'grove-fulltext-search-results',
	)

	const controls = el.createDiv('grove-sidebar-controls')
	const searchInput = controls.createEl('input', {
		cls: 'grove-ann-search',
		attr: { type: 'search', placeholder: options.searchPlaceholder },
	})
	searchInput.addEventListener('input', () => hooks.onSearch(searchInput.value.trim()))

	const filterDots = new Map<string, HTMLElement>()
	let clearFilterBtn: HTMLButtonElement | null = null
	if (options.colorFilter) {
		const filterRow = controls.createDiv('grove-ann-filters')
		for (const c of HIGHLIGHT_COLORS) {
			const dot = filterRow.createEl('button', {
				cls: 'grove-filter-dot',
				attr: { 'aria-label': `只看${c.name}色批注`, title: `只看${c.name}色` },
			})
			dot.style.backgroundColor = c.css
			dot.addEventListener('click', () => hooks.onColorFilter?.(c.key))
			filterDots.set(c.key, dot)
		}
		clearFilterBtn = filterRow.createEl('button', { cls: 'grove-filter-clear grove-hidden', text: '清除筛选' })
		clearFilterBtn.addEventListener('click', () => {
			searchInput.value = ''
			hooks.onClearFilters?.()
		})
	}

	const manageRow = controls.createDiv('grove-ann-filters')
	const sortBtn = manageRow.createEl('button', { cls: 'grove-manage-btn', text: options.sortLabels.position })
	sortBtn.addEventListener('click', () => hooks.onToggleSort())
	const collapseAllBtn = options.collapseAll
		? manageRow.createEl('button', { cls: 'grove-manage-btn', text: '折叠全部' })
		: null
	collapseAllBtn?.addEventListener('click', () => hooks.onToggleCollapseAll?.())
	const multiBtn = manageRow.createEl('button', { cls: 'grove-manage-btn', text: '多选' })
	multiBtn.addEventListener('click', () => hooks.onToggleMultiSelect())

	const selectBarEl = (options.selectBarInControls === false ? el : controls).createDiv('grove-select-bar grove-hidden')
	const selectCountEl = selectBarEl.createSpan('grove-select-count')
	selectCountEl.setText('已选 0 条')
	const delBtn = selectBarEl.createEl('button', { text: '删除所选', cls: 'grove-select-delete' })
	delBtn.addEventListener('click', () => hooks.onDeleteSelected())
	const cancelBtn = selectBarEl.createEl('button', { text: '取消', cls: 'grove-select-cancel' })
	cancelBtn.addEventListener('click', () => hooks.onCancelSelect())

	const listEl = el.createDiv('grove-ann-list')

	const syncFilters = (query: string, color: string | null, total: number, filtered: number): void => {
		const filtering = !!query || !!color
		if (annCountEl) {
			annCountEl.setText(String(filtering ? filtered : total))
			annCountEl.title = filtering ? `符合条件 ${filtered} / 共 ${total} 个批注` : `共 ${total} 个批注`
		}
		clearFilterBtn?.toggleClass('grove-hidden', !filtering)
		for (const [key, dot] of filterDots) dot.toggleClass('is-active', color === key)
	}

	const syncSort = (mode: 'position' | 'recent'): void => {
		sortBtn.setText(mode === 'position' ? options.sortLabels.position : options.sortLabels.recent)
	}

	// ---- 页签：书签 / 引用 / 全文搜索 / 批注 ----
	// 四组内容仍按原顺序直接挂在侧栏下，用 data-tab + CSS 控制显隐，
	// 这样列表的 flex 滚动、手机抽屉和已有的折叠逻辑都不用改。
	let currentTab: SidebarTab = 'annotations'
	const activateTab = (tab: SidebarTab): void => {
		currentTab = tab
		el.dataset.tab = tab
		for (const [key, btn] of tabButtons) btn.toggleClass('is-active', key === tab)
		// 从命令面板直接搜全书时，用户期望看到搜索框而不是折叠的 summary
		if (tab === 'search') fullTextSearchEl.open = true
	}
	const tabsEl = el.createDiv('grove-sidebar-tabs')
	const tabButtons = new Map<SidebarTab, HTMLButtonElement>()
	const tabDefs: Array<[SidebarTab, string]> = [
		['bookmarks', '书签'],
		['citations', '引用'],
		['search', '全文搜索'],
		['annotations', '批注'],
	]
	for (const [key, label] of tabDefs) {
		const btn = tabsEl.createEl('button', {
			cls: 'grove-sidebar-tab',
			attr: { 'aria-label': `显示${label}` },
		})
		btn.createSpan({ text: label })
		if (key === 'annotations') {
			annCountEl = btn.createSpan('grove-sidebar-tab-count')
			annCountEl.setText('0')
		}
		btn.addEventListener('click', () => activateTab(key))
		tabButtons.set(key, btn)
	}
	const closeSidebar = tabsEl.createEl('button', {
		cls: 'clickable-icon grove-sidebar-close',
		attr: { 'aria-label': '关闭批注栏', title: '关闭批注栏' },
	})
	setIcon(closeSidebar, 'x')
	closeSidebar.addEventListener('click', () => el.addClass('grove-hidden'))
	el.insertBefore(tabsEl, bookmark.el)
	activateTab(currentTab)

	return {
		el,
		bookmark,
		citation,
		pageCitation,
		fullTextSearchEl,
		fullTextInput,
		fullTextStatus,
		fullTextResults,
		searchInput,
		filterDots,
		clearFilterBtn,
		sortBtn,
		collapseAllBtn,
		selectBarEl,
		selectCountEl,
		listEl,
		activateTab,
		syncFilters,
		syncSort,
	}
}
