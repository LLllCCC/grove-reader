/**
 * 「本页引用」过滤：从全书的引用分组里只留下指向某个定位（如 `page:3`）的行。
 * 独立成不依赖 obsidian 的模块，便于 smoke 覆盖。
 */
import { parseGroveHref } from './wikilink'

interface BacklinkRowLike {
	target: { cfi?: string }
	links: Array<{ link?: string | null }>
}

export function filterBacklinkGroupsByCfi<G extends { chapter: string; rows: BacklinkRowLike[] }>(
	groups: G[],
	cfi: string,
): G[] {
	const key = cfi.trim()
	if (!key) return []
	const out: G[] = []
	for (const group of groups) {
		const rows = group.rows.filter(row =>
			row.target.cfi === key
			|| row.links.some(link => parseGroveHref(link.link ?? '')?.target.cfi === key),
		)
		if (rows.length) out.push({ ...group, rows })
	}
	return out
}
