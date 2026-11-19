import { t } from './i18n'

/**
 * 纯 JS 的 SHA-1：桌面端原本用 node:crypto，但移动端没有 Node，
 * 而 bookIdFor 必须同步且结果与历史数据完全一致（书 id 就是它以
 * 前算出来的），所以干脆两端统一用这份实现。
 */
function sha1Hex(message: string): string {
	const data = new TextEncoder().encode(message)
	const bitLen = data.length * 8
	const total = (((data.length + 8) >> 6) + 1) << 6
	const buf = new Uint8Array(total)
	buf.set(data)
	buf[data.length] = 0x80
	const view = new DataView(buf.buffer)
	view.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false)
	view.setUint32(total - 4, bitLen >>> 0, false)

	let h0 = 0x67452301
	let h1 = 0xefcdab89
	let h2 = 0x98badcfe
	let h3 = 0x10325476
	let h4 = 0xc3d2e1f0
	const w = new Uint32Array(80)

	for (let i = 0; i < total; i += 64) {
		for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4, false)
		for (let t = 16; t < 80; t++) w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1)

		let a = h0
		let b = h1
		let c = h2
		let d = h3
		let e = h4
		for (let t = 0; t < 80; t++) {
			let f: number
			let k: number
			if (t < 20) {
				f = (b & c) | (~b & d)
				k = 0x5a827999
			} else if (t < 40) {
				f = b ^ c ^ d
				k = 0x6ed9eba1
			} else if (t < 60) {
				f = (b & c) | (b & d) | (c & d)
				k = 0x8f1bbcdc
			} else {
				f = b ^ c ^ d
				k = 0xca62c1d6
			}
			const tmp = (rotl(a, 5) + f + e + k + w[t]) >>> 0
			e = d
			d = c
			c = rotl(b, 30)
			b = a
			a = tmp
		}
		h0 = (h0 + a) >>> 0
		h1 = (h1 + b) >>> 0
		h2 = (h2 + c) >>> 0
		h3 = (h3 + d) >>> 0
		h4 = (h4 + e) >>> 0
	}

	return [h0, h1, h2, h3, h4].map(x => x.toString(16).padStart(8, '0')).join('')
}

function rotl(x: number, n: number): number {
	return ((x << n) | (x >>> (32 - n))) >>> 0
}

/** 由库内路径计算书籍数据的稳定 ID（结果与旧版 node:crypto 完全一致） */
export function bookIdFor(vaultPath: string): string {
	return sha1Hex(vaultPath.replace(/\\/g, '/'))
}

export function randomId(): string {
	const bytes = new Uint8Array(8)
	// 渲染进程与移动端 WebView 都有 Web Crypto；Node 18+ 也有
	globalThis.crypto.getRandomValues(bytes)
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
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

/** 把 text 里命中 query 的片段包成 <mark>，用于批注/搜索结果里的关键词高亮 */
export function setHighlightedText(el: HTMLElement, text: string, query: string): void {
	el.empty()
	const needle = query.trim().toLowerCase()
	const lower = text.toLowerCase()
	let from = 0
	let hit = needle ? lower.indexOf(needle, from) : -1
	if (hit < 0) {
		el.setText(text)
		return
	}
	while (hit >= 0) {
		if (hit > from) el.createSpan().setText(text.slice(from, hit))
		el.createEl('mark', { cls: 'grove-ann-hit' }).setText(text.slice(hit, hit + needle.length))
		from = hit + needle.length
		hit = lower.indexOf(needle, from)
	}
	if (from < text.length) el.createSpan().setText(text.slice(from))
}

/**
 * 把受信任的内联 SVG 字符串解析成真实 DOM 节点。
 * 替代 innerHTML：内容来自本仓库 logos.ts 常量，但仍走解析而非字符串注入，
 * 既满足 Obsidian 审核对 innerHTML 的要求，也不给未来拼接用户内容留口子。
 */
export function appendInlineSvg(target: HTMLElement, svg: string): SVGSVGElement | null {
	const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
	if (parsed.querySelector('parsererror')) return null
	const root = parsed.documentElement
	if (!root || root.nodeName.toLowerCase() !== 'svg') return null
	const node = document.importNode(root, true) as unknown as SVGSVGElement
	target.appendChild(node)
	return node
}

/** 文件大小友好显示：1234 → 1.2 KB */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return ''
	if (n < 1024) return `${n} B`
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** PDF 页码标签：既是界面文案，也会写进批注数据与笔记章节名 */
export function pageLabel(n: number): string {
	return t('第 {n} 页', { n })
}

/** 阅读时长友好显示 */
export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return ''
	if (seconds < 60) return t('{n} 秒', { n: Math.round(seconds) })
	if (seconds < 3600) return t('{n} 分钟', { n: Math.round(seconds / 60) })
	if (seconds < 3600 * 24) return t('{n} 小时', { n: (seconds / 3600).toFixed(1) })
	return t('{n} 天', { n: (seconds / 3600 / 24).toFixed(1) })
}

/** 相对时间：刚刚 / 23 分钟前 / 3 小时前 / 昨天 / 5 天前 / 2 个月前 */
export function relativeTime(timestamp: number, now = Date.now()): string {
	if (!timestamp || !Number.isFinite(timestamp)) return ''
	const diff = Math.max(0, now - timestamp)
	const MIN = 60_000
	const HOUR = 60 * MIN
	const DAY = 24 * HOUR
	if (diff < MIN) return t('刚刚')
	if (diff < HOUR) return t('{n} 分钟前', { n: Math.floor(diff / MIN) })
	if (diff < DAY) return t('{n} 小时前', { n: Math.floor(diff / HOUR) })
	if (diff < 2 * DAY) return t('昨天')
	if (diff < 30 * DAY) return t('{n} 天前', { n: Math.floor(diff / DAY) })
	if (diff < 365 * DAY) return t('{n} 个月前', { n: Math.floor(diff / (30 * DAY)) })
	return t('{n} 年前', { n: Math.floor(diff / (365 * DAY)) })
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

/**
 * 书名里如果已经带了作者（「一生受用的概率统计 [日]佐佐木弹」、
 * 「大国县治（杨华）」），把尾部作者/括号去掉——作者已经显示在书名下方。
 * 只处理能跟 author 对上的尾部，避免误删「第二版」「套装共3册」这类信息。
 */
export function stripTitleAuthor(title: string, author: string): string {
	let t = (title || '').trim()
	const rawAuthor = (author || '').trim()
	if (!t || !rawAuthor) return t
	const core = normalizeAuthor(rawAuthor)
	if (!core) return t
	const variants = [rawAuthor]
	const noCountry = rawAuthor
		.replace(/^[\s\[【（(]*(?:\[[^\]]+\]|【[^】]+】|[（(][^）)]*[）)])?\s*/, '')
		.trim()
	if (noCountry && noCountry !== rawAuthor) variants.push(noCountry)

	for (const variant of variants) {
		if (variant && t.endsWith(variant)) {
			t = t.slice(0, -variant.length).trim()
			break
		}
	}

	// 尾部括号：只删“括号内容能和作者对上”的那一段
	for (let i = 0; i < 2; i++) {
		const m = t.match(/[（(]\s*([^（）()]*?)\s*[）)]\s*$/) || t.match(/[\[【]\s*([^\[\]【】]*?)\s*[\]】]\s*$/)
		if (!m) break
		const inside = normalizeAuthor(m[1])
		if (inside && (inside.includes(core) || core.includes(inside))) {
			t = t.slice(0, m.index).trim()
		} else {
			break
		}
	}

	// 去掉只剩国家/地区标记的尾巴，以及残留的连接符
	t = t.replace(/[\s\-–—]*[\[【（(]\s*(?:日|美|英|法|德|俄|韩|加|澳|意|西|荷|瑞典|瑞士|以色列|印度|巴西|墨西哥|阿根廷|波兰|捷克|奥地利|土耳其|伊朗|南非|新西兰|新加坡|马来西亚|泰国|越南|菲律宾|印尼|丹麦|挪威|芬兰|希腊|葡萄牙|爱尔兰|比利时|匈牙利|罗马尼亚|乌克兰|俄罗斯)\s*[\]】）)]\s*$/u, '')
	t = t.replace(/[\s\-–—_.]+$/, '').trim()
	return t || title
}

function normalizeAuthor(value: string): string {
	return value
		.replace(/^[\s\[【（(]+|[\s\]】）)]+$/g, '')
		.replace(/^\[[^\]]+\]\s*/, '')
		.replace(/^【[^】]+】\s*/, '')
		.replace(/[（(][^）)]*[）)]/g, '')
		.replace(/[\s,，、;；:：.·]/g, '')
		.toLowerCase()
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


/**
 * 进度百分比 → 页码（1 起）。
 * PDF 换版本后页数会变，`page:N` 失效时按百分比落一页；夹到 1..total，坏数值退到第 1 页。
 */
export function pageFromFraction(fraction: number, total: number): number {
	if (!Number.isFinite(total) || total <= 0) return 1
	const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
	return Math.max(1, Math.min(total, Math.round(f * (total - 1)) + 1))
}
