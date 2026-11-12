import { requestUrl } from 'obsidian'
import type { PortraitChunk } from './portrait'
import { buildAskPrompt } from './portrait'

/** 划词解释 / 全书问答都走 OpenAI 兼容的 /chat/completions，换服务只要改地址和模型名 */
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

/** 常见失败给一句可执行的补救提示，不要只丢网络层错误码 */
export function hintFor(message: string): string {
	if (/net::|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|Failed to fetch|ECONNREFUSED/i.test(message)) {
		return '（检查接口地址是否写错、网络是否可达）'
	}
	if (/\b401\b|\b403\b|invalid.*api.*key|unauthorized/i.test(message)) {
		return '（API Key 无效或没有该模型的权限）'
	}
	if (/\b429\b|rate limit/i.test(message)) return '（请求太频繁或额度用尽，稍后再试）'
	return ''
}

interface ChatMessage {
	role: 'system' | 'user' | 'assistant'
	content: string
}

/** 通用 chat 调用：失败时抛出带可读原因的 Error */
export async function chatCompletion(
	cfg: AiConfig,
	messages: ChatMessage[],
	options: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
	const base = cfg.baseUrl.trim().replace(/\/+$/, '')
	const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
	const body = {
		model: cfg.model.trim(),
		messages,
		temperature: options.temperature ?? 0.3,
		max_tokens: options.maxTokens ?? 700,
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

/** 调用 AI 解释一段文字 */
export async function explainSelection(cfg: AiConfig, text: string): Promise<string> {
	return chatCompletion(cfg, [
		{ role: 'system', content: (cfg.prompt || '').trim() || DEFAULT_PROMPT },
		{ role: 'user', content: `请解释这段文字：\n\n${text.trim()}` },
	], { temperature: 0.3, maxTokens: 700 })
}

/** 为全书索引概括一段正文 */
export async function summarizePortraitChunk(
	cfg: AiConfig,
	bookTitle: string,
	chapter: string,
	text: string,
): Promise<string> {
	const answer = await chatCompletion(cfg, [
		{
			role: 'system',
			content:
				'你在为一本书建立问答索引。请用 1-3 句话概括用户给出的正文片段，' +
				'保留关键人物、概念、结论和数字；只输出概括，不要评价、不要寒暄、不要复述原文。',
		},
		{
			role: 'user',
			content: `书名：《${bookTitle || '未命名'}》\n章节：${chapter || '正文'}\n\n${text}`,
		},
	], { temperature: 0.2, maxTokens: 300 })
	return answer.replace(/\s+/g, ' ').trim()
}

/** 全书问答：把命中的要点与摘录交给 AI */
export async function answerBookQuestion(
	cfg: AiConfig,
	bookTitle: string,
	question: string,
	chunks: PortraitChunk[],
): Promise<string> {
	return chatCompletion(cfg, [
		{
			role: 'system',
			content: '你是一位严谨的中文阅读助手。只根据用户提供的书内材料回答，材料不足时明确说明，不要编造。',
		},
		{ role: 'user', content: buildAskPrompt(bookTitle, question, chunks) },
	], { temperature: 0.3, maxTokens: 900 })
}
