import { createHash, randomBytes } from 'node:crypto'

/** 由库内路径计算书籍数据的稳定 ID */
export function bookIdFor(vaultPath: string): string {
	return createHash('sha1').update(vaultPath.replace(/\\/g, '/')).digest('hex')
}

export function randomId(): string {
	return randomBytes(8).toString('hex')
}

export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|#^[\]%!@&=+$,;:'`~\n\r\t]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return (cleaned || '未命名').slice(0, 80).trim()
}

/** encodeURIComponent 后再补码 !'()*，保证放进 Markdown 链接不会断开 */
export function encodeParam(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** foliate 的 metadata.title 可能是字符串或语言映射对象 */
export function formatLanguageMap(value: unknown): string {
	if (typeof value === 'string') return value
	if (value && typeof value === 'object') {
		const first = Object.values(value as Record<string, unknown>)[0]
		if (typeof first === 'string') return first
	}
	return ''
}

export function formatAuthor(value: unknown): string {
	if (typeof value === 'string') return value
	if (Array.isArray(value)) return value.map(formatAuthor).filter(Boolean).join(', ')
	if (value && typeof value === 'object') {
		const name = (value as { name?: unknown }).name
		if (typeof name === 'string') return name
		if (name) return formatLanguageMap(name)
	}
	return ''
}

export function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + '…' : text
}

/** 文件大小友好显示：1234 → 1.2 KB */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return ''
	if (n < 1024) return `${n} B`
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 阅读时长友好显示 */
export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return ''
	if (seconds < 60) return `${Math.round(seconds)} 秒`
	if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`
	if (seconds < 3600 * 24) return `${(seconds / 3600).toFixed(1)} 小时`
	return `${(seconds / 3600 / 24).toFixed(1)} 天`
}

/** 相对时间：刚刚 / 23 分钟前 / 3 小时前 / 昨天 / 5 天前 / 2 个月前 */
export function relativeTime(timestamp: number, now = Date.now()): string {
	if (!timestamp || !Number.isFinite(timestamp)) return ''
	const diff = Math.max(0, now - timestamp)
	const MIN = 60_000
	const HOUR = 60 * MIN
	const DAY = 24 * HOUR
	if (diff < MIN) return '刚刚'
	if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`
	if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
	if (diff < 2 * DAY) return '昨天'
	if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`
	if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))} 个月前`
	return `${Math.floor(diff / (365 * DAY))} 年前`
}

/**
 * 比较两个 CFI 的先后。CFI 是「/6/14!/4/2/1:0」这种斜杠路径，
 * 直接按字符串比较会得到 /10 < /9 的错误顺序，这里按数字段逐段比较。
 */
export function compareCfi(a: string, b: string): number {
	const split = (cfi: string): string[] => cfi.match(/\d+|[^\d]+/g) ?? []
	const sa = split(a)
	const sb = split(b)
	const len = Math.max(sa.length, sb.length)
	for (let i = 0; i < len; i++) {
		const x = sa[i]
		const y = sb[i]
		if (x === undefined) return -1
		if (y === undefined) return 1
		const nx = /^\d+$/.test(x)
		const ny = /^\d+$/.test(y)
		if (nx && ny) {
			const d = Number(x) - Number(y)
			if (d !== 0) return d < 0 ? -1 : 1
		} else if (x !== y) {
			return x < y ? -1 : 1
		}
	}
	return 0
}

const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/

/**
 * 归一化 PDF 划选文本：扫描版 OCR 的文字层常按「单字一个文本块」切分，
 * 浏览器对每个独立定位的块返回的选区文本自带换行；这里把行重新拼接——
 * 中日韩字符之间不加空格，拉丁/数字之间补一个空格。
 */
export function normalizeSelectionText(raw: string): string {
	const lines = raw
		.replace(/\r/g, '')
		.split('\n')
		.map(l => l.trim())
		.filter(Boolean)
	let out = ''
	for (const line of lines) {
		if (!out) {
			out = line
			continue
		}
		const prev = out[out.length - 1] ?? ''
		const next = line[0] ?? ''
		const separator = CJK_CHAR.test(prev) || CJK_CHAR.test(next) ? '' : ' '
		out += separator + line
	}
	return out
}

/** 兼容 Windows/POSIX 分隔符的取文件名 */
export function basenameOf(p: string): string {
	return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/** 去掉下载站/书库给文件名加的数字 ID 前缀，如 `165293_一生受用的概率统计` → `一生受用的概率统计` */
export function stripNumericTitlePrefix(t: string): string {
	return t.replace(/^\d{3,}[_\-\s]+/, '')
}

/**
 * 清洗 PDF 文件名作为书架展示标题：
 * 去掉 [OCR]、(Z-Library) 等常见标记与尾部下载时间戳，
 * 如 `[OCR]_大国县治 (杨华) (Z-Library)_20260911_0340.layered` → `大国县治 (杨华)`
 */
/**
 * 把下载/截图/OCR 弄脏的文件名洗成可读书名：
 * - 去掉 `@image#1:Clipboard_Screenshot...`、`Pasted image...` 等附件后缀
 * - 去掉 `(Z-Library)`、`(z-library.sk, 1lib.sk, z-lib.sk)` 等站点标记
 * - 去掉 `[OCR]_`、`_OCR`、`.layered`、`_20260911_0340` 等 OCR/时间戳
 * - 下划线转空格，压掉多余空白
 * 不主动删作者、副标题或括号里的版次信息。
 */
export function cleanBookTitle(fileName: string): string {
	const original = fileName.replace(/\.(epub|mobi|azw3|azw|fb2|cbz|pdf|txt)$/i, '').trim()
	let t = original
	t = stripNumericTitlePrefix(t)
	// 截图/附件后缀：书名@image#1:Clipboard_Screenshot.png、书名_Clipboard_Screenshot-1
	t = t.replace(/[@\s_-]*@?image#\d+:.*$/i, ' ')
	t = t.replace(/[@\s_-]*(?:clipboard[_\s-]?screenshot|pasted[_\s-]?image).*$/i, ' ')
	// 下载站标记：全角/半角括号、方括号；含多站点列表
	t = t.replace(/[（(]\s*(?:z[-_\s]?lib(?:rary)?(?:\.[a-z]+)?|1lib(?:\.[a-z]+)?)[^）)]*[）)]/gi, ' ')
	t = t.replace(/[\[【]\s*(?:z[-_\s]?lib(?:rary)?|1lib)[^\]】]*[\]】]/gi, ' ')
	// OCR / layered / 时间戳
	t = t.replace(/\.(layered|ocr)\b/gi, ' ')
	t = t.replace(/\[\s*ocr\s*\]/gi, ' ')
	t = t.replace(/[_\s-]*ocr[_\s-]*/gi, ' ')
	t = t.replace(/[-_\s]*\d{8}[-_]\d{4,6}\s*$/, ' ')
	t = t.replace(/_+/g, ' ').replace(/\s{2,}/g, ' ')
	t = t.replace(/^[-_\s]+|[-_\s]+$/g, '')
	return t || original
}

/** 兼容旧调用名：PDF 书架标题也走同一套清洗 */
export const cleanPdfDisplayTitle = cleanBookTitle

export function isAbsolutePath(p: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

/**
 * 疑似重复检测的归一化键：清洗过的标题再去掉括号注记、
 * OCR/layered 等格式词与所有空白标点，只留核心文字。
 */
export function duplicateKeyOf(fileName: string): string {
	const core = cleanPdfDisplayTitle(fileName)
		.replace(/[（(][^（）()]*[)）]/g, '')
		.replace(/\b(ocr|layered|epub|mobi|azw3|pdf|fb2|cbz)\b/gi, '')
		.replace(/[\s\-_—.、,，:：;；!！?？'"]+/g, '')
		.toLowerCase()
	return core.length >= 2 ? core : ''
}

function parseHexColor(hex: string): [number, number, number] {
	let h = hex.trim().replace(/^#/, '')
	if (h.length === 3) h = h.split('').map(c => c + c).join('')
	if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return [255, 255, 255]
	return [
		Number.parseInt(h.slice(0, 2), 16),
		Number.parseInt(h.slice(2, 4), 16),
		Number.parseInt(h.slice(4, 6), 16),
	]
}

export function isDarkColor(hex: string): boolean {
	const [r, g, b] = parseHexColor(hex)
	return (0.299 * r + 0.587 * g + 0.114 * b) < 128
}

/** 按背景亮度给出可读的前景色 */
export function contrastFg(bg: string): string {
	return isDarkColor(bg) ? '#c9c9ce' : '#2b2b2b'
}
