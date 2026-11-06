import { requestUrl } from 'obsidian'

/** 划词解释走 OpenAI 兼容的 /chat/completions，换服务只要改地址和模型名 */
export interface AiConfig {
	baseUrl: string
	apiKey: string
	model: string
	prompt?: string
}

const DEFAULT_PROMPT =
	'你是一位中文阅读助手。请用简洁、准确的中文解释用户选中的文字：先说字面意思，' +
	'如果它在书中有特定含义就点出来，不要复述原文，不要寒暄。总长度控制在 150 字以内。'

export function isAiConfigured(cfg: AiConfig): boolean {
	return !!cfg.apiKey.trim() && !!cfg.baseUrl.trim() && !!cfg.model.trim()
}

/** 调用 AI 解释一段文字；失败时抛出带可读原因的 Error */
export async function explainSelection(cfg: AiConfig, text: string): Promise<string> {
	const base = cfg.baseUrl.trim().replace(/\/+$/, '')
	const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
	const body = {
		model: cfg.model.trim(),
		messages: [
			{ role: 'system', content: (cfg.prompt || '').trim() || DEFAULT_PROMPT },
			{ role: 'user', content: `请解释这段文字：\n\n${text.trim()}` },
		],
		temperature: 0.3,
		max_tokens: 700,
	}
	const res = await requestUrl({
		url,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${cfg.apiKey.trim()}`,
		},
		body: JSON.stringify(body),
		throw: false,
	})
	if (res.status >= 400) {
		let detail = ''
		try {
			const j = res.json as { error?: { message?: string }; message?: string }
			detail = j?.error?.message || j?.message || ''
		} catch {
			detail = (res.text || '').slice(0, 160)
		}
		throw new Error(`${res.status}${detail ? ` · ${detail}` : ''}`)
	}
	const json = res.json as {
		choices?: Array<{ message?: { content?: string } }>
	}
	const answer = json?.choices?.[0]?.message?.content?.trim()
	if (!answer) throw new Error('返回内容为空')
	return answer
}
