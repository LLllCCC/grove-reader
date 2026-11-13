/**
 * AI 按章导读。
 *
 * 和全书问答的「6000 字要点块」不同，这里以章节为单位：
 *   EPUB → spine 里的每一节（目录标签）；TXT → 识别出的章；PDF → 每页一组。
 * 章节太碎就相邻合并，章节太大就按段落拆开，保证一章一次 AI 请求。
 * 结果按书落盘：<数据目录>/guides/<书 id>.json。
 */
import type { PlatformIO } from './platformIO'
import { joinPath, writeJsonFile } from './platformIO'
import { normalizeText, type SourceSection } from './portrait'

export interface GuideItem {
	index: number
	label: string
	summary: string
	/** 生成时这一章的正文长度，续建/失效时用来判断书有没有变 */
	chars: number
	/** 原文定位：PDF 用 page:N；EPUB/TXT 留空，靠 chapter + pct 降级 */
	cfi: string
	/** 章节起点在全书中的位置 0..1 */
	pct: number
}

export interface GuideDoc {
	version: 1
	bookPath: string
	title: string
	createdAt: number
	updatedAt: number
	status: 'ready' | 'partial'
	items: GuideItem[]
}

/** 一章最多交给 AI 多少字（超出只取头尾） */
export const GUIDE_TEXT_CHARS = 6000
/** 一本书最多生成多少章导读，超过就相邻合并 */
export const MAX_GUIDES = 60

/** 送给 AI 之前的截断：保留开头与结尾，中间省略 */
export function guidePromptText(text: string, max = GUIDE_TEXT_CHARS): string {
	const body = normalizeText(text)
	if (body.length <= max) return body
	const head = Math.max(1, Math.floor(max * 0.7))
	const tail = Math.max(1, max - head)
	return `${body.slice(0, head)}\n…（中间省略）…\n${body.slice(body.length - tail)}`
}

/** 规划阶段的一章：比落盘的 GuideItem 多一份正文，生成时用，不写进 JSON */
export interface GuideUnit extends GuideItem {
	text: string
}

/** 长章节按段落/句号切开，避免一次请求塞整章 */
function splitLongText(text: string, limit: number): string[] {
	const out: string[] = []
	let rest = text
	while (rest.length > limit) {
		const window = rest.slice(0, limit)
		let cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'))
		if (cut < limit * 0.5) {
			cut = Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'))
		}
		if (cut < limit * 0.5) cut = limit - 1
		out.push(rest.slice(0, cut + 1).trim())
		rest = rest.slice(cut + 1).trimStart()
	}
	if (rest.trim()) out.push(rest.trim())
	return out.filter(Boolean)
}

/** 「第 12 页」这种标签换成 PDF 的 page:N 定位串 */
function pageCfi(label: string): string {
	const m = label.match(/^第\s*(\d+)\s*页$/)
	return m ? `page:${m[1]}` : ''
}

/**
 * 把各节正文整理成「一章一次请求」的单元。
 * 空节丢掉；超大节拆开；节数超过 maxGuides 时把相邻节合并成一组。
 */
export function planGuideUnits(
	sections: SourceSection[],
	maxGuides = MAX_GUIDES,
	maxChars = GUIDE_TEXT_CHARS,
): GuideUnit[] {
	const parts = sections
		.map(s => ({ label: (s.label ?? '').trim() || '正文', text: normalizeText(s.text) }))
		.filter(s => !!s.text)
	if (!parts.length) return []

	const pieces: Array<{ label: string; text: string; cfi: string }> = []
	for (const part of parts) {
		if (part.text.length <= maxChars) {
			pieces.push({ ...part, cfi: pageCfi(part.label) })
			continue
		}
		const split = splitLongText(part.text, maxChars)
		split.forEach((text, i) => {
			pieces.push({
				label: i === 0 ? part.label : `${part.label} · 续 ${i + 1}`,
				text,
				cfi: i === 0 ? pageCfi(part.label) : '',
			})
		})
	}

	let units = pieces
	if (units.length > maxGuides) {
		const groupSize = Math.ceil(units.length / maxGuides)
		units = []
		for (let i = 0; i < pieces.length; i += groupSize) {
			const group = pieces.slice(i, i + groupSize)
			const label = group.length > 1
				? `${group[0].label} ~ ${group[group.length - 1].label}`
				: group[0].label
			units.push({ label, text: group.map(g => g.text).join('\n\n'), cfi: group[0].cfi })
		}
	}

	const total = units.reduce((n, unit) => n + unit.text.length, 0)
	let seen = 0
	return units.map((unit, index) => {
		const pct = total ? seen / total : 0
		seen += unit.text.length
		return {
			index,
			label: unit.label,
			summary: '',
			chars: unit.text.length,
			cfi: unit.cfi || pageCfi(unit.label),
			pct,
			text: unit.text,
		}
	})
}

/** 续建：只复用「下标连续 + 章节名/长度都对得上」的前缀 */
export function resumableGuideItems(doc: GuideDoc | null, planned: GuideItem[]): GuideItem[] {
	if (!doc || doc.status !== 'partial' || !doc.items.length || !planned.length) return []
	const reusable: GuideItem[] = []
	const limit = Math.min(doc.items.length, planned.length)
	for (let i = 0; i < limit; i++) {
		const old = doc.items[i]
		const next = planned[i]
		if (!old || old.index !== i) break
		if (!old.summary) break
		if (old.label !== next.label) break
		if (old.chars !== next.chars) break
		reusable.push(old)
	}
	return reusable
}

export function guidePath(dataRoot: string, bookId: string): string {
	return joinPath(dataRoot, 'guides', `${bookId}.json`)
}

export async function loadGuide(io: PlatformIO, dataRoot: string, bookId: string): Promise<GuideDoc | null> {
	if (!bookId) return null
	const path = guidePath(dataRoot, bookId)
	try {
		if (!(await io.exists(path))) return null
		const raw = JSON.parse(await io.read(path)) as GuideDoc
		if (!raw || raw.version !== 1 || !Array.isArray(raw.items)) return null
		return raw
	} catch {
		return null
	}
}

export async function saveGuide(io: PlatformIO, dataRoot: string, bookId: string, doc: GuideDoc): Promise<void> {
	if (!bookId) return
	await writeJsonFile(io, guidePath(dataRoot, bookId), doc)
}

export async function removeGuide(io: PlatformIO, dataRoot: string, bookId: string): Promise<void> {
	if (!bookId) return
	try {
		await io.remove(guidePath(dataRoot, bookId))
	} catch {
		// 不存在就算了
	}
}

/** 书改名/移动时把导读迁到新 id 下 */
export async function moveGuide(
	io: PlatformIO,
	dataRoot: string,
	fromId: string,
	toId: string,
	newBookPath?: string,
): Promise<void> {
	if (!fromId || !toId || fromId === toId) return
	const doc = await loadGuide(io, dataRoot, fromId)
	if (!doc) return
	if (newBookPath) doc.bookPath = newBookPath
	doc.updatedAt = Date.now()
	await saveGuide(io, dataRoot, toId, doc)
	await removeGuide(io, dataRoot, fromId)
}
