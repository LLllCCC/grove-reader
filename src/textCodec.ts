/** TXT 编码识别与分页（纯函数，便于脱离 Obsidian 测试） */

export const VIEW_TYPE_GROVE_TEXT = 'grove-reader-text'

/** 每页字符数；按换行边界截断，避免把一行拆开 */
const PAGE_CHARS = 30_000
/** 编码切换时最多保留的页数，防止异常大文件把内存打满 */
const MAX_PAGES = 5000

export interface DecodedText {
	text: string
	encoding: string
	warning?: string
}

export interface TextViewState {
	bookPath?: string
	page?: number
	/** 回跳链接带来的定位（txt:<start>-<end>） */
	cfi?: string
}

/**
 * 解码 TXT：
 * 1. 用户指定编码优先；
 * 2. UTF-8 / UTF-16 BOM；
 * 3. 严格 UTF-8；
 * 4. GB18030（兼容 GBK/GB2312）；
 * 5. Big5；
 * 6. 最后按 UTF-8 替换非法字节。
 */
export function decodeTextBuffer(buffer: ArrayBuffer, preferred = 'auto'): DecodedText {
	const bytes = new Uint8Array(buffer)
	const decode = (label: string, fatal: boolean): string | null => {
		try {
			return new TextDecoder(label, { fatal }).decode(bytes).replace(/^\uFEFF/, '')
		} catch {
			return null
		}
	}
	if (preferred && preferred !== 'auto') {
		const value = decode(preferred, true)
		if (value !== null) return { text: value, encoding: preferred }
	}
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		const value = decode('utf-8', true)
		if (value !== null) return { text: value, encoding: 'utf-8' }
	}
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		const value = decode('utf-16le', true)
		if (value !== null) return { text: value, encoding: 'utf-16le' }
	}
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		const value = decode('utf-16be', true)
		if (value !== null) return { text: value, encoding: 'utf-16be' }
	}
	for (const encoding of ['utf-8', 'gb18030', 'big5']) {
		const value = decode(encoding, true)
		if (value !== null) {
			return {
				text: value,
				encoding,
				warning: preferred && preferred !== 'auto' && preferred !== encoding
					? `指定的 ${preferred.toUpperCase()} 解码失败，已改用 ${encoding.toUpperCase()}`
					: undefined,
			}
		}
	}
	return {
		text: new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''),
		encoding: 'utf-8',
		warning: '无法严格识别编码，已按 UTF-8 替换非法字符显示',
	}
}

/** 按字符数分页，尽量在换行处断开；避免 16MB 小说一次性塞进 DOM */
export function paginateText(text: string, pageChars = PAGE_CHARS): string[] {
	if (!text) return ['']
	const pages: string[] = []
	let start = 0
	while (start < text.length && pages.length < MAX_PAGES) {
		let end = Math.min(text.length, start + pageChars)
		if (end < text.length) {
			const newline = text.indexOf('\n', end)
			if (newline >= 0 && newline - end < 3000) end = newline + 1
		}
		pages.push(text.slice(start, end))
		start = end
	}
	return pages.length ? pages : ['']
}

