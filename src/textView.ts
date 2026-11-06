import { ItemView, Notice, ViewStateResult, WorkspaceLeaf, setIcon } from 'obsidian'
import type GroveReaderPlugin from './main'
import { BACKGROUND_PRESETS, DEFAULT_APPEARANCE, ReaderAppearance } from './types'
import { basenameOf, cleanBookTitle, contrastFg, isDarkColor } from './util'
import { decodeTextBuffer, paginateText, TextViewState, VIEW_TYPE_GROVE_TEXT } from './textCodec'

export { VIEW_TYPE_GROVE_TEXT } from './textCodec'

/** 与 EPUB 阅读外观面板保持同一组字体预设 */
const TEXT_FONT_PRESETS: Array<{ label: string; value: string }> = [
	{ label: '跟随主题', value: '' },
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

export class TextView extends ItemView {
	bookPath = ''
	private bytes: ArrayBuffer | null = null
	private pages: string[] = ['']
	private page = 0
	private encoding = 'auto'
	private detected = ''
	private warning: string | undefined
	private title = 'TXT'
	private loadingPath = ''
	private lastWheel = 0

	private readerEl!: HTMLElement
	private scrollEl!: HTMLElement
	private textEl!: HTMLElement
	private titleEl!: HTMLElement
	private metaEl!: HTMLElement
	private slider!: HTMLInputElement
	private progressLabel!: HTMLElement
	private prevBtn!: HTMLButtonElement
	private nextBtn!: HTMLButtonElement
	private encodingSelect!: HTMLSelectElement
	private appearPanelEl!: HTMLElement

	constructor(leaf: WorkspaceLeaf, private plugin: GroveReaderPlugin) {
		super(leaf)
	}

	getViewType(): string {
		return VIEW_TYPE_GROVE_TEXT
	}

	getDisplayText(): string {
		return this.title || 'TXT'
	}

	getIcon(): string {
		return 'file-text'
	}

	async setState(state: unknown, result?: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as TextViewState
		if (s.bookPath && s.bookPath !== this.bookPath) {
			this.bookPath = s.bookPath
			this.encoding = 'auto'
			this.page = 0
		}
		await super.setState(state, result ?? { history: false })
		if (this.readerEl && this.bookPath) await this.#load()
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty()
		this.contentEl.addClass('grove-content')
		this.#buildDom()
		this.#applyAppearance()
		this.registerEvent(this.app.workspace.on('css-change', () => this.#applyAppearance()))
		if (this.bookPath) await this.#load()
		else this.#showEmpty('没有指定要打开的 TXT 文件')
	}

	#buildDom(): void {
		const toolbar = this.contentEl.createDiv('grove-toolbar')
		this.titleEl = toolbar.createDiv('grove-text-title')
		this.titleEl.setText('TXT')
		this.metaEl = toolbar.createDiv('grove-text-meta')

		const progress = toolbar.createDiv('grove-progress')
		this.slider = progress.createEl('input', {
			attr: { type: 'range', min: '1', max: '1', step: '1', value: '1' },
		})
		this.progressLabel = progress.createSpan('grove-progress-label')
		this.progressLabel.setText('—')
		this.slider.disabled = true
		this.slider.addEventListener('input', () => {
			const n = Number.parseInt(this.slider.value, 10)
			if (!Number.isFinite(n)) return
			this.page = Math.max(0, Math.min(this.pages.length - 1, n - 1))
			this.progressLabel.setText(`${this.page + 1} / ${this.pages.length}`)
		})
		this.slider.addEventListener('change', () => this.#showPage())

		const encodingWrap = toolbar.createDiv('grove-text-encoding')
		encodingWrap.createSpan({ text: '编码' })
		this.encodingSelect = encodingWrap.createEl('select', { cls: 'dropdown' })
		for (const [value, label] of [
			['auto', '自动'],
			['utf-8', 'UTF-8'],
			['gb18030', 'GB18030 / GBK'],
			['big5', 'Big5'],
			['utf-16le', 'UTF-16 LE'],
			['utf-16be', 'UTF-16 BE'],
		]) this.encodingSelect.createEl('option', { value, text: label })
		this.encodingSelect.value = this.encoding
		this.encodingSelect.addEventListener('change', () => {
			this.encoding = this.encodingSelect.value
			this.page = 0
			this.#decodeAndRender()
			new Notice(`${this.plugin.manifest.name}：编码已切换为 ${this.encoding === 'auto' ? '自动' : this.encoding}`)
		})

		const appearBtn = toolbar.createEl('button', {
			cls: 'clickable-icon grove-icon-btn',
			attr: { 'aria-label': '阅读外观（字体 / 背景 / 行距）' },
		})
		setIcon(appearBtn, 'type')
		appearBtn.addEventListener('click', e => {
			e.stopPropagation()
			this.#toggleAppearancePanel()
		})

		this.appearPanelEl = this.contentEl.createDiv('grove-appear-panel grove-hidden')
		this.registerDomEvent(this.contentEl, 'click', e => {
			if (this.appearPanelEl.hasClass('grove-hidden')) return
			const t = e.target
			if (t instanceof Element && !t.closest('.grove-appear-panel') && !t.closest('.grove-icon-btn')) {
				this.appearPanelEl.addClass('grove-hidden')
			}
		}, { capture: true })

		const body = this.contentEl.createDiv('grove-body')
		this.readerEl = body.createDiv('grove-reader')
		this.scrollEl = this.readerEl.createDiv('grove-reader-inner grove-text-scroll')
		this.textEl = this.scrollEl.createEl('pre', { cls: 'grove-text-content' })
		this.registerDomEvent(this.scrollEl, 'wheel', e => this.#onWheel(e), { passive: false })

		const pageBtns = this.readerEl.createDiv('grove-page-btns')
		this.prevBtn = pageBtns.createEl('button', {
			cls: 'clickable-icon grove-page-btn',
			attr: { 'aria-label': '上一页' },
		})
		setIcon(this.prevBtn, 'chevron-left')
		this.prevBtn.disabled = true
		this.prevBtn.addEventListener('click', () => this.#goPage(this.page - 1))
		this.nextBtn = pageBtns.createEl('button', {
			cls: 'clickable-icon grove-page-btn',
			attr: { 'aria-label': '下一页' },
		})
		setIcon(this.nextBtn, 'chevron-right')
		this.nextBtn.disabled = true
		this.nextBtn.addEventListener('click', () => this.#goPage(this.page + 1))
	}

	async #load(): Promise<void> {
		const path = this.bookPath
		if (!path || this.loadingPath === path) return
		this.loadingPath = path
		this.#showEmpty('正在读取…')
		try {
			const bytes = await this.plugin.readBookBytes(path)
			if (this.loadingPath !== path) return
			this.bytes = bytes
			this.title = this.plugin.shelfCache.get(path)?.title || cleanBookTitle(basenameOf(path))
			this.#decodeAndRender()
		} catch (e) {
			this.#showEmpty(`读取失败：${e instanceof Error ? e.message : String(e)}`)
		} finally {
			if (this.loadingPath === path) this.loadingPath = ''
		}
	}

	#decodeAndRender(): void {
		if (!this.bytes) return
		const decoded = decodeTextBuffer(this.bytes, this.encoding)
		this.detected = decoded.encoding
		this.warning = decoded.warning
		this.pages = paginateText(decoded.text)
		this.page = Math.min(this.page, this.pages.length - 1)
		this.titleEl.setText(this.title)
		this.titleEl.title = this.title
		this.metaEl.setText(`编码 ${this.detected.toUpperCase()} · ${this.pages.length} 页${this.warning ? ` · ${this.warning}` : ''}`)
		this.encodingSelect.value = this.encoding
		this.slider.min = '1'
		this.slider.max = String(Math.max(1, this.pages.length))
		this.slider.disabled = this.pages.length <= 1
		this.#showPage()
	}

	#showPage(): void {
		if (!this.textEl) return
		this.textEl.setText(this.pages[this.page] ?? '')
		this.scrollEl.scrollTop = 0
		this.slider.value = String(this.page + 1)
		this.progressLabel.setText(`${this.page + 1} / ${this.pages.length}`)
		this.prevBtn.disabled = this.page <= 0
		this.nextBtn.disabled = this.page >= this.pages.length - 1
	}

	#goPage(page: number): void {
		this.page = Math.max(0, Math.min(this.pages.length - 1, page))
		this.#showPage()
	}

	#showEmpty(message: string): void {
		if (!this.textEl) return
		this.textEl.setText(message)
		this.titleEl.setText(this.title || 'TXT')
		this.metaEl.setText('')
		this.progressLabel.setText('—')
		this.slider.disabled = true
		this.prevBtn.disabled = true
		this.nextBtn.disabled = true
	}

	#onWheel(e: WheelEvent): void {
		if (!this.plugin.settings.appearance.wheelPageTurn || e.ctrlKey || e.metaKey) return
		const atBottom = this.scrollEl.scrollTop + this.scrollEl.clientHeight >= this.scrollEl.scrollHeight - 2
		const atTop = this.scrollEl.scrollTop <= 0
		const now = Date.now()
		if (now - this.lastWheel < 450) return
		if (e.deltaY > 0 && atBottom && this.page < this.pages.length - 1) {
			e.preventDefault()
			this.lastWheel = now
			this.#goPage(this.page + 1)
		} else if (e.deltaY < 0 && atTop && this.page > 0) {
			e.preventDefault()
			this.lastWheel = now
			this.#goPage(this.page - 1)
		}
	}

	#toggleAppearancePanel(): void {
		if (this.appearPanelEl.hasClass('grove-hidden')) {
			this.#renderAppearancePanel()
			this.appearPanelEl.removeClass('grove-hidden')
		} else {
			this.appearPanelEl.addClass('grove-hidden')
		}
	}

	#renderAppearancePanel(): void {
		const a = this.plugin.settings.appearance
		const panel = this.appearPanelEl
		panel.empty()

		const bgRow = panel.createDiv('grove-appear-row')
		bgRow.createSpan('grove-appear-label').setText('背景')
		const swatches = bgRow.createDiv('grove-appear-swatches')
		const themeChip = swatches.createEl('button', { cls: 'grove-appear-chip', text: '跟随主题' })
		if (a.followTheme) themeChip.addClass('is-active')
		themeChip.addEventListener('click', () => this.#patchAppearance({ followTheme: true }, true))
		for (const preset of BACKGROUND_PRESETS) {
			const sw = swatches.createEl('button', { cls: 'grove-appear-swatch', attr: { 'aria-label': preset.name, title: preset.name } })
			sw.style.backgroundColor = preset.bg
			if (!a.followTheme && a.bgKey === preset.key) sw.addClass('is-active')
			sw.addEventListener('click', () => this.#patchAppearance({ followTheme: false, bgKey: preset.key }, true))
		}
		const customWrap = swatches.createDiv('grove-appear-swatch grove-appear-custom')
		customWrap.style.backgroundColor = a.customBg
		if (!a.followTheme && a.bgKey === 'custom') customWrap.addClass('is-active')
		const colorInput = customWrap.createEl('input', { attr: { type: 'color', title: '自定义背景色' } })
		colorInput.value = /^#[0-9a-fA-F]{6}$/.test(a.customBg) ? a.customBg : '#ffffff'
		colorInput.addEventListener('input', () => {
			Object.assign(this.plugin.settings.appearance, { followTheme: false, bgKey: 'custom', customBg: colorInput.value })
			customWrap.style.backgroundColor = colorInput.value
			this.#applyAppearance()
			this.plugin.persistSettingsSoon()
		})

		const fontRow = panel.createDiv('grove-appear-row')
		fontRow.createSpan('grove-appear-label').setText('字体')
		const fontSelect = fontRow.createEl('select', { cls: 'dropdown' })
		for (const font of TEXT_FONT_PRESETS) fontSelect.createEl('option', { value: font.value, text: font.label })
		fontSelect.value = TEXT_FONT_PRESETS.some(font => font.value === a.fontFamily) ? a.fontFamily : ''
		fontSelect.addEventListener('change', () => this.#patchAppearance({ fontFamily: fontSelect.value }, true))

		const sliders: Array<{ label: string; key: keyof ReaderAppearance; min: number; max: number; step: number; fmt: (v: number) => string }> = [
			{ label: '字号', key: 'fontSize', min: 80, max: 180, step: 5, fmt: v => `${Math.round(v)}%` },
			{ label: '行距', key: 'lineHeight', min: 1.2, max: 2.4, step: 0.05, fmt: v => v.toFixed(2) },
			{ label: '上下留白', key: 'pageMargin', min: 0, max: 200, step: 4, fmt: v => `${Math.round(v)}px` },
			{ label: '版心宽', key: 'maxInlineSize', min: 480, max: 1200, step: 20, fmt: v => `${Math.round(v)}px` },
		]
		for (const item of sliders) {
			const row = panel.createDiv('grove-appear-row')
			row.createSpan('grove-appear-label').setText(item.label)
			const wrap = row.createDiv('grove-appear-slider')
			const range = wrap.createEl('input', {
				attr: { type: 'range', min: String(item.min), max: String(item.max), step: String(item.step) },
			})
			const valueEl = wrap.createSpan('grove-appear-value')
			const current = Number(a[item.key]) || item.min
			range.value = String(current)
			valueEl.setText(item.fmt(current))
			range.addEventListener('input', () => {
				const value = Number.parseFloat(range.value)
				valueEl.setText(item.fmt(value))
				this.#patchAppearance({ [item.key]: value } as Partial<ReaderAppearance>)
			})
		}

		const foot = panel.createDiv('grove-appear-foot')
		const reset = foot.createEl('button', { text: '恢复默认' })
		reset.addEventListener('click', () => {
			Object.assign(this.plugin.settings.appearance, DEFAULT_APPEARANCE)
			this.#applyAppearance()
			void this.plugin.persistSettingsNow()
			this.#renderAppearancePanel()
		})
	}

	#patchAppearance(patch: Partial<ReaderAppearance>, rerender = false): void {
		Object.assign(this.plugin.settings.appearance, patch)
		this.#applyAppearance()
		this.plugin.persistSettingsSoon()
		if (rerender) this.#renderAppearancePanel()
	}

	#applyAppearance(): void {
		if (!this.readerEl || !this.textEl) return
		const a = this.plugin.settings.appearance
		let bg: string
		let fg: string
		if (a.followTheme) {
			const style = getComputedStyle(document.body)
			const dark = document.body.classList.contains('theme-dark')
			bg = style.getPropertyValue('--background-primary').trim() || (dark ? '#1e1e20' : '#ffffff')
			fg = style.getPropertyValue('--text-normal').trim() || (dark ? '#dcddde' : '#2b2b2b')
		} else {
			const preset = BACKGROUND_PRESETS.find(item => item.key === a.bgKey)
			bg = a.bgKey === 'custom' ? a.customBg : (preset?.bg ?? '#ffffff')
			fg = a.bgKey === 'custom' ? contrastFg(bg) : (preset?.fg ?? contrastFg(bg))
		}
		const themeFont = getComputedStyle(document.body).getPropertyValue('--font-text').trim()
		const font = a.fontFamily || themeFont || 'serif'
		this.readerEl.style.backgroundColor = bg
		this.readerEl.style.color = fg
		this.scrollEl.style.backgroundColor = bg
		this.textEl.style.color = fg
		this.textEl.style.fontFamily = font
		this.textEl.style.fontSize = `${a.fontSize}%`
		this.textEl.style.lineHeight = String(a.lineHeight)
		this.textEl.style.maxWidth = `${a.maxInlineSize}px`
		this.textEl.style.paddingTop = `${a.pageMargin}px`
		this.textEl.style.paddingBottom = `${a.pageMargin}px`
		this.textEl.style.paddingLeft = '28px'
		this.textEl.style.paddingRight = '28px'
		this.readerEl.style.setProperty('--text-selection', isDarkColor(bg) ? 'rgba(120,160,255,0.35)' : 'rgba(64,120,255,0.25)')
	}

	async onClose(): Promise<void> {
		this.contentEl.empty()
	}
}
