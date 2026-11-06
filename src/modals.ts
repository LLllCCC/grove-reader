import { App, AbstractInputSuggest, FuzzySuggestModal, Modal, Notice, TFile, TFolder } from 'obsidian'
import { colorName, isShelfExt } from './types'
import { colorDot, normalizeTerms, searchDocs } from './search'
import type { SearchDoc } from './search'
import type { BookList } from './lists'
import { todayKey } from './stats'
import type GroveReaderPlugin from './main'
import { basenameOf, cleanBookTitle } from './util'
import type { OpEntry } from './oplog'
import type { HealthReport } from './health'
import type { SyncChange, SyncPlan } from './noteSync'

export class BookPickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onPick: (file: TFile) => void) {
		super(app)
		this.setPlaceholder('选择要阅读的电子书或 PDF…')
	}

	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter(f => isShelfExt(f.extension))
	}

	getItemText(file: TFile): string {
		return file.path
	}

	onChooseItem(file: TFile): void {
		this.onPick(file)
	}
}

export class CommentModal extends Modal {
	constructor(
		app: App,
		private value: string,
		private onSave: (note: string) => void,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: '批注评论' })
		const textarea = this.contentEl.createEl('textarea', { cls: 'grove-comment-input' })
		textarea.value = this.value
		textarea.placeholder = '写下你的想法…（Ctrl+Enter 保存，留空保存即清除评论）'
		const buttons = this.contentEl.createDiv('modal-button-container')
		const save = () => {
			this.onSave(textarea.value.trim())
			this.close()
		}
		const ok = buttons.createEl('button', { text: '保存', cls: 'mod-cta' })
		ok.addEventListener('click', save)
		const cancel = buttons.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
		textarea.addEventListener('keydown', e => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
				e.preventDefault()
				save()
			}
		})
		window.setTimeout(() => textarea.focus(), 50)
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private message: string,
		private onConfirm: () => void,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: '确认操作' })
		this.contentEl.createEl('p', { text: this.message })
		const buttons = this.contentEl.createDiv('modal-button-container')
		const ok = buttons.createEl('button', { text: '删除', cls: 'mod-warning' })
		ok.addEventListener('click', () => {
			this.onConfirm()
			this.close()
		})
		const cancel = buttons.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

// ------------------------------------------------------------------
// 书单
// ------------------------------------------------------------------

const NEW_LIST_OPTION: BookList = { id: '__grove_new__', name: '新建书单…' }
const NO_LIST_OPTION: BookList = { id: '__grove_none__', name: '移出书单（回到未分类）' }

/** 选择要把一本书移入哪个书单；回调参数 'new' 表示新建、null 表示移出 */
export class ListPickerModal extends FuzzySuggestModal<BookList> {
	constructor(app: App, private lists: BookList[], private onPick: (list: BookList | null | 'new') => void) {
		super(app)
		this.setPlaceholder('选择书单…')
	}

	getItems(): BookList[] {
		return [NEW_LIST_OPTION, NO_LIST_OPTION, ...this.lists]
	}

	getItemText(list: BookList): string {
		return list.name
	}

	onChooseItem(list: BookList): void {
		if (list.id === NEW_LIST_OPTION.id) this.onPick('new')
		else if (list.id === NO_LIST_OPTION.id) this.onPick(null)
		else this.onPick(list)
	}
}

export interface BookInfoValues {
	title: string
	author: string
	publisher: string
}

/** 手动编辑书名/作者/出版社（元数据缺失或解析不准时的兜底） */
export class BookInfoModal extends Modal {
	constructor(
		app: App,
		private values: BookInfoValues,
		private onSave: (values: BookInfoValues) => void,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: '编辑书籍信息' })
		const mk = (label: string, key: keyof BookInfoValues): HTMLInputElement => {
			this.contentEl.createEl('div', { text: label, cls: 'grove-info-label' })
			const input = this.contentEl.createEl('input', { type: 'text', cls: 'grove-folder-input' })
			input.value = this.values[key]
			return input
		}
		const title = mk('书名', 'title')
		const author = mk('作者', 'author')
		const publisher = mk('出版社', 'publisher')
		const buttons = this.contentEl.createDiv('modal-button-container')
		const ok = buttons.createEl('button', { text: '保存', cls: 'mod-cta' })
		ok.addEventListener('click', () => {
			this.onSave({ title: title.value.trim(), author: author.value.trim(), publisher: publisher.value.trim() })
			this.close()
		})
		const cancel = buttons.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
		window.setTimeout(() => {
			title.focus()
			title.select()
		}, 50)
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export class CoverUrlModal extends Modal {
	constructor(
		app: App,
		private onSubmit: (url: string) => Promise<void>,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: '用图片链接更换封面' })
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: '粘贴图片直链（http / https），支持 jpg、png、webp、gif，建议使用 2:3 的竖图。',
		})
		const input = this.contentEl.createEl('input', {
			type: 'url',
			cls: 'grove-cover-url-input',
			attr: { placeholder: 'https://example.com/cover.jpg' },
		})
		const status = this.contentEl.createDiv('grove-cover-url-status')
		const buttons = this.contentEl.createDiv('modal-button-container')
		const cancel = buttons.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
		const ok = buttons.createEl('button', { text: '下载并设为封面', cls: 'mod-cta' })
		const submit = async (): Promise<void> => {
			const url = input.value.trim()
			if (!/^https?:\/\//i.test(url)) {
				status.setText('请填写以 http:// 或 https:// 开头的图片链接')
				return
			}
			ok.disabled = true
			ok.setText('下载中…')
			status.setText('')
			try {
				await this.onSubmit(url)
				this.close()
			} catch (e) {
				status.setText(e instanceof Error ? e.message : String(e))
				ok.disabled = false
				ok.setText('下载并设为封面')
			}
		}
		ok.addEventListener('click', () => void submit())
		input.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault()
				void submit()
			}
		})
		window.setTimeout(() => input.focus(), 50)
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export class DeleteBookModal extends Modal {
	constructor(
		app: App,
		private bookTitle: string,
		private annotationCount: number,
		private noteName: string | undefined,
		private onConfirm: (deleteFile: boolean, deleteNote: boolean) => Promise<void> | void,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: '删除书籍' })
		this.contentEl.createEl('p', { text: `《${this.bookTitle}》` })
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `这本书有 ${this.annotationCount} 条批注。勾选删除原文件时，书籍、阅读数据（批注、阅读位置、书单归属）会一起移入插件回收站；只移出书架则全部保留。`,
		})
		const row = this.contentEl.createDiv('grove-delete-check')
		const checkbox = row.createEl('input', { type: 'checkbox' })
		checkbox.id = 'grove-delete-file'
		const label = row.createEl('label', { text: '同时删除原文件（移入插件回收站，30 天后清理）' })
		label.setAttr('for', 'grove-delete-file')

		const noteRow = this.contentEl.createDiv('grove-delete-check')
		const noteBox = noteRow.createEl('input', { type: 'checkbox' })
		noteBox.id = 'grove-delete-note'
		noteBox.disabled = !this.noteName
		const noteLabel = noteRow.createEl('label', {
			text: this.noteName ? `同时把生成的阅读笔记移入回收站（${this.noteName}）` : '这本书还没有生成阅读笔记',
		})
		noteLabel.setAttr('for', 'grove-delete-note')

		// 选项联动：删笔记必然要删原文件；取消删原文件时，笔记选项一并取消
		checkbox.addEventListener('change', () => {
			if (!checkbox.checked) noteBox.checked = false
		})
		noteBox.addEventListener('change', () => {
			if (noteBox.checked) checkbox.checked = true
		})

		const hint = this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: '勾选删除阅读笔记会自动勾选删除原文件；取消删除原文件会同时取消笔记。删除后可在 设置 → 回收站 恢复，30 天后自动清理。',
		})
		hint.addClass('grove-delete-hint')

		const buttons = this.contentEl.createDiv('modal-button-container')
		const cancel = buttons.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
		const ok = buttons.createEl('button', { text: '删除', cls: 'mod-warning' })
		ok.addEventListener('click', () => {
			void (async () => {
				ok.disabled = true
				ok.setText('删除中…')
				try {
					await this.onConfirm(checkbox.checked, noteBox.checked && !!this.noteName)
					this.close()
				} catch (e) {
					ok.disabled = false
					ok.setText('删除')
					new Notice(e instanceof Error ? e.message : String(e))
				}
			})()
		})
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export class DangerConfirmModal extends Modal {
	constructor(
		app: App,
		private titleText: string,
		private message: string,
		private word: string,
		private onConfirm: () => void,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: this.titleText })
		this.contentEl.createEl('p', { text: this.message })
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `此操作不可在插件内撤销。请输入「${this.word}」以确认。`,
		})
		const input = this.contentEl.createEl('input', { type: 'text', cls: 'grove-folder-input' })
		input.placeholder = this.word
		const buttons = this.contentEl.createDiv('modal-button-container')
		const cancel = buttons.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
		const ok = buttons.createEl('button', { text: '确认清空', cls: 'mod-warning' })
		ok.disabled = true
		input.addEventListener('input', () => {
			ok.disabled = input.value.trim() !== this.word
		})
		input.addEventListener('keydown', e => {
			if (e.key === 'Enter' && !ok.disabled) {
				e.preventDefault()
				this.onConfirm()
				this.close()
			}
		})
		ok.addEventListener('click', () => {
			this.onConfirm()
			this.close()
		})
		window.setTimeout(() => input.focus(), 50)
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export class TextPromptModal extends Modal {
	constructor(
		app: App,
		private titleText: string,
		private placeholder: string,
		private initial: string,
		private onSubmit: (value: string) => void,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: this.titleText })
		const input = this.contentEl.createEl('input', { type: 'text', cls: 'grove-folder-input' })
		input.placeholder = this.placeholder
		input.value = this.initial
		const submit = () => {
			const v = input.value.trim()
			if (!v) {
				new Notice('名称不能为空')
				return
			}
			this.onSubmit(v)
			this.close()
		}
		input.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault()
				submit()
			}
		})
		const buttons = this.contentEl.createDiv('modal-button-container')
		const ok = buttons.createEl('button', { text: '确定', cls: 'mod-cta' })
		ok.addEventListener('click', submit)
		const cancel = buttons.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
		window.setTimeout(() => {
			input.focus()
			input.select()
		}, 50)
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		input: HTMLInputElement | HTMLDivElement,
		private onPicked?: (path: string) => void,
	) {
		super(app, input)
	}

	getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase().replace(/[\\/]+$/, '')
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path !== '/')
			.filter(f => !q || f.path.toLowerCase().includes(q))
			.slice(0, 50)
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path)
	}

	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path)
		// AbstractInputSuggest.setValue 不触发 input/change 事件，需手动通知调用方保存
		this.onPicked?.(folder.path)
		this.close()
	}
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)} 秒`
	if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`
	return `${(seconds / 3600).toFixed(1)} 小时`
}

function formatLastRead(ts: number): string {
	if (!ts) return '—'
	const days = Math.floor((Date.now() - ts) / 86_400_000)
	if (days <= 0) return '今天'
	if (days === 1) return '昨天'
	if (days < 30) return `${days} 天前`
	return new Date(ts).toLocaleDateString('zh-CN')
}

/** 阅读/翻页累计统计：按书 + 最近 14 天 */
export class ReadingStatsModal extends Modal {
	constructor(
		app: App,
		private plugin: GroveReaderPlugin,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.modalEl.addClass('grove-stats-modal')
		this.contentEl.createEl('h3', { text: '阅读统计' })
		const stats = this.plugin.stats
		const books = stats.sortedBooks()
		const today = todayKey()
		const todaySec = stats.dailyTotals().get(today)?.seconds ?? 0
		const totalSec = books.reduce((sum, [, b]) => sum + b.seconds, 0)
		const streak = stats.streak()
		const goalMin = Math.max(0, this.plugin.settings.dailyGoalMinutes || 0)
		const goalSec = goalMin * 60

		const summary = this.contentEl.createDiv('grove-stats-summary')
		const card = (label: string, value: string, sub: string): HTMLElement => {
			const el = summary.createDiv('grove-stats-card')
			el.createDiv('grove-stats-card-label').setText(label)
			el.createDiv('grove-stats-card-value').setText(value)
			el.createDiv('grove-stats-card-sub').setText(sub)
			return el
		}
		const todayCard = card(
			'今日阅读',
			formatDuration(todaySec),
			goalSec ? (todaySec >= goalSec ? `已达成 ${goalMin} 分钟目标` : `目标 ${goalMin} 分钟`) : '未设目标',
		)
		if (goalSec > 0) {
			const goal = todayCard.createDiv('grove-stats-goal')
			const fill = goal.createDiv('grove-stats-goal-fill')
			fill.style.width = `${Math.min(100, Math.round((todaySec / goalSec) * 100))}%`
		}
		card('连续阅读', `${streak.current} 天`, `最长 ${streak.longest} 天`)
		card('活跃天数', `${streak.activeDays} 天`, '有阅读记录的天数')
		card('累计阅读', formatDuration(totalSec), `${books.length} 本书`)

		const heatDays = stats.recentDays(84)
		const heatTotal = heatDays.reduce((sum, d) => sum + d.seconds, 0)
		const heatPages = heatDays.reduce((sum, d) => sum + d.pages, 0)
		const heatHead = this.contentEl.createDiv('grove-stats-chart-head')
		heatHead.createSpan('grove-stats-chart-title').setText('最近 12 周')
		heatHead.createSpan('grove-stats-chart-total').setText(
			`合计 ${formatDuration(heatTotal)}${heatPages ? ` · ${heatPages} 页` : ''}`,
		)
		const heat = this.contentEl.createDiv('grove-stats-heatmap')
		for (const d of heatDays) {
			const cell = heat.createDiv('grove-stats-heat-cell')
			const level = this.#heatLevel(d.seconds, goalSec)
			cell.addClass(`is-level-${level}`)
			if (d.day === today) cell.addClass('is-today')
			const label = d.seconds > 0
				? `${d.day}：${formatDuration(d.seconds)}${d.pages ? ` · ${d.pages} 页` : ''}`
				: `${d.day}：未阅读`
			cell.title = label
			cell.setAttr('aria-label', label)
		}
		const legend = this.contentEl.createDiv('grove-stats-heat-legend')
		legend.createSpan({ text: '少' })
		for (let i = 0; i <= 4; i++) legend.createDiv(`grove-stats-heat-cell is-level-${i}`)
		legend.createSpan({ text: '多' })

		const table = this.contentEl.createEl('table', { cls: 'grove-stats-table' })
		const head = table.createEl('tr')
		for (const h of ['书名', '累计阅读', '天数', '今日', '最近阅读']) head.createEl('th', { text: h })
		if (!books.length) {
			table.createEl('tr').createEl('td', { text: '还没有阅读记录。打开一本书读一会儿，这里就会出现数据。', attr: { colspan: '5' } })
		}
		for (const [bookPath, b] of books) {
			const title = this.plugin.shelfCache.get(bookPath)?.title || cleanBookTitle(basenameOf(bookPath))
			const tr = table.createEl('tr')
			tr.createEl('td', { text: title.length > 24 ? title.slice(0, 24) + '…' : title, attr: { title: bookPath } })
			tr.createEl('td', { cls: 'grove-stats-num', text: formatDuration(b.seconds) })
			tr.createEl('td', { cls: 'grove-stats-num', text: String(Object.keys(b.days).length) })
			const todayCell = tr.createEl('td', { cls: 'grove-stats-num' })
			if (b.days[today]) {
				todayCell.setText(formatDuration(b.days[today].seconds))
				todayCell.addClass('grove-stats-today')
			} else {
				todayCell.setText('—')
			}
			tr.createEl('td', { text: formatLastRead(b.lastRead) })
		}
	}

	#heatLevel(seconds: number, goalSec: number): number {
		if (seconds <= 0) return 0
		if (goalSec > 0) {
			const ratio = seconds / goalSec
			if (ratio <= 0.25) return 1
			if (ratio <= 0.5) return 2
			if (ratio <= 1) return 3
			return 4
		}
		const minutes = seconds / 60
		if (minutes < 15) return 1
		if (minutes < 30) return 2
		if (minutes < 60) return 3
		return 4
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export class FolderPromptModal extends Modal {
	constructor(
		app: App,
		private titleText: string,
		private placeholder: string,
		private onSubmit: (value: string) => void,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: this.titleText })
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: '填入库内文件夹路径，或本机绝对路径（如 D:\\Books）。输入时可从建议中选择。',
		})
		const input = this.contentEl.createEl('input', { attr: { type: 'text' }, cls: 'grove-folder-input' })
		input.placeholder = this.placeholder
		new FolderSuggest(this.app, input)
		const submit = () => {
			const v = input.value.trim().replace(/[\\/]+$/, '')
			if (!v) {
				new Notice('请填写文件夹路径')
				return
			}
			this.onSubmit(v)
			this.close()
		}
		input.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault()
				submit()
			}
		})
		const buttons = this.contentEl.createDiv('modal-button-container')
		const ok = buttons.createEl('button', { text: '添加', cls: 'mod-cta' })
		ok.addEventListener('click', submit)
		const cancel = buttons.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
		window.setTimeout(() => input.focus(), 50)
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export class OpLogModal extends Modal {
	constructor(app: App, private entries: OpEntry[]) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: '操作记录' })
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: '只记录删除书籍、清空批注、恢复隐藏、备份失败等关键动作，最多保留 200 条；翻页、搜索等高频操作不记录。',
		})
		if (!this.entries.length) {
			this.contentEl.createEl('p', { text: '还没有记录。' })
			return
		}
		const list = this.contentEl.createDiv('grove-oplog-list')
		for (const entry of this.entries) {
			const row = list.createDiv('grove-oplog-row')
			row.createSpan('grove-oplog-time').setText(new Date(entry.at).toLocaleString('zh-CN', { hour12: false }))
			const body = row.createDiv('grove-oplog-body')
			body.createSpan('grove-oplog-action').setText(entry.action)
			body.createSpan('grove-oplog-detail').setText(entry.detail)
		}
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export class HealthReportModal extends Modal {
	constructor(
		app: App,
		private report: HealthReport,
		private cleanupCount: number,
		private onCleanup: () => void,
	) {
		super(app)
	}

	onOpen(): void {
		const { report } = this
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: '数据体检' })
		const issueCount = report.missingBooks.length + report.missingNotes.length + report.duplicates.length
			+ report.staleShelf.length + report.staleLists.length + report.staleStats.length + report.brokenNoteIds.length
		this.contentEl.createEl('p', {
			text: `批注数据 ${report.jsonCount} 份 / ${report.annotationCount} 条；发现 ${issueCount} 项需要关注。`,
		})
		if (!issueCount) {
			this.contentEl.createEl('p', { text: '没有发现结构性问题：书籍路径、笔记、书架、书单和统计都能对上。' })
		} else {
			const body = this.contentEl.createDiv('grove-health-body')
			const section = (title: string, items: string[]): void => {
				if (!items.length) return
				body.createEl('h4', { text: `${title}（${items.length}）` })
				const list = body.createEl('ul', { cls: 'grove-health-list' })
				for (const item of items.slice(0, 8)) list.createEl('li', { text: item })
				if (items.length > 8) list.createEl('li', { text: `…还有 ${items.length - 8} 项`, cls: 'grove-health-more' })
			}
			section('找不到原文件的批注', report.missingBooks.map(b =>
				`《${b.title || '未命名'}》 · ${b.annotations} 条 · ${b.bookPath || '无路径'}`))
			section('笔记文件不存在', report.missingNotes.map(n => `《${n.title || '未命名'}》 → ${n.notePath}`))
			section('同一路径有多份批注数据', report.duplicates.map(d => `${d.bookPath}（${d.files.length} 份）`))
			section('书架缓存指向不存在的文件', report.staleShelf)
			section('书单指向不存在的文件', report.staleLists)
			section('阅读统计指向不存在的文件', report.staleStats)
			section('笔记里的书籍 ID 找不到数据', report.brokenNoteIds.map(b => `${b.note} → ${b.id.slice(0, 12)}…`))
			if (report.missingBooks.length) {
				this.contentEl.createEl('p', {
					cls: 'setting-item-description',
					text: '孤儿批注 JSON 不会被自动删除；确认无用后可在 data/books/ 手动清理（建议先备份）。',
				})
			}
		}

		const buttons = this.contentEl.createDiv('modal-button-container')
		const copy = buttons.createEl('button', { text: '复制报告' })
		copy.addEventListener('click', () => {
			void navigator.clipboard.writeText(this.#reportText())
				.then(() => new Notice('体检报告已复制'))
				.catch(() => new Notice('复制失败，请手动选择文本'))
		})
		const cleanupable = this.cleanupCount
		if (cleanupable) {
			const cleanup = buttons.createEl('button', { text: `清理 ${cleanupable} 项失效引用`, cls: 'mod-warning' })
			cleanup.addEventListener('click', () => {
				this.close()
				this.onCleanup()
			})
		}
		const close = buttons.createEl('button', { text: '关闭', cls: 'mod-cta' })
		close.addEventListener('click', () => this.close())
	}

	#reportText(): string {
		const { report } = this
		const lines: string[] = [`Grove Reader 数据体检 ${new Date().toLocaleString('zh-CN', { hour12: false })}`]
		lines.push(`批注数据 ${report.jsonCount} 份 / ${report.annotationCount} 条`)
		const add = (title: string, items: string[]): void => {
			if (!items.length) return
			lines.push('', `${title}（${items.length}）`, ...items)
		}
		add('找不到原文件的批注', report.missingBooks.map(b => `《${b.title || '未命名'}》 ${b.annotations} 条 ${b.bookPath}`))
		add('笔记文件不存在', report.missingNotes.map(n => `《${n.title}》 ${n.notePath}`))
		add('重复路径', report.duplicates.map(d => `${d.bookPath} (${d.files.join(', ')})`))
		add('书架缓存失效', report.staleShelf)
		add('书单失效', report.staleLists)
		add('统计失效', report.staleStats)
		add('笔记 ID 失联', report.brokenNoteIds.map(b => `${b.note} ${b.id}`))
		return lines.join('\n')
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export class TrashModal extends Modal {
	constructor(app: App, private plugin: GroveReaderPlugin) {
		super(app)
	}

	onOpen(): void {
		this.render()
	}

	private render(): void {
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h3', { text: '回收站' })
		const entries = this.plugin.trash.list()
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `删除的书籍、笔记、批注和封面会先放在这里，保留 ${this.plugin.trash.retentionDays()} 天。恢复会放回原路径；原位置已有同名文件时会拒绝恢复。`,
		})
		if (!entries.length) {
			contentEl.createEl('p', { text: '回收站是空的。' })
		} else {
			const total = entries.reduce((sum, entry) => sum + entry.size, 0)
			contentEl.createEl('p', { text: `共 ${entries.length} 项，占用 ${formatSize(total)}。` })
			const list = contentEl.createDiv('grove-trash-list')
			for (const entry of entries) {
				const row = list.createDiv('grove-trash-row')
				const info = row.createDiv('grove-trash-info')
				info.createDiv('grove-trash-title').setText(entry.title || basenameOf(entry.bookPath))
				const date = new Date(entry.deletedAt).toLocaleString('zh-CN', { hour12: false })
				info.createDiv('grove-trash-meta').setText(`${date} · ${formatSize(entry.size)}${entry.files.note ? ' · 含阅读笔记' : ''}`)
				const actions = row.createDiv('grove-trash-actions')
				const restore = actions.createEl('button', { text: '恢复' })
				restore.addEventListener('click', () => {
					void (async () => {
						try {
							await this.plugin.restoreTrash(entry.id)
							this.render()
						} catch (e) {
							new Notice(e instanceof Error ? e.message : String(e))
						}
					})()
				})
				const purge = actions.createEl('button', { text: '永久删除', cls: 'mod-warning' })
				purge.addEventListener('click', () => {
					new ConfirmModal(this.app, `永久删除《${entry.title || '这本书'}》？将同时删除回收站里的原文件、笔记和批注，无法恢复。`, () => {
						this.plugin.purgeTrash(entry.id)
						this.render()
					}).open()
				})
			}
		}

		const buttons = contentEl.createDiv('modal-button-container')
		if (entries.length) {
			const empty = buttons.createEl('button', { text: '清空回收站', cls: 'mod-warning' })
			empty.addEventListener('click', () => {
				new ConfirmModal(this.app, `清空回收站里的 ${entries.length} 项？将永久删除，无法恢复。`, () => {
					this.plugin.emptyTrash()
					this.render()
				}).open()
			})
		}
		const close = buttons.createEl('button', { text: '关闭', cls: 'mod-cta' })
		close.addEventListener('click', () => this.close())
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

function formatSize(bytes: number): string {
	if (!bytes) return '0 B'
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export class SearchModal extends Modal {
	private docs: SearchDoc[] = []
	private results: SearchDoc[] = []
	private query = ''
	private onlyNotes = false
	private limit = 80
	private timer: number | null = null
	private inputEl!: HTMLInputElement
	private resultsEl!: HTMLElement
	private countEl!: HTMLElement
	private exportMdBtn!: HTMLButtonElement
	private exportCsvBtn!: HTMLButtonElement
	private exporting = false

	constructor(app: App, private plugin: GroveReaderPlugin) {
		super(app)
	}

	onOpen(): void {
		this.modalEl.addClass('grove-search-modal')
		this.docs = this.plugin.loadSearchIndex()
		this.renderShell()
		this.runSearch()
	}

	private renderShell(): void {
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h3', { text: '全局批注检索' })
		this.inputEl = contentEl.createEl('input', {
			type: 'search',
			cls: 'grove-search-input',
			attr: { placeholder: '搜索划线、评论、章节或书名…' },
		})
		this.inputEl.addEventListener('input', () => {
			if (this.timer) window.clearTimeout(this.timer)
			this.timer = window.setTimeout(() => {
				this.timer = null
				this.query = this.inputEl.value
				this.limit = 80
				this.runSearch()
			}, 120)
		})
		this.inputEl.addEventListener('keydown', e => {
			if (e.key === 'Enter' && this.results[0]?.bookExists) {
				e.preventDefault()
				this.openHit(this.results[0])
			}
		})

		const bar = contentEl.createDiv('grove-search-bar')
		this.countEl = bar.createSpan('grove-search-count')
		const only = bar.createEl('label', { cls: 'grove-search-only' })
		const onlyBox = only.createEl('input', { type: 'checkbox' })
		only.createSpan({ text: '只看有评论的' })
		onlyBox.addEventListener('change', () => {
			this.onlyNotes = onlyBox.checked
			this.limit = 80
			this.runSearch()
		})
		const rebuild = bar.createEl('button', { text: '重新索引' })
		rebuild.addEventListener('click', () => {
			this.docs = this.plugin.loadSearchIndex()
			this.runSearch()
			new Notice(`已重新索引 ${this.docs.length} 条批注`)
		})

		this.resultsEl = contentEl.createDiv('grove-search-results')
		const footer = contentEl.createDiv('modal-button-container')
		this.exportMdBtn = footer.createEl('button', { text: '导出 Markdown' })
		this.exportMdBtn.addEventListener('click', () => void this.doExport('md'))
		this.exportCsvBtn = footer.createEl('button', { text: '导出 CSV' })
		this.exportCsvBtn.addEventListener('click', () => void this.doExport('csv'))
		const close = footer.createEl('button', { text: '关闭', cls: 'mod-cta' })
		close.addEventListener('click', () => this.close())
	}

	private async doExport(format: 'md' | 'csv'): Promise<void> {
		if (this.exporting) return
		this.exporting = true
		this.exportMdBtn.disabled = true
		this.exportCsvBtn.disabled = true
		try {
			await this.plugin.exportSearchResults(this.results, this.query, format)
		} catch (e) {
			new Notice(`导出失败：${e instanceof Error ? e.message : String(e)}`)
		} finally {
			this.exporting = false
			const disabled = this.results.length === 0
			this.exportMdBtn.disabled = disabled
			this.exportCsvBtn.disabled = disabled
		}
	}

	private runSearch(): void {
		this.query = this.inputEl.value
		this.results = this.query.trim() ? searchDocs(this.docs, this.query, { onlyNotes: this.onlyNotes }) : []
		if (!this.query.trim()) {
			this.countEl.setText(`共 ${this.docs.length} 条批注`)
		} else {
			this.countEl.setText(`${this.results.length} 条结果 / 共 ${this.docs.length} 条`)
		}
		const disabled = this.results.length === 0
		this.exportMdBtn.disabled = disabled
		this.exportCsvBtn.disabled = disabled
		this.renderResults()
	}

	private renderResults(): void {
		const { resultsEl } = this
		resultsEl.empty()
		if (!this.query.trim()) {
			resultsEl.createDiv({ cls: 'grove-search-empty', text: '输入关键词，搜索所有书的划线与评论。空格分隔多个词时按 AND 匹配。' })
			return
		}
		if (!this.results.length) {
			resultsEl.createDiv({ cls: 'grove-search-empty', text: '没有匹配的批注。试试减少关键词，或取消「只看有评论的」。' })
			return
		}
		const terms = normalizeTerms(this.query)
		for (const doc of this.results.slice(0, this.limit)) {
			const hit = resultsEl.createDiv('grove-search-hit')
			if (!doc.bookExists) hit.addClass('is-missing')
			const head = hit.createDiv('grove-search-hit-head')
			head.createSpan({ cls: 'grove-search-dot' }).style.background = colorDot(doc.annotation.color)
			head.createSpan({ cls: 'grove-search-book', text: doc.bookTitle })
			const meta = [doc.annotation.chapter, doc.annotation.cfi.startsWith('page:') ? `第 ${doc.annotation.cfi.slice(5)} 页` : '', colorName(doc.annotation.color)]
				.filter(Boolean)
				.join(' · ')
			if (meta) head.createSpan({ cls: 'grove-search-meta', text: meta })
			if (!doc.bookExists) head.createSpan({ cls: 'grove-search-missing', text: '原文件缺失' })
			const quote = hit.createDiv('grove-search-quote')
			this.appendHighlighted(quote, doc.annotation.text, terms)
			if (doc.annotation.note?.trim()) {
				const note = hit.createDiv('grove-search-note')
				this.appendHighlighted(note, doc.annotation.note, terms)
			}
			if (doc.bookExists) {
				hit.tabIndex = 0
				hit.setAttr('role', 'button')
				hit.addEventListener('click', () => this.openHit(doc))
				hit.addEventListener('keydown', e => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault()
						this.openHit(doc)
					}
				})
			}
		}
		if (this.results.length > this.limit) {
			const more = resultsEl.createEl('button', { cls: 'grove-search-more', text: `显示更多（还有 ${this.results.length - this.limit} 条）` })
			more.addEventListener('click', () => {
				this.limit += 80
				this.renderResults()
			})
		}
	}

	private appendHighlighted(el: HTMLElement, text: string, terms: string[]): void {
		if (!terms.length) {
			el.setText(text)
			return
		}
		const re = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
		let last = 0
		for (const match of text.matchAll(re)) {
			const index = match.index ?? 0
			if (index > last) el.createSpan({ text: text.slice(last, index) })
			el.createEl('mark', { cls: 'grove-search-mark', text: match[0] })
			last = index + match[0].length
		}
		if (last < text.length) el.createSpan({ text: text.slice(last) })
	}

	private openHit(doc: SearchDoc): void {
		if (!doc.bookExists) return
		this.close()
		void this.plugin.openBookByPath(doc.bookPath, doc.annotation.cfi)
	}

	onClose(): void {
		if (this.timer) window.clearTimeout(this.timer)
		this.contentEl.empty()
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class TemplatePickerModal extends Modal {
	constructor(
		app: App,
		private plugin: GroveReaderPlugin,
		private bookPath: string,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: '笔记模板' })
		const data = this.plugin.store.load(this.bookPath)
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `《${data.title || basenameOf(this.bookPath)}》使用哪一套模板生成阅读笔记。切换后已存在的笔记会按新模板重写生成区。`,
		})
		const list = this.plugin.templateList()
		const current = data.templateId ?? ''
		const options = [{ id: '', name: '跟随默认', path: this.plugin.defaultTemplatePath() }]
		for (const tpl of list) {
			if (tpl.id === 'legacy' && list.length === 1) continue
			options.push({ id: tpl.id, name: tpl.name, path: tpl.path })
		}
		const wrap = this.contentEl.createDiv('grove-template-options')
		for (const option of options) {
			const row = wrap.createDiv('grove-template-option')
			if (option.id === current) row.addClass('is-active')
			row.createDiv('grove-template-option-name').setText(option.name)
			row.createDiv('grove-template-option-path').setText(option.path)
			row.tabIndex = 0
			row.setAttr('role', 'button')
			const choose = (): void => {
				this.plugin.setBookTemplate(this.bookPath, option.id)
				this.close()
			}
			row.addEventListener('click', choose)
			row.addEventListener('keydown', e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault()
					choose()
				}
			})
		}
		const buttons = this.contentEl.createDiv('modal-button-container')
		const close = buttons.createEl('button', { text: '关闭', cls: 'mod-cta' })
		close.addEventListener('click', () => this.close())
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export class TemplateEditModal extends Modal {
	constructor(
		app: App,
		private titleText: string,
		private initialName: string,
		private initialPath: string,
		private onSave: (name: string, path: string) => void,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: this.titleText })
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: '模板是库内 Markdown 文件；可以复制一份现有模板再改。',
		})
		const name = this.contentEl.createEl('input', { attr: { type: 'text', placeholder: '模板名称，例如：教材 / 小说' }, cls: 'grove-folder-input' })
		name.value = this.initialName
		const path = this.contentEl.createEl('input', {
			attr: { type: 'text', placeholder: '模板文件路径，例如：Grove Reader/阅读笔记/教材模板.md' },
			cls: 'grove-folder-input',
		})
		path.value = this.initialPath
		const buttons = this.contentEl.createDiv('modal-button-container')
		const cancel = buttons.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
		const save = buttons.createEl('button', { text: '保存', cls: 'mod-cta' })
		save.addEventListener('click', () => {
			const n = name.value.trim()
			const p = path.value.trim().replace(/\\/g, '/')
			if (!n) {
				new Notice('请填写模板名称')
				return
			}
			if (!p) {
				new Notice('请填写模板文件路径')
				return
			}
			this.onSave(n, p)
			this.close()
		})
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export class PromptModal extends Modal {
	constructor(
		app: App,
		private titleText: string,
		private placeholder: string,
		private onSubmit: (value: string) => void,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: this.titleText })
		const input = this.contentEl.createEl('input', {
			cls: 'grove-folder-input',
			attr: { type: 'text', placeholder: this.placeholder },
		})
		const submit = (): void => {
			const value = input.value.trim()
			if (!value) {
				new Notice('请输入关键词')
				return
			}
			this.onSubmit(value)
			this.close()
		}
		input.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault()
				submit()
			}
		})
		const buttons = this.contentEl.createDiv('modal-button-container')
		const cancel = buttons.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
		const ok = buttons.createEl('button', { text: '搜索', cls: 'mod-cta' })
		ok.addEventListener('click', submit)
		window.setTimeout(() => input.focus(), 50)
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

// ------------------------------------------------------------------
// 笔记 → 批注回写
// ------------------------------------------------------------------

/** 预览笔记里的改动，勾选后写回批注数据；缺条目只提示，不删数据 */
export class NoteSyncModal extends Modal {
	constructor(
		app: App,
		private plan: SyncPlan,
		private onApply: (changes: SyncChange[]) => void,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: '从笔记同步批注' })
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: '勾选要写回批注数据的改动。笔记里被删掉的条目不会删批注，只在这里提示。',
		})

		const selected = new Set(this.plan.changes.map(c => changeKey(c)))
		const list = this.contentEl.createDiv('grove-sync-list')
		if (!this.plan.changes.length) {
			list.createDiv('grove-sync-empty').setText('没有检测到被改动的摘录或评论')
		}
		for (const c of this.plan.changes) {
			const item = list.createDiv('grove-sync-item')
			const box = item.createEl('input', { type: 'checkbox' })
			box.checked = true
			box.addEventListener('change', () => {
				if (box.checked) selected.add(changeKey(c))
				else selected.delete(changeKey(c))
				syncApplyButton()
			})
			const body = item.createDiv('grove-sync-body')
			const head = body.createDiv('grove-sync-head')
			head.createSpan('grove-sync-field').setText(c.field === 'note' ? '评论' : '摘录')
			head.createSpan('grove-sync-diff').setText(`${collapse(c.from) || '（空）'} → ${collapse(c.to) || '（空）'}`)
		}

		if (this.plan.missing.length) {
			const hint = this.contentEl.createDiv('grove-sync-hint')
			hint.setText(`笔记里找不到 ${this.plan.missing.length} 条批注（未删除，可在插件里单独处理）`)
		}
		if (this.plan.skipped.length) {
			this.contentEl.createDiv('grove-sync-hint').setText(
				`${this.plan.skipped.length} 条批注的评论无法判断（条目里没有 %% 块），已跳过`,
			)
		}
		if (this.plan.unknown.length) {
			this.contentEl.createDiv('grove-sync-hint').setText(
				`笔记里有 ${this.plan.unknown.length} 个块 id 对不上这本书的批注，已忽略`,
			)
		}

		const buttons = this.contentEl.createDiv('modal-button-container')
		const cancel = buttons.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
		const apply = buttons.createEl('button', { text: '应用改动', cls: 'mod-cta' })
		const syncApplyButton = (): void => {
			apply.setText(`应用改动（${selected.size}）`)
			apply.disabled = selected.size === 0
		}
		syncApplyButton()
		apply.addEventListener('click', () => {
			const picked = this.plan.changes.filter(c => selected.has(changeKey(c)))
			this.onApply(picked)
			this.close()
		})
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

function changeKey(c: SyncChange): string {
	return `${c.id}|${c.field}`
}

/** 差异预览压成一行，太长截断 */
function collapse(text: string): string {
	const one = (text || '').replace(/\s+/g, ' ').trim()
	return one.length > 42 ? `${one.slice(0, 42)}…` : one
}
