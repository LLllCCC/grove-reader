import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import type GroveReaderPlugin from './main'
import { FolderPromptModal, FolderSuggest } from './modals'
import { BACKUP_FOLDER_NAME, DEFAULT_SHELF_DISPLAY } from './types'
import { isAbsolutePath } from './util'

export class GroveSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: GroveReaderPlugin) {
		super(app, plugin)
	}

	display(): void {
		const { containerEl } = this
		containerEl.empty()
		containerEl.createEl('h2', { text: 'Grove Reader 设置' })

		// —— 书架扫描文件夹 ——
		containerEl.createEl('h3', { text: '书架' })
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
		new Setting(containerEl)
			.setName('笔记模板')
			.setDesc('模板文件路径（库内）。文件不存在时使用内置默认模板；语法见使用指南')
			.addText(text =>
				text.setValue(this.plugin.settings.noteTemplatePath).onChange(async value => {
					this.plugin.settings.noteTemplatePath = value.trim() || '阅读笔记/Grove 笔记模板.md'
					await this.plugin.saveSettings()
				}))
			.addButton(button =>
				button.setButtonText('创建 / 打开').setCta().onClick(() => void this.plugin.openNoteTemplate()))
		new Setting(containerEl)
			.setName('使用指南')
			.setDesc('在笔记文件夹生成《Grove Reader 使用指南》（已存在则直接打开）')
			.addButton(button =>
				button.setButtonText('生成 / 打开').onClick(() => void this.plugin.openUsageDoc()))

		// —— 数据安全 ——
		containerEl.createEl('h3', { text: '数据安全' })
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

		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: '批注数据保存在 .obsidian/plugins/grove-reader/data/ 下，每本书一个 JSON 文件；即使停用或删除插件，已生成的 Markdown 笔记也不受影响。阅读中的字体、背景等外观设置请在阅读界面的「Aa」面板中调整。',
		})
	}
}
