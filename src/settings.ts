import { App, Notice, Platform, PluginSettingTab, Setting, getLanguage, setIcon } from 'obsidian'
import type GroveReaderPlugin from './main'
import { FolderPromptModal, FolderSuggest, ConfirmModal, OpLogModal, TemplateEditModal } from './modals'
import { APP_NAME, BACKUP_FOLDER_NAME, DEFAULT_SHELF_DISPLAY, HIGHLIGHT_COLORS, normalizeToolbarOrder } from './types'
import type { GroveSettings } from './types'
import { appendInlineSvg, basenameOf, isAbsolutePath } from './util'
import { applyLocale, localeName, t, type UiLocale } from './i18n'
import { LOGO_OPTIONS } from './logos'
import { embeddingProviderLabel, type EmbeddingProvider } from './embedding'
import { VectorIndexModal } from './vectorIndexModal'
import { ImportHighlightsModal } from './importHighlightsModal'

type SettingsTab = 'appearance' | 'shelf' | 'reading' | 'data'

const SETTINGS_TABS: Array<{ id: SettingsTab; name: string }> = [
	{ id: 'appearance', name: '外观' },
	{ id: 'shelf', name: '书架' },
	{ id: 'reading', name: '阅读与笔记' },
	{ id: 'data', name: '数据与维护' },
]

export class GroveSettingTab extends PluginSettingTab {
	private activeTab: SettingsTab = 'appearance'

	constructor(app: App, private plugin: GroveReaderPlugin) {
		super(app, plugin)
	}

	display(): void {
		const { containerEl } = this
		containerEl.empty()

		const currentLogo = this.plugin.settings.logoStyle ?? 'original'
		const selected = LOGO_OPTIONS.find(o => o.id === currentLogo)
		const brand = containerEl.createDiv('grove-settings-brand')
		if (selected?.wordmark) {
			appendInlineSvg(brand, selected.wordmark)
		} else {
			const icon = brand.createSpan('grove-settings-brand-icon')
			setIcon(icon, 'library')
			brand.createSpan('grove-settings-brand-name').setText(APP_NAME)
		}

		containerEl.createEl('h2', { text: t('{name} 设置', { name: APP_NAME }) })
		this.#renderTabs(containerEl)

		const body = containerEl.createDiv('grove-settings-body')
		switch (this.activeTab) {
			case 'appearance':
				this.#renderAppearance(body, currentLogo)
				break
			case 'shelf':
				this.#renderShelf(body)
				break
			case 'reading':
				this.#renderReading(body)
				break
			case 'data':
				this.#renderData(body)
				break
		}
	}

	/** 顶部四个入口；以后新增设置时，先选一个 tab，再在对应 render 里加 Setting 即可 */
	#renderTabs(containerEl: HTMLElement): void {
		const nav = containerEl.createDiv('grove-settings-tabs')
		nav.setAttr('role', 'tablist')
		for (const tab of SETTINGS_TABS) {
			const button = nav.createEl('button', { cls: 'grove-settings-tab', text: t(tab.name) })
			button.type = 'button'
			button.setAttr('role', 'tab')
			button.setAttr('aria-selected', String(this.activeTab === tab.id))
			if (this.activeTab === tab.id) button.addClass('is-active')
			button.addEventListener('click', () => {
				if (this.activeTab === tab.id) return
				this.activeTab = tab.id
				this.display()
				const scroller = this.containerEl.closest('.vertical-tab-content')
				if (scroller instanceof HTMLElement) scroller.scrollTo({ top: 0 })
			})
		}
	}

	#renderAppearance(containerEl: HTMLElement, currentLogo: string): void {
		// —— 界面语言 ——
		new Setting(containerEl)
			.setName(t('界面语言'))
			.setDesc(
				t(
					'选择插件界面使用的语言。跟随 Obsidian 时随应用语言自动切换，改动后重新打开视图或重启 Obsidian 才会全部生效。',
				),
			)
			.addDropdown(drop => {
				drop.addOption('auto', localeName('auto'))
				drop.addOption('zh', localeName('zh'))
				drop.addOption('en', localeName('en'))
				drop.setValue(this.plugin.settings.uiLocale ?? 'auto')
				drop.onChange(async value => {
					this.plugin.settings.uiLocale = value as UiLocale
					await this.plugin.saveSettings()
					applyLocale(this.plugin.settings.uiLocale, getLanguage())
					this.plugin.app.workspace.updateOptions()
					this.display()
					new Notice(t('界面语言已切换，重新打开视图或重启 Obsidian 后全部生效。'))
				})
			})

		// —— 标志 ——
		containerEl.createEl('h3', { text: t('标志') })
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: t('选一个显示在标签页、功能区和空书架上的标志。标签页图标会在重新打开书架后更新。'),
		})
		const grid = containerEl.createDiv('grove-logo-grid')
		const options: Array<{ id: string; name: string; desc?: string; wordmark?: string }> = [
			{ id: 'original', name: t('原始图标'), desc: t('Obsidian 自带的 library 图标') },
			...LOGO_OPTIONS,
		]
		for (const option of options) {
			const card = grid.createDiv('grove-logo-card')
			if (option.id === currentLogo) card.addClass('is-active')
			const preview = card.createDiv('grove-logo-preview')
			if (option.wordmark) {
				appendInlineSvg(preview, option.wordmark)
			} else {
				const icon = preview.createSpan('grove-logo-original')
				setIcon(icon, 'library')
			}
			card.createDiv('grove-logo-name').setText(t(option.name))
			if (option.desc) card.createDiv('grove-logo-desc').setText(t(option.desc))
			card.addEventListener('click', () => {
				this.plugin.settings.logoStyle = option.id
				void this.plugin.saveSettings()
				this.plugin.applyLogo()
				this.display()
			})
		}

		// —— 书架显示 ——
		containerEl.createEl('h3', { text: t('书架显示') })
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: t('卡片上显示哪些信息。默认只留最常用的几项，信息多时卡片会换行变高。'),
		})
		const shelfToggle = (name: string, desc: string, key: keyof typeof DEFAULT_SHELF_DISPLAY): void => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle(toggle =>
					toggle
						.setValue(this.plugin.settings.shelfDisplay[key])
						.onChange(async value => {
							this.plugin.settings.shelfDisplay[key] = value
							await this.plugin.saveSettings()
							this.plugin.refreshShelfViews()
						}))
		}
		shelfToggle(t('格式徽章'), t('在卡片信息行显示 EPUB / PDF / MOBI 等格式标签'), 'showFormatBadge')
		shelfToggle(t('阅读进度'), t('封面底部进度条 + 卡片上的百分比；读完后显示「已读」'), 'showProgress')
		shelfToggle(t('批注条数'), t('显示这本书有多少条批注'), 'showAnnotationCount')
		shelfToggle(t('最近阅读'), t('显示「3 天前」这类相对时间'), 'showLastRead')
		shelfToggle(t('笔记标记'), t('已生成阅读笔记的书显示文档图标，点击直接打开笔记'), 'showNoteBadge')
		shelfToggle(t('文件大小'), t('在卡片上显示文件体积（关闭时仍可在悬浮提示里看到）'), 'showFileSize')
		shelfToggle(t('继续阅读'), t('书架顶部显示最近在读、尚未读完的书（最多 6 本）'), 'showContinueReading')
		shelfToggle(t('作者与出版社合并一行'), t('关闭后作者、出版社各占一行，卡片会更高'), 'mergeAuthorPublisher')
		shelfToggle(t('书单色条'), t('卡片左侧显示所属书单的色条（颜色由书单自动生成）'), 'showListColor')
	}

	#renderShelf(containerEl: HTMLElement): void {
		// —— 扫描文件夹 ——
		containerEl.createEl('h3', { text: t('扫描文件夹') })
		new Setting(containerEl)
			.setName(t('扫描文件夹'))
			.setDesc(t('书架从这些文件夹扫描书籍；支持库内文件夹或本机绝对路径（子文件夹会一并扫描）。PDF、TXT 也会被收纳进书架，点击用 Obsidian 原生视图或 Grove TXT 视图打开'))
			.addButton(button =>
				button
					.setButtonText(t('添加文件夹'))
					.setCta()
					.onClick(() => {
						new FolderPromptModal(this.app, t('添加扫描文件夹'), t('例如：书籍'), async value => {
							if (!this.plugin.settings.scanFolders.includes(value)) {
								this.plugin.settings.scanFolders.push(value)
								await this.plugin.saveSettings()
								this.plugin.refreshShelfViews()
								this.display()
							}
						}).open()
					}))
		for (const folder of [...this.plugin.settings.scanFolders]) {
			const setting = new Setting(containerEl).setName(folder)
			setting.settingEl.addClass('grove-setting-sub')
			setting.addButton(button =>
				button.setIcon('trash-2').setTooltip(t('移除')).onClick(async () => {
					const i = this.plugin.settings.scanFolders.indexOf(folder)
					if (i >= 0) this.plugin.settings.scanFolders.splice(i, 1)
					await this.plugin.saveSettings()
					this.plugin.refreshShelfViews()
					this.display()
				}))
		}

		// —— 隐藏的书 ——
		containerEl.createEl('h3', { text: t('隐藏与恢复') })
		const hiddenBooks = this.plugin.settings.hiddenBooks ?? []
		const hiddenCount = hiddenBooks.length
		if (hiddenCount) {
			// 列出书名，别只给一个数字：恢复时才知道自己在恢复什么
			const hiddenList = containerEl.createDiv('grove-hidden-books')
			for (const p of hiddenBooks) {
				const title = this.plugin.shelfCache.get(p)?.title || basenameOf(p)
				hiddenList.createDiv('grove-hidden-book').setText(title)
			}
		}
		new Setting(containerEl)
			.setName(t('从书架移除的书籍'))
			.setDesc(hiddenCount
				? `当前隐藏 ${hiddenCount} 本，原文件和批注数据都还在；恢复后会重新出现在书架`
				: t('在书架右键「删除书籍…」且不勾选删除原文件时，书会暂时收在这里'))
			.addButton(button =>
				button
					.setButtonText(t('全部恢复'))
					.setDisabled(hiddenCount === 0)
					.onClick(async () => {
						await this.plugin.restoreHiddenBooks()
						this.display()
					}))
	}

	#renderReading(containerEl: HTMLElement): void {
		// —— 阅读 ——
		containerEl.createEl('h3', { text: t('阅读') })
		new Setting(containerEl)
			.setName(t('打开书本时同时展开批注列表'))
			.setDesc(t('关闭后，打开书时只显示正文；可随时点工具栏的「批注列表」按钮唤出侧栏。在正文中点击已批注的文段时，侧栏仍会自动展开并定位到对应批注'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.openSidebarWithBook).onChange(async value => {
					this.plugin.settings.openSidebarWithBook = value
					await this.plugin.saveSettings()
				}))

		new Setting(containerEl)
			.setName(t('手机上点正文上下区域翻页'))
			.setDesc(t('开启后，手机点正文上方 1/4 翻到上一页、下方 1/4 翻到下一页；中间区域仍是展开工具栏。默认关闭，避免误触'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.mobileTapZones ?? false).onChange(async value => {
					this.plugin.settings.mobileTapZones = value
					await this.plugin.saveSettings()
				}))

		new Setting(containerEl)
			.setName(t('手机上双指轻按切换沉浸阅读'))
			.setDesc(t('开启后，双指同时轻点正文会隐藏/显示工具栏与侧栏，适合手机全屏阅读。默认开启'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.mobileTwoFingerImmersive ?? true).onChange(async value => {
					this.plugin.settings.mobileTwoFingerImmersive = value
					await this.plugin.saveSettings()
				}))

		new Setting(containerEl)
			.setName(t('工具栏样式'))
			.setDesc(t('图标更省空间；文字按钮更好认，适合不熟悉图标的场景'))
			.addDropdown(dropdown =>
				dropdown
					.addOptions({ icon: t('图标'), text: t('文字') })
					.setValue(this.plugin.settings.toolbarStyle ?? 'icon')
					.onChange(async value => {
						this.plugin.settings.toolbarStyle = value === 'text' ? 'text' : 'icon'
						await this.plugin.saveSettings()
						new Notice(t('Grove Reader：工具栏样式已保存，重开书本后生效'))
					}))

		new Setting(containerEl)
			.setName(t('默认高亮颜色'))
			.setDesc(t('手机工具栏颜色菜单里的「默认色」按钮使用这个颜色；桌面 5 个色点不变'))
			.addDropdown(dropdown => {
				for (const c of HIGHLIGHT_COLORS) dropdown.addOption(c.key, c.name)
				dropdown
					.setValue(this.plugin.settings.defaultHighlightColor ?? 'yellow')
					.onChange(async value => {
						this.plugin.settings.defaultHighlightColor = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName(t('EPUB 高亮样式'))
			.setDesc(t('马克笔＝下半段色带 + 底部细线；整行色块＝整行半透明填充。重开书本后生效'))
			.addDropdown(dropdown =>
				dropdown
					.addOptions({ wash: t('马克笔（下划色带）'), block: t('整行色块') })
					.setValue(this.plugin.settings.epubHighlightStyle ?? 'wash')
					.onChange(async value => {
						this.plugin.settings.epubHighlightStyle = value === 'block' ? 'block' : 'wash'
						await this.plugin.saveSettings()
						new Notice(t('Grove Reader：高亮样式已保存，重开书本后生效'))
					}))

		new Setting(containerEl)
			.setName(t('隐藏的工具栏按钮'))
			.setDesc(t('用逗号分隔：评论 / 外观 / AI 问答 / 导读 / 笔记 / 书签 / 批注；重开书本后生效'))
			.addText(text =>
				text
					.setPlaceholder(t('例如：外观, 笔记'))
					.setValue((this.plugin.settings.hiddenToolbarActions ?? []).join(', '))
					.onChange(async value => {
						this.plugin.settings.hiddenToolbarActions = value
							.split(/[,，]/)
							.map(s => s.trim())
							.filter(Boolean)
						await this.plugin.saveSettings()
					}))

		// 动作顺序：用上下箭头调整，保存后重开书本生效
		const orderSetting = new Setting(containerEl)
			.setName(t('工具栏按钮顺序'))
			.setDesc(t('颜色与「评论」固定在左侧；其余按钮按这里从上到下排列，重开书本后生效'))
		orderSetting.addButton(button =>
			button.setButtonText(t('恢复默认')).onClick(async () => {
				this.plugin.settings.toolbarOrder = []
				await this.plugin.saveSettings()
				this.display()
			}))
		const orderBox = containerEl.createDiv('grove-order-editor')
		const order = normalizeToolbarOrder(this.plugin.settings.toolbarOrder)
		const move = async (index: number, delta: number): Promise<void> => {
			const next = order.slice()
			const target = index + delta
			if (target < 0 || target >= next.length) return
			;[next[index], next[target]] = [next[target], next[index]]
			this.plugin.settings.toolbarOrder = next
			await this.plugin.saveSettings()
			this.display()
		}
		order.forEach((name, index) => {
			const row = orderBox.createDiv('grove-order-row')
			row.createSpan('grove-order-index').setText(String(index + 1))
			row.createSpan('grove-order-name').setText(t(name))
			const up = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': t('上移'), title: t('上移') } })
			setIcon(up, 'chevron-up')
			up.disabled = index === 0
			up.addEventListener('click', () => void move(index, -1))
			const down = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': t('下移'), title: t('下移') } })
			setIcon(down, 'chevron-down')
			down.disabled = index === order.length - 1
			down.addEventListener('click', () => void move(index, 1))
		})

		new Setting(containerEl)
			.setName(t('每日阅读目标'))
			.setDesc(t('分钟；0 = 不设目标。用于阅读统计页的今日进度和热力图深浅'))
			.addText(text =>
				text.setValue(String(this.plugin.settings.dailyGoalMinutes ?? 30)).onChange(async value => {
					const n = Number.parseInt(value, 10)
					if (Number.isFinite(n) && n >= 0) {
						this.plugin.settings.dailyGoalMinutes = Math.min(600, n)
						await this.plugin.saveSettings()
					}
				}))

		new Setting(containerEl)
			.setName(t('每日页数目标'))
			.setDesc(t('页/天；0 = 不设目标。按翻页 / 换节计数（PDF 按页，EPUB 与 TXT 按屏），统计页显示今日进度'))
			.addText(text =>
				text.setValue(String(this.plugin.settings.dailyPageGoal ?? 0)).onChange(async value => {
					const n = Number.parseInt(value, 10)
					if (Number.isFinite(n) && n >= 0) {
						this.plugin.settings.dailyPageGoal = Math.min(2000, n)
						await this.plugin.saveSettings()
					}
				}))

		new Setting(containerEl)
			.setName(t('年度阅读目标'))
			.setDesc(t('本/年；0 = 不设目标。阅读统计页用方格显示今年读完进度'))
			.addText(text =>
				text.setValue(String(this.plugin.settings.yearlyGoalBooks ?? 24)).onChange(async value => {
					const n = Number.parseInt(value, 10)
					if (Number.isFinite(n) && n >= 0) {
						this.plugin.settings.yearlyGoalBooks = Math.min(500, n)
						await this.plugin.saveSettings()
					}
				}))

		new Setting(containerEl)
			.setName(t('每日复习条数'))
			.setDesc(t('间隔重复复习每天最多看几条；0 = 关闭复习。命令「今日复习」和书架右上角的复习按钮都按它出题'))
			.addText(text =>
				text.setValue(String(this.plugin.settings.reviewDailyCap ?? 5)).onChange(async value => {
					const n = Number.parseInt(value, 10)
					if (Number.isFinite(n) && n >= 0) {
						this.plugin.settings.reviewDailyCap = Math.min(100, n)
						await this.plugin.saveSettings()
					}
				}))

		new Setting(containerEl)
			.setName(t('复习队列包含旧划线'))
			.setDesc(t('开启时，昨天及更早、还没复习过的划线也会排进复习；关闭后只考到期的'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.reviewIncludeNew !== false).onChange(async value => {
					this.plugin.settings.reviewIncludeNew = value
					await this.plugin.saveSettings()
				}))

		new Setting(containerEl)
			.setName(t('朗读语速'))
			.setDesc(t('系统语音的朗读速度；1.0 为正常'))
			.addSlider(slider =>
				slider
					.setLimits(0.6, 1.6, 0.1)
					.setValue(this.plugin.settings.ttsRate ?? 1)
					.setDynamicTooltip()
					.onChange(async value => {
						this.plugin.settings.ttsRate = Math.round(value * 10) / 10
						await this.plugin.saveSettings()
					}))

		new Setting(containerEl)
			.setName(t('e-ink / 极简模式'))
			.setDesc(t('关闭动画、阴影与悬停位移；手机工具栏只留颜色、评论、外观、笔记、批注 5 个按钮，并启用点正文上下区域翻页'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.einkMode ?? false).onChange(async value => {
					this.plugin.settings.einkMode = value
					await this.plugin.saveSettings()
					this.plugin.applyEinkMode()
				}))

		// —— TXT 分页 ——
		containerEl.createEl('h3', { text: t('TXT 阅读') })
		new Setting(containerEl)
			.setName(t('TXT 页面版式'))
			.setDesc(t('单页＝一屏一页；双页＝左右两栏像翻书；自动＝窗口够宽时双页、变窄自动回到单页（与 EPUB 缩放时自动分栏的规律一致）'))
			.addDropdown(dropdown =>
				dropdown
					.addOptions({ auto: t('自动'), single: t('单页'), double: t('双页') })
					.setValue(this.plugin.settings.txtLayout ?? 'auto')
					.onChange(async value => {
						this.plugin.settings.txtLayout = value as GroveSettings['txtLayout']
						await this.plugin.saveSettings()
						this.plugin.refreshTextViewLayout()
					}))
		new Setting(containerEl)
			.setName(t('TXT 键盘翻页方向'))
			.setDesc(t('鼠标滚轮始终上下滚动即翻页；这里决定方向键用 ←/→ 还是 ↑/↓'))
			.addDropdown(dropdown =>
				dropdown
					.addOptions({ horizontal: '← / →', vertical: '↑ / ↓' })
					.setValue(this.plugin.settings.txtTurnAxis ?? 'horizontal')
					.onChange(async value => {
						this.plugin.settings.txtTurnAxis = value as GroveSettings['txtTurnAxis']
						await this.plugin.saveSettings()
					}))

		// —— PDF 链接 ——
		containerEl.createEl('h3', { text: t('PDF 链接') })
		new Setting(containerEl)
			.setName(t('复制链接的格式'))
			.setDesc(t('Grove 双链：[[书.pdf#grove-cfi=page:12&r=…]]，点击回到原句并标出框选；PDF++ 兼容：[[书.pdf#page=12&rect=…]]，供安装了 PDF++ 的库使用'))
			.addDropdown(dropdown =>
				dropdown
					.addOptions({ grove: t('Grove 双链（默认）'), pdfplus: t('PDF++ 兼容') })
					.setValue(this.plugin.settings.pdfLinkStyle ?? 'grove')
					.onChange(async value => {
						this.plugin.settings.pdfLinkStyle = value === 'pdfplus' ? 'pdfplus' : 'grove'
						await this.plugin.saveSettings()
					}))
		new Setting(containerEl)
			.setName(t('PDF 链接别名'))
			.setDesc(t('复制页链接 / 批注链接时写在竖线后的文字'))
			.addDropdown(dropdown =>
				dropdown
					.addOptions({ 'title-page': t('书名 · 页码'), page: t('仅页码'), snippet: t('原文开头') })
					.setValue(this.plugin.settings.pdfLinkAlias ?? 'title-page')
					.onChange(async value => {
						this.plugin.settings.pdfLinkAlias = value as GroveSettings['pdfLinkAlias']
						await this.plugin.saveSettings()
					}))

		// —— AI 解释 ——
		containerEl.createEl('h3', { text: t('AI 解释') })
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: t('划词后点「解释」按钮，让 AI 用中文说明这段文字的意思。走 OpenAI 兼容接口，默认填的是智谱 GLM-4-Flash（免费额度，注册即可用）。Key 只保存在本机插件配置里。'),
		})
		new Setting(containerEl)
			.setName(t('接口地址'))
			.setDesc(t('例如 https://open.bigmodel.cn/api/paas/v4（智谱）或 https://api.deepseek.com/v1（DeepSeek）'))
			.addText(text =>
				text
					.setPlaceholder('https://open.bigmodel.cn/api/paas/v4')
					.setValue(this.plugin.settings.aiBaseUrl ?? '')
					.onChange(async value => {
						this.plugin.settings.aiBaseUrl = value.trim()
						await this.plugin.saveSettings()
					}))
		new Setting(containerEl)
			.setName('API Key')
			.setDesc(t('留空则「解释」按钮会提示去配置。不要把它写进笔记或分享给别人'))
			.addText(text => {
				text.inputEl.type = 'password'
				text.setPlaceholder('sk-…')
					.setValue(this.plugin.settings.aiApiKey ?? '')
					.onChange(async value => {
						this.plugin.settings.aiApiKey = value.trim()
						await this.plugin.saveSettings()
					})
			})
		new Setting(containerEl)
			.setName(t('模型'))
			.setDesc(t('智谱免费版填 glm-4-flash；DeepSeek 填 deepseek-chat'))
			.addText(text =>
				text
					.setPlaceholder('glm-4-flash')
					.setValue(this.plugin.settings.aiModel ?? '')
					.onChange(async value => {
						this.plugin.settings.aiModel = value.trim()
						await this.plugin.saveSettings()
					}))
		new Setting(containerEl)
			.setName(t('提示词'))
			.setDesc(t('留空用内置提示词；想让它更贴近你的阅读习惯可以自己写'))
			.addTextArea(text => {
				text.setPlaceholder(t('你是一位中文阅读助手…'))
					.setValue(this.plugin.settings.aiPrompt ?? '')
					.onChange(async value => {
						this.plugin.settings.aiPrompt = value
						await this.plugin.saveSettings()
					})
				text.inputEl.rows = 3
			})
		// —— 语义检索（向量） ——
		containerEl.createEl('h3', { text: t('语义检索（向量）') })
		const provider = (this.plugin.settings.aiEmbeddingProvider ?? 'local') as EmbeddingProvider
		new Setting(containerEl)
			.setName(t('向量服务'))
			.setDesc(t('本地＝离线词法向量，不联网不花钱（同义说法未必命中）；智谱 embedding-3 需要资源包；硅基流动 bge-m3 有免费额度但需要单独填 Key。换服务后旧索引会失效，需重建'))
			.addDropdown(dropdown => {
				for (const key of ['local', 'zhipu', 'siliconflow', 'custom'] as EmbeddingProvider[]) {
					dropdown.addOption(key, embeddingProviderLabel(key))
				}
				dropdown.setValue(provider).onChange(async value => {
					this.plugin.settings.aiEmbeddingProvider = value as EmbeddingProvider
					await this.plugin.saveSettings()
					this.display()
				})
			})
		if (provider !== 'local') {
			new Setting(containerEl)
				.setName(t('嵌入接口地址'))
				.setDesc(t('OpenAI 兼容 /embeddings；留空则用上面的聊天接口地址（硅基流动默认 https://api.siliconflow.cn/v1）'))
				.addText(text =>
					text
						.setPlaceholder(provider === 'siliconflow' ? 'https://api.siliconflow.cn/v1' : t('留空用聊天接口地址'))
						.setValue(this.plugin.settings.aiEmbeddingBaseUrl ?? '')
						.onChange(async value => {
							this.plugin.settings.aiEmbeddingBaseUrl = value.trim()
							await this.plugin.saveSettings()
						}))
			new Setting(containerEl)
				.setName(t('嵌入 API Key'))
				.setDesc(t('留空则用上面的聊天 Key；硅基流动等第三方必须单独填'))
				.addText(text => {
					text.inputEl.type = 'password'
					text.setPlaceholder('sk-…')
						.setValue(this.plugin.settings.aiEmbeddingApiKey ?? '')
						.onChange(async value => {
							this.plugin.settings.aiEmbeddingApiKey = value.trim()
							await this.plugin.saveSettings()
						})
				})
			new Setting(containerEl)
				.setName(t('向量模型'))
				.setDesc(t('智谱填 embedding-3；硅基流动填 BAAI/bge-m3；OpenAI 填 text-embedding-3-small'))
				.addText(text =>
					text
						.setPlaceholder(provider === 'siliconflow' ? 'BAAI/bge-m3' : 'embedding-3')
						.setValue(this.plugin.settings.aiEmbeddingModel ?? '')
						.onChange(async value => {
							this.plugin.settings.aiEmbeddingModel = value.trim()
							await this.plugin.saveSettings()
						}))
			if (provider !== 'siliconflow') {
				new Setting(containerEl)
					.setName(t('向量维度'))
					.setDesc(t('默认 1024；服务不支持时会自动退回默认维度。维度越大索引越精确也越占空间'))
					.addText(text =>
						text
							.setPlaceholder('1024')
							.setValue(String(this.plugin.settings.aiEmbeddingDimensions ?? 1024))
							.onChange(async value => {
								const n = Number.parseInt(value, 10)
								if (Number.isFinite(n) && n >= 0) {
									this.plugin.settings.aiEmbeddingDimensions = Math.min(3072, n)
									await this.plugin.saveSettings()
								}
							}))
			}
		}

		// —— 笔记 ——
		containerEl.createEl('h3', { text: t('笔记') })
		new Setting(containerEl)
			.setName(t('新增/修改批注时自动更新笔记'))
			.setDesc(t('仅更新已经点过「生成/更新阅读笔记」的书：加删批注、改评论后约 1.5 秒自动重写笔记的生成区（标记区外你手写的内容会保留）。关闭后需手动点按钮更新'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.autoUpdateNote).onChange(async value => {
					this.plugin.settings.autoUpdateNote = value
					await this.plugin.saveSettings()
				}))
		new Setting(containerEl)
			.setName(t('摘录回跳链接样式'))
			.setDesc(t('双链：笔记里的「↩ 回原文」写成指向书文件的 [[双链]]，能在图谱和反向链接里看到「哪些笔记引了这本书」，插件关掉时也能打开书；协议链接：旧的 obsidian://grove 写法。改完只影响你手动「生成/更新笔记」的笔记，自动刷新不会悄悄改写旧笔记；想一次性换掉，用命令「刷新全部阅读笔记」'))
			.addDropdown(dropdown =>
				dropdown
					.addOption('wikilink', t('双链（推荐）'))
					.addOption('protocol', t('协议链接（旧）'))
					.setValue(this.plugin.settings.excerptLinkStyle === 'protocol' ? 'protocol' : 'wikilink')
					.onChange(async value => {
						this.plugin.settings.excerptLinkStyle = value === 'protocol' ? 'protocol' : 'wikilink'
						await this.plugin.saveSettings()
					}))
		new Setting(containerEl)
			.setName(t('笔记文件夹'))
			.setDesc(t('生成的阅读笔记保存位置（相对库根目录，输入时可从建议中选择；修改后旧笔记会在下次生成时自动移过去）'))
			.addText(text => {
				const save = async (raw: string): Promise<void> => {
					this.plugin.settings.notesFolder = raw.trim().replace(/[\\/]+$/, '') || '阅读笔记'
					await this.plugin.saveSettings()
				}
				new FolderSuggest(this.app, text.inputEl, value => void save(value))
				text.setValue(this.plugin.settings.notesFolder).onChange(async value => {
					await save(value)
				})
			})
		const templates = this.plugin.settings.noteTemplates ?? []
		const defaultId = this.plugin.settings.defaultNoteTemplateId ?? ''
		const openAddTemplate = (): void => {
			new TemplateEditModal(this.app, t('添加笔记模板'), '', this.plugin.defaultTemplatePath(), async (name, path) => {
				const id = `tpl-${Date.now().toString(36)}`
				this.plugin.settings.noteTemplates = [...(this.plugin.settings.noteTemplates ?? []), { id, name, path }]
				if (!this.plugin.settings.defaultNoteTemplateId) this.plugin.settings.defaultNoteTemplateId = id
				await this.plugin.saveSettings()
				this.display()
			}).open()
		}
		if (!templates.length) {
			new Setting(containerEl)
				.setName(t('默认模板'))
				.setDesc(t('模板文件路径（库内）。文件不存在时使用内置默认模板；可添加多套模板，按书单独切换'))
				.addText(text =>
					text.setValue(this.plugin.settings.noteTemplatePath).onChange(async value => {
						this.plugin.settings.noteTemplatePath = value.trim() || 'Grove Reader/阅读笔记/Grove 笔记模板.md'
						await this.plugin.saveSettings()
					}))
				.addButton(button =>
					button.setButtonText(t('创建 / 打开')).setCta().onClick(() => void this.plugin.openNoteTemplate()))
				.addButton(button =>
					button.setButtonText(t('添加模板')).onClick(openAddTemplate))
		} else {
			new Setting(containerEl)
				.setName(t('默认笔记模板'))
				.setDesc(t('新书默认使用这一套；单本书可在书架右键「笔记模板…」单独切换'))
				.addDropdown(dropdown => {
					for (const tpl of templates) dropdown.addOption(tpl.id, tpl.name)
					dropdown
						.setValue(templates.some(t => t.id === defaultId) ? defaultId : templates[0].id)
						.onChange(async value => {
							this.plugin.settings.defaultNoteTemplateId = value
							await this.plugin.saveSettings()
						})
				})
				.addButton(button =>
					button.setButtonText(t('添加模板')).setCta().onClick(openAddTemplate))
			for (const tpl of templates) {
				const setting = new Setting(containerEl).setName(tpl.name).setDesc(tpl.path)
				setting.settingEl.addClass('grove-setting-sub')
				if (tpl.id === (defaultId || templates[0].id)) {
					setting.addButton(button => button.setButtonText(t('默认')).setDisabled(true))
				} else {
					setting.addButton(button =>
						button.setButtonText(t('设为默认')).onClick(async () => {
							this.plugin.settings.defaultNoteTemplateId = tpl.id
							await this.plugin.saveSettings()
							this.display()
						}))
				}
				setting.addButton(button =>
					button.setIcon('trash-2').setTooltip(t('从列表移除（不删模板文件）')).onClick(async () => {
						this.plugin.settings.noteTemplates = templates.filter(t => t.id !== tpl.id)
						if (this.plugin.settings.defaultNoteTemplateId === tpl.id) {
							this.plugin.settings.defaultNoteTemplateId = this.plugin.settings.noteTemplates[0]?.id ?? ''
						}
						await this.plugin.saveSettings()
						this.display()
					}))
			}
			new Setting(containerEl)
				.setName(t('模板文件'))
				.setDesc(t('打开当前默认模板；文件不存在时会按内置内容创建'))
				.addButton(button =>
					button.setButtonText(t('创建 / 打开')).setCta().onClick(() => void this.plugin.openNoteTemplate()))
		}
		new Setting(containerEl)
			.setName(t('使用指南'))
			.setDesc(t("在笔记文件夹生成《{p0} 使用指南》；已存在时可直接打开，或用「重新生成」覆盖为当前版本", { p0: APP_NAME }))
			.addButton(button =>
				button.setButtonText(t('生成 / 打开')).onClick(() => void this.plugin.openUsageDoc()))
			.addButton(button =>
				button.setButtonText(t('重新生成')).onClick(() => this.plugin.confirmRegenerateUsageDoc()))
	}

	#renderData(containerEl: HTMLElement): void {
		// —— 数据安全 ——
		containerEl.createEl('h3', { text: t('数据安全') })
		new Setting(containerEl)
			.setName(t('数据文件夹'))
			.setDesc(t('批注 JSON、封面、书单、阅读统计的存放位置（库内相对路径）。留空 = 插件目录下的 data/。直接改路径不会搬数据；请用右侧「迁移数据…」复制后重启'))
			.addText(text =>
				text
					.setPlaceholder(t('例如：Grove Reader'))
					.setValue(this.plugin.settings.dataFolder ?? '')
					.onChange(async raw => {
						const value = raw.trim().replace(/[\\/]+$/, '')
						if (value && (isAbsolutePath(value) || value.split(/[\\/]/).includes('..'))) {
							new Notice(t('请填写库内相对路径（例如 Grove Reader），不要填盘符或 ..'))
							text.setValue(this.plugin.settings.dataFolder ?? '')
							return
						}
						this.plugin.settings.dataFolder = value
						await this.plugin.saveSettings()
					}))
			.addButton(button =>
				button.setButtonText(t('迁移数据…')).onClick(() => this.plugin.promptMigrateDataFolder()))
		new Setting(containerEl)
			.setName(t('库内备份文件夹'))
			.setDesc(t('「立即备份」写入的库内文件夹（相对路径，可含子目录，如「00-Obsidian插件/插件运行时产生的文件/Grove Reader/数据备份」）。修改后光标离开输入框时，旧文件夹里的备份自动转移到新路径'))
			.addText(text => {
				let committed = this.plugin.settings.backupFolder?.trim() || BACKUP_FOLDER_NAME
				text
					.setPlaceholder(BACKUP_FOLDER_NAME)
					.setValue(committed)
					.onChange(async value => {
						this.plugin.settings.backupFolder = value.trim() || BACKUP_FOLDER_NAME
						await this.plugin.saveSettings()
					})
				text.inputEl.addEventListener('blur', async () => {
					const next = this.plugin.settings.backupFolder?.trim() || BACKUP_FOLDER_NAME
					if (next === committed) return
					if (isAbsolutePath(next)) {
						new Notice(t('Grove Reader：这里请填库内相对路径（绝对路径请用下面的「备份额外保存到」）'))
						this.plugin.settings.backupFolder = committed
						await this.plugin.saveSettings()
						text.setValue(committed)
						return
					}
					const prev = committed
					committed = next
					await this.plugin.migrateBackupFolder(prev, next)
				})
			})
		new Setting(containerEl)
			.setName(t('备份批注数据到库内'))
			.setDesc(t('把全部书籍批注 JSON、书架缓存、书单与自定义封面导出到上面的「库内备份文件夹」。该文件夹是普通库内文件，随库同步，删除或重装插件都不受影响。建议定期执行（命令面板也有同名命令）'))
			.addButton(button =>
				button.setButtonText(t('立即备份')).onClick(() => void this.plugin.exportDataBackup()))
		// 额外复制到库外路径只有桌面端能做（手机只能访问库内文件）
		if (!Platform.isMobile) {
			new Setting(containerEl)
				.setName(t('备份额外保存到（可选）'))
				.setDesc(t('填一个本机其他盘或优盘的路径（如 G:\\Grove备份），「立即备份」时会额外复制一份过去——同一块盘上的备份防不了磁盘故障。留空则只备份到库内'))
				.addText(text =>
					text
						.setPlaceholder(t('例如 G:\\Grove备份'))
						.setValue(this.plugin.settings.backupTargetDir ?? '')
						.onChange(async value => {
							this.plugin.settings.backupTargetDir = value.trim()
							await this.plugin.saveSettings()
						}))
		}
		new Setting(containerEl)
			.setName(t('最大备份数'))
			.setDesc(t('每本书的批注数据最多保留多少份自动备份（每 10 分钟最多写一份）'))
			.addText(text =>
				text.setValue(String(this.plugin.settings.maxBackups)).onChange(async value => {
					const n = Number.parseInt(value, 10)
					if (Number.isFinite(n) && n >= 0) {
						this.plugin.settings.maxBackups = n
						await this.plugin.saveSettings()
					}
				}))
		new Setting(containerEl)
			.setName(t('自动备份'))
			.setDesc(t('每天/每周首次启动时自动把批注、书架、书单导出到库内备份文件夹；关闭则只手动备份'))
			.addDropdown(dropdown =>
				dropdown
					.addOptions({ off: t('关闭'), daily: t('每天'), weekly: t('每周') })
					.setValue(this.plugin.settings.autoBackup)
					.onChange(async value => {
						this.plugin.settings.autoBackup = value as 'off' | 'daily' | 'weekly'
						await this.plugin.saveSettings()
					}))

		// —— 检索与导出 ——
		containerEl.createEl('h3', { text: t('检索与导出') })
		new Setting(containerEl)
			.setName(t('全局批注检索'))
			.setDesc(t('跨书搜索划线与评论；结果可跳回原文；「导出…」可先按范围/书/章节/颜色/今天筛选、分组并实时预览，再写 Markdown / CSV 到笔记文件夹'))
			.addButton(button =>
				button.setButtonText(t('搜索')).setCta().onClick(() => this.plugin.showSearch()))
		new Setting(containerEl)
			.setName(t('语义索引管理'))
			.setDesc(t('查看每本书的向量索引状态（可用 / 未建立 / 原书已改 / 模型已换），可单独重建、删除或清理失效索引'))
			.addButton(button =>
				button.setButtonText(t('管理')).onClick(() => new VectorIndexModal(this.app, this.plugin).open()))
		new Setting(containerEl)
			.setName(t('导入外部标注'))
			.setDesc(t('把 Kindle My Clippings.txt、Readwise CSV、微信读书 Markdown 转成 Grove 批注；按书名/作者匹配书籍，重复摘录自动跳过，导入的条目会带来源标记'))
			.addButton(button =>
				button.setButtonText(t('导入…')).setCta().onClick(() => new ImportHighlightsModal(this.app, this.plugin).open()))

		// —— 回收站（走 PlatformIO，手机端同样可用）——
		const trash = this.plugin.trash
		if (trash) {
			containerEl.createEl('h3', { text: t('回收站') })
			const trashSetting = new Setting(containerEl)
				.setName(t('已删除的书籍'))
				.setDesc(t("删书时把原文件、笔记、批注和封面移到这里，保留 {p0} 天；可恢复或永久删除", { p0: trash.retentionDays() }))
				.addButton(button =>
					button.setButtonText(t('打开')).onClick(() => this.plugin.showTrash()))
			void trash.list().then(entries => {
				if (entries.length) trashSetting.setDesc(t("已删除 {p0} 项；可恢复或永久删除，保留 {p1} 天", { p0: entries.length, p1: trash.retentionDays() }))
			})
		}

		// —— 操作记录 ——
		containerEl.createEl('h3', { text: t('操作记录') })
		new Setting(containerEl)
			.setName(t('关键操作记录'))
			.setDesc(t('只记录删除书籍、清空批注、恢复隐藏、备份等低频但重要的动作，最多 200 条；翻页、搜索不记录。'))
			.addButton(button =>
				button.setButtonText(t('查看')).onClick(() => {
					new OpLogModal(this.app, this.plugin.oplog.list()).open()
				}))
			.addButton(button =>
				button.setButtonText(t('清空')).onClick(() => {
					new ConfirmModal(this.app, t('清空操作记录？只删日志，不影响批注数据。'), () => {
						this.plugin.oplog.clear()
						new Notice(t('已清空操作记录'))
					}).open()
				}))

		// —— 维护 ——
		containerEl.createEl('h3', { text: t('维护') })
		new Setting(containerEl)
			.setName(t('数据体检'))
			.setDesc(t('检查批注 JSON、笔记、书架缓存、书单、统计之间的引用是否还对得上；只读，不会删除书籍或批注'))
			.addButton(button =>
				button.setButtonText(t('运行')).setCta().onClick(() => this.plugin.showHealthReport()))
		new Setting(containerEl)
			.setName(t('调试模式'))
			.setDesc(t('把打开书籍、删除、清空、备份等事件写入 data/debug.log（512KB 轮转），默认关闭；反馈问题时再开'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.debugMode).onChange(async value => {
					this.plugin.settings.debugMode = value
					await this.plugin.saveSettings()
					this.plugin.setDebugMode(value)
				}))
			.addButton(button =>
				button.setButtonText(t('打开日志')).onClick(() => void this.plugin.openDebugLog()))


		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: t(`批注数据每本书一个 JSON 文件，默认在插件目录的 data/ 下；填写「数据文件夹」后会改存到库内对应目录（如「Grove Reader」→ Grove Reader/data/）。即使停用或删除插件，已生成的 Markdown 笔记也不受影响。阅读中的字体、背景等外观设置请在阅读界面的「Aa」面板中调整。`),
		})
	}
}
