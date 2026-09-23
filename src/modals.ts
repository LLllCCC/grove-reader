import { App, AbstractInputSuggest, FuzzySuggestModal, Modal, Notice, TFile, TFolder } from 'obsidian'
import { SUPPORTED_BOOK_EXTS } from './types'
import type { BookList } from './lists'

export class BookPickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onPick: (file: TFile) => void) {
		super(app)
		this.setPlaceholder('选择要阅读的电子书…')
	}

	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter(f => SUPPORTED_BOOK_EXTS.includes(f.extension.toLowerCase()))
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
