// 书架虚拟化的窗口数学（纯函数）。
// 抽出来是为了能进 npm run smoke：jsdom 没有排版引擎，真实 DOM 测不出
// 「滚动到中部少一行 / spacer 撑错高度」这类问题。

export interface ShelfWindowInput {
	scrollTop: number
	clientHeight: number
	/** 网格顶部相对滚动内容起点的距离（px） */
	gridTop: number
	columns: number
	rowHeight: number
	itemCount: number
	/** 视口上下各多渲染几行，默认 3 */
	overscanRows?: number
}

export interface ShelfWindow {
	/** 首个要渲染的卡片下标 */
	start: number
	/** 最后一个要渲染的卡片下标（不含） */
	end: number
	startRow: number
	endRow: number
	/** 上方 spacer 撑起的行数 */
	topRows: number
	/** 下方 spacer 撑起的行数 */
	bottomRows: number
	totalRows: number
}

const CARD_GAP = 16
const MIN_CARD_WIDTH = 120

function positive(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? value : fallback
}

/** 行高估算：卡片宽 × 1.5（封面 + 文字）+ 96；拿到真实卡片后会被实测值覆盖 */
export function estimateRowHeight(gridWidth: number, columns: number): number {
	const cols = Math.max(1, Math.floor(positive(columns, 1)))
	const width = Number.isFinite(gridWidth) && gridWidth > 0 ? gridWidth : 0
	const cardWidth = Math.max(MIN_CARD_WIDTH, (width - (cols - 1) * CARD_GAP) / cols)
	return cardWidth * 1.5 + 96
}

/** spacer 高度：n 行卡片 + 行间隙，最后一行后面不留 gap */
export function spacerHeight(rows: number, rowHeight: number): number {
	if (!Number.isFinite(rows) || rows <= 0) return 0
	const height = positive(rowHeight, 1)
	return Math.max(0, rows * height - CARD_GAP)
}

export function computeShelfWindow(input: ShelfWindowInput): ShelfWindow {
	const itemCount = Number.isFinite(input.itemCount) ? Math.max(0, Math.floor(input.itemCount)) : 0
	if (!itemCount) return { start: 0, end: 0, startRow: 0, endRow: 0, topRows: 0, bottomRows: 0, totalRows: 0 }

	const cols = Math.max(1, Math.floor(positive(input.columns, 1)))
	const rowHeight = positive(input.rowHeight, 1)
	const overscanRaw = input.overscanRows ?? 3
	const overscan = Number.isFinite(overscanRaw) ? Math.max(0, Math.floor(overscanRaw)) : 3
	const totalRows = Math.ceil(itemCount / cols)

	const scrollTop = Number.isFinite(input.scrollTop) ? input.scrollTop : 0
	const gridTop = Number.isFinite(input.gridTop) ? input.gridTop : 0
	const clientHeight = Number.isFinite(input.clientHeight) ? Math.max(0, input.clientHeight) : 0
	const rel = Math.max(0, scrollTop - gridTop)

	// 多算一行，避免底部露白
	const visibleRows = Math.max(1, Math.ceil(clientHeight / rowHeight)) + 1
	const maxFirstRow = Math.max(0, totalRows - visibleRows)
	const firstRow = Math.min(Math.max(0, Math.floor(rel / rowHeight)), maxFirstRow)
	const startRow = Math.max(0, firstRow - overscan)
	const endRow = Math.min(totalRows, firstRow + visibleRows + overscan)
	const start = startRow * cols
	const end = Math.min(itemCount, endRow * cols)

	return {
		start,
		end,
		startRow,
		endRow,
		topRows: startRow,
		bottomRows: Math.max(0, totalRows - Math.ceil(end / cols)),
		totalRows,
	}
}
