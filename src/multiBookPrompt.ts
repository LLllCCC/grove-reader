import { t } from './i18n'
/**
 * 跨书问答的 prompt 组装（纯函数，不依赖 Obsidian，smoke 可直接测）。
 * 材料来源可以是要点索引，也可以是语义检索命中的正文段落。
 */
export interface MultiBookMaterial {
	book: string
	chapter: string
	summary: string
	preview?: string
}

export function buildMultiBookPrompt(question: string, materials: MultiBookMaterial[]): string {
	const body = materials.map((m, i) => {
		const head = `[${i + 1}] 《${m.book}》· ${m.chapter || '正文'}`
		return [head, m.summary ? `要点：${m.summary}` : '', m.preview ? `摘录：${m.preview}` : '']
			.filter(Boolean)
			.join('\n')
	}).join('\n\n')
	return [
		t('下面是从多本书中检索到的材料。'),
		'',
		body || '（没有检索到相关材料）',
		'',
		t('请只依据上面的材料回答，不要编造；材料没有提到就直说「这些书里没有提到」。'),
		t('跨书比较或并列观点时，注明书名（必要时带章节）。用中文回答，先给结论再给依据，400 字以内。'),
		'',
		`问题：${question.trim()}`,
	].join('\n')
}
