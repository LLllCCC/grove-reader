/**
 * 间隔重复复习队列（SM-2 简化版）。
 *
 * 只挑「旧的」划线与批注：昨天及更早创建的才有资格进队列，当天刚划的不会立刻被考。
 * 纯函数，不依赖 Obsidian，便于 smoke 覆盖。
 */
import type { Annotation, ReviewState } from './types'
import { t } from './i18n'

export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy'

export const REVIEW_GRADE_LABELS: Record<ReviewGrade, string> = {
	again: '忘记',
	hard: '模糊',
	good: '记住',
	easy: '简单',
}

/** 复习卡片右下角的按键提示（与 ReviewModal 的键盘绑定一致） */
export const REVIEW_GRADE_KEYS: Record<ReviewGrade, string> = {
	again: '1',
	hard: '2',
	good: '3',
	easy: '4',
}

export const DAY_MS = 86_400_000
export const MIN_EASE = 1.3
export const MAX_EASE = 3
export const DEFAULT_EASE = 2.5

/** 一条待复习的划线 */
export interface ReviewQueueItem {
	bookPath: string
	bookTitle: string
	annotation: Annotation
}

export interface ReviewStats {
	/** 今天到期（含过期未复习）的条数 */
	due: number
	/** 昨天及更早、还没复习过的条数 */
	fresh: number
	/** 今天已经复习过的条数 */
	today: number
}

/** 本地时区的当天 0 点 */
export function startOfDay(ts: number): number {
	const d = new Date(ts)
	d.setHours(0, 0, 0, 0)
	return d.getTime()
}

/** 加 N 天并归到 0 点；用 Date 运算，跨夏令时也不会偏一小时 */
export function addDays(ts: number, days: number): number {
	const d = new Date(ts)
	d.setDate(d.getDate() + days)
	d.setHours(0, 0, 0, 0)
	return d.getTime()
}

function clampEase(ease: number): number {
	if (!Number.isFinite(ease)) return DEFAULT_EASE
	const clamped = Math.min(MAX_EASE, Math.max(MIN_EASE, ease))
	return Math.round(clamped * 100) / 100
}

/** 把可能是旧数据 / 手改坏的数据收拢成合法排期 */
export function normalizeReview(prev?: ReviewState): ReviewState | null {
	if (!prev || typeof prev !== 'object') return null
	const interval = Number.isFinite(prev.interval) && prev.interval > 0 ? Math.round(prev.interval) : 0
	const due = Number.isFinite(prev.due) ? startOfDay(prev.due) : 0
	const reps = Number.isFinite(prev.reps) && prev.reps > 0 ? Math.round(prev.reps) : 0
	const lapses = Number.isFinite(prev.lapses) && prev.lapses > 0 ? Math.round(prev.lapses) : 0
	if (!interval && !due) return null
	return {
		due,
		interval,
		ease: clampEase(prev.ease),
		reps,
		lapses,
		last: Number.isFinite(prev.last) ? prev.last : undefined,
	}
}

/**
 * 结算一次复习。
 *
 * 新卡（还没有排期）：忘记/模糊 → 1 天，记住 → 3 天，简单 → 7 天。
 * 老卡：模糊 ×1.2，记住 ×ease，简单 ×ease×1.3；忘记回到 1 天并扣 ease。
 */
export function nextReview(prev: ReviewState | undefined, grade: ReviewGrade, now: number): ReviewState {
	const base = normalizeReview(prev) ?? { due: 0, interval: 0, ease: DEFAULT_EASE, reps: 0, lapses: 0 }
	let interval: number
	let ease = base.ease
	let lapses = base.lapses

	switch (grade) {
		case 'again':
			interval = 1
			ease = base.ease - 0.2
			lapses = base.lapses + 1
			break
		case 'hard':
			interval = base.interval > 0 ? Math.max(1, Math.round(base.interval * 1.2)) : 1
			ease = base.ease - 0.15
			break
		case 'good':
			interval = base.interval > 0 ? Math.max(1, Math.round(base.interval * base.ease)) : 3
			break
		case 'easy':
			interval = base.interval > 0 ? Math.max(2, Math.round(base.interval * base.ease * 1.3)) : 7
			ease = base.ease + 0.15
			break
		default:
			interval = 1
	}

	return {
		due: addDays(now, interval),
		interval,
		ease: clampEase(ease),
		reps: base.reps + 1,
		lapses,
		last: now,
	}
}

/** 今天到期（含过期未复习） */
export function isDue(annotation: Annotation, now: number): boolean {
	const review = normalizeReview(annotation.review)
	if (!review) return false
	return review.due <= startOfDay(now)
}

/** 昨天及更早创建、还没复习过 → 可以当新卡排进队列 */
export function isFreshCandidate(annotation: Annotation, now: number): boolean {
	if (normalizeReview(annotation.review)) return false
	const created = Number.isFinite(annotation.createdAt) ? annotation.createdAt : 0
	if (!created) return false
	return startOfDay(created) < startOfDay(now)
}

/** 今天已经复习过几条（看 review.last 是否落在今天） */
export function reviewedToday(items: ReviewQueueItem[], now: number): number {
	const today = startOfDay(now)
	let n = 0
	for (const item of items) {
		const review = normalizeReview(item.annotation.review)
		if (!review?.last) continue
		if (startOfDay(review.last) === today) n++
	}
	return n
}

export function reviewStats(items: ReviewQueueItem[], now: number): ReviewStats {
	let due = 0
	let fresh = 0
	for (const item of items) {
		const a = item.annotation
		if (!a || typeof a.text !== 'string' || !a.text.trim()) continue
		if (isDue(a, now)) due++
		else if (isFreshCandidate(a, now)) fresh++
	}
	return { due, fresh, today: reviewedToday(items, now) }
}

/**
 * 挑出这一批要复习的条目：先到期最久的，再补旧划线。
 * 到期顺序按 due 升序，同一到期日按创建时间；新卡按创建时间从旧到新。
 */
export function pickReviewQueue(
	items: ReviewQueueItem[],
	now: number,
	limit: number,
	opts: { includeNew?: boolean } = {},
): ReviewQueueItem[] {
	const max = Math.max(0, Math.floor(limit))
	if (!max) return []
	const due: ReviewQueueItem[] = []
	const fresh: ReviewQueueItem[] = []
	for (const item of items) {
		const a = item.annotation
		if (!a || typeof a.text !== 'string' || !a.text.trim()) continue
		if (isDue(a, now)) {
			due.push(item)
			continue
		}
		if (opts.includeNew !== false && isFreshCandidate(a, now)) fresh.push(item)
	}
	due.sort((x, y) => {
		const dx = normalizeReview(x.annotation.review)!.due
		const dy = normalizeReview(y.annotation.review)!.due
		if (dx !== dy) return dx - dy
		return (x.annotation.createdAt || 0) - (y.annotation.createdAt || 0)
	})
	fresh.sort((x, y) => (x.annotation.createdAt || 0) - (y.annotation.createdAt || 0))
	return [...due, ...fresh].slice(0, max)
}

/** 到期日的说法：今天 / 明天 / N 天后 */
export function dueLabel(due: number, now: number): string {
	const diff = Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS)
	if (diff <= 0) return t('今天')
	if (diff === 1) return t('明天')
	return `${diff} 天后`
}
