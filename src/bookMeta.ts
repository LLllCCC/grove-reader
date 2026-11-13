/**
 * 书架 AI 元数据的解析（纯函数，不依赖 Obsidian，smoke 可直接测）。
 */
export interface MetaSuggestion {
	author: string
	category: string
	intro: string
}

/** 从模型输出里抠 JSON；带 ```json 代码块或前后闲聊都能处理 */
export function parseMetaSuggestion(raw: string): MetaSuggestion {
	const text = raw.trim().replace(/```(?:json)?/gi, '').replace(/```/g, '')
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start >= 0 && end > start) {
		try {
			const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
			const pick = (key: string): string => typeof obj[key] === 'string' ? String(obj[key]).trim() : ''
			return { author: pick('author'), category: pick('category'), intro: pick('intro') }
		} catch {
			// 落到下面的空结果
		}
	}
	return { author: '', category: '', intro: '' }
}
