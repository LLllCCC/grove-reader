/**
 * 复习弹窗：一次只出一张卡（摘录 + 章节 + 我的评论），四个评分键决定下次到期。
 * 排期逻辑在 review.ts（纯函数，smoke 覆盖），这里只管交互。
 */
import { App, Modal } from 'obsidian'
import type { ReviewGrade, ReviewQueueItem } from './review'
import { REVIEW_GRADE_KEYS, REVIEW_GRADE_LABELS, dueLabel } from './review'
import { IMPORT_SOURCE_LABELS, colorCss } from './types'
import { t } from './i18n'

export interface ReviewModalHandlers {
	/** 评分落库（由插件写回批注 JSON） */
	onGrade: (item: ReviewQueueItem, grade: ReviewGrade) => void
	/** 回原文（打开书并跳到这条划线的位置） */
	onJump: (item: ReviewQueueItem) => void
	/** 复习时补写 / 修改评论；保存后调用 done 重绘卡片 */
	onComment: (item: ReviewQueueItem, done: () => void) => void
	/** 「再来一批」：返回下一批；空数组表示今天没有更多了 */
	getNext: () => ReviewQueueItem[]
	/** 关闭后通知外部刷新到期数徽标 */
	onClose?: () => void
}

export interface ReviewModalData {
	queue: ReviewQueueItem[]
	/** 每日上限；0 = 不设上限 */
	dailyCap: number
	/** 打开弹窗时今天已复习的条数 */
	reviewedToday: number
	/** 有值时是「只复习本书」模式：不显示每日目标，进度按本书队列算 */
	scopeTitle?: string
}

const GRADES: ReviewGrade[] = ['again', 'hard', 'good', 'easy']

export class ReviewModal extends Modal {
	#items: ReviewQueueItem[]
	#index = 0
	#graded = 0
	#skipped = 0
	#tally: Record<ReviewGrade, number> = { again: 0, hard: 0, good: 0, easy: 0 }
	#nextDue = 0
	#finished = false

	constructor(
		app: App,
		private data: ReviewModalData,
		private handlers: ReviewModalHandlers,
	) {
		super(app)
		this.#items = [...data.queue]
	}

	onOpen(): void {
		this.modalEl.addClass('grove-review-modal')
		this.scope.register([], REVIEW_GRADE_KEYS.again, ev => this.#gradeKey(ev, 'again'))
		this.scope.register([], REVIEW_GRADE_KEYS.hard, ev => this.#gradeKey(ev, 'hard'))
		this.scope.register([], REVIEW_GRADE_KEYS.good, ev => this.#gradeKey(ev, 'good'))
		this.scope.register([], REVIEW_GRADE_KEYS.easy, ev => this.#gradeKey(ev, 'easy'))
		this.scope.register([], 'n', ev => {
			ev.preventDefault()
			this.#skip()
			return false
		})
		this.scope.register([], 'o', ev => {
			ev.preventDefault()
			this.#jump()
			return false
		})
		this.scope.register([], 'e', ev => {
			ev.preventDefault()
			this.#comment()
			return false
		})
		this.#render()
	}

	onClose(): void {
		this.contentEl.empty()
		this.handlers.onClose?.()
	}

	#gradeKey(ev: KeyboardEvent, grade: ReviewGrade): false {
		ev.preventDefault()
		this.#grade(grade)
		return false
	}

	#current(): ReviewQueueItem | null {
		return this.#items[this.#index] ?? null
	}

	#grade(grade: ReviewGrade): void {
		const item = this.#current()
		if (!item) return
		this.handlers.onGrade(item, grade)
		this.#tally[grade]++
		this.#graded++
		const due = item.annotation.review?.due
		if (due && (!this.#nextDue || due < this.#nextDue)) this.#nextDue = due
		this.#index++
		this.#render()
	}

	#skip(): void {
		if (!this.#current()) return
		this.#skipped++
		this.#index++
		this.#render()
	}

	#jump(): void {
		const item = this.#current()
		if (!item) return
		this.handlers.onJump(item)
		this.close()
	}

	#comment(): void {
		const item = this.#current()
		if (!item) return
		this.handlers.onComment(item, () => this.#render())
	}

	#render(): void {
		const { contentEl } = this
		contentEl.empty()
		contentEl.addClass('grove-review')
		const item = this.#current()
		if (!item) this.#finished = true
		const capText = this.data.dailyCap ? ` / 目标 ${this.data.dailyCap} 条` : ''
		const doneToday = this.data.reviewedToday + this.#graded
		const scope = this.data.scopeTitle
		const scopeLabel = scope ? (scope.startsWith('《') ? scope : `《${scope}》`) : ''
		contentEl.createEl('h3', { text: scope ? t('复习本书') : t('今日复习'), cls: 'grove-review-title' })
		contentEl.createEl('p', {
			cls: 'grove-review-meta',
			text: scope
				? (this.#finished
					? `${scopeLabel} · 本轮复习 ${this.#graded} 条`
					: `${scopeLabel} · 第 ${Math.min(this.#index + 1, this.#items.length)} / ${this.#items.length} 条`)
				: (this.#finished
					? `今天已复习 ${doneToday} 条${capText}`
					: t('第 {i} / {total} 条 · 今天已复习 {done} 条{cap}', { i: Math.min(this.#index + 1, this.#items.length), total: this.#items.length, done: doneToday, cap: capText })),
		})

		if (!item) {
			this.#renderSummary(contentEl)
			return
		}

		const bar = contentEl.createDiv('grove-review-bar')
		const fill = bar.createDiv('grove-review-bar-fill')
		fill.style.width = `${Math.round((this.#index / Math.max(1, this.#items.length)) * 100)}%`

		const a = item.annotation
		const card = contentEl.createDiv('grove-review-card')
		card.style.borderLeftColor = colorCss(a.color)
		const src = card.createDiv('grove-review-src')
		src.createSpan({ cls: 'grove-review-book', text: `《${item.bookTitle}》` })
		if (a.chapter) src.createSpan({ cls: 'grove-review-chapter', text: a.chapter })
		if (a.source && IMPORT_SOURCE_LABELS[a.source]) {
			src.createSpan({ cls: 'grove-review-source', text: t(IMPORT_SOURCE_LABELS[a.source]) })
		}
		card.createDiv({ cls: 'grove-review-text', text: a.text.trim() })
		const note = (a.note ?? '').trim()
		if (note) {
			const noteEl = card.createDiv('grove-review-note')
			noteEl.createSpan({ cls: 'grove-review-note-label', text: t('我的评论') })
			noteEl.createSpan({ cls: 'grove-review-note-text', text: note })
		}

		const actions = contentEl.createDiv('grove-review-actions')
		for (const grade of GRADES) {
			const btn = actions.createEl('button', {
				cls: `grove-review-btn grove-review-${grade}`,
				attr: { type: 'button', 'data-grade': grade },
			})
			btn.createSpan({ text: t(REVIEW_GRADE_LABELS[grade]) })
			btn.createEl('kbd', { text: REVIEW_GRADE_KEYS[grade] })
			btn.addEventListener('click', () => this.#grade(grade))
		}

		const foot = contentEl.createDiv('grove-review-foot')
		const jump = foot.createEl('button', { cls: 'grove-review-link', attr: { type: 'button' } })
		jump.setText(t('回原文'))
		jump.addEventListener('click', () => this.#jump())
		const comment = foot.createEl('button', { cls: 'grove-review-link', attr: { type: 'button' } })
		comment.setText(a.note ? t('改想法') : t('写想法'))
		comment.addEventListener('click', () => this.#comment())
		const skip = foot.createEl('button', { cls: 'grove-review-link', attr: { type: 'button' } })
		skip.setText(t('跳过这条'))
		skip.addEventListener('click', () => this.#skip())
		foot.createSpan({ cls: 'grove-review-hint', text: t('键盘：1–4 评分 · E 写想法 · N 跳过 · O 回原文') })
	}

	#renderSummary(contentEl: HTMLElement): void {
		this.#finished = true
		const box = contentEl.createDiv('grove-review-summary')
		box.createEl('h4', { text: `本轮复习完成：${this.#graded} 条` })
		const parts: string[] = []
		for (const grade of GRADES) {
			if (this.#tally[grade]) parts.push(`${t(REVIEW_GRADE_LABELS[grade])} ${this.#tally[grade]}`)
		}
		if (this.#skipped) parts.push(`跳过 ${this.#skipped}`)
		if (parts.length) box.createEl('p', { cls: 'grove-review-tally', text: parts.join(' · ') })
		if (this.#nextDue) {
			box.createEl('p', {
				cls: 'grove-review-meta',
				text: `最早下次到期：${dueLabel(this.#nextDue, Date.now())}。间隔会随「记住 / 简单」逐步拉长。`,
			})
		}

		const next = this.handlers.getNext()
		const actions = contentEl.createDiv('grove-review-summary-actions')
		if (next.length) {
			const more = actions.createEl('button', { cls: 'mod-cta', text: `再来一批（${next.length} 条）`, attr: { type: 'button' } })
			more.addEventListener('click', () => {
				this.#items = next
				this.#index = 0
				this.#skipped = 0
				this.#finished = false
				this.#render()
			})
		} else {
			box.createEl('p', { cls: 'grove-review-empty', text: this.data.scopeTitle
				? t('这本书今天没有更多可复习的划线了。')
				: t('今天没有更多到期的划线和旧摘录了，明天再来。') })
		}
		const close = actions.createEl('button', { text: t('关闭'), attr: { type: 'button' } })
		close.addEventListener('click', () => this.close())
	}
}
