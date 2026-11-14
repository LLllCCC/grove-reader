import { App, AbstractInputSuggest, FuzzySuggestModal, Modal, Notice, TFile, TFolder, normalizePath, setIcon } from 'obsidian'
import { Annotation, colorName, isShelfExt, READING_STATUS_LABELS } from './types'
import type { BookData, ReadingStatus } from './types'
import { colorDot, normalizeTerms, searchDocs } from './search'
import type { SearchDoc } from './search'
import type { BookList } from './lists'
import { forecastFinishDays, todayKey } from './stats'
import type GroveReaderPlugin from './main'
import { basenameOf, cleanBookTitle, truncate } from './util'
import type { OpEntry } from './oplog'
import type { HealthReport } from './health'
import type { SyncChange, SyncPlan } from './noteSync'
import { filterGlobalBookmarks } from './globalBookmarks'
import type { GlobalBookmarkRow } from './globalBookmarks'
import { posterFileName, renderReadingPoster } from './poster'
import { AnnotationExportModal } from './exportModal'

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
		private okText = '删除',
		private okClass = 'mod-warning',
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: '确认操作' })
		this.contentEl.createEl('p', { text: this.message })
		const buttons = this.contentEl.createDiv('modal-button-container')
		const ok = buttons.createEl('button', { text: this.okText, cls: this.okClass })
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

/** ConfirmModal 的 Promise 版：需要 await 的流程（生成前的花费确认等）用它 */
export function confirmAsync(app: App, message: string, okText = '继续', okClass = 'mod-cta'): Promise<boolean> {
	return new Promise(resolve => {
		const modal = new Modal(app)
		let answered = false
		modal.onOpen = (): void => {
			modal.contentEl.empty()
			modal.contentEl.createEl('h3', { text: '确认操作' })
			modal.contentEl.createEl('p', { text: message })
			const buttons = modal.contentEl.createDiv('modal-button-container')
			const ok = buttons.createEl('button', { text: okText, cls: okClass })
			ok.addEventListener('click', () => {
				answered = true
				resolve(true)
				modal.close()
			})
			const cancel = buttons.createEl('button', { text: '取消' })
			cancel.addEventListener('click', () => {
				answered = true
				resolve(false)
				modal.close()
			})
		}
		modal.onClose = (): void => {
			if (!answered) resolve(false)
		}
		modal.open()
	})
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
	category: string
	intro: string
	/** 哪些字段是 AI 补全的，用来在编辑框旁标一下 */
	aiMeta?: { author?: boolean; category?: boolean; intro?: boolean }
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
		const label = (text: string, ai = false): void => {
			const row = this.contentEl.createDiv('grove-info-label')
			row.setText(text)
			if (ai) row.createSpan({ cls: 'grove-info-ai', text: 'AI 生成' })
		}
		const mk = (text: string, key: keyof BookInfoValues, ai = false): HTMLInputElement => {
			label(text, ai)
			const input = this.contentEl.createEl('input', { type: 'text', cls: 'grove-folder-input' })
			input.value = String(this.values[key] ?? '')
			return input
		}
		const title = mk('书名', 'title')
		const author = mk('作者', 'author', this.values.aiMeta?.author)
		const publisher = mk('出版社', 'publisher')
		const category = mk('分类', 'category', this.values.aiMeta?.category)
		label('一句话简介', this.values.aiMeta?.intro)
		const intro = this.contentEl.createEl('textarea', {
			cls: 'grove-comment-input',
			attr: { rows: '3', placeholder: '例如：一本讲如何用环境设计替代意志力的实用小书' },
		})
		intro.value = this.values.intro
		const buttons = this.contentEl.createDiv('modal-button-container')
		const ok = buttons.createEl('button', { text: '保存', cls: 'mod-cta' })
		ok.addEventListener('click', () => {
			this.onSave({
				title: title.value.trim(),
				author: author.value.trim(),
				publisher: publisher.value.trim(),
				category: category.value.trim(),
				intro: intro.value.trim(),
			})
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
		const todayPages = stats.dailyTotals().get(today)?.pages ?? 0
		const pageGoal = Math.max(0, this.plugin.settings.dailyPageGoal || 0)
		const pagesCard = card('今日页数', `${todayPages} 页`, pageGoal ? `目标 ${pageGoal} 页` : '未设目标')
		if (pageGoal > 0) {
			const goal = pagesCard.createDiv('grove-stats-goal')
			const fill = goal.createDiv('grove-stats-goal-fill')
			fill.style.width = `${Math.min(100, Math.round((todayPages / pageGoal) * 100))}%`
		}
		card('连续阅读', `${streak.current} 天`, `最长 ${streak.longest} 天`)
		card('活跃天数', `${streak.activeDays} 天`, '有阅读记录的天数')
		card('累计阅读', formatDuration(totalSec), `${books.length} 本书`)
		const review = this.plugin.reviewOverview()
		card(
			'今日复习',
			review.cap ? `${review.today} / ${review.cap} 条` : '已关闭',
			review.cap ? `到期 ${review.due} 条${this.plugin.settings.reviewIncludeNew !== false ? ` · 旧划线 ${review.fresh} 条` : ''}` : '设置 → 每日复习条数',
		)

		// 年度目标方格 + 读完预测：状态直接读每本书的数据，预测按近 7 天速度
		const goalBooks = Math.max(0, this.plugin.settings.yearlyGoalBooks || 0)
		const year = new Date().getFullYear()
		const weekSeconds = stats.recentDays(7).reduce((sum, d) => sum + d.seconds, 0)
		const statusOf = (d: BookData): ReadingStatus => {
			if (d.readingStatus) return d.readingStatus
			const fraction = d.lastLocation?.fraction ?? 0
			return fraction >= 0.99 ? 'done' : fraction > 0 ? 'reading' : 'want'
		}
		const booksData = this.plugin.store.listBookPaths().map(path => this.plugin.store.load(path))
		const finishedThisYear = booksData.filter(d => {
			if (statusOf(d) !== 'done') return false
			const stat = stats.peek(d.bookPath)
			const days = Object.keys(stat?.days ?? {}).sort()
			const day = days.length
				? days[days.length - 1]
				: d.lastLocation?.updatedAt ? todayKey(new Date(d.lastLocation.updatedAt)) : ''
			return day.startsWith(`${year}-`)
		}).length
		const forecasts = booksData
			.filter(d => statusOf(d) === 'reading')
			.map(d => {
				const fraction = d.lastLocation?.fraction ?? 0
				return {
					title: d.title || basenameOf(d.bookPath).replace(/\.[^.]+$/, ''),
					fraction,
					days: forecastFinishDays(stats.peek(d.bookPath), fraction),
				}
			})
			.filter(x => x.days != null)
			.sort((a, b) => (a.days ?? 0) - (b.days ?? 0))
			.slice(0, 3)
		if (goalBooks > 0 || forecasts.length) {
			const box = this.contentEl.createDiv('grove-goal')
			if (goalBooks > 0) {
				const head = box.createDiv('grove-goal-head')
				head.createSpan('grove-goal-title').setText('年度目标')
				head.createSpan('grove-goal-value').setText(`${finishedThisYear} / ${goalBooks} 本`)
				const grid = box.createDiv('grove-goal-grid')
				const cells = Math.min(goalBooks, 120)
				for (let i = 0; i < cells; i++) {
					const cell = grid.createDiv('grove-goal-cell')
					if (i < finishedThisYear) {
						cell.addClass('is-done')
						setIcon(cell, 'book')
					}
				}
				box.createDiv('grove-goal-sub').setText(
					finishedThisYear > cells
						? `今年读完 ${finishedThisYear} 本（方格最多显示 ${cells} 个）`
						: `今年读完 ${finishedThisYear} 本 · 近 7 天日均 ${Math.round(weekSeconds / 7 / 60)} 分钟`,
				)
			}
			if (forecasts.length) {
				const list = box.createDiv('grove-forecast')
				list.createDiv('grove-forecast-title').setText('读完预测（按近 7 天速度）')
				for (const item of forecasts) {
					const row = list.createDiv('grove-forecast-row')
					row.createSpan('grove-forecast-book').setText(`《${item.title}》`)
					row.createSpan('grove-forecast-days').setText(`约 ${item.days} 天后`)
					row.createSpan('grove-forecast-progress').setText(`${Math.round(item.fraction * 100)}%`)
				}
			}
		}

		// 手动打卡：和「今日阅读」互补，读完一小段也能标记今天来过
		const checkRow = this.contentEl.createDiv('grove-stats-checkin')
		const checked = stats.checkedIn(today)
		const checkBtn = checkRow.createEl('button', {
			text: checked ? '今日已打卡' : '今日打卡',
			cls: checked ? '' : 'mod-cta',
		})
		checkBtn.disabled = checked
		checkBtn.addEventListener('click', () => {
			if (!stats.checkin()) return
			new Notice('Grove Reader：今日打卡成功')
			this.onOpen()
		})
		checkRow.createSpan('grove-stats-checkin-count').setText(`累计打卡 ${stats.checkinCount()} 天`)
		const posterBtn = checkRow.createEl('button', { text: '生成阅读海报' })
		posterBtn.addEventListener('click', () => void this.#savePoster())

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

		// —— 最近 14 天趋势 ——
		const trendDays = stats.recentDays(14)
		const trendMax = Math.max(1, ...trendDays.map(d => d.seconds))
		const trendHead = this.contentEl.createDiv('grove-stats-chart-head')
		trendHead.createSpan('grove-stats-chart-title').setText('最近 14 天')
		const trend = this.contentEl.createDiv('grove-stats-chart')
		for (const d of trendDays) {
			const col = trend.createDiv('grove-stats-col')
			const track = col.createDiv('grove-stats-col-track')
			const bar = track.createDiv('grove-stats-col-bar')
			bar.style.height = `${Math.max(2, Math.round((d.seconds / trendMax) * 100))}%`
			col.title = `${d.day}：${d.seconds ? formatDuration(d.seconds) : '未阅读'}`
			col.createSpan('grove-stats-col-date').setText(d.day.slice(5))
			if (d.day === today) col.addClass('is-today')
		}

		// —— 阅读时段（4 小时一段） ——
		const hours = stats.hourTotals()
		const buckets = [0, 4, 8, 12, 16, 20].map(start =>
			hours.slice(start, start + 4).reduce((sum, v) => sum + v, 0))
		const bucketMax = Math.max(1, ...buckets)
		const rhythmHead = this.contentEl.createDiv('grove-stats-chart-head')
		rhythmHead.createSpan('grove-stats-chart-title').setText('阅读时段')
		const rhythm = this.contentEl.createDiv('grove-stats-chart is-rhythm')
		buckets.forEach((seconds, i) => {
			const col = rhythm.createDiv('grove-stats-col')
			const track = col.createDiv('grove-stats-col-track')
			const bar = track.createDiv('grove-stats-col-bar')
			bar.style.height = `${Math.max(2, Math.round((seconds / bucketMax) * 100))}%`
			col.title = `${i * 4}–${i * 4 + 4} 点：${seconds ? formatDuration(seconds) : '未阅读'}`
			col.createSpan('grove-stats-col-date').setText(`${i * 4}–${i * 4 + 4}`)
		})

		// 手机窄屏下表格比弹窗宽，用单独的滚动容器，别把整个弹窗撑出横向滚动
		const tableWrap = this.contentEl.createDiv('grove-stats-table-wrap')
		const table = tableWrap.createEl('table', { cls: 'grove-stats-table' })
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

	/** 阅读海报：统计画成 1080×1440 PNG，存到 Grove Reader/书摘卡/ */
	async #savePoster(): Promise<void> {
		const stats = this.plugin.stats
		const books = stats.sortedBooks()
		const streak = stats.streak()
		const canvas = renderReadingPoster({
			date: new Date(),
			todaySeconds: stats.dailyTotals().get(todayKey())?.seconds ?? 0,
			totalSeconds: books.reduce((sum, [, b]) => sum + b.seconds, 0),
			streakCurrent: streak.current,
			streakLongest: streak.longest,
			activeDays: streak.activeDays,
			checkins: stats.checkinCount(),
			days: stats.recentDays(14),
			books: books.slice(0, 3).map(([path, b]) => ({
				title: cleanBookTitle(basenameOf(path)),
				seconds: b.seconds,
			})),
		})
		const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
		if (!blob) {
			new Notice('Grove Reader：海报生成失败，请稍后再试')
			return
		}
		const folder = normalizePath('Grove Reader/书摘卡')
		try {
			if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder)
			const path = normalizePath(`${folder}/${posterFileName()}`)
			await this.app.vault.createBinary(path, await blob.arrayBuffer())
			new Notice(`Grove Reader：阅读海报已保存到 ${path}`)
		} catch (e) {
			new Notice(`Grove Reader：保存海报失败（${e instanceof Error ? e.message : String(e)}）`)
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
			+ report.orphanPortraits.length + report.vectorIssues.length + report.reviewIssues.length
		this.contentEl.createEl('p', {
			text: `批注数据 ${report.jsonCount} 份 / ${report.annotationCount} 条；发现 ${issueCount} 项需要关注。`,
		})
		if (!issueCount) {
			this.contentEl.createEl('p', { text: '没有发现结构性问题：书籍路径、笔记、书架、书单、统计、AI 要点索引和语义索引都能对上。' })
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
			section('AI 要点索引对应的书已不存在', report.orphanPortraits.map(p =>
				`《${p.title || '未命名'}》 · ${p.bookPath || '无路径'}`))
			section('语义索引损坏或对应的书已不存在', report.vectorIssues.map(v =>
				v.reason === 'broken'
					? `${v.file} · 文件损坏或缺少字段`
					: `《${v.title || '未命名'}》 · ${v.bookPath || '无路径'}`))
			section('复习排期异常', report.reviewIssues.map(r =>
				`《${r.title || '未命名'}》 · ${r.annotationId.slice(0, 10) || r.file} · ${r.reason}`))
			if (report.reviewIssues.length) {
				this.contentEl.createEl('p', {
					cls: 'setting-item-description',
					text: '复习排期异常不会影响阅读与笔记；这条划线下次评分时会被正常覆盖，也可用命令「清空全部复习排期」重来。',
				})
			}
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
		add('AI 要点索引孤儿', report.orphanPortraits.map(p => `《${p.title || '未命名'}》 ${p.bookPath}`))
		add('语义索引失效', report.vectorIssues.map(v => v.reason === 'broken'
			? `${v.file} 损坏`
			: `《${v.title || '未命名'}》 ${v.bookPath}`))
		add('复习排期异常', report.reviewIssues.map(r =>
			`《${r.title || '未命名'}》 ${r.annotationId || r.file} ${r.reason}`))
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
		void this.render()
	}

	private async render(): Promise<void> {
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h3', { text: '回收站' })
		const trash = this.plugin.trash
		if (!trash) {
			contentEl.createEl('p', { text: '回收站暂不可用。' })
			return
		}
		const entries = await trash.list()
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `删除的书籍、笔记、批注和封面会先放在这里，保留 ${trash.retentionDays()} 天。恢复会放回原路径；原位置已有同名文件时会拒绝恢复。`,
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
							void this.render()
						} catch (e) {
							new Notice(e instanceof Error ? e.message : String(e))
						}
					})()
				})
				const purge = actions.createEl('button', { text: '永久删除', cls: 'mod-warning' })
				purge.addEventListener('click', () => {
					new ConfirmModal(this.app, `永久删除《${entry.title || '这本书'}》？将同时删除回收站里的原文件、笔记和批注，无法恢复。`, () => {
						void this.plugin.purgeTrash(entry.id)
						void this.render()
					}).open()
				})
			}
		}

		const buttons = contentEl.createDiv('modal-button-container')
		if (entries.length) {
			const empty = buttons.createEl('button', { text: '清空回收站', cls: 'mod-warning' })
			empty.addEventListener('click', () => {
				new ConfirmModal(this.app, `清空回收站里的 ${entries.length} 项？将永久删除，无法恢复。`, () => {
					void this.plugin.emptyTrash()
					void this.render()
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
	private exportBtn!: HTMLButtonElement

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
		this.exportBtn = footer.createEl('button', { text: '导出…', cls: 'mod-cta' })
		this.exportBtn.addEventListener('click', () => this.openExport())
		const close = footer.createEl('button', { text: '关闭' })
		close.addEventListener('click', () => this.close())
	}

	/** 打开导出弹窗：先筛选、看预览，再决定写 Markdown 还是 CSV */
	private openExport(): void {
		if (!this.docs.length) return
		new AnnotationExportModal(this.app, this.plugin, {
			all: this.docs,
			results: this.results,
			query: this.query,
			scope: this.query.trim() && this.results.length ? 'results' : 'all',
			onlyNotes: this.onlyNotes,
		}).open()
	}

	private runSearch(): void {
		this.query = this.inputEl.value
		this.results = this.query.trim() ? searchDocs(this.docs, this.query, { onlyNotes: this.onlyNotes }) : []
		if (!this.query.trim()) {
			this.countEl.setText(`共 ${this.docs.length} 条批注`)
		} else {
			this.countEl.setText(`${this.results.length} 条结果 / 共 ${this.docs.length} 条`)
		}
		// 没有检索词时也能导出全部批注，所以只看索引是否为空
		this.exportBtn.disabled = this.docs.length === 0
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

// ------------------------------------------------------------------
// 批注 → Canvas
// ------------------------------------------------------------------

export interface CanvasTarget {
	path: string
	name: string
}

export interface CanvasExportPayload {
	ids: string[]
	/** 已有画布的路径；新建时为空 */
	target: string
	/** 新建画布的文件名（不含 .canvas） */
	name: string
}

/** 选批注 + 选目标画布；导出逻辑留给 main，弹窗只负责收集意图 */
export class CanvasExportModal extends Modal {
	constructor(
		app: App,
		private bookTitle: string,
		private annotations: Annotation[],
		private canvases: CanvasTarget[],
		private defaultName: string,
		private onExport: (payload: CanvasExportPayload) => void,
	) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.contentEl.createEl('h3', { text: '发送批注到 Canvas' })
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `从《${this.bookTitle}》选择要导出的批注：卡片含摘录、评论、回笔记与回原文链接。`,
		})

		const selected = new Set(this.annotations.map(a => a.id))
		const toolbar = this.contentEl.createDiv('grove-canvas-toolbar')
		const countEl = toolbar.createSpan('grove-canvas-count')
		const allBtn = toolbar.createEl('button', { text: '全选', cls: 'grove-manage-btn' })
		const noneBtn = toolbar.createEl('button', { text: '全不选', cls: 'grove-manage-btn' })

		const list = this.contentEl.createDiv('grove-sync-list grove-canvas-list')
		const boxes: HTMLInputElement[] = []
		for (const a of this.annotations) {
			const item = list.createDiv('grove-sync-item')
			const box = item.createEl('input', { type: 'checkbox' })
			box.checked = true
			boxes.push(box)
			box.addEventListener('change', () => {
				if (box.checked) selected.add(a.id)
				else selected.delete(a.id)
				syncCount()
			})
			const body = item.createDiv('grove-sync-body')
			const head = body.createDiv('grove-sync-head')
			head.createSpan('grove-sync-field').setText(a.chapter || '未分章')
			head.createSpan('grove-canvas-page').setText(a.pdf?.page ? `第 ${a.pdf.page} 页` : '')
			body.createDiv('grove-canvas-excerpt').setText(truncate(a.text.replace(/\s+/g, ' '), 100))
		}

		const targetRow = this.contentEl.createDiv('grove-canvas-target')
		const select = targetRow.createEl('select', { cls: 'dropdown' })
		select.createEl('option', { value: '__new__', text: '新建画布' })
		for (const c of this.canvases) select.createEl('option', { value: c.path, text: `追加到：${c.name}` })
		const nameInput = targetRow.createEl('input', { type: 'text', cls: 'grove-folder-input' })
		nameInput.value = this.defaultName
		nameInput.placeholder = '画布名称'
		select.addEventListener('change', () => {
			nameInput.toggleClass('grove-hidden', select.value !== '__new__')
		})

		allBtn.addEventListener('click', () => {
			for (const b of boxes) b.checked = true
			for (const a of this.annotations) selected.add(a.id)
			syncCount()
		})
		noneBtn.addEventListener('click', () => {
			for (const b of boxes) b.checked = false
			selected.clear()
			syncCount()
		})

		const buttons = this.contentEl.createDiv('modal-button-container')
		const cancel = buttons.createEl('button', { text: '取消' })
		cancel.addEventListener('click', () => this.close())
		const ok = buttons.createEl('button', { text: '导出', cls: 'mod-cta' })
		const syncCount = (): void => {
			countEl.setText(`已选 ${selected.size} / ${this.annotations.length}`)
			ok.setText(`导出（${selected.size}）`)
			ok.disabled = selected.size === 0
		}
		syncCount()
		ok.addEventListener('click', () => {
			const name = nameInput.value.trim()
			if (select.value === '__new__' && !name) {
				new Notice('Grove Reader：请先给新画布起个名字')
				return
			}
			this.onExport({
				ids: [...selected],
				target: select.value === '__new__' ? '' : select.value,
				name,
			})
			this.close()
		})
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

export interface GlobalBookmarkHandlers {
	onJump: (row: GlobalBookmarkRow) => void
	onDelete: (row: GlobalBookmarkRow) => void
}

function bookmarkTime(ts: number): string {
	const d = new Date(ts || 0)
	if (!ts) return ''
	return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 全局书签：汇总所有书的书签，点击跳回书内位置，可搜索/删除 */
export class GlobalBookmarksModal extends Modal {
	private query = ''

	constructor(
		app: App,
		private getRows: () => GlobalBookmarkRow[],
		private handlers: GlobalBookmarkHandlers,
	) {
		super(app)
	}

	onOpen(): void {
		this.#render()
	}

	#render(): void {
		const { contentEl } = this
		contentEl.empty()
		contentEl.addClass('grove-global-bm')
		contentEl.createEl('h3', { text: '全局书签' })
		const all = this.getRows()
		const bookCount = new Set(all.map(r => r.bookPath)).size
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: all.length
				? `共 ${all.length} 条书签，分布在 ${bookCount} 本书里。点击条目跳回书内位置。`
				: '还没有书签。',
		})
		if (!all.length) {
			contentEl.createEl('p', { cls: 'grove-ann-empty', text: '在阅读时点工具栏的书签按钮，就能把当前位置记下来。' })
			this.#buttons()
			return
		}

		const input = contentEl.createEl('input', {
			type: 'search',
			cls: 'grove-global-bm-search',
			placeholder: '搜索书名 / 位置 / 片段',
		})
		input.value = this.query
		input.addEventListener('input', () => {
			this.query = input.value
			draw()
		})

		const list = contentEl.createDiv('grove-global-bm-list')
		const none = contentEl.createDiv('grove-ann-empty grove-hidden')
		none.setText('没有匹配的书签')

		const draw = (): void => {
			const rows = filterGlobalBookmarks(all, this.query)
			list.empty()
			none.toggleClass('grove-hidden', rows.length > 0)
			for (const row of rows) {
				const item = list.createDiv('grove-bm-item')
				const main = item.createDiv('grove-bm-main')
				main.createDiv('grove-bm-label').setText(row.bookTitle)
				main.createDiv('grove-bm-text').setText(
					`${row.bookmark.label || '未命名位置'}${row.bookmark.text ? ` · ${row.bookmark.text}` : ''}`,
				)
				main.addEventListener('click', () => {
					this.handlers.onJump(row)
					this.close()
				})
				item.createSpan('grove-bm-time').setText(bookmarkTime(row.bookmark.createdAt))
				const actions = item.createDiv('grove-bm-actions')
				const jump = actions.createEl('button', { cls: 'clickable-icon grove-mini-btn', attr: { 'aria-label': '跳到书签位置' } })
				setIcon(jump, 'arrow-up-left')
				jump.addEventListener('click', e => {
					e.stopPropagation()
					this.handlers.onJump(row)
					this.close()
				})
				const del = actions.createEl('button', { cls: 'clickable-icon grove-mini-btn', attr: { 'aria-label': '删除书签' } })
				setIcon(del, 'trash-2')
				del.addEventListener('click', e => {
					e.stopPropagation()
					this.handlers.onDelete(row)
					this.#render()
				})
			}
		}
		draw()
		this.#buttons()
	}

	#buttons(): void {
		const buttons = this.contentEl.createDiv('modal-button-container')
		const close = buttons.createEl('button', { text: '关闭', cls: 'mod-cta' })
		close.addEventListener('click', () => this.close())
	}

	onClose(): void {
		this.contentEl.empty()
	}
}
