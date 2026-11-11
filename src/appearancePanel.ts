/**
 * 外观面板的共用渲染（EPUB 与 TXT 同一份）。
 *
 * 两个视图原先各写一套，结果慢慢长歪了：TXT 少了「翻页」行、少了自定义字体与
 * 预览，滑杆数量也不同。用户按 EPUB 的习惯去 TXT 里找「鼠标滚动切换」就找不到。
 *
 * 这里只负责画控件，不改状态：任何改动都通过 host.patch() 回到各视图自己的
 * #patchAppearance()——那边要负责应用样式、落盘与（必要时）重画面板。
 */
import { BACKGROUND_PRESETS, type ReaderAppearance } from './types'

/** 字体预设：两个视图共用一份，避免再各写一套慢慢长歪 */
const FONT_PRESETS: Array<{ label: string; value: string }> = [
	{ label: '跟随书籍', value: '' },
	{ label: '系统衬线', value: 'serif' },
	{ label: '系统无衬线', value: 'sans-serif' },
	{ label: '宋体', value: '"Songti SC", "SimSun", "Noto Serif CJK SC", serif' },
	{ label: '黑体', value: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif' },
	{ label: '楷体', value: '"KaiTi", "STKaiti", "Kaiti SC", serif' },
	{ label: '仿宋', value: '"FangSong", "STFangsong", "Fang Song", serif' },
	{ label: '霞鹜文楷', value: '"LXGW WenKai", "LXGW WenKai GB", "LXGW WenKai Screen", KaiTi, serif' },
	{ label: '思源宋体', value: '"Source Han Serif SC", "Noto Serif CJK SC", "SimSun", serif' },
	{ label: '思源黑体', value: '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif' },
]

export interface AppearancePanelHost {
	/** 'txt' 不提供「段间距」：TXT 按纯文本排版，没有 <p> 的外边距可调 */
	surface: 'ebook' | 'txt'
	appearance: () => ReaderAppearance
	/** rerender=true 表示这次改动会改变面板自身的选中态（背景 / 字体） */
	patch: (patch: Partial<ReaderAppearance>, rerender?: boolean) => void
	reset: () => void
}

export function renderAppearancePanel(panel: HTMLElement, host: AppearancePanelHost): void {
	const a = host.appearance()
	panel.empty()

	// —— 背景 ——
	const bgRow = panel.createDiv('grove-appear-row')
	bgRow.createSpan('grove-appear-label').setText('背景')
	const swatches = bgRow.createDiv('grove-appear-swatches')
	const themeChip = swatches.createEl('button', { cls: 'grove-appear-chip' })
	themeChip.setText('跟随主题')
	themeChip.addEventListener('click', () => host.patch({ followTheme: true }, true))
	if (a.followTheme) themeChip.addClass('is-active')

	for (const preset of BACKGROUND_PRESETS) {
		const sw = swatches.createEl('button', {
			cls: 'grove-appear-swatch',
			attr: { 'aria-label': preset.name, title: preset.name },
		})
		sw.style.backgroundColor = preset.bg
		if (!a.followTheme && a.bgKey === preset.key) sw.addClass('is-active')
		sw.addEventListener('click', () => host.patch({ followTheme: false, bgKey: preset.key }, true))
	}
	const customWrap = swatches.createDiv('grove-appear-swatch grove-appear-custom')
	customWrap.style.backgroundColor = a.customBg
	if (!a.followTheme && a.bgKey === 'custom') customWrap.addClass('is-active')
	const colorInput = customWrap.createEl('input', { attr: { type: 'color', title: '自定义背景色' } })
	colorInput.value = /^#[0-9a-fA-F]{6}$/.test(a.customBg) ? a.customBg : '#ffffff'
	colorInput.addEventListener('input', () => {
		host.patch({ followTheme: false, bgKey: 'custom', customBg: colorInput.value })
		customWrap.style.backgroundColor = colorInput.value
	})

	// —— 字体 ——
	const fontRow = panel.createDiv('grove-appear-row')
	fontRow.createSpan('grove-appear-label').setText('字体')
	const fontCol = fontRow.createDiv('grove-appear-col')
	const fontSelect = fontCol.createEl('select', { cls: 'dropdown' })
	for (const font of FONT_PRESETS) {
		// 第一项是「不指定字体」，两个视图的措辞不同：EPUB 跟随书籍内嵌样式，TXT 跟随主题
		const label = font.value === '' && host.surface === 'txt' ? '跟随主题' : font.label
		fontSelect.createEl('option', { value: font.value, text: label })
	}
	const presetValue = FONT_PRESETS.some(f => f.value === a.fontFamily) ? a.fontFamily : ''
	fontSelect.value = presetValue

	const customFont = fontCol.createEl('input', {
		attr: { type: 'text', placeholder: '自定义字体名（可留空），如 霞鹜文楷' },
	})
	if (!presetValue && a.fontFamily) customFont.value = a.fontFamily.replace(/["']/g, '')

	const themeFont = getComputedStyle(document.body).getPropertyValue('--font-text').trim()
	const preview = fontCol.createDiv('grove-font-preview')
	preview.setText('永 Aa 阅读字体预览 123')
	preview.style.fontFamily = a.fontFamily || themeFont || 'serif'
	const updatePreview = (family: string): void => {
		preview.style.fontFamily = family || themeFont || 'serif'
	}
	fontSelect.addEventListener('change', () => {
		updatePreview(fontSelect.value)
		host.patch({ fontFamily: fontSelect.value }, true)
	})
	customFont.addEventListener('change', () => {
		const raw = customFont.value.trim()
		// 字体名里的引号会破坏后面拼进 CSS 的 font-family 声明，直接剔除
		const family = raw ? raw.split(',').map(s => `"${s.trim().replace(/"/g, '')}"`).join(', ') : ''
		updatePreview(family)
		host.patch({ fontFamily: family }, true)
	})

	// —— 滑杆 ——
	const sliders: Array<{
		label: string
		key: keyof ReaderAppearance
		min: number
		max: number
		step: number
		fmt: (v: number) => string
	}> = [
		{ label: '字号', key: 'fontSize', min: 80, max: 180, step: 5, fmt: v => `${Math.round(v)}%` },
		{ label: '行距', key: 'lineHeight', min: 1.2, max: 2.4, step: 0.05, fmt: v => v.toFixed(2) },
		{ label: '上下留白', key: 'pageMargin', min: 0, max: 200, step: 4, fmt: v => `${Math.round(v)}px` },
	]
	if (host.surface === 'ebook') {
		sliders.push({
			label: '段间距',
			key: 'paragraphSpacing',
			min: 0,
			max: 2,
			step: 0.1,
			fmt: v => (v <= 0 ? '跟随书籍' : `${v.toFixed(1)}em`),
		})
	}
	sliders.push({ label: '版心宽', key: 'maxInlineSize', min: 480, max: 1200, step: 20, fmt: v => `${Math.round(v)}px` })

	for (const item of sliders) {
		const row = panel.createDiv('grove-appear-row')
		row.createSpan('grove-appear-label').setText(item.label)
		const wrap = row.createDiv('grove-appear-slider')
		const range = wrap.createEl('input', {
			attr: {
				type: 'range',
				min: String(item.min),
				max: String(item.max),
				step: String(item.step),
			},
		})
		const valueEl = wrap.createSpan('grove-appear-value')
		const current = Number(a[item.key]) || item.min
		range.value = String(current)
		valueEl.setText(item.fmt(current))
		range.addEventListener('input', () => {
			const value = Number.parseFloat(range.value)
			valueEl.setText(item.fmt(value))
			host.patch({ [item.key]: value } as Partial<ReaderAppearance>)
		})
	}

	// —— 翻页 ——
	const pageRow = panel.createDiv('grove-appear-row')
	pageRow.createSpan('grove-appear-label').setText('翻页')
	const pageCol = pageRow.createDiv('grove-appear-col')
	const wheelLabel = pageCol.createEl('label', { cls: 'grove-appear-toggle' })
	const wheelBox = wheelLabel.createEl('input', { attr: { type: 'checkbox' } })
	wheelBox.checked = a.wheelPageTurn
	wheelLabel.createSpan({ text: '鼠标滚动切换（上下滚动翻页）' })
	wheelBox.addEventListener('change', () => host.patch({ wheelPageTurn: wheelBox.checked }))

	// —— 恢复默认 ——
	const foot = panel.createDiv('grove-appear-foot')
	const reset = foot.createEl('button', { text: '恢复默认' })
	reset.addEventListener('click', () => host.reset())
}
