export const DATA_VERSION = 1

/** 插件对外显示名（manifest 里的 name 与此保持一致） */
export const APP_NAME = 'Grove Reader'

/** 本库把书籍/笔记/数据统一放在这个根目录下（库内相对路径） */
export const LIBRARY_ROOT = 'Grove Reader'

/** 迁移前的旧目录名：仅用于启动时识别被旧实例写回的设置 */
export const LEGACY_LIBRARY_ROOT = '林间书屋'

/** 库内备份文件夹名（「备份批注数据到库内」命令生成） */
export const BACKUP_FOLDER_NAME = 'Grove Reader 数据备份'

export const SUPPORTED_BOOK_EXTS = ['epub', 'mobi', 'azw3', 'fb2', 'fbz', 'cbz']

/**
 * PDF 视图类型放在这里，是因为 pdfView 只在桌面端动态加载：
 * main.ts 需要在不 import pdfView 的前提下判断叶子是不是 PDF 视图。
 */
export const VIEW_TYPE_GROVE_PDF = 'grove-pdf-view'

/** 书架卡片上的格式标签文案（含 PDF；PDF 不在插件内渲染，但同为「书的格式」） */
export const FORMAT_LABELS: Record<string, string> = {
	epub: 'EPUB',
	mobi: 'MOBI',
	azw3: 'AZW3',
	fb2: 'FB2',
	fbz: 'FB2',
	cbz: 'CBZ',
	pdf: 'PDF',
	txt: 'TXT',
}

/**
 * 书架额外收纳、但不在插件内按电子书解析的扩展名（目前是 PDF、TXT）。
 * PDF 由 Obsidian 原生视图或系统程序打开；TXT 由 Grove Reader 的纯文本视图打开。
 * 不能把 txt 加进 registerExtensions，否则会接管全局 .txt 打开行为。
 */
export const SHELF_EXTRA_EXTS = ['pdf', 'txt']

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
	/** 外部导入来源；本地划线的批注没有该字段 */
	source?: 'kindle' | 'readwise' | 'weread'
	/** 外部来源里的位置串（如 Kindle 的「位置 1234-1236」） */
	location?: string
	/** 间隔重复复习状态；没有该字段表示还没复习过 */
	review?: ReviewState
	createdAt: number
	updatedAt: number
}

/**
 * 一条划线的复习排期（SM-2 简化版）。
 * 存在批注对象里，随批注一起跨设备合并与备份，不新增文件。
 */
export interface ReviewState {
	/** 下次到期日（当天 0 点的时间戳） */
	due: number
	/** 当前间隔（天） */
	interval: number
	/** 难度系数（1.3–3.0，越小越难） */
	ease: number
	/** 复习次数 */
	reps: number
	/** 忘记次数 */
	lapses: number
	/** 上次复习时间戳 */
	last?: number
}

/** 外部标注来源的显示名 */
export const IMPORT_SOURCE_LABELS: Record<string, string> = {
	kindle: 'Kindle',
	readwise: 'Readwise',
	weread: '微信读书',
}

/** 书签：只记位置，不含原文（与划线批注分开存） */
export interface Bookmark {
	id: string
	/** 与 Annotation.cfi 同一套定位：电子书是 CFI / `txt:<offset>`，PDF 是 `page:N` */
	cfi: string
	/** 列表里显示的位置名：章节名或「第 N 页」 */
	label?: string
	/** 加书签时那一段的开头，帮助回忆为什么标记 */
	text?: string
	createdAt: number
}

export interface LastLocation {
	cfi: string
	index: number
	fraction?: number
	/** PDF：当前页码 */
	page?: number
	updatedAt: number
}

/** PDF 每本记住的视图偏好（不影响电子书/TXT） */
export interface PdfViewPrefs {
	zoomMode?: 'fit-width' | 'fit-page' | 'actual' | 'custom'
	/** custom 模式下的缩放倍数（相对适合宽度） */
	zoom?: number
	flow?: 'scroll' | 'paged'
	spread?: boolean
	rotation?: 0 | 90 | 180 | 270
}

/** 手动阅读状态；未设置时按阅读进度自动判断 */
export type ReadingStatus = 'want' | 'reading' | 'done' | 'unread'

export const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
	reading: '在读',
	want: '想读',
	done: '读完',
	unread: '未读',
}

/** 右键菜单与筛选下拉的顺序 */
export const READING_STATUS_ORDER: ReadingStatus[] = ['reading', 'want', 'done', 'unread']

export interface BookData {
	version: number
	/** 库内相对路径；库外书为绝对路径。作为打开与找回的标识 */
	bookPath: string
	/** 'pdf'（由打开时自动写入）或缺省（电子书） */
	kind?: 'ebook' | 'pdf'
	title: string
	author: string
	/** 分类（手动填写或 AI 补全） */
	category?: string
	/** 一句话简介 */
	intro?: string
	/** 个人评分 1–5；缺省 = 未评分 */
	rating?: number
	/** ISBN（手动填写；随笔记录进笔记 frontmatter） */
	isbn?: string
	/** AI 补全标记；手动改过对应字段后清掉 */
	aiMeta?: { author?: boolean; category?: boolean; intro?: boolean; at?: number }
	/** 书架手动标记的阅读状态；缺省按进度自动判断 */
	readingStatus?: ReadingStatus
	/** 生成的阅读笔记路径（库内相对路径） */
	notePath?: string
	/** 本书单独使用的笔记模板 id；空 = 跟随默认模板 */
	templateId?: string
	lastLocation?: LastLocation
	annotations: Annotation[]
	/** 书签；旧数据没有该字段（读取时补空数组） */
	bookmarks?: Bookmark[]
	/** 跨设备合并用的删除墓碑：批注 id → 删除时间；防止另一台设备把已删批注写回来 */
	deletedAnnotations?: Record<string, number>
	/** 书签删除墓碑：书签 id → 删除时间 */
	deletedBookmarks?: Record<string, number>
	/** PDF 专属：缩放档/翻页方式/单双页/旋转，按书记忆 */
	pdfView?: PdfViewPrefs
}

/** 一套可命名的笔记模板；path 为库内 Markdown 路径 */
export interface NoteTemplate {
	id: string
	name: string
	path: string
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
	{ key: 'green', name: '护眼', bg: '#c0edc6', fg: '#2c3a2f' },
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
	/** 鼠标滚轮上下滚动时翻页（仅 EPUB 分页视图） */
	wheelPageTurn: boolean
	/** EPUB 正文分栏：0 = 跟随窗口，1 = 单栏，2 = 双栏（窄屏仍会自动单栏） */
	epubColumns: 0 | 1 | 2
	/** EPUB 翻页方式：分页 / 连续滚动 */
	epubFlow: 'paginated' | 'scrolled'
	/** EPUB 竖排（从右往左）；仅对支持排版的电子书生效 */
	epubVertical: boolean
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
	wheelPageTurn: true,
	epubColumns: 0,
	epubFlow: 'paginated',
	epubVertical: false,
}

// ------------------------------------------------------------------
// 书架卡片展示
// ------------------------------------------------------------------

/** 书籍在书架卡片上展示的统计信息（由批注 JSON + 阅读统计汇总而来） */
export interface ShelfBookInfo {
	/** 批注条数 */
	annotations: number
	/** 写了想法的批注条数 */
	thoughts?: number
	/** 阅读位置占比 0–1 */
	fraction?: number
	/** 最近一次阅读时间戳 */
	lastRead?: number
	/** 累计阅读秒数 */
	seconds?: number
	/** 已生成的阅读笔记路径（文件存在时才给） */
	notePath?: string
	/** 书架手动标记的阅读状态 */
	readingStatus?: ReadingStatus
}

export interface ShelfDisplaySettings {
	/** 格式徽章（EPUB / PDF / MOBI…） */
	showFormatBadge: boolean
	/** 阅读进度：封面底部进度条 + 卡片百分比 */
	showProgress: boolean
	/** 批注条数 */
	showAnnotationCount: boolean
	/** 最近阅读时间（3 天前） */
	showLastRead: boolean
	/** 已生成笔记的标记（点击打开笔记） */
	showNoteBadge: boolean
	/** 文件大小（默认关闭，tooltip 里始终有） */
	showFileSize: boolean
	/** 顶部「继续阅读」条 */
	showContinueReading: boolean
	/** 作者与出版社合并成一行 */
	mergeAuthorPublisher: boolean
	/** 书单归属色条 */
	showListColor: boolean
}

export const DEFAULT_SHELF_DISPLAY: ShelfDisplaySettings = {
	showFormatBadge: true,
	showProgress: true,
	showAnnotationCount: true,
	// 最近阅读默认关闭：顶部的「继续阅读」已经承担了「最近在读」的信息，
	// 卡片上再放一行相对时间会把信息行挤成两行
	showLastRead: false,
	showNoteBadge: true,
	showFileSize: false,
	showContinueReading: true,
	mergeAuthorPublisher: true,
	showListColor: false,
}

// ------------------------------------------------------------------

export interface GroveSettings {
	notesFolder: string
	/** 笔记模板文件路径（库内相对路径）；不存在时使用内置默认模板 */
	noteTemplatePath: string
	maxBackups: number
	/** 书架扫描文件夹（库内相对路径或本机绝对路径） */
	scanFolders: string[]
	/** 从书架移除但保留原文件的书籍路径（可随时恢复） */
	hiddenBooks: string[]
	/** 调试模式：把关键事件写入 data/debug.log（默认关） */
	debugMode: boolean
	/** 界面语言：auto = 跟随 Obsidian，zh = 中文，en = English */
	uiLocale: 'auto' | 'zh' | 'en'
	/** 自动备份：off / daily / weekly */
	autoBackup: 'off' | 'daily' | 'weekly'
	/** 上次自动备份的时间戳（毫秒） */
	lastAutoBackupAt: number
	/** 每日阅读目标（分钟），0 = 不设目标 */
	dailyGoalMinutes: number
	/** 每日页数目标（翻页/换节计数），0 = 不设目标 */
	dailyPageGoal: number
	/** 年度阅读目标（本），0 = 不设目标 */
	yearlyGoalBooks: number
	/** 每日复习条数（间隔重复）；0 = 关闭复习 */
	reviewDailyCap: number
	/** 复习队列是否纳入「昨天及更早、从没复习过」的划线 */
	reviewIncludeNew: boolean
	/** 朗读语速：0.6–1.6 */
	ttsRate: number
	/** e-ink / 极简模式：去动画与阴影、手机工具栏精简、点按翻页 */
	einkMode: boolean
	/** 多套笔记模板；为空时退回 noteTemplatePath */
	noteTemplates: NoteTemplate[]
	/** 默认笔记模板 id；为空时用列表第一套 */
	defaultNoteTemplateId: string
	/**
	 * 数据目录（库内相对路径）：批注 JSON、封面、书单、统计的存放位置。
	 * 留空 = 沿用旧行为（插件目录下的 data/）。
	 */
	dataFolder: string
	/** 书架排序：default / added / title / progress */
	shelfSort: string
	/** 标志风格：original（Obsidian 原生 library 图标）或 logos.ts 里的 id */
	logoStyle: string
	/** 书架卡片显示哪些信息 */
	shelfDisplay: ShelfDisplaySettings
	/** 打开书本时是否自动展开右侧批注列表 */
	openSidebarWithBook: boolean
	/** 手机端点正文上方/下方 1/4 翻页（默认关，避免误触） */
	mobileTapZones: boolean
	/** 手机上双指轻按切换沉浸阅读（隐藏工具栏与侧栏） */
	mobileTwoFingerImmersive: boolean
	/** 新增/修改批注时，自动刷新已生成的阅读笔记（标记区外手写内容保留） */
	autoUpdateNote: boolean
	/**
	 * 阅读笔记里每条摘录的回跳链接样式：
	 * wikilink＝指向书文件的 Obsidian 双链（能进图谱/反向链接），protocol＝旧的 obsidian:// 链接。
	 * 只影响「生成/更新笔记」写出来的内容，已有笔记下次刷新时才变。
	 */
	excerptLinkStyle: 'wikilink' | 'protocol'
	/** 「备份批注数据到库内」执行时额外复制一份的本机路径（另一块盘/优盘）；空 = 关闭 */
	backupTargetDir?: string
	/** 「备份批注数据到库内」写入的库内文件夹（相对路径）；改路径后旧备份自动转移 */
	backupFolder: string
	appearance: ReaderAppearance
	/** TXT 分页版式：auto＝按窗口宽度自动，single＝单页，double＝双页 */
	txtLayout: 'auto' | 'single' | 'double'
	/** TXT 键盘翻页方向：horizontal＝←/→，vertical＝↑/↓；滚轮始终翻页 */
	txtTurnAxis: 'horizontal' | 'vertical'
	/** AI 解释：OpenAI 兼容接口地址（默认智谱 GLM，免费） */
	aiBaseUrl: string
	/** AI 解释：API Key（只存在本机 data.json） */
	aiApiKey: string
	/** AI 解释：模型名 */
	aiModel: string
	/** AI 解释：自定义提示词，留空用内置 */
	aiPrompt: string
	/** 语义检索：嵌入服务 */
	aiEmbeddingProvider: 'local' | 'zhipu' | 'siliconflow' | 'custom'
	/** 语义检索：嵌入接口地址；空 = 用聊天接口地址（siliconflow 默认官方地址） */
	aiEmbeddingBaseUrl: string
	/** 语义检索：嵌入接口 Key；空 = 用聊天 Key（siliconflow 必须单独填） */
	aiEmbeddingApiKey: string
	/** 语义检索：嵌入模型名（OpenAI 兼容 /embeddings） */
	aiEmbeddingModel: string
	/** 语义检索：向量维度；服务不支持时会自动退回默认维度。0 = 不传 */
	aiEmbeddingDimensions: number
	/** PDF 链接格式：grove＝本插件双链；pdfplus＝PDF++ 的 #page=…&rect=… */
	pdfLinkStyle: 'grove' | 'pdfplus'
	/** PDF 链接别名：title-page＝书名 · 页码；page＝仅页码；snippet＝原文开头 */
	pdfLinkAlias: 'title-page' | 'page' | 'snippet'
	/** 阅读工具栏样式：icon＝图标；text＝文字按钮 */
	toolbarStyle: 'icon' | 'text'
	/** EPUB 高亮样式：wash＝下半段色带 + 底部细线；block＝整行色块 */
	epubHighlightStyle: 'wash' | 'block'
	/** 手机颜色菜单里「默认色」按钮使用的高亮色 key */
	defaultHighlightColor: string
	/** 工具栏里隐藏的动作（中文标签：评论 / 外观 / AI 问答 / 导读 / 笔记 / 书签 / 批注） */
	hiddenToolbarActions: string[]
	/** 工具栏动作按钮顺序（中文标签）；空数组＝默认顺序 */
	toolbarOrder: string[]
}

/**
 * 可排序的工具栏动作。颜色与「评论」固定在左侧，不参与排序。
 * 新增动作时同时改这里和 readerActions 的渲染表。
 */
export const TOOLBAR_ACTIONS = ['外观', 'AI 问答', '导读', '朗读', '笔记', '书签', '批注'] as const

/** 合并用户顺序与默认顺序：忽略未知项和重复项，未列出的动作按默认顺序补在后面 */
export function normalizeToolbarOrder(order?: string[]): string[] {
	const out: string[] = []
	for (const name of order ?? []) {
		if (!(TOOLBAR_ACTIONS as readonly string[]).includes(name)) continue
		if (!out.includes(name)) out.push(name)
	}
	for (const name of TOOLBAR_ACTIONS) {
		if (!out.includes(name)) out.push(name)
	}
	return out
}

export const DEFAULT_SETTINGS: GroveSettings = {
	notesFolder: '阅读笔记',
	noteTemplatePath: 'Grove Reader/阅读笔记/Grove 笔记模板.md',
	maxBackups: 10,
	scanFolders: [],
	hiddenBooks: [],
	debugMode: false,
	uiLocale: 'auto',
	autoBackup: 'off',
	lastAutoBackupAt: 0,
	dailyGoalMinutes: 30,
	dailyPageGoal: 0,
	yearlyGoalBooks: 24,
	reviewDailyCap: 5,
	reviewIncludeNew: true,
	ttsRate: 1,
	einkMode: false,
	noteTemplates: [],
	defaultNoteTemplateId: '',
	dataFolder: '',
	shelfSort: 'default',
	logoStyle: 'original',
	shelfDisplay: { ...DEFAULT_SHELF_DISPLAY },
	openSidebarWithBook: true,
	mobileTapZones: false,
	mobileTwoFingerImmersive: true,
	autoUpdateNote: true,
	excerptLinkStyle: 'wikilink',
	backupFolder: BACKUP_FOLDER_NAME,
	appearance: { ...DEFAULT_APPEARANCE },
	txtLayout: 'auto',
	txtTurnAxis: 'horizontal',
	aiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
	aiApiKey: '',
	aiModel: 'glm-4-flash',
	pdfLinkStyle: 'grove',
	pdfLinkAlias: 'title-page',
	toolbarStyle: 'icon',
	epubHighlightStyle: 'wash',
	defaultHighlightColor: 'yellow',
	hiddenToolbarActions: [],
	toolbarOrder: [],
	aiPrompt: '',
	aiEmbeddingProvider: 'local',
	aiEmbeddingBaseUrl: '',
	aiEmbeddingApiKey: '',
	aiEmbeddingModel: 'embedding-3',
	aiEmbeddingDimensions: 1024,
}
