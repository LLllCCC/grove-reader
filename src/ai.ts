import { requestUrl } from 'obsidian'
import type { PortraitChunk } from './portrait'
import { buildAskPrompt } from './portrait'
import { buildMultiBookPrompt, type MultiBookMaterial } from './multiBookPrompt'
import { t } from './i18n'

export { buildMultiBookPrompt } from './multiBookPrompt'
export type { MultiBookMaterial } from './multiBookPrompt'

/** 划词解释 / 全书问答都走 OpenAI 兼容的 /chat/completions，换服务只要改地址和模型名 */
export interface AiConfig {
	baseUrl: string
	apiKey: string
	model: string
	prompt?: string
}

function defaultPrompt(): string {
	return (
		t('你是一位中文阅读助手。请用简洁、准确的中文解释用户选中的文字：先说字面意思，') +
		t('如果它在书中有特定含义就点出来，不要复述原文，不要寒暄。总长度控制在 150 字以内。')
	)
}

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
	if (!answer) throw new Error(t('返回内容为空'))
	return answer
}

/** 划词 AI 动作：解释 / 翻译 / 摘要 */
export type SelectionAiTask = 'explain' | 'translate' | 'summarize'

/** 调用 AI 解释一段文字 */
export async function explainSelection(cfg: AiConfig, text: string): Promise<string> {
	return chatCompletion(cfg, [
		{ role: 'system', content: (cfg.prompt || '').trim() || defaultPrompt() },
		{ role: 'user', content: `请解释这段文字：\n\n${text.trim()}` },
	], { temperature: 0.3, maxTokens: 700 })
}

/** 划词翻译 / 摘要；解释复用上面的自定义提示词 */
export async function transformSelection(cfg: AiConfig, text: string, task: SelectionAiTask): Promise<string> {
	if (task === 'explain') return explainSelection(cfg, text)
	const system = task === 'translate'
		? t('你是一位翻译助手。把用户选中的文字翻译成简体中文；如果原文已经是中文，翻译成自然、准确的英文。只输出译文，不要解释、不要寒暄。')
		: t('你是一位阅读助手。用 3-5 句话概括用户选中文字的核心意思，保留关键人物、概念、结论和数字；不要复述原文、不要评价、不要寒暄。')
	return chatCompletion(cfg, [
		{ role: 'system', content: system },
		{ role: 'user', content: text.trim() },
	], { temperature: 0.2, maxTokens: 800 })
}

/** 查词：返回「释义 / 词性 / 例句」三行，尽量短 */
export async function lookupWord(cfg: AiConfig, word: string, context = ''): Promise<string> {
	return chatCompletion(cfg, [
		{
			role: 'system',
			content: t('你是一位词典助手。用简体中文解释用户给的单词或短语，结合原文语境判断它在句中的含义。')
				+ t('严格按三行输出，不要寒暄、不要 Markdown 标题：\n')
				+ t('释义：一句话说清\n词性：名词/动词/形容词等\n例句：一个简短例句（英文词给英文例句并附中文翻译）'),
		},
		{
			role: 'user',
			content: context.trim()
				? `单词：${word.trim()}\n原文：${context.trim().slice(0, 400)}`
				: `单词：${word.trim()}`,
		},
	], { temperature: 0.2, maxTokens: 320 })
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
				t('你在为一本书建立问答索引。请用 1-3 句话概括用户给出的正文片段，') +
				t('保留关键人物、概念、结论和数字；只输出概括，不要评价、不要寒暄、不要复述原文。'),
		},
		{
			role: 'user',
			content: `书名：《${bookTitle || '未命名'}》\n章节：${chapter || '正文'}\n\n${text}`,
		},
	], { temperature: 0.2, maxTokens: 300 })
	return answer.replace(/\s+/g, ' ').trim()
}

/** 为按章导读概括一章正文 */
export async function summarizeGuideSection(
	cfg: AiConfig,
	bookTitle: string,
	chapter: string,
	text: string,
): Promise<string> {
	const answer = await chatCompletion(cfg, [
		{
			role: 'system',
			content:
				t('你在为一本书写分章导读。请用 2-4 句话说明这一章讲了什么：') +
				t('关键人物、事件、概念与结论，最后可以给一句阅读提示。') +
				t('只输出导读，不要复述原文、不要评价、不要寒暄。'),
		},
		{
			role: 'user',
			content: `书名：《${bookTitle || '未命名'}》\n章节：${chapter || '正文'}\n\n${text}`,
		},
	], { temperature: 0.3, maxTokens: 400 })
	return answer.replace(/\s+/g, ' ').trim()
}

/** 向量嵌入：OpenAI 兼容 /embeddings，分批请求；维度参数被服务拒绝时自动退回默认维度 */
export async function embedTexts(
	cfg: AiConfig,
	texts: string[],
	options: { model?: string; dimensions?: number; batchSize?: number } = {},
): Promise<number[][]> {
	if (!texts.length) return []
	const base = cfg.baseUrl.trim().replace(/\/+$/, '')
	const url = /\/embeddings$/.test(base) ? base : `${base}/embeddings`
	const model = (options.model ?? '').trim() || 'embedding-3'
	const batchSize = Math.max(1, Math.min(32, options.batchSize ?? 16))
	const request = async (batch: string[], withDims: boolean): Promise<{ vectors?: number[][]; error?: string }> => {
		const body: Record<string, unknown> = { model, input: batch }
		if (withDims && options.dimensions && options.dimensions > 0) body.dimensions = options.dimensions
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
			return { error: `${res.status}${detail ? ` · ${detail}` : ''}` }
		}
		const json = res.json as { data?: Array<{ embedding?: number[] }> }
		const data = json?.data ?? []
		if (data.length !== batch.length) return { error: t('嵌入返回条数与请求不一致') }
		return { vectors: data.map(item => item.embedding ?? []) }
	}
	const out: number[][] = []
	for (let i = 0; i < texts.length; i += batchSize) {
		const batch = texts
			.slice(i, i + batchSize)
			.map(text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000))
		let result = await request(batch, true)
		// 有些兼容服务不认 dimensions：400 时退回默认维度
		if (result.error && options.dimensions && /\b400\b|dimension/i.test(result.error)) {
			result = await request(batch, false)
		}
		if (result.error || !result.vectors) throw new Error(result.error || t('嵌入失败'))
		for (const vector of result.vectors) {
			if (!vector.length) throw new Error('嵌入返回空向量')
			out.push(vector)
		}
	}
	return out
}

/** 多书一起问：材料里带书名，要求跨书比较时注明出处 */
export async function answerMultiBookQuestion(
	cfg: AiConfig,
	question: string,
	materials: MultiBookMaterial[],
	history: AskTurn[] = [],
): Promise<string> {
	const prompt = buildMultiBookPrompt(question, materials)
	const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
		{
			role: 'system',
			content: t('你是一位严谨的中文阅读助手。只根据用户提供的多本书材料回答，材料不足时明确说明，不要编造。'),
		},
	]
	for (const turn of history.slice(-HISTORY_TURNS)) {
		const text = turn.text.trim()
		if (!text) continue
		messages.push({
			role: turn.role,
			content: turn.role === 'assistant' && text.length > HISTORY_ANSWER_CHARS
				? `${text.slice(0, HISTORY_ANSWER_CHARS)}…`
				: text,
		})
	}
	messages.push({ role: 'user', content: prompt })
	return chatCompletion(cfg, messages, { temperature: 0.3, maxTokens: 1000 })
}

/** 多轮追问时保留的一轮对话 */
export interface AskTurn {
	role: 'user' | 'assistant'
	text: string
}

const HISTORY_TURNS = 6
const HISTORY_ANSWER_CHARS = 900

/**
 * 全书问答：把命中的要点与摘录交给 AI。
 * history 传最近的问答轮次，追问时可以接着说「第二点再展开」这类话；
 * 每轮仍然按当前问题重新检索材料，避免旧材料串味。
 */
export async function answerBookQuestion(
	cfg: AiConfig,
	bookTitle: string,
	question: string,
	chunks: PortraitChunk[],
	history: AskTurn[] = [],
): Promise<string> {
	const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
		{
			role: 'system',
			content: t('你是一位严谨的中文阅读助手。只根据用户提供的书内材料回答，材料不足时明确说明，不要编造。')
				+ t('用户可能在前面的问答基础上继续追问，请结合上下文回答。'),
		},
	]
	for (const turn of history.slice(-HISTORY_TURNS)) {
		const text = turn.text.trim()
		if (!text) continue
		messages.push({
			role: turn.role,
			content: turn.role === 'assistant' && text.length > HISTORY_ANSWER_CHARS
				? `${text.slice(0, HISTORY_ANSWER_CHARS)}…`
				: text,
		})
	}
	messages.push({ role: 'user', content: buildAskPrompt(bookTitle, question, chunks) })
	return chatCompletion(cfg, messages, { temperature: 0.3, maxTokens: 900 })
}
