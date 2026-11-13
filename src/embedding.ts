/**
 * 语义检索的向量服务选择。
 *
 * - local：离线词法向量（字符 n-gram 哈希），不联网、不花钱，能找「说法相近」的段落，
 *   但不是深度语义（同义词未必命中）。作为默认，保证任何环境都能用向量检索。
 * - zhipu / siliconflow / custom：OpenAI 兼容 /embeddings。智谱的 embedding-3 不免费；
 *   硅基流动的 BAAI/bge-m3 有免费额度，但需要单独填 Key。
 */
import type GroveReaderPlugin from './main'
import { embedTexts } from './ai'
import { LOCAL_EMBED_DIMS, localVector } from './localEmbed'

export type EmbeddingProvider = 'local' | 'zhipu' | 'siliconflow' | 'custom'

export interface EmbeddingRuntime {
	provider: EmbeddingProvider
	baseUrl: string
	apiKey: string
	model: string
	dimensions: number
	/** 写进索引、用于判断索引是否还匹配当前配置 */
	docModel: string
}

export { LOCAL_EMBED_DIMS, localVector }

export function resolveEmbedding(plugin: GroveReaderPlugin): EmbeddingRuntime {
	const s = plugin.settings
	const provider = (s.aiEmbeddingProvider ?? 'local') as EmbeddingProvider
	if (provider === 'local') {
		return {
			provider,
			baseUrl: '',
			apiKey: '',
			model: 'local-hash',
			dimensions: LOCAL_EMBED_DIMS,
			docModel: `local:hash-${LOCAL_EMBED_DIMS}`,
		}
	}
	const isSilicon = provider === 'siliconflow'
	const baseUrl = (s.aiEmbeddingBaseUrl ?? '').trim()
		|| (isSilicon ? 'https://api.siliconflow.cn/v1' : (s.aiBaseUrl ?? '').trim())
	const apiKey = (s.aiEmbeddingApiKey ?? '').trim() || (isSilicon ? '' : (s.aiApiKey ?? '').trim())
	const model = (s.aiEmbeddingModel ?? '').trim() || (isSilicon ? 'BAAI/bge-m3' : 'embedding-3')
	// bge-m3 固定 1024 维，不传 dimensions
	const dimensions = isSilicon ? 0 : (s.aiEmbeddingDimensions ?? 1024)
	const dimsLabel = dimensions > 0 ? String(dimensions) : 'auto'
	return {
		provider,
		baseUrl,
		apiKey,
		model,
		dimensions,
		docModel: `${provider}:${model}:${dimsLabel}`,
	}
}

export function isLocalEmbedding(runtime: EmbeddingRuntime): boolean {
	return runtime.provider === 'local'
}

/** 统一的嵌入入口：本地直接算，远端走 /embeddings */
export async function embedForSearch(
	runtime: EmbeddingRuntime,
	texts: string[],
	batchSize = 16,
): Promise<number[][]> {
	if (!texts.length) return []
	if (runtime.provider === 'local') return texts.map(text => Array.from(localVector(text)))
	if (!runtime.apiKey.trim()) throw new Error('没有嵌入 API Key（设置 → AI 解释 → 向量服务）')
	return embedTexts(
		{ baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, model: runtime.model },
		texts,
		{
			model: runtime.model,
			dimensions: runtime.dimensions > 0 ? runtime.dimensions : undefined,
			batchSize,
		},
	)
}

/** 设置界面上的服务名 */
export function embeddingProviderLabel(provider: EmbeddingProvider): string {
	switch (provider) {
		case 'local':
			return '本地（离线，词法向量）'
		case 'zhipu':
			return '智谱（embedding-3）'
		case 'siliconflow':
			return '硅基流动（BAAI/bge-m3，有免费额度）'
		default:
			return '自定义 OpenAI 兼容'
	}
}
