export const DATA_VERSION = 1

/** 库内备份文件夹名（「备份批注数据到库内」命令生成） */
export const BACKUP_FOLDER_NAME = 'Grove Reader 数据备份'

export const SUPPORTED_BOOK_EXTS = ['epub', 'mobi', 'azw3', 'fb2', 'fbz', 'cbz']

/**
 * 书架额外收纳、但不在插件内阅读的扩展名（目前是 PDF）。
 * 这些文件由 Obsidian 原生视图或系统程序打开；
 * 不能加进 registerExtensions，否则会接管/破坏原生打开行为。
 */
export const SHELF_EXTRA_EXTS = ['pdf']

export function isShelfExt(ext: string): boolean {
	const e = ext.toLowerCase()
	return SUPPORTED_BOOK_EXTS.includes(e) || SHELF_EXTRA_EXTS.includes(e)
}

/** 该扩展名是否由 Grove Reader 自己渲染（决定书架卡片点击后的去向） */
export function isReaderExt(ext: string): boolean {
	return SUPPORTED_BOOK_EXTS.includes(ext.toLowerCase())
}

export const HIGHLIGHT_COLORS = [
	{ key: 'yellow', name: '黄', css: '#ffe066' },
	{ key: 'green', name: '绿', css: '#8ce99a' },
	{ key: 'blue', name: '蓝', css: '#74c0fc' },
	{ key: 'red', name: '红', css: '#ffa8a8' },
	{ key: 'purple', name: '紫', css: '#d0bfff' },
] as const

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]['key']

export function colorCss(key: string): string {
	return HIGHLIGHT_COLORS.find(c => c.key === key)?.css ?? HIGHLIGHT_COLORS[0].css
}

export function colorName(key: string): string {
	return HIGHLIGHT_COLORS.find(c => c.key === key)?.name ?? key
}

export interface Annotation {
	id: string
	/** 范围 CFI（电子书）或 `page:N`（PDF），定位原文 */
	cfi: string
	/** 划选的原文文本 */
	text: string
	color: string
	note?: string
	chapter?: string
	/** 所在 spine section / PDF 页码，用于笔记排序 */
	sectionIndex?: number
	/** PDF 专属：页码与归一化高亮矩形（相对页面宽高 0–1） */
	pdf?: { page: number; rects: Array<{ l: number; t: number; w: number; h: number }> }
	createdAt: number
	updatedAt: number
}

export interface LastLocation {
	cfi: string
	index: number
	fraction?: number
	/** PDF：当前页码 */
	page?: number
	updatedAt: number
}

export interface BookData {
	version: number
	/** 库内相对路径；库外书为绝对路径。作为打开与找回的标识 */
	bookPath: string
	/** 'pdf'（由打开时自动写入）或缺省（电子书） */
	kind?: 'ebook' | 'pdf'
	title: string
	author: string
	/** 生成的阅读笔记路径（库内相对路径） */
	notePath?: string
	lastLocation?: LastLocation
	annotations: Annotation[]
}

// ------------------------------------------------------------------
// 阅读外观（微信读书风格的可调项）
// ------------------------------------------------------------------

export interface BackgroundPreset {
	key: string
	name: string
	bg: string
	fg: string
}

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
	{ key: 'white', name: '纸白', bg: '#ffffff', fg: '#2b2b2b' },
	{ key: 'sepia', name: '米黄', bg: '#f5efdc', fg: '#4a3b2a' },
	{ key: 'green', name: '护眼', bg: '#cde6d0', fg: '#2c3a2f' },
	{ key: 'night', name: '夜间', bg: '#191b1d', fg: '#b9bdc2' },
]

export interface ReaderAppearance {
	/** 背景跟随 Obsidian 明暗主题 */
	followTheme: boolean
	/** BACKGROUND_PRESETS 的 key，或 'custom' */
	bgKey: string
	/** 自定义背景色（hex），bgKey = 'custom' 时生效 */
	customBg: string
	/** CSS font-family 值；空串 = 跟随书籍/主题 */
	fontFamily: string
	/** 字号百分比，80–180 */
	fontSize: number
	/** 行距倍数，1.2–2.4 */
	lineHeight: number
	/** 上下留白 px，0–200 */
	pageMargin: number
	/** 版心最大宽度 px，480–1200 */
	maxInlineSize: number
	/** 段间距 em，0 = 跟随书籍 */
	paragraphSpacing: number
}

export const DEFAULT_APPEARANCE: ReaderAppearance = {
	followTheme: true,
	bgKey: 'white',
	customBg: '#ffffff',
	fontFamily: '',
	fontSize: 100,
	lineHeight: 1.65,
	pageMargin: 48,
	maxInlineSize: 700,
	paragraphSpacing: 0,
}

// ------------------------------------------------------------------

export interface GroveSettings {
	notesFolder: string
	/** 笔记模板文件路径（库内相对路径）；不存在时使用内置默认模板 */
	noteTemplatePath: string
	maxBackups: number
	/** 书架扫描文件夹（库内相对路径或本机绝对路径） */
	scanFolders: string[]
	/** 书架排序：default / added / title / progress */
	shelfSort: string
	/** 打开书本时是否自动展开右侧批注列表 */
	openSidebarWithBook: boolean
	/** 新增/修改批注时，自动刷新已生成的阅读笔记（标记区外手写内容保留） */
	autoUpdateNote: boolean
	/** 「备份批注数据到库内」执行时额外复制一份的本机路径（另一块盘/优盘）；空 = 关闭 */
	backupTargetDir?: string
	appearance: ReaderAppearance
}

export const DEFAULT_SETTINGS: GroveSettings = {
	notesFolder: '阅读笔记',
	noteTemplatePath: '阅读笔记/Grove 笔记模板.md',
	maxBackups: 10,
	scanFolders: [],
	shelfSort: 'default',
	openSidebarWithBook: true,
	autoUpdateNote: true,
	appearance: { ...DEFAULT_APPEARANCE },
}
