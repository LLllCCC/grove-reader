import type { ViewStateResult } from 'obsidian'
import type { SourceSection } from '../portrait'
import type { BookData } from '../types'
import type { GroveLinkTarget } from '../wikilink'

/** 阅读引擎的三种实现：foliate 电子书、纯文本、PDF */
export type ReaderKind = 'ebook' | 'txt' | 'pdf'

/** 格式能力：共享 UI 用它决定哪些按钮/面板该出现 */
export interface ReaderCaps {
	/** 是否有可划选的文字 */
	text: boolean
	/** 是否有字体/背景/行距等可重排外观 */
	appearance: boolean
	/** 是否有缩放/适应宽度 */
	zoom: boolean
	/** 是否有编码选择 */
	encoding: boolean
	/** 纯图片书（CBZ）：没有正文 */
	imageOnly: boolean
}

/**
 * 三套阅读视图共同实现的契约。
 * 渲染、分页、定位仍由各引擎负责；共享工具栏/侧栏只依赖这份接口。
 */
export interface ReaderEngine {
	readonly bookPath: string
	readonly bookTitle: string
	readonly kind: ReaderKind
	readonly caps: ReaderCaps
	readonly ready: boolean

	snapshot(): BookData | null
	highlight(color: string): void
	comment(): void
	jumpTo(cfi: string, fallback?: GroveLinkTarget): void
	nextPage(): void
	prevPage(): void
	/** 停止朗读（没有在朗读时是空操作） */
	stopTts?(): void
	/** 收起 / 展开批注栏 */
	toggleSidebar?(): void
	refreshAnnotations(): void
	extractAiSections(onProgress?: (done: number, total: number) => void): Promise<SourceSection[]>
	getState(): Record<string, unknown>
	setState(state: unknown, result?: ViewStateResult): Promise<void>
}

export function isReaderEngine(value: unknown): value is ReaderEngine {
	if (!value || typeof value !== 'object') return false
	const v = value as Partial<ReaderEngine>
	return typeof v.bookPath === 'string'
		&& typeof v.jumpTo === 'function'
		&& typeof v.nextPage === 'function'
		&& typeof v.extractAiSections === 'function'
}
