import { App, AbstractInputSuggest, FuzzySuggestModal, Modal, Notice, TFile, TFolder } from 'obsidian'
import { isShelfExt } from './types'
import type { BookList } from './lists'
import { todayKey } from './stats'
import type GroveReaderPlugin from './main'
import { basenameOf } from './util'

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

		const table = this.contentEl.createEl('table', { cls: 'grove-stats-table' })
		const head = table.createEl('tr')
		for (const h of ['书名', '累计阅读', '天数', '今日', '最近阅读']) head.createEl('th', { text: h })
		if (!books.length) {
			table.createEl('tr').createEl('td', { text: '还没有阅读记录。打开一本书读一会儿，这里就会出现数据。', attr: { colspan: '5' } })
		}
		const today = todayKey()
		for (const [bookPath, b] of books) {
			const title = this.plugin.shelfCache.get(bookPath)?.title || basenameOf(bookPath).replace(/\.[^.]+$/, '')
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

		if (books.length) {
			const days = stats.recentDays(14)
			const totalSec = days.reduce((s, d) => s + d.seconds, 0)
			const totalPages = days.reduce((s, d) => s + d.pages, 0)
			const headRow = this.contentEl.createDiv('grove-stats-chart-head')
			headRow.createSpan('grove-stats-chart-title').setText('最近 14 天')
			headRow.createSpan('grove-stats-chart-total').setText(
				`合计 ${formatDuration(totalSec)}${totalPages ? ` · ${totalPages} 页` : ''}`,
			)
			const max = Math.max(...days.map(d => d.seconds), 1)
			const chart = this.contentEl.createDiv('grove-stats-chart')
			for (const d of days) {
				const col = chart.createDiv('grove-stats-col')
				col.title = d.seconds > 0
					? `${d.day}：${formatDuration(d.seconds)}${d.pages ? ` · ${d.pages} 页` : ''}`
					: `${d.day}：未阅读`
				const track = col.createDiv('grove-stats-col-track')
				if (d.seconds > 0) {
					const bar = track.createDiv('grove-stats-col-bar')
					bar.style.height = `${Math.max(4, Math.round((d.seconds / max) * 100))}%`
				}
				col.createDiv('grove-stats-col-date').setText(d.day.slice(8))
				if (d.day === today) col.addClass('is-today')
			}
		}
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
