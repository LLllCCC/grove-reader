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
export function cleanPdfDisplayTitle(fileName: string): string {
	const original = fileName.replace(/\.[^.]+$/, '')
	let t = original
	t = stripNumericTitlePrefix(t)
	t = t.replace(/\.(layered|ocr)\b/gi, ' ')
	t = t.replace(/\[\s*ocr\s*\]/gi, ' ')
	t = t.replace(/\(\s*z[-\s]?lib(rary)?\s*\)/gi, ' ')
	t = t.replace(/[-_\s]*\d{8}[-_]\d{4,6}\s*$/, ' ')
	t = t.replace(/_+/g, ' ').replace(/\s{2,}/g, ' ')
	t = t.replace(/^[-_\s]+|[-_\s]+$/g, '')
	return t || original
}

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
