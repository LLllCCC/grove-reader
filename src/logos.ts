/**
 * 插件标志（wordmark）集合。
 * 全部是手绘 SVG：五位字母用圆头笔画，参考 bilibili / YOPO 那种轻松的字标。
 * wordmark 用于设置页预览与空书架；icon 是 100×100 的方形图标，注册给 Obsidian
 * 作为标签页 / 功能区图标（addIcon 的坐标系是 0 0 100 100）。
 */

export type LogoId = 'original' | 'grove-color' | 'grove-forest' | 'grove-sage' | 'grove-badge'

export interface LogoOption {
	id: LogoId
	name: string
	desc: string
	/** 完整 <svg>，viewBox 0 0 380 100 */
	wordmark?: string
	/** addIcon 用的 100×100 内容（不含 svg 外层） */
	icon?: string
}

const LETTERS = `
	<path d="M62 40a22 22 0 1 0 0 32v-14H50" stroke="#7BD88F"/>
	<path d="M106 24v56" stroke="#4ECDC4"/>
	<path d="M106 24h18a16 16 0 0 1 0 32h-18" stroke="#4ECDC4"/>
	<path d="M124 56l16 24" stroke="#4ECDC4"/>
	<circle cx="192" cy="52" r="28" stroke="#FFD166"/>
	<path d="M240 24l22 56 22-56" stroke="#FF8FA3"/>
	<path d="M346 24h-36v56h36" stroke="#8AB4F8"/>
	<path d="M310 52h30" stroke="#8AB4F8"/>`

const LETTERS_MONO = `
	<path d="M62 40a22 22 0 1 0 0 32v-14H50"/>
	<path d="M106 24v56"/>
	<path d="M106 24h18a16 16 0 0 1 0 32h-18"/>
	<path d="M124 56l16 24"/>
	<circle cx="192" cy="52" r="28"/>
	<path d="M240 24l22 56 22-56"/>
	<path d="M346 24h-36v56h36"/>
	<path d="M310 52h30"/>`

const svg = (inner: string, stroke = '#F2E9D8', width = 15): string =>
	`<svg viewBox="0 0 380 100" xmlns="http://www.w3.org/2000/svg" fill="none" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" stroke="${stroke}">${inner}</svg>`

export const LOGO_OPTIONS: LogoOption[] = [
	{
		id: 'grove-color',
		name: '彩叶字标',
		desc: '五个字母各用一种林间色，最活泼的一版',
		wordmark: svg(LETTERS),
		icon: `<rect x="4" y="4" width="92" height="92" rx="22" fill="#7BD88F"/><path d="M70 30a24 24 0 1 0 0 40v-13H58" fill="none" stroke="#14342B" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>`,
	},
	{
		id: 'grove-forest',
		name: '森林牌',
		desc: '深绿底、米白字母，稳重，适合长时间看',
		wordmark: `<svg viewBox="0 0 380 100" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="8" width="376" height="84" rx="22" fill="#14342B"/><g fill="none" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" stroke="#F2E9D8">${LETTERS_MONO}</g></svg>`,
		icon: `<rect x="4" y="4" width="92" height="92" rx="22" fill="#14342B"/><path d="M70 30a24 24 0 1 0 0 40v-13H58" fill="none" stroke="#F2E9D8" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>`,
	},
	{
		id: 'grove-sage',
		name: '灰绿字标',
		desc: '单色低饱和，藏在界面里不抢戏',
		wordmark: svg(LETTERS_MONO, '#A9C6A0'),
		icon: `<rect x="4" y="4" width="92" height="92" rx="22" fill="#A9C6A0"/><path d="M70 30a24 24 0 1 0 0 40v-13H58" fill="none" stroke="#1B3326" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>`,
	},
	{
		id: 'grove-badge',
		name: '印章',
		desc: '方形印章 + 字标，适合当头像或缩略标志',
		wordmark: `<svg viewBox="0 0 380 100" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="8" width="84" height="84" rx="20" fill="#1F4D3A"/><path d="M64 28a22 22 0 1 0 0 44v-16H52" fill="none" stroke="#F2E9D8" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><text x="100" y="52" fill="#F2E9D8" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="25" letter-spacing="1.5">GROVE</text><text x="101" y="74" fill="#8FBFA3" font-family="Segoe UI, Arial, sans-serif" font-size="11" letter-spacing="5">READER</text></svg>`,
		icon: `<rect x="4" y="4" width="92" height="92" rx="22" fill="#F2E9D8"/><path d="M70 30a24 24 0 1 0 0 40v-13H58" fill="none" stroke="#1F4D3A" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>`,
	},
]

export function logoById(id: string | undefined): LogoOption | undefined {
	return LOGO_OPTIONS.find(o => o.id === id)
}
