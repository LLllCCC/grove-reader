import { App, Notice, PluginSettingTab, Setting, setIcon } from 'obsidian'
import type GroveReaderPlugin from './main'
import { FolderPromptModal, FolderSuggest, ConfirmModal, OpLogModal, TemplateEditModal } from './modals'
import { APP_NAME, BACKUP_FOLDER_NAME, DEFAULT_SHELF_DISPLAY } from './types'
import { isAbsolutePath } from './util'
import { LOGO_OPTIONS } from './logos'

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
			brand.innerHTML = selected.wordmark
		} else {
			const icon = brand.createSpan('grove-settings-brand-icon')
			setIcon(icon, 'library')
			brand.createSpan('grove-settings-brand-name').setText(APP_NAME)
		}

		containerEl.createEl('h2', { text: `${APP_NAME} 设置` })
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
			const button = nav.createEl('button', { cls: 'grove-settings-tab', text: tab.name })
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
		// —— 标志 ——
		containerEl.createEl('h3', { text: '标志' })
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: '选一个显示在标签页、功能区和空书架上的标志。标签页图标会在重新打开书架后更新。',
		})
		const grid = containerEl.createDiv('grove-logo-grid')
		const options: Array<{ id: string; name: string; desc?: string; wordmark?: string }> = [
			{ id: 'original', name: '原始图标', desc: 'Obsidian 自带的 library 图标' },
			...LOGO_OPTIONS,
		]
		for (const option of options) {
			const card = grid.createDiv('grove-logo-card')
			if (option.id === currentLogo) card.addClass('is-active')
			const preview = card.createDiv('grove-logo-preview')
			if (option.wordmark) {
				preview.innerHTML = option.wordmark
			} else {
				const icon = preview.createSpan('grove-logo-original')
				setIcon(icon, 'library')
			}
			card.createDiv('grove-logo-name').setText(option.name)
			if (option.desc) card.createDiv('grove-logo-desc').setText(option.desc)
			card.addEventListener('click', () => {
				this.plugin.settings.logoStyle = option.id
				void this.plugin.saveSettings()
				this.plugin.applyLogo()
				this.display()
			})
		}

		// —— 书架显示 ——
		containerEl.createEl('h3', { text: '书架显示' })
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: '卡片上显示哪些信息。默认只留最常用的几项，信息多时卡片会换行变高。',
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
		shelfToggle('格式徽章', '在卡片信息行显示 EPUB / PDF / MOBI 等格式标签', 'showFormatBadge')
		shelfToggle('阅读进度', '封面底部进度条 + 卡片上的百分比；读完后显示「已读」', 'showProgress')
		shelfToggle('批注条数', '显示这本书有多少条批注', 'showAnnotationCount')
		shelfToggle('最近阅读', '显示「3 天前」这类相对时间', 'showLastRead')
		shelfToggle('笔记标记', '已生成阅读笔记的书显示文档图标，点击直接打开笔记', 'showNoteBadge')
		shelfToggle('文件大小', '在卡片上显示文件体积（关闭时仍可在悬浮提示里看到）', 'showFileSize')
		shelfToggle('继续阅读', '书架顶部显示最近在读、尚未读完的书（最多 6 本）', 'showContinueReading')
		shelfToggle('作者与出版社合并一行', '关闭后作者、出版社各占一行，卡片会更高', 'mergeAuthorPublisher')
		shelfToggle('书单色条', '卡片左侧显示所属书单的色条（颜色由书单自动生成）', 'showListColor')
	}

	#renderShelf(containerEl: HTMLElement): void {
		// —— 扫描文件夹 ——
		containerEl.createEl('h3', { text: '扫描文件夹' })
		new Setting(containerEl)
			.setName('扫描文件夹')
			.setDesc('书架从这些文件夹扫描书籍；支持库内文件夹或本机绝对路径（子文件夹会一并扫描）。PDF 也会被收纳进书架，点击用 Obsidian 自带查看器打开')
			.addButton(button =>
				button
					.setButtonText('添加文件夹')
					.setCta()
					.onClick(() => {
						new FolderPromptModal(this.app, '添加扫描文件夹', '例如：书籍', async value => {
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
				button.setIcon('trash-2').setTooltip('移除').onClick(async () => {
					const i = this.plugin.settings.scanFolders.indexOf(folder)
					if (i >= 0) this.plugin.settings.scanFolders.splice(i, 1)
					await this.plugin.saveSettings()
					this.plugin.refreshShelfViews()
					this.display()
				}))
		}

		// —— 隐藏的书 ——
		containerEl.createEl('h3', { text: '隐藏与恢复' })
		const hiddenCount = this.plugin.settings.hiddenBooks?.length ?? 0
		new Setting(containerEl)
			.setName('从书架移除的书籍')
			.setDesc(hiddenCount
				? `当前隐藏 ${hiddenCount} 本，原文件和批注数据都还在；恢复后会重新出现在书架`
				: '在书架右键「删除书籍…」且不勾选删除原文件时，书会暂时收在这里')
			.addButton(button =>
				button
					.setButtonText('全部恢复')
					.setDisabled(hiddenCount === 0)
					.onClick(async () => {
						await this.plugin.restoreHiddenBooks()
						this.display()
					}))
	}

	#renderReading(containerEl: HTMLElement): void {
		// —— 阅读 ——
		containerEl.createEl('h3', { text: '阅读' })
		new Setting(containerEl)
			.setName('打开书本时同时展开批注列表')
			.setDesc('关闭后，打开书时只显示正文；可随时点工具栏的「批注列表」按钮唤出侧栏。在正文中点击已批注的文段时，侧栏仍会自动展开并定位到对应批注')
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.openSidebarWithBook).onChange(async value => {
					this.plugin.settings.openSidebarWithBook = value
					await this.plugin.saveSettings()
				}))

		new Setting(containerEl)
			.setName('每日阅读目标')
			.setDesc('分钟；0 = 不设目标。用于阅读统计页的今日进度和热力图深浅')
			.addText(text =>
				text.setValue(String(this.plugin.settings.dailyGoalMinutes ?? 30)).onChange(async value => {
					const n = Number.parseInt(value, 10)
					if (Number.isFinite(n) && n >= 0) {
						this.plugin.settings.dailyGoalMinutes = Math.min(600, n)
						await this.plugin.saveSettings()
					}
				}))

		// —— 笔记 ——
		containerEl.createEl('h3', { text: '笔记' })
		new Setting(containerEl)
			.setName('新增/修改批注时自动更新笔记')
			.setDesc('仅更新已经点过「生成/更新阅读笔记」的书：加删批注、改评论后约 1.5 秒自动重写笔记的生成区（标记区外你手写的内容会保留）。关闭后需手动点按钮更新')
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.autoUpdateNote).onChange(async value => {
					this.plugin.settings.autoUpdateNote = value
					await this.plugin.saveSettings()
				}))
		new Setting(containerEl)
			.setName('笔记文件夹')
			.setDesc('生成的阅读笔记保存位置（相对库根目录，输入时可从建议中选择；修改后旧笔记会在下次生成时自动移过去）')
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
			new TemplateEditModal(this.app, '添加笔记模板', '', this.plugin.defaultTemplatePath(), async (name, path) => {
				const id = `tpl-${Date.now().toString(36)}`
				this.plugin.settings.noteTemplates = [...(this.plugin.settings.noteTemplates ?? []), { id, name, path }]
				if (!this.plugin.settings.defaultNoteTemplateId) this.plugin.settings.defaultNoteTemplateId = id
				await this.plugin.saveSettings()
				this.display()
			}).open()
		}
		if (!templates.length) {
			new Setting(containerEl)
				.setName('默认模板')
				.setDesc('模板文件路径（库内）。文件不存在时使用内置默认模板；可添加多套模板，按书单独切换')
				.addText(text =>
					text.setValue(this.plugin.settings.noteTemplatePath).onChange(async value => {
						this.plugin.settings.noteTemplatePath = value.trim() || 'Grove Reader/阅读笔记/Grove 笔记模板.md'
						await this.plugin.saveSettings()
					}))
				.addButton(button =>
					button.setButtonText('创建 / 打开').setCta().onClick(() => void this.plugin.openNoteTemplate()))
				.addButton(button =>
					button.setButtonText('添加模板').onClick(openAddTemplate))
		} else {
			new Setting(containerEl)
				.setName('默认笔记模板')
				.setDesc('新书默认使用这一套；单本书可在书架右键「笔记模板…」单独切换')
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
					button.setButtonText('添加模板').setCta().onClick(openAddTemplate))
			for (const tpl of templates) {
				const setting = new Setting(containerEl).setName(tpl.name).setDesc(tpl.path)
				setting.settingEl.addClass('grove-setting-sub')
				if (tpl.id === (defaultId || templates[0].id)) {
					setting.addButton(button => button.setButtonText('默认').setDisabled(true))
				} else {
					setting.addButton(button =>
						button.setButtonText('设为默认').onClick(async () => {
							this.plugin.settings.defaultNoteTemplateId = tpl.id
							await this.plugin.saveSettings()
							this.display()
						}))
				}
				setting.addButton(button =>
					button.setIcon('trash-2').setTooltip('从列表移除（不删模板文件）').onClick(async () => {
						this.plugin.settings.noteTemplates = templates.filter(t => t.id !== tpl.id)
						if (this.plugin.settings.defaultNoteTemplateId === tpl.id) {
							this.plugin.settings.defaultNoteTemplateId = this.plugin.settings.noteTemplates[0]?.id ?? ''
						}
						await this.plugin.saveSettings()
						this.display()
					}))
			}
			new Setting(containerEl)
				.setName('模板文件')
				.setDesc('打开当前默认模板；文件不存在时会按内置内容创建')
				.addButton(button =>
					button.setButtonText('创建 / 打开').setCta().onClick(() => void this.plugin.openNoteTemplate()))
		}
		new Setting(containerEl)
			.setName('使用指南')
			.setDesc(`在笔记文件夹生成《${APP_NAME} 使用指南》；已存在时可直接打开，或用「重新生成」覆盖为当前版本`)
			.addButton(button =>
				button.setButtonText('生成 / 打开').onClick(() => void this.plugin.openUsageDoc()))
			.addButton(button =>
				button.setButtonText('重新生成').onClick(() => this.plugin.confirmRegenerateUsageDoc()))
	}

	#renderData(containerEl: HTMLElement): void {
		// —— 数据安全 ——
		containerEl.createEl('h3', { text: '数据安全' })
		new Setting(containerEl)
			.setName('数据文件夹')
			.setDesc('批注 JSON、封面、书单、阅读统计的存放位置（库内相对路径）。留空 = 插件目录下的 data/。直接改路径不会搬数据；请用右侧「迁移数据…」复制后重启')
			.addText(text =>
				text
					.setPlaceholder('例如：Grove Reader')
					.setValue(this.plugin.settings.dataFolder ?? '')
					.onChange(async raw => {
						const value = raw.trim().replace(/[\\/]+$/, '')
						if (value && (isAbsolutePath(value) || value.split(/[\\/]/).includes('..'))) {
							new Notice('请填写库内相对路径（例如 Grove Reader），不要填盘符或 ..')
							text.setValue(this.plugin.settings.dataFolder ?? '')
							return
						}
						this.plugin.settings.dataFolder = value
						await this.plugin.saveSettings()
					}))
			.addButton(button =>
				button.setButtonText('迁移数据…').onClick(() => this.plugin.promptMigrateDataFolder()))
		new Setting(containerEl)
			.setName('库内备份文件夹')
			.setDesc('「立即备份」写入的库内文件夹（相对路径，可含子目录，如「00-Obsidian插件/插件运行时产生的文件/Grove Reader/数据备份」）。修改后光标离开输入框时，旧文件夹里的备份自动转移到新路径')
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
						new Notice('Grove Reader：这里请填库内相对路径（绝对路径请用下面的「备份额外保存到」）')
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
			.setName('备份批注数据到库内')
			.setDesc('把全部书籍批注 JSON、书架缓存、书单与自定义封面导出到上面的「库内备份文件夹」。该文件夹是普通库内文件，随库同步，删除或重装插件都不受影响。建议定期执行（命令面板也有同名命令）')
			.addButton(button =>
				button.setButtonText('立即备份').onClick(() => void this.plugin.exportDataBackup()))
		new Setting(containerEl)
			.setName('备份额外保存到（可选）')
			.setDesc('填一个本机其他盘或优盘的路径（如 G:\\Grove备份），「立即备份」时会额外复制一份过去——同一块盘上的备份防不了磁盘故障。留空则只备份到库内')
			.addText(text =>
				text
					.setPlaceholder('例如 G:\\Grove备份')
					.setValue(this.plugin.settings.backupTargetDir ?? '')
					.onChange(async value => {
						this.plugin.settings.backupTargetDir = value.trim()
						await this.plugin.saveSettings()
					}))
		new Setting(containerEl)
			.setName('最大备份数')
			.setDesc('每本书的批注数据最多保留多少份自动备份（每 10 分钟最多写一份）')
			.addText(text =>
				text.setValue(String(this.plugin.settings.maxBackups)).onChange(async value => {
					const n = Number.parseInt(value, 10)
					if (Number.isFinite(n) && n >= 0) {
						this.plugin.settings.maxBackups = n
						await this.plugin.saveSettings()
					}
				}))
		new Setting(containerEl)
			.setName('自动备份')
			.setDesc('每天/每周首次启动时自动把批注、书架、书单导出到库内备份文件夹；关闭则只手动备份')
			.addDropdown(dropdown =>
				dropdown
					.addOptions({ off: '关闭', daily: '每天', weekly: '每周' })
					.setValue(this.plugin.settings.autoBackup)
					.onChange(async value => {
						this.plugin.settings.autoBackup = value as 'off' | 'daily' | 'weekly'
						await this.plugin.saveSettings()
					}))

		// —— 检索与导出 ——
		containerEl.createEl('h3', { text: '检索与导出' })
		new Setting(containerEl)
			.setName('全局批注检索')
			.setDesc('跨书搜索划线与评论；结果可跳回原文，导出 Markdown / CSV 到笔记文件夹')
			.addButton(button =>
				button.setButtonText('搜索').setCta().onClick(() => this.plugin.showSearch()))

		// —— 回收站 ——
		containerEl.createEl('h3', { text: '回收站' })
		const trashCount = this.plugin.trash.list().length
		new Setting(containerEl)
			.setName('已删除的书籍')
			.setDesc(`删书时把原文件、笔记、批注和封面移到这里，保留 ${this.plugin.trash.retentionDays()} 天；可恢复或永久删除`)
			.addButton(button =>
				button.setButtonText(`打开（${trashCount}）`).onClick(() => this.plugin.showTrash()))

		// —— 操作记录 ——
		containerEl.createEl('h3', { text: '操作记录' })
		new Setting(containerEl)
			.setName('关键操作记录')
			.setDesc('只记录删除书籍、清空批注、恢复隐藏、备份等低频但重要的动作，最多 200 条；翻页、搜索不记录。')
			.addButton(button =>
				button.setButtonText('查看').onClick(() => {
					new OpLogModal(this.app, this.plugin.oplog.list()).open()
				}))
			.addButton(button =>
				button.setButtonText('清空').onClick(() => {
					new ConfirmModal(this.app, '清空操作记录？只删日志，不影响批注数据。', () => {
						this.plugin.oplog.clear()
						new Notice('已清空操作记录')
					}).open()
				}))

		// —— 维护 ——
		containerEl.createEl('h3', { text: '维护' })
		new Setting(containerEl)
			.setName('数据体检')
			.setDesc('检查批注 JSON、笔记、书架缓存、书单、统计之间的引用是否还对得上；只读，不会删除书籍或批注')
			.addButton(button =>
				button.setButtonText('运行').setCta().onClick(() => this.plugin.showHealthReport()))
		new Setting(containerEl)
			.setName('调试模式')
			.setDesc('把打开书籍、删除、清空、备份等事件写入 data/debug.log（512KB 轮转），默认关闭；反馈问题时再开')
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.debugMode).onChange(async value => {
					this.plugin.settings.debugMode = value
					await this.plugin.saveSettings()
					this.plugin.setDebugMode(value)
				}))
			.addButton(button =>
				button.setButtonText('打开日志').onClick(() => void this.plugin.openDebugLog()))

		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: `批注数据每本书一个 JSON 文件，默认在插件目录的 data/ 下；填写「数据文件夹」后会改存到库内对应目录（如「Grove Reader」→ Grove Reader/data/）。即使停用或删除插件，已生成的 Markdown 笔记也不受影响。阅读中的字体、背景等外观设置请在阅读界面的「Aa」面板中调整。`,
		})
	}
}
