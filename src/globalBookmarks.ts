/**
 * 全局书签列表：把各书 JSON 里的书签汇总成一张表，按添加时间倒序。
 * 纯函数，不依赖 Obsidian，便于 smoke 覆盖。
 */
import type { Bookmark } from './types'
import { basenameOf } from './util'

export interface GlobalBookmarkSource {
	bookPath: string
	/** 书架里的书名；空则退回文件名 */
	title?: string
	bookmarks?: Bookmark[]
}

export interface GlobalBookmarkRow {
	bookPath: string
	bookTitle: string
	bookmark: Bookmark
}

function titleOf(src: GlobalBookmarkSource): string {
	const title = (src.title ?? '').trim()
	if (title) return title
	return basenameOf(src.bookPath).replace(/\.[^.]+$/, '') || src.bookPath
}

/** 汇总 + 倒序（新加的在前）；同一时间戳时按书名稳定排序 */
export function collectGlobalBookmarks(sources: GlobalBookmarkSource[]): GlobalBookmarkRow[] {
	const rows: GlobalBookmarkRow[] = []
	for (const src of sources) {
		const bookTitle = titleOf(src)
		for (const bookmark of src.bookmarks ?? []) {
			if (!bookmark || typeof bookmark.cfi !== 'string') continue
			rows.push({ bookPath: src.bookPath, bookTitle, bookmark })
		}
	}
	return rows.sort((a, b) => {
		const d = (b.bookmark.createdAt || 0) - (a.bookmark.createdAt || 0)
		if (d !== 0) return d
		const t = a.bookTitle.localeCompare(b.bookTitle, 'zh')
		if (t !== 0) return t
		return a.bookmark.id.localeCompare(b.bookmark.id)
	})
}

/** 搜索：书名 / 位置名 / 片段，空格分词后逐个 AND 匹配 */
export function filterGlobalBookmarks(rows: GlobalBookmarkRow[], query: string): GlobalBookmarkRow[] {
	const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
	if (!words.length) return rows
	return rows.filter(row => {
		const hay = `${row.bookTitle}\n${row.bookmark.label ?? ''}\n${row.bookmark.text ?? ''}`.toLowerCase()
		return words.every(w => hay.includes(w))
	})
}
