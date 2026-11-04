import { App, AbstractInputSuggest, FuzzySuggestModal, Modal, Notice, TFile, TFolder } from 'obsidian'
import { isShelfExt } from './types'
import type { BookList } from './lists'
import { todayKey } from './stats'
import type GroveReaderPlugin from './main'
import { basenameOf } from './util'
import type { OpEntry } from './oplog'

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
			text: `这本书有 ${this.annotationCount} 条批注。勾选删除原文件时，会同时删除阅读数据（批注、阅读位置、书单归属）；只移出书架则全部保留。生成的 Markdown 笔记是否删除可在下方选择。`,
		})
		const row = this.contentEl.createDiv('grove-delete-check')
		const checkbox = row.createEl('input', { type: 'checkbox' })
		checkbox.id = 'grove-delete-file'
		const label = row.createEl('label', { text: '同时删除库里的原文件（按 Obsidian 的删除设置处理）' })
		label.setAttr('for', 'grove-delete-file')

		const noteRow = this.contentEl.createDiv('grove-delete-check')
		const noteBox = noteRow.createEl('input', { type: 'checkbox' })
		noteBox.id = 'grove-delete-note'
		noteBox.disabled = !this.noteName
		const noteLabel = noteRow.createEl('label', {
			text: this.noteName ? `同时删除生成的阅读笔记（${this.noteName}）` : '这本书还没有生成阅读笔记',
		})
		noteLabel.setAttr('for', 'grove-delete-note')

		const hint = this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: '不勾选删除原文件时只从书架移除：原文件和批注数据都会保留，之后可以在设置里恢复。只删笔记不会删批注数据，之后仍可重新生成。',
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
