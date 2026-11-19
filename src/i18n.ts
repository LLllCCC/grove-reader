import { EN } from './locales/en'

/**
 * 极简 i18n：以中文原文作为键。
 * - 中文环境直接返回原文，零查表开销
 * - 英文环境查 EN 词典，缺失时回落中文（不会出现空白或 undefined）
 * - 插值统一写成 {name}，调用方传第二个参数
 *
 * 这样改造可以增量推进：没翻译到的位置仍然显示中文，插件始终可用。
 */

export type UiLocale = 'auto' | 'zh' | 'en'
export type ResolvedLocale = 'zh' | 'en'

let current: ResolvedLocale = 'zh'

/**
 * 把设置里的 auto/zh/en 解析成实际语言；auto 跟随 Obsidian 语言。
 * systemLang 由调用方传入（main.ts / settings.ts 用 obsidian 的 getLanguage()），
 * 这样本模块不依赖 obsidian，脚本侧的打包与测试可以直接引用。
 */
export function resolveLocale(setting: UiLocale | undefined, systemLang?: string): ResolvedLocale {
	if (setting === 'zh' || setting === 'en') return setting
	const sys = String(systemLang ?? '').toLowerCase()
	// Obsidian 的中文语言码是 zh / zh-cn / zh-tw
	if (sys.startsWith('zh')) return 'zh'
	// 拿不到系统语言时按英文处理：面向社区发布时英文是更安全的默认
	return sys ? 'en' : 'zh'
}

export function applyLocale(setting: UiLocale | undefined, systemLang?: string): ResolvedLocale {
	current = resolveLocale(setting, systemLang)
	return current
}

export function currentLocale(): ResolvedLocale {
	return current
}

/** 取文案；params 里的键对应文案中的 {键} 占位符 */
export function t(zh: string, params?: Record<string, string | number>): string {
	let out = current === 'en' ? EN[zh] ?? zh : zh
	if (params) {
		for (const key of Object.keys(params)) {
			out = out.split(`{${key}}`).join(String(params[key]))
		}
	}
	return out
}

/** 语言显示名（语言选择器自身用，始终双语） */
export function localeName(loc: UiLocale): string {
	if (loc === 'zh') return '中文'
	if (loc === 'en') return 'English'
	return current === 'en' ? 'Follow Obsidian' : '跟随 Obsidian'
}
