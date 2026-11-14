import { FileSystemAdapter, MarkdownView, Notice, Platform, Plugin, TFile, TFolder, WorkspaceLeaf, addIcon, normalizePath, setIcon } from 'obsidian'
import { BookStore } from './store'
import { ShelfCache } from './bookshelf'
import { ListsStore } from './lists'
import { STATS_TICK_MS, StatsStore, accrueTick } from './stats'
import {
	APP_NAME,
	DEFAULT_APPEARANCE,
	DEFAULT_SETTINGS,
	DEFAULT_SHELF_DISPLAY,
	LIBRARY_ROOT,
	BookData,
	NoteTemplate,
	GroveSettings,
	HIGHLIGHT_COLORS,
	SUPPORTED_BOOK_EXTS,
	ShelfBookInfo,
	BACKUP_FOLDER_NAME,
	FORMAT_LABELS,
	READING_STATUS_LABELS,
	VIEW_TYPE_GROVE_PDF,
	colorName,
} from './types'
import { ReaderView, VIEW_TYPE_GROVE_READER } from './readerView'
import { BookshelfView, VIEW_TYPE_GROVE_BOOKSHELF } from './bookshelf'
import { TextView, VIEW_TYPE_GROVE_TEXT } from './textView'
import { BookPickerModal, CanvasExportModal, CommentModal, ConfirmModal, DangerConfirmModal, FolderPromptModal, GlobalBookmarksModal, HealthReportModal, NoteSyncModal, OpLogModal, ReadingStatsModal, PromptModal, SearchModal, TemplatePickerModal, TrashModal } from './modals'
import type { CanvasExportPayload } from './modals'
import { applySync, planSync } from './noteSync'
import { collectGlobalBookmarks } from './globalBookmarks'
import type { GlobalBookmarkRow } from './globalBookmarks'
import { appendCardWall, buildCardText, canvasColor, emptyCanvas, parseCanvas, serializeCanvas } from './canvas'
import type { CardGroup, CardSpec } from './canvas'
import { quoteCardFileName, renderQuoteCard } from './cardImage'
import { buildShelfBase, SHELF_BASE_NAME } from './baseTemplate'
import { GroveSettingTab } from './settings'
import { appendAnnotationBlocks, buildNote, buildTemplateContext, DEFAULT_NOTE_TEMPLATE, DEFAULT_TEMPLATE_PATH, renderNoteTemplate, resolveExcerptLinkStyle } from './notes'
import type { NoteExtraFields, NoteLinkOptions } from './notes'
import { collectExcerptBacklinks, type ExcerptBacklinkRow } from './backlinks'
import { BookAskModal } from './bookAskModal'
import { MultiBookAskModal } from './multiBookAskModal'
import { GuideModal } from './guideModal'
import { ImportHighlightsModal } from './importHighlightsModal'
import { ReviewModal } from './reviewModal'
import { nextReview, pickReviewQueue, reviewStats, reviewedToday } from './review'
import type { ReviewGrade, ReviewQueueItem } from './review'
import { LibrarySearchModal } from './librarySearch'
import { movePortrait } from './portrait'
import { moveGuide } from './guide'
import { moveVectorDoc } from './vectorIndex'
import { chatCompletion, isAiConfigured } from './ai'
import { parseGroveHref } from './wikilink'
import { parsePdfPlusHref } from './pdfLink'
import type { GroveLinkTarget, ParsedGroveLink } from './wikilink'
import type { ReaderEngine } from './engine/types'
import { bookIdFor, basenameOf, cleanBookTitle, isAbsolutePath, sanitizeFileName, stripNumericTitlePrefix } from './util'
import { isReaderExt, isShelfExt } from './types'
import { usageDocMarkdown, USAGE_DOC_NAME } from './usageDoc'
import { LOGO_OPTIONS, logoById } from './logos'
import { OpLog } from './oplog'
import { createPlatformIO } from './platformFactory'
import { PlatformIO, joinPath } from './platformIO'
import { DebugLog } from './debugLog'
import { buildSearchIndex, exportCsv, exportMarkdown } from './search'
import type { ExportOptions, SearchDoc } from './search'
// 以下模块只在桌面端动态加载（它们 import Node fs / Node path / electron），
// 这里只取类型，不会在运行期被 require。
import type { PdfView } from './pdfView'
import type { TrashStore } from './trash'
import type { HealthReport } from './health'

export default class GroveReaderPlugin extends Plugin {
	settings: GroveSettings = { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_APPEARANCE } }
	store!: BookStore
	shelfCache!: ShelfCache
	lists!: ListsStore
	stats!: StatsStore
	oplog!: OpLog
	debugLog!: DebugLog
	/** 回收站需要 Node fs，只在桌面端构造；移动端为 null */
	trash: TrashStore | null = null
	/** 跨平台文件层：桌面端是 Node fs，移动端是 vault.adapter */
	io!: PlatformIO
	/** 桌面专属 fs 模块（Node fs），只在桌面端 onload 里动态加载 */
	private desktopFs: typeof import('./desktopFs') | null = null
	vaultBase = ''
	/** 插件安装目录（data.json 在这里，不随数据目录迁移） */
	pluginDir = ''
	/** 书架搜索词：只活在本次会话，关掉书架页再打开还在，重启 Obsidian 清空 */
	shelfSearch = ''
	/** 阅读计时的基线：上一拍结算时刻、最近一次真实交互、当前统计中的书 */
	private statsLastTick = 0
	private statsLastActive = 0
	private statsActivePath = ''
	/** 启动打点：插件实例创建 → onload 结束 → 书架首屏可交互（同一进程内相对时间） */
	private readonly startupAt = typeof performance !== 'undefined' ? performance.now() : 0
	private pluginReadyAt = 0
	private shelfReadyAt = 0

	private dataRoot!: string
	private persistTimer: number | null = null
	private ribbonEl: HTMLElement | null = null

	/** 手机端（含手机 App）：回收站/体检/PDF/库外路径等桌面能力全部禁用 */
	get isMobile(): boolean {
		return Platform.isMobile || Platform.isMobileApp
	}

	async onload(): Promise<void> {
		await this.loadSettings()
		this.applyEinkMode()
		for (const option of LOGO_OPTIONS) {
			if (option.icon) addIcon(`grove-logo-${option.id}`, option.icon)
		}
		const adapter = this.app.vault.adapter
		if (!this.isMobile && adapter instanceof FileSystemAdapter) this.vaultBase = adapter.getBasePath()
		const pluginDirRel = this.manifest.dir || joinPath('.obsidian', 'plugins', this.manifest.id)
		this.pluginDir = this.vaultBase ? joinPath(this.vaultBase, pluginDirRel) : pluginDirRel
		if (!this.isMobile) this.desktopFs = await import('./desktopFs')
		// 旧实例可能把 data.json 写回迁移前的路径：启动时按实际目录自动纠正（需读磁盘，仅桌面端）
		await this.adoptMigratedFolders()
		// 数据目录可迁到库内普通文件夹（便于随库同步/备份）；留空则沿用插件目录
		const dataFolder = this.settings.dataFolder?.trim()
		this.dataRoot = dataFolder
			? (this.vaultBase ? joinPath(this.vaultBase, normalizePath(dataFolder)) : normalizePath(dataFolder))
			: this.pluginDir
		const io = await createPlatformIO(this.app)
		this.io = io
		this.oplog = new OpLog(this.dataRoot, io)
		await this.oplog.load()
		this.debugLog = new DebugLog(this.dataRoot, io, this.settings.debugMode)
		// 回收站走 PlatformIO，手机端同样可用（vault.adapter 移动库内文件）
		const { TrashStore } = await import('./trash')
		this.trash = new TrashStore(this.dataRoot, io, this.vaultBase ?? '')
		void this.trash
			.purgeExpired()
			.then(purged => {
				if (!purged) return
				this.oplog?.add('回收站清理', `自动清理 ${purged} 项`)
				this.debug('trash', 'purge expired', { count: purged })
			})
			.catch(() => {
				// 清理失败不影响启动
			})
		this.store = new BookStore(this.dataRoot, this.settings.maxBackups, io)
		await this.store.preload()
		let lastSaveErrorAt = 0
		this.store.onError = e => {
			console.error('[Grove Reader] 批注数据保存失败', e)
			this.oplog?.add('批注保存失败', e instanceof Error ? e.message : String(e))
			this.debug('store', 'save error', e instanceof Error ? e.message : String(e))
			const now = Date.now()
			if (now - lastSaveErrorAt > 30_000) {
				lastSaveErrorAt = now
				new Notice('Grove Reader：批注数据保存失败（文件可能被 iCloud/杀软锁定），稍后会自动重试')
			}
		}
		this.shelfCache = new ShelfCache(this.dataRoot, io)
		await this.shelfCache.load()
		this.lists = new ListsStore(this.dataRoot, io)
		await this.lists.load()
		this.stats = new StatsStore(joinPath(this.dataRoot, 'data', 'stats.json'), io)
		await this.stats.load()

		// 手机上 Obsidian 对外部同步的文件不一定发 modify 事件；定时对一遍盘（17 个小文件，很轻）
		this.registerInterval(window.setInterval(() => void this.reloadAllBooks(), 15000))

		// 移动端从后台回来时，Syncthing 可能刚同步完；主动对一遍磁盘
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.hidden) return
			void this.reloadAllBooks()
		})

		// 手机双指轻按切沉浸阅读（设置里可关）
		this.#registerImmersiveGesture()

		// 外部同步（Syncthing 等）改动批注 JSON 时，重新读进内存并刷新界面
		this.registerEvent(this.app.vault.on('modify', file => {
			if (!(file instanceof TFile) || file.extension !== 'json') return
			if (!this.store.hasBookId(file.basename)) return
			void this.store.reloadFromDisk(file.basename).then(updated => {
				if (!updated) return
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_READER)) {
					const v = leaf.view as unknown as { refreshAnnotations?: () => void }
					v.refreshAnnotations?.()
				}
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_TEXT)) {
					const v = leaf.view as unknown as { refreshAnnotations?: () => void }
					v.refreshAnnotations?.()
				}
			})
		}))

		this.registerView(VIEW_TYPE_GROVE_READER, leaf => new ReaderView(leaf, this))
		this.registerView(VIEW_TYPE_GROVE_BOOKSHELF, leaf => new BookshelfView(leaf, this))
		this.registerView(VIEW_TYPE_GROVE_TEXT, leaf => new TextView(leaf, this))
		// PDF 视图：桌面走本地文件的 range 读取，手机退化为整文件读入内存（大文件会拒绝）
		const { PdfView } = await import('./pdfView')
		this.registerView(VIEW_TYPE_GROVE_PDF, leaf => new PdfView(leaf, this))
		// 注册扩展名：电子书文件会显示在文件列表中，点击直接用阅读器打开
		// 注意：pdf 不注册——保持 Obsidian 原生双击行为，PDF 经书架/协议进入插件
		this.registerExtensions(SUPPORTED_BOOK_EXTS, VIEW_TYPE_GROVE_READER)
		// 用 Grove 打开某本书：?book=<bookId> 走批注数据，?path=<库内路径> 直接按路径打开
		this.registerObsidianProtocolHandler('grove', params => {
			// ?view=shelf 直接打开书架（手机上没有好用的入口，笔记里也能一键跳转）
			if (params['view'] === 'shelf') {
				void this.openBookshelf()
				return
			}
			const byPath = params['path'] ?? ''
			if (byPath) {
				void this.openBookByPath(byPath, params['cfi'] ?? undefined)
				return
			}
			void this.openByBookId(params['book'] ?? '', params['cfi'] ?? '')
		})
		// 摘录双链：`[[书.epub#grove-cfi=…|↩ 回原文]]` 的点击接管。
		// 捕获阶段先手，阅读视图与 Live Preview 都能拦；只认自家子路径，别的链接一律放行。
		this.registerDomEvent(document, 'click', ev => this.#onGroveLinkClick(ev), { capture: true })
		// 手机 Live Preview 的 CM6 链接不一定派发 click（tap 被编辑器自己消费），补 pointerup 兜底
		if (this.isMobile) {
			this.registerDomEvent(document, 'pointerdown', ev => {
				this.#tapStart = { x: ev.clientX, y: ev.clientY, at: Date.now() }
			}, { capture: true })
			this.registerDomEvent(document, 'pointerup', ev => this.#onGroveLinkPointerUp(ev), { capture: true })
		}
		// 笔记里的摘录双链随编辑变化：解析完自动刷新打开中的「引用」页签
		this.registerEvent(this.app.metadataCache.on('resolved', () => {
			if (this.backlinkTimer != null) window.clearTimeout(this.backlinkTimer)
			this.backlinkTimer = window.setTimeout(() => this.refreshCitations(), 1200)
		}))
		this.registerEvent(this.app.workspace.on('file-open', file => {
			this.debug('workspace', 'file-open', file?.path ?? null)
			const pend = this.#pendingGroveLink
			if (!pend || !file) return
			if (file.path !== pend.path) return
			window.clearTimeout(pend.timer)
			this.#pendingGroveLink = null
			// 稍等一拍让 Obsidian 的导航完全收尾，再换成 Grove 视图
			window.setTimeout(pend.open, 30)
		}))
		// 文件列表里的 TXT 也提供「用 Grove Reader 打开」，自动识别 GBK/GB18030
		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
			if (file instanceof TFile && file.extension.toLowerCase() === 'txt') {
				menu.addItem(item =>
					item.setTitle('用 Grove Reader 打开（自动识别编码）')
						.setIcon('book-open')
						.onClick(() => void this.#openTextBook(file.path)))
			}
		}))
		this.ribbonEl = this.addRibbonIcon(this.currentLogoIcon(), `${APP_NAME}：书架`, () => void this.openBookshelf())

		this.registerCommands()
		this.addSettingTab(new GroveSettingTab(this.app, this))
		this.registerEvent(this.app.workspace.on('css-change', () => {
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_READER)) {
				const view = leaf.view
				if (view instanceof ReaderView) view.applyAppearance()
			}
		}))
		this.#startStatsTracking()
		this.app.workspace.onLayoutReady(() => void this.maybeAutoBackup())
		this.pluginReadyAt = this.#now()
		this.debug('app', 'onload', { version: this.manifest.version, dataRoot: this.dataRoot, readyMs: Math.round(this.pluginReadyAt - this.startupAt) })
	}

	#now(): number {
		return typeof performance !== 'undefined' ? performance.now() : Date.now()
	}

	/** 书架首屏（第一批卡片 + 搜索状态）可交互：只在本次会话第一次记录 */
	markShelfInteractive(bookCount: number): void {
		if (this.shelfReadyAt) return
		this.shelfReadyAt = this.#now()
		this.debug('startup', 'shelf interactive', {
			pluginReadyMs: this.pluginReadyAt ? Math.round(this.pluginReadyAt - this.startupAt) : null,
			shelfMs: Math.round(this.shelfReadyAt - this.startupAt),
			books: bookCount,
		})
	}

	/** 启动打点结果（相对插件实例创建；未发生时为 null） */
	startupTimings(): { pluginReadyMs: number | null; shelfInteractiveMs: number | null } {
		return {
			pluginReadyMs: this.pluginReadyAt ? Math.round(this.pluginReadyAt - this.startupAt) : null,
			shelfInteractiveMs: this.shelfReadyAt ? Math.round(this.shelfReadyAt - this.startupAt) : null,
		}
	}

	onunload(): void {
		// 各视图的 onClose 会负责落盘与销毁渲染器；这里再兜一层排队中的批注写入
		void this.store?.flush()
		document.body.removeClass('grove-immersive')
		this.stats?.saveNow()
		void this.stats?.flush()
		this.oplog?.saveNow()
		void this.oplog?.flush()
		void this.debugLog?.flush()
		if (this.pdfWorkerBlobUrl) {
			URL.revokeObjectURL(this.pdfWorkerBlobUrl)
			this.pdfWorkerBlobUrl = null
		}
	}

	/** 当前应使用的图标 id（original 或无效值时回退到 Obsidian 原生 library） */
	currentLogoIcon(): string {
		const option = logoById(this.settings.logoStyle)
		return option?.icon ? `grove-logo-${option.id}` : 'library'
	}

	/** 当前标志的完整字标 SVG；original 时为空 */
	logoWordmark(): string {
		return logoById(this.settings.logoStyle)?.wordmark ?? ''
	}

	/** 设置里切换标志后：更新功能区图标 + 已打开的书架 */
	applyLogo(): void {
		if (this.ribbonEl) setIcon(this.ribbonEl, this.currentLogoIcon())
		this.refreshShelfViews()
	}

	/** 调试日志：默认关闭；开启后同时写控制台与 data/debug.log */
	debug(category: string, message: string, data?: unknown): void {
		if (!this.settings.debugMode) return
		console.debug(`[Grove Reader][${category}] ${message}`, data ?? '')
		this.debugLog?.write(category, message, data)
	}

	setDebugMode(enabled: boolean): void {
		this.debugLog?.setEnabled(enabled)
		if (enabled) this.debug('app', 'debug mode enabled')
	}

	async openDebugLog(): Promise<void> {
		if (this.isMobile) {
			new Notice(`${APP_NAME}：手机端暂不支持打开调试日志文件`)
			return
		}
		if (!this.settings.debugMode) {
			new Notice(`${APP_NAME}：请先开启调试模式`)
			return
		}
		this.debug('app', 'open debug log')
		try {
			// 桌面端才有 electron：延迟 require，避免手机端加载插件时就 require('electron')
			const { shell } = require('electron') as typeof import('electron')
			await shell.openPath(this.debugLog.path())
		} catch (e) {
			new Notice(`${APP_NAME}：无法打开日志文件（${e instanceof Error ? e.message : String(e)}）`)
		}
	}

	/** 每天/每周首次启动时自动备份；时间戳先落盘，避免同一天重复执行 */
	async maybeAutoBackup(): Promise<void> {
		const mode = this.settings.autoBackup
		if (mode !== 'daily' && mode !== 'weekly') return
		const interval = mode === 'daily' ? 86_400_000 : 7 * 86_400_000
		if (Date.now() - (this.settings.lastAutoBackupAt || 0) < interval) return
		this.settings.lastAutoBackupAt = Date.now()
		await this.saveSettings()
		this.debug('backup', 'auto start', { mode })
		await this.exportDataBackup()
	}

	/** 数据体检：只读扫描，不删任何东西（PlatformIO，桌面/手机都能跑） */
	showHealthReport(): void {
		void this.#runHealthReport()
	}

	async #runHealthReport(): Promise<void> {
		const { buildHealthReport, healthCleanupCount } = await import('./health')
		const report = await buildHealthReport(this.io, this.vaultBase ?? '', this.dataRoot, this.settings.notesFolder)
		this.debug('health', 'scan', {
			json: report.jsonCount,
			missingBooks: report.missingBooks.length,
			missingNotes: report.missingNotes.length,
		})
		new HealthReportModal(this.app, report, healthCleanupCount(report), () => void this.confirmCleanupHealth(report)).open()
	}

	private async confirmCleanupHealth(report: HealthReport): Promise<void> {
		const { healthCleanupCount } = await import('./health')
		const count = healthCleanupCount(report)
		if (!count) {
			new Notice(`${APP_NAME}：没有可清理的失效引用`)
			return
		}
		new ConfirmModal(
			this.app,
			`将移除 ${count} 项失效引用（书架缓存、书单、统计、笔记路径、AI 要点索引、语义索引），不会删除任何书籍或批注 JSON。继续？`,
			() => void this.cleanupHealth(report),
		).open()
	}

	/** 只清理“指向不存在文件”的引用，不动孤儿批注 JSON 本身 */
	async cleanupHealth(report: HealthReport): Promise<void> {
		let removed = 0
		for (const path of report.staleShelf) {
			this.shelfCache.remove(path)
			removed++
		}
		for (const path of report.staleLists) {
			this.lists.setMember(path, null)
			removed++
		}
		for (const path of report.staleStats) {
			this.stats.remove(path)
			removed++
		}
		for (const issue of report.missingNotes) {
			// bookExists 在扫描时就算好了：原书还在、只是笔记丢了，才清这条引用
			if (!issue.bookExists) continue
			this.store.clearNotePath(issue.bookPath)
			removed++
		}
		for (const item of report.orphanPortraits) {
			try {
				await this.io.remove(joinPath(this.dataRoot, 'portraits', item.file))
				removed++
			} catch {
				// 已被手动删除或占用，下次体检再处理
			}
		}
		for (const item of report.vectorIssues) {
			try {
				await this.io.remove(joinPath(this.dataRoot, 'vectors', item.file))
				removed++
			} catch {
				// 索引可由原书重建，删不掉就下次再清
			}
		}
		this.shelfCache.saveNow()
		this.lists.saveNow()
		this.stats.saveNow()
		this.oplog.add('数据体检清理', `移除失效引用 ${removed} 项`)
		this.debug('health', 'cleanup', { removed })
		this.refreshShelfViews()
		new Notice(`${APP_NAME}：已清理 ${removed} 项失效引用`)
	}

	/**
	 * 删除书籍时把书籍/笔记/批注/封面一起移入插件回收站。
	 * 移动失败时返回 false，调用方回退到 Obsidian 自带的删除逻辑。
	 */
	async moveToTrash(bookPath: string, title: string, notePath?: string): Promise<boolean> {
		if (!this.trash) return false
		const entry = this.shelfCache.get(bookPath)
		const dataFile = `${bookIdFor(bookPath)}.json`
		const hasData = this.store.hasDataFor(bookPath)
		try {
			await this.trash.move({
				title,
				bookPath,
				notePath,
				dataFile: hasData ? dataFile : undefined,
				cover: entry?.cover,
				portraitId: bookIdFor(bookPath),
				shelfEntry: entry ?? null,
				statsEntry: this.stats.peek(bookPath) ?? null,
				listId: this.lists.listIdOf(bookPath),
			})
			return true
		} catch (e) {
			this.debug('trash', 'move failed', { bookPath, error: e instanceof Error ? e.message : String(e) })
			return false
		}
	}

	async restoreTrash(id: string): Promise<void> {
		if (!this.trash) return
		const entry = await this.trash.restore(id)
		// 删除时 store.delete() 已经把这本书移出内存；恢复后必须把 data.json 重新读入，
		// 否则再次打开会拿空数据把刚恢复的批注/书签覆盖掉
		await this.store.reloadFromDisk(bookIdFor(entry.bookPath))
		this.shelfCache.set(entry.bookPath, entry.shelfEntry ?? {})
		if (entry.statsEntry) this.stats.setBook(entry.bookPath, entry.statsEntry)
		if (entry.listId) this.lists.setMember(entry.bookPath, entry.listId)
		this.settings.hiddenBooks = (this.settings.hiddenBooks ?? []).filter(p => p !== entry.bookPath)
		await this.saveSettings()
		this.refreshShelfViews()
		this.oplog.add('恢复回收站', `《${entry.title}》`)
		this.debug('trash', 'restore', { id, bookPath: entry.bookPath })
		new Notice(`${APP_NAME}：已恢复《${entry.title}》`)
	}

	async purgeTrash(id: string): Promise<void> {
		if (!this.trash) return
		const entry = (await this.trash.list()).find(e => e.id === id)
		await this.trash.purge(id)
		this.oplog.add('回收站永久删除', entry ? `《${entry.title}》` : id)
		this.debug('trash', 'purge', { id })
		new Notice(`${APP_NAME}：已永久删除`)
	}

	async emptyTrash(): Promise<void> {
		if (!this.trash) return
		const count = await this.trash.empty()
		this.oplog.add('清空回收站', `${count} 项`)
		this.debug('trash', 'empty', { count })
		new Notice(`${APP_NAME}：已清空回收站（${count} 项）`)
	}

	showTrash(): void {
		if (!this.trash) return
		new TrashModal(this.app, this).open()
	}

	/** 汇总所有书的书签（全局书签弹窗用） */
	globalBookmarkRows(): GlobalBookmarkRow[] {
		const sources = this.store.listBookPaths().map(bookPath => {
			const data = this.store.load(bookPath)
			return { bookPath, title: data.title, bookmarks: data.bookmarks ?? [] }
		})
		return collectGlobalBookmarks(sources)
	}

	openGlobalBookmarks(): void {
		new GlobalBookmarksModal(
			this.app,
			() => this.globalBookmarkRows(),
			{
				onJump: row => void this.openBookByPath(row.bookPath, row.bookmark.cfi),
				onDelete: row => this.deleteGlobalBookmark(row),
			},
		).open()
	}

	/** 汇总所有书的划线，供复习队列挑选（排除已删除的墓碑条目与空摘录） */
	reviewCandidates(): ReviewQueueItem[] {
		const out: ReviewQueueItem[] = []
		for (const path of this.store.listBookPaths()) {
			const data = this.store.load(path)
			const title = (data.title || '').trim() || basenameOf(path).replace(/\.[^.]+$/, '') || path
			for (const annotation of data.annotations ?? []) {
				if (data.deletedAnnotations?.[annotation.id]) continue
				if (!annotation.text?.trim()) continue
				out.push({ bookPath: path, bookTitle: title, annotation })
			}
		}
		return out
	}

	/** 今天到期的条数（书架按钮与提示用） */
	reviewDueCount(now = Date.now()): number {
		return reviewStats(this.reviewCandidates(), now).due
	}

	/** 现在点「复习」实际会出几张：到期 + 旧划线，且不超过今天剩余额度 */
	reviewPendingCount(now = Date.now()): number {
		const cap = Math.max(0, Math.floor(this.settings.reviewDailyCap ?? 0))
		if (!cap) return 0
		const items = this.reviewCandidates()
		const left = Math.max(0, cap - reviewedToday(items, now))
		if (!left) return 0
		return pickReviewQueue(items, now, left, { includeNew: this.settings.reviewIncludeNew !== false }).length
	}

	/** 复习概览：今日已复习 / 到期 / 旧划线 / 每日上限（统计页用） */
	reviewOverview(now = Date.now()): { today: number; due: number; fresh: number; cap: number } {
		const stats = reviewStats(this.reviewCandidates(), now)
		return { ...stats, cap: Math.max(0, Math.floor(this.settings.reviewDailyCap ?? 0)) }
	}

	/** 今日复习：按每日上限挑一批到期的 / 旧划线，弹窗逐条评分 */
	openReview(): void {
		const cap = Math.max(0, Math.floor(this.settings.reviewDailyCap ?? 0))
		if (!cap) {
			new Notice(`${APP_NAME}：复习功能已关闭（设置 → 每日复习条数）`)
			return
		}
		const now = Date.now()
		const candidates = this.reviewCandidates()
		const stats = reviewStats(candidates, now)
		const remaining = Math.max(0, cap - stats.today)
		if (!remaining) {
			new Notice(`${APP_NAME}：今天的复习目标已完成（${stats.today}/${cap} 条），明天再来`)
			return
		}
		const queue = pickReviewQueue(candidates, now, remaining, { includeNew: this.settings.reviewIncludeNew !== false })
		if (!queue.length) {
			new Notice(stats.fresh
				? `${APP_NAME}：今天没有到期的划线；另有 ${stats.fresh} 条新划线，明天起进入复习`
				: `${APP_NAME}：还没有可复习的划线`)
			return
		}
		const nextBatch = (): ReviewQueueItem[] => {
			const fresh = this.reviewCandidates()
			const left = Math.max(0, cap - reviewedToday(fresh, Date.now()))
			return left ? pickReviewQueue(fresh, Date.now(), left, { includeNew: this.settings.reviewIncludeNew !== false }) : []
		}
		new ReviewModal(this.app, { queue, dailyCap: cap, reviewedToday: stats.today }, {
			onGrade: (item, grade) => this.gradeReviewItem(item, grade),
			onJump: item => void this.openBookByPath(item.bookPath, item.annotation.cfi),
			onComment: (item, done) => this.editReviewComment(item, done),
			getNext: nextBatch,
			onClose: () => this.refreshShelfReviewBadges(),
		}).open()
	}

	/** 复习时补写评论：保存后写回批注、刷新笔记，并重绘当前卡片 */
	editReviewComment(item: ReviewQueueItem, done: () => void): void {
		new CommentModal(this.app, item.annotation.note ?? '', note => {
			const data = this.store.load(item.bookPath)
			const annotation = data.annotations.find(a => a.id === item.annotation.id)
			if (!annotation) return
			const text = note.trim()
			annotation.note = text || undefined
			annotation.updatedAt = Date.now()
			item.annotation.note = annotation.note
			this.store.save(data)
			this.refreshNoteForBook(item.bookPath)
			done()
		}).open()
	}

	/** 复习进度变化后，刷新已打开书架上的到期数徽标 */
	refreshShelfReviewBadges(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_BOOKSHELF)) {
			if (leaf.view instanceof BookshelfView) leaf.view.updateReviewEntry()
		}
	}

	/** 评分落库：排期写在批注对象里，随批注一起合并 / 备份，不新增文件 */
	gradeReviewItem(item: ReviewQueueItem, grade: ReviewGrade): void {
		const data = this.store.load(item.bookPath)
		const annotation = data.annotations.find(a => a.id === item.annotation.id)
		if (!annotation) return
		const now = Date.now()
		const review = nextReview(annotation.review, grade, now)
		annotation.review = review
		annotation.updatedAt = now
		item.annotation.review = review
		this.store.save(data)
		this.debug('review', 'grade', { book: item.bookPath, id: annotation.id, grade, due: review.due, interval: review.interval })
	}

	/** 清空全部复习排期（不动划线、评论与笔记）；清完这些划线会重新按「旧划线」进队列 */
	resetReviewSchedule(): void {
		let scheduled = 0
		for (const path of this.store.listBookPaths()) {
			const data = this.store.load(path)
			for (const a of data.annotations ?? []) if (a.review) scheduled++
		}
		if (!scheduled) {
			new Notice(`${APP_NAME}：还没有任何复习排期`)
			return
		}
		new DangerConfirmModal(
			this.app,
			'清空全部复习排期',
			`将清除 ${scheduled} 条划线的复习进度（到期日、间隔、难度）。划线、评论和笔记都不动；清完它们会重新按「旧划线」进入队列。`,
			'清空',
			() => {
				const now = Date.now()
				let cleared = 0
				for (const path of this.store.listBookPaths()) {
					const data = this.store.load(path)
					let changed = false
					for (const a of data.annotations ?? []) {
						if (!a.review) continue
						delete a.review
						a.updatedAt = now
						changed = true
						cleared++
					}
					if (changed) this.store.save(data)
				}
				this.oplog.add('清空复习排期', `${cleared} 条`)
				this.refreshShelfReviewBadges()
				new Notice(`${APP_NAME}：已清空 ${cleared} 条复习排期`)
			},
		).open()
	}

	deleteGlobalBookmark(row: GlobalBookmarkRow): void {
		const data = this.store.load(row.bookPath)
		data.bookmarks = (data.bookmarks ?? []).filter(b => b.id !== row.bookmark.id)
		this.store.save(data)
		this.refreshNoteForBook(row.bookPath)
		new Notice(`${APP_NAME}：已删除书签「${row.bookmark.label || '未命名位置'}」`)
	}

	loadSearchIndex(): SearchDoc[] {
		const books = this.store.listBookPaths().map(p => this.store.load(p))
		return buildSearchIndex(books, p => this.#bookFileExists(p))
	}

	/** 书还在不在：库内走 vault 索引，库外绝对路径只在桌面端查磁盘 */
	#bookFileExists(path: string): boolean {
		if (isAbsolutePath(path)) return this.desktopFs?.pathExists(path) ?? false
		return this.app.vault.getAbstractFileByPath(path) !== null
	}

	/** 打开前确认文件存在：库内用索引，库外（仅桌面端）落盘查 */
	#fileExistsOnDisk(path: string): boolean {
		if (!this.desktopFs) return false
		return this.desktopFs.pathExists(isAbsolutePath(path) ? path : joinPath(this.vaultBase, path))
	}

	showSearch(): void {
		new SearchModal(this.app, this).open()
	}

	/** e-ink / 极简模式：body 上加一个类，动画、阴影与手机工具栏精简都由 CSS 接管 */
	applyEinkMode(): void {
		document.body.toggleClass('grove-eink', this.settings.einkMode === true)
	}

	/** 生成 / 覆盖书架 Base：封面画廊 + 在读 / 想读 / 今年读完 / 全部 */
	async generateShelfBase(): Promise<void> {
		const folder = normalizePath(this.settings.notesFolder?.trim() || '阅读笔记')
		const path = normalizePath(`${folder}/${SHELF_BASE_NAME}`)
		try {
			if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder)
			const content = buildShelfBase({ notesFolder: folder })
			const existing = this.app.vault.getAbstractFileByPath(path)
			if (existing instanceof TFile) await this.app.vault.modify(existing, content)
			else await this.app.vault.create(path, content)
			this.oplog.add('生成书架 Base', path)
			new Notice(`${APP_NAME}：已生成 ${path}（重新生成会覆盖）`)
		} catch (e) {
			new Notice(`${APP_NAME}：生成书架 Base 失败（${e instanceof Error ? e.message : String(e)}）`)
		}
	}

	async exportSearchResults(docs: SearchDoc[], query: string, format: 'md' | 'csv', options?: ExportOptions): Promise<void> {
		if (!docs.length) {
			new Notice(`${APP_NAME}：没有可导出的结果`)
			return
		}
		const baseFolder = (this.settings.notesFolder?.trim() || '阅读笔记').replace(/\\/g, '/').replace(/\/+$/, '')
		const folder = normalizePath(`${baseFolder}/批注检索`)
		try {
			// 库内路径统一走 vault.adapter（桌面端 io 是 Node fs，只认绝对路径）
			if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder)
		} catch {
			// 写文件时会再报错
		}
		const now = new Date()
		const p = (n: number): string => String(n).padStart(2, '0')
		const base = `批注检索-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
		const ext = format === 'md' ? 'md' : 'csv'
		let target = normalizePath(`${folder}/${base}.${ext}`)
		let i = 2
		while (this.app.vault.getAbstractFileByPath(target) || await this.app.vault.adapter.exists(target)) {
			target = normalizePath(`${folder}/${base}-${i}.${ext}`)
			i++
		}
		const content = format === 'md' ? exportMarkdown(docs, query, options) : exportCsv(docs)
		try {
			await this.app.vault.create(target, content)
		} catch {
			try {
				await this.app.vault.adapter.write(target, content)
			} catch (e) {
				new Notice(`${APP_NAME}：导出失败（${e instanceof Error ? e.message : String(e)}）`)
				return
			}
		}
		this.oplog.add('导出批注检索', `${docs.length} 条 → ${target}`)
		this.debug('search', 'export', { count: docs.length, target, format })
		new Notice(`${APP_NAME}：已导出 ${docs.length} 条到 ${target}`)
	}

	/**
	 * 书库被整体迁到 <库>/Grove Reader/ 后，若设置里仍是旧路径（例如迁移时旧实例
	 * 又把 data.json 写回去了），按磁盘实际情况自动接管，避免书架空白。
	 * 需要直接读磁盘，只有桌面端能做；手机端跳过。
	 */
	private async adoptMigratedFolders(): Promise<void> {
		if (this.isMobile || !this.vaultBase) return
		const { adoptMigratedFolders } = await import('./desktopFs')
		const changed = adoptMigratedFolders({ vaultBase: this.vaultBase, settings: this.settings })
		if (!changed) return
		void this.saveSettings()
		console.log('[Grove Reader] 已自动接管迁移后的书库目录')
		this.debug('adopt', 'switched settings to current library root', { root: LIBRARY_ROOT })
	}

	// ------------------------------------------------------------------
	// 阅读统计
	// ------------------------------------------------------------------

	/**
	 * 每 15 秒结算一拍阅读时长。
	 *
	 * 判据是「这一拍里人还在看」，不是「窗口有焦点」：焦点在、人走了（吃饭、
	 * 接电话）照样会记成读完一小时，报表一失真整个统计就没意义了。
	 * 活动由三个视图上报（翻页/滚动/点按/按键），见 noteReadingActivity()。
	 * 翻页次数仍由视图调用 statsPageTurn 记。
	 */
	#startStatsTracking(): void {
		this.statsLastTick = Date.now()
		this.statsLastActive = this.statsLastTick
		this.registerInterval(window.setInterval(() => {
			const now = Date.now()
			const view = this.activeReadingView()
			const path = view?.ready ? view.bookPath : ''
			// 换书/离开阅读页：只重设基线，不把上一本的这一拍记到新书上
			if (!path || path !== this.statsActivePath) {
				this.statsActivePath = path
				this.statsLastTick = now
				this.statsLastActive = now
				return
			}
			const seconds = accrueTick({ now, lastTickAt: this.statsLastTick, lastActive: this.statsLastActive })
			this.statsLastTick = now
			if (!document.hasFocus()) return
			if (seconds > 0) this.stats.record(path, seconds, 0)
		}, STATS_TICK_MS))
	}

	/** 视图里的任一交互都算「人在看」：翻页、滚动、点按、按键都该调一次 */
	noteReadingActivity(): void {
		this.statsLastActive = Date.now()
	}

	/** 当前真正在前台的阅读视图（含 TXT）；PDF 由类型守卫判定 */
	private activeReadingView(): { bookPath: string; ready: boolean } | null {
		const reader = this.app.workspace.getActiveViewOfType(ReaderView)
		if (reader) return reader
		const text = this.app.workspace.getActiveViewOfType(TextView)
		if (text) return text
		const leaf = this.app.workspace.activeLeaf
		return leaf && this.#isPdfView(leaf.view) ? leaf.view : null
	}

	/** 视图翻页/换节时调用：当日翻页计数 +1 */
	statsPageTurn(bookPath: string): void {
		this.noteReadingActivity()
		this.stats.record(bookPath, 0, 1)
	}

	private activeReader(): ReaderView | null {
		return this.app.workspace.getActiveViewOfType(ReaderView)
	}

	/**
	 * pdfView 只在桌面端动态加载，这里不能再用 instanceof / getActiveViewOfType(PdfView)，
	 * 统一按视图类型字符串判断。getLeavesOfType 已按最近使用排序，第一个就是「当前」。
	 */
	#isPdfView(view: unknown): view is PdfView {
		const v = view as { getViewType?: () => string } | null
		return !!v && typeof v.getViewType === 'function' && v.getViewType() === VIEW_TYPE_GROVE_PDF
	}

	private activePdf(): PdfView | null {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_PDF)[0]
		return leaf && this.#isPdfView(leaf.view) ? leaf.view : null
	}

	/** 数据根目录：书摘卡、要点索引等模块通过它定位自己的文件 */
	getDataRoot(): string {
		return this.dataRoot
	}

	/**
	 * 沉浸阅读：隐藏 Grove 工具栏与侧栏。
	 * 桌面端顺带切换系统全屏；手机端只做 CSS 隐藏（Obsidian 移动端没有网页全屏）。
	 */
	toggleImmersive(force?: boolean): void {
		const want = force ?? !document.body.classList.contains('grove-immersive')
		document.body.toggleClass('grove-immersive', want)
		this.debug('ui', 'immersive', { on: want })
		if (this.isMobile) return
		try {
			if (want && !document.fullscreenElement) {
				void document.documentElement.requestFullscreen?.()?.catch(() => undefined)
			} else if (!want && document.fullscreenElement === document.documentElement) {
				void document.exitFullscreen?.()?.catch(() => undefined)
			}
		} catch {
			// 全屏被系统拒绝时，CSS 隐藏仍然生效
		}
	}

	/** 双指轻按切沉浸：两指都抬起且未明显移动、用时 < 320ms 才算轻按 */
	#registerImmersiveGesture(): void {
		let twoFinger: { x: number; y: number; at: number } | null = null
		this.registerDomEvent(document, 'touchstart', (ev: TouchEvent) => {
			if (!this.isMobile || !this.settings.mobileTwoFingerImmersive || ev.touches.length !== 2) {
				twoFinger = null
				return
			}
			if (!document.querySelector('.grove-content')) return
			const a = ev.touches[0]
			const b = ev.touches[1]
			twoFinger = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, at: Date.now() }
		}, { passive: true })
		this.registerDomEvent(document, 'touchmove', (ev: TouchEvent) => {
			if (!twoFinger || ev.touches.length !== 2) return
			const a = ev.touches[0]
			const b = ev.touches[1]
			const dx = (a.clientX + b.clientX) / 2 - twoFinger.x
			const dy = (a.clientY + b.clientY) / 2 - twoFinger.y
			if (dx * dx + dy * dy > 18 * 18) twoFinger = null
		}, { passive: true })
		this.registerDomEvent(document, 'touchend', (ev: TouchEvent) => {
			if (!twoFinger || ev.touches.length > 0) return
			const quick = Date.now() - twoFinger.at <= 320
			twoFinger = null
			if (quick) this.toggleImmersive()
		}, { passive: true })
	}

	/** 书改名/移动时迁移 AI 要点索引（与批注数据同步，避免索引变成孤儿） */
	migratePortrait(oldPath: string, newPath: string): void {
		const from = this.store.bookId(oldPath)
		const to = this.store.bookId(newPath)
		if (!from || !to || from === to) return
		void movePortrait(this.io, this.dataRoot, from, to, newPath).catch(() => undefined)
		void moveGuide(this.io, this.dataRoot, from, to, newPath).catch(() => undefined)
		void moveVectorDoc(this.io, this.dataRoot, from, to, newPath).catch(() => undefined)
	}

	/** AI 按主题整理书单：一次请求把书架上的书分 3-6 组，写进书单 */
	organizeThemeLists(): void {
		const s = this.settings
		const cfg = { baseUrl: s.aiBaseUrl ?? '', apiKey: s.aiApiKey ?? '', model: s.aiModel ?? '' }
		if (!isAiConfigured(cfg)) {
			new Notice('Grove Reader：还没有配置 AI。设置 → 阅读 → AI 解释 里填入接口地址与 API Key', 8000)
			return
		}
		const entries = this.shelfCache.entries()
			.filter(([path]) => isShelfExt((path.split('.').pop() ?? '').toLowerCase()))
			.slice(0, 60)
		if (!entries.length) {
			new Notice('Grove Reader：书架还没有书，先添加扫描文件夹或导入书籍')
			return
		}
		new ConfirmModal(
			this.app,
			`将调用 AI 把 ${entries.length} 本书按主题整理成 3-6 个书单（一次请求，使用你自己的 API Key）。已有同名书单会复用，书原来的书单不会被清掉。继续？`,
			() => {
				void (async () => {
					const lines = entries.map(([path, entry], i) => {
						const title = entry.title || cleanBookTitle(basenameOf(path))
						return `${i + 1}. ${title}${entry.author ? ` — ${entry.author}` : ''}`
					})
					let answer = ''
					try {
						answer = await chatCompletion(cfg, [
							{
								role: 'system',
								content: '你是图书管理员。把用户给出的书按主题分组，每组 3-12 本；' +
									'组名用简洁中文（不超过 8 字），不要「其他」「杂项」这类兜底组。' +
									'只输出 JSON 数组，格式：[{"name":"组名","books":[1,3,5]}]，不要解释。',
							},
							{ role: 'user', content: lines.join('\n') },
						], { temperature: 0.2, maxTokens: 900 })
					} catch (e) {
						new Notice(`Grove Reader：整理失败（${e instanceof Error ? e.message : String(e)}）`, 8000)
						return
					}
					let groups: Array<{ name?: unknown; books?: unknown }> = []
					try {
						const start = answer.indexOf('[')
						const end = answer.lastIndexOf(']')
						groups = JSON.parse(answer.slice(start, end + 1)) as typeof groups
					} catch {
						new Notice('Grove Reader：AI 返回的内容不是可识别的 JSON，换本模型再试')
						return
					}
					let assigned = 0
					let created = 0
					for (const group of groups) {
						const name = String(group?.name ?? '').trim().slice(0, 20)
						if (!name) continue
						const list = this.lists.lists().find(l => l.name === name) ?? this.lists.create(name)
						created++
						for (const raw of Array.isArray(group?.books) ? group.books : []) {
							const entry = entries[Number(raw) - 1]
							if (!entry) continue
							this.lists.setMember(entry[0], list.id)
							assigned++
						}
					}
					if (!assigned) {
						new Notice('Grove Reader：AI 没有给出可用的分组')
						return
					}
					this.oplog.add('AI 整理书单', `${created} 个书单 / ${assigned} 本书`)
					new Notice(`Grove Reader：已整理出 ${created} 个书单，归入 ${assigned} 本书`)
					for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_BOOKSHELF)) {
						const view = leaf.view
						if (view instanceof BookshelfView) void view.refresh()
					}
				})()
			},
			'开始整理',
			'mod-cta',
		).open()
	}

	private withAnyReader(checking: boolean, run: (view: ReaderEngine) => unknown): boolean {
		const r = this.activeReader()
		if (r?.ready) {
			if (!checking) run(r)
			return true
		}
		const p = this.activePdf()
		if (p?.ready) {
			if (!checking) run(p)
			return true
		}
		const t = this.app.workspace.getActiveViewOfType(TextView)
		if (t?.ready) {
			if (!checking) run(t)
			return true
		}
		return false
	}

	// ------------------------------------------------------------------
	// 打开书籍 / 书架
	// ------------------------------------------------------------------

	/**
	 * 把已有标签切到前台。
	 * 只用 revealLeaf 时它只负责「露出来」（弹窗窗口/折叠侧栏），主区域里不会改激活标签，
	 * 表现为「点了链接但书在后台打开」。setActiveLeaf 才是真正切前台的那个。
	 */
	private activateLeaf(leaf: WorkspaceLeaf): void {
		try {
			this.app.workspace.setActiveLeaf(leaf, { focus: true })
		} catch {
			this.app.workspace.revealLeaf(leaf)
		}
	}

	async openBookshelf(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_BOOKSHELF).first()
		if (existing) {
			this.activateLeaf(existing)
			return
		}
		const leaf = this.app.workspace.getLeaf('tab')
		await leaf.setViewState({ type: VIEW_TYPE_GROVE_BOOKSHELF, active: true })
		this.app.workspace.revealLeaf(leaf)
	}

	/** 设置里改了书架显示项后，让已打开的书架立即重绘 */
	refreshShelfViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_BOOKSHELF)) {
			const view = leaf.view
			if (view instanceof BookshelfView) void view.refresh()
		}
	}

	/** 把某本书已生成的阅读笔记按当前批注重写（清空批注后用） */
	refreshNoteForBook(bookPath: string): void {
		const data = this.store.load(bookPath)
		const notePath = data.notePath
		if (!notePath) return
		const file = this.app.vault.getAbstractFileByPath(notePath)
		if (!(file instanceof TFile)) return
		void (async () => {
			try {
				const existing = await this.app.vault.read(file)
				// 这个入口只被用户主动操作调用（清空批注 / 切模板），跟随当前设置
				const markdown = await this.#composeNoteMarkdown(data, existing, false, true)
				if (markdown !== existing) await this.app.vault.modify(file, markdown)
			} catch (e) {
				console.error('[Grove Reader] 刷新阅读笔记失败', e)
			}
		})()
	}

	/** 这本书是否有打开着的阅读/PDF 视图 */
	hasOpenBookView(bookPath: string): boolean {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_READER)
			.some(leaf => leaf.view instanceof ReaderView && leaf.view.bookPath === bookPath)
			|| this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_PDF)
				.some(leaf => this.#isPdfView(leaf.view) && leaf.view.bookPath === bookPath)
	}

	/** 删除书籍前关掉仍打开着它的阅读视图，避免继续写回数据；返回关闭的视图数 */
	closeBookViews(bookPath: string): number {		let closed = 0
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_READER)) {
			const view = leaf.view
			if (view instanceof ReaderView && view.bookPath === bookPath) {
				leaf.detach()
				closed++
			}
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_PDF)) {
			const view = leaf.view
			if (this.#isPdfView(view) && view.bookPath === bookPath) {
				leaf.detach()
				closed++
			}
		}
		return closed
	}

	/** 恢复所有「从书架移除但保留文件」的书 */
	async restoreHiddenBooks(): Promise<void> {
		const count = this.settings.hiddenBooks?.length ?? 0
		if (!count) {
			new Notice(`${APP_NAME}：没有隐藏的书`)
			return
		}
		this.settings.hiddenBooks = []
		await this.saveSettings()
		this.refreshShelfViews()
		this.oplog.add('恢复隐藏书籍', `${count} 本`)
		new Notice(`${APP_NAME}：已恢复 ${count} 本`)
	}

	/** 清空一本书的全部批注/评论（保留阅读位置），需要输入确认词 */
	clearAnnotationsFor(bookPath: string): void {
		const data = this.store.load(bookPath)
		const count = data.annotations?.length ?? 0
		if (!count) {
			new Notice(`${APP_NAME}：这本书还没有批注`)
			return
		}
		const title = data.title || bookPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '这本书'
		const openHint = this.hasOpenBookView(bookPath) ? ' 当前有打开的阅读窗口，清空后会自动关闭它。' : ''
		new DangerConfirmModal(
			this.app,
			'清空本书批注',
			`将删除《${title}》的 ${count} 条批注与评论；阅读位置会保留。${openHint}`,
			'清空',
			() => {
				const closed = this.closeBookViews(bookPath)
				const finish = (): void => {
					// 关视图可能触发一次 onClose 写盘，等它落完再清，避免批注被写回来
					const fresh = this.store.load(bookPath)
					fresh.annotations = []
					this.store.save(fresh)
					this.refreshNoteForBook(bookPath)
					this.refreshShelfViews()
					this.oplog.add('清空批注', `《${title}》；${count} 条`)
					this.debug('annotations', 'clear', { bookPath, count })
					new Notice(`已清空 ${count} 条批注`)
				}
				if (closed) window.setTimeout(finish, 300)
				else finish()
			},
		).open()
	}

	openPicker(): void {
		const books = this.app.vault
			.getFiles()
			.filter(f => isShelfExt(f.extension))
		if (!books.length) {
			new Notice('Grove Reader：库中没有找到电子书文件（支持 epub / mobi / azw3 / fb2 / cbz，PDF 也可选）')
			return
		}
		new BookPickerModal(this.app, file => void this.openBook(file)).open()
	}

	async openBook(file: TFile, cfi?: string, fallback?: GroveLinkTarget): Promise<void> {
		await this.openBookByPath(file.path, cfi, fallback)
	}

	async openBookByPath(bookPath: string, cfi?: string, fallback?: GroveLinkTarget): Promise<void> {
		if (!this.app.vault.getAbstractFileByPath(bookPath) && !this.#fileExistsOnDisk(bookPath)) {
			new Notice(isAbsolutePath(bookPath) && this.isMobile
				? `${APP_NAME}：手机端暂不支持打开库外文件：${bookPath}`
				: `${APP_NAME}：文件不存在或已被移动：${bookPath}`)
			return
		}
		const ext = (bookPath.split('.').pop() ?? '').toLowerCase()
		this.debug('reader', 'open', bookPath)
		if (ext === 'pdf') {
			await this.#openPdfBook(bookPath, cfi, fallback)
			return
		}
		if (ext === 'txt') {
			await this.#openTextBook(bookPath, cfi, fallback)
			return
		}
		if (!isReaderExt(ext)) {
			await this.#openWithNativeViewer(bookPath)
			return
		}
		const existing = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_GROVE_READER)
			.find(leaf => leaf.view instanceof ReaderView && leaf.view.bookPath === bookPath)
		if (existing && existing.view instanceof ReaderView) {
			this.activateLeaf(existing)
			if (cfi || fallback) existing.view.jumpTo(cfi ?? '', fallback)
			return
		}
		const leaf = this.app.workspace.getLeaf('tab')
		await leaf.setViewState({
			type: VIEW_TYPE_GROVE_READER,
			active: true,
			state: { bookPath, cfi, fallback },
		})
		this.debug('reader', 'open done', { kind: 'epub-new' })
		this.activateLeaf(leaf)
	}

	/** 在 Grove Reader 内打开 TXT（自动识别 UTF-8 / GB18030 / Big5）；cfi 为批注回跳定位 */
	async #openTextBook(bookPath: string, cfi?: string, fallback?: GroveLinkTarget): Promise<void> {
		const existing = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_GROVE_TEXT)
			.find(leaf => leaf.view instanceof TextView && leaf.view.bookPath === bookPath)
		if (existing && existing.view instanceof TextView) {
			this.activateLeaf(existing)
			if (cfi || fallback) existing.view.jumpTo(cfi ?? '', fallback)
			return
		}
		const leaf = this.app.workspace.getLeaf('tab')
		await leaf.setViewState({
			type: VIEW_TYPE_GROVE_TEXT,
			active: true,
			state: { bookPath, cfi, fallback },
		})
		this.debug('reader', 'open done', { kind: 'txt-new' })
		this.activateLeaf(leaf)
	}

	/** 在 Grove Reader 内打开 PDF（专用视图：渲染 + 文字层划选批注） */
	async #openPdfBook(bookPath: string, cfi?: string, fallback?: GroveLinkTarget): Promise<void> {
		const existing = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_GROVE_PDF)
			.find(leaf => this.#isPdfView(leaf.view) && leaf.view.bookPath === bookPath)
		if (existing && this.#isPdfView(existing.view)) {
			this.activateLeaf(existing)
			if (cfi || fallback) existing.view.jumpToCfi(cfi ?? '', fallback)
			return
		}
		const leaf = this.app.workspace.getLeaf('tab')
		await leaf.setViewState({
			type: VIEW_TYPE_GROVE_PDF,
			active: true,
			state: { bookPath, cfi, fallback },
		})
		this.app.workspace.revealLeaf(leaf)
	}

	/** PDF 等：库内文件用 Obsidian 原生视图打开，库外文件交给系统默认程序 */
	async #openWithNativeViewer(bookPath: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(bookPath)
		if (!(f instanceof TFile)) {
			try {
				// 运行时 API，未收录进官方类型定义
				;(this.app as unknown as { openWithDefaultApp(path: string): void }).openWithDefaultApp(bookPath)
			} catch (e) {
				console.error('[Grove Reader] 打开外部文件失败', e)
				new Notice(`Grove Reader：请在文件管理器中打开该文件（${bookPath}）`)
			}
			return
		}
		const existing = this.app.workspace
			.getLeavesOfType('pdf')
			.find(leaf => (leaf.view as { file?: TFile }).file?.path === f.path)
		if (existing) {
			this.activateLeaf(existing)
			return
		}
		const leaf = this.app.workspace.getLeaf('tab')
		await leaf.openFile(f)
		this.app.workspace.revealLeaf(leaf)
	}

	private async openByBookId(bookId: string, cfi: string): Promise<void> {
		if (!bookId) {
			new Notice('Grove Reader：链接缺少书籍信息')
			return
		}
		const bookPath = this.store.getPathForBookId(bookId)
		if (!bookPath) {
			new Notice('Grove Reader：找不到该链接对应的书籍数据')
			return
		}
		await this.openBookByPath(bookPath, cfi || undefined)
	}

	/**
	 * 双链点击接管：`[[书.epub#grove-cfi=…|↩ 回原文]]`。
	 * 捕获阶段先手（阅读视图与 Live Preview 都能拦），只认自家子路径，别的链接一律放行。
	 */
	/** metadataCache 解析完后延迟刷新「引用」页签 */
	private backlinkTimer: number | null = null

	/** 手机端双链的挂起跳转：等 Obsidian 自己的导航落地（file-open），再换成 Grove 视图 */
	#pendingGroveLink: { path: string; open: () => void; timer: number } | null = null

	/** 手机端点按识别：Live Preview 的 CM6 链接不走 document click，只能自己看 pointerup */
	#tapStart: { x: number; y: number; at: number } | null = null

	#onGroveLinkClick(ev: MouseEvent): void {
		const target = ev.target as HTMLElement | null
		const raw = this.#groveHrefAt(target)
		// 手机上没有 CDP、console 也不进 logcat：疑似链接点击就记进 debug 日志（开着调试模式时）
		const cls = typeof target?.className === 'string' ? target.className.slice(0, 80) : String(target?.className ?? '')
		this.debug('link', 'click', { prevented: ev.defaultPrevented, target: cls, raw: raw.slice(0, 100) })
		if (ev.defaultPrevented) return
		this.#openGroveHref(raw, ev)
	}

	/**
	 * 手机 Live Preview 里点内部双链时，CM6 自己处理 tap，可能不派发 document click；
	 * 在 pointerup 上补一层：短按、位移小、落点能解析出 grove 链接才接管。
	 */
	#onGroveLinkPointerUp(ev: PointerEvent): void {
		const start = this.#tapStart
		this.#tapStart = null
		if (!start) return
		if (Date.now() - start.at > 650) return
		if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 12) return
		const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
		const raw = this.#groveHrefAt(target)
		if (!raw) return
		this.debug('link', 'pointerup', { target: target?.className ?? '', raw: raw.slice(0, 100) })
		this.#openGroveHref(raw, null)
	}

	/** 从点击目标里找 grove 链接：阅读模式有 data-href，Live Preview 要回编辑器文档反查 */
	#groveHrefAt(target: HTMLElement | null): string {
		const anchor = target?.closest?.('[data-href], a[href]') as HTMLElement | null
		const raw = anchor ? (anchor.getAttribute('data-href') || anchor.getAttribute('href') || '') : ''
		if (raw) return raw
		return target ? (this.#hrefFromLivePreview(target) ?? '') : ''
	}

	#openGroveHref(raw: string, ev: MouseEvent | null): void {
		if (!raw) return
		if (raw.includes('grove-')) {
			const parsed = parseGroveHref(raw)
			if (!parsed) return
			this.#handleLinkClick(ev, parsed.vaultPath, () => void this.openGroveLink(parsed))
			return
		}
		// PDF++ 形态：`[[书.pdf#page=12&selection=…]]`，Obsidian 自己只会打开第一页
		const pdfLink = parsePdfPlusHref(raw)
		if (!pdfLink) return
		const pdfFile = this.#resolveLinkedFile(pdfLink.bookPath)
		if (!pdfFile) return
		const linkTarget: GroveLinkTarget = {
			cfi: `page:${pdfLink.page}`,
			pdfRects: pdfLink.rects,
			pdfRectsPt: pdfLink.pointRects,
		}
		this.#handleLinkClick(ev, pdfFile.path, () => void this.openBookByPath(pdfFile.path, linkTarget.cfi, linkTarget))
	}

	/** 链接点击：桌面端直接拦下；手机端等 Obsidian 导航落地后再换成 Grove 视图 */
	#handleLinkClick(ev: MouseEvent | null, path: string, open: () => void): void {
		if (this.isMobile) {
			// 手机端实测：Obsidian 自己的链接处理器（mobile-tap）也会打开这个文件，
			// 而且晚于我们的 setViewState 落地，把 Grove 视图顶回原生编辑器（0.33.2 回归）。
			// 所以这里不拦截：让 Obsidian 先导航，file-open 里再换成 Grove 并精确跳转。
			if (this.#pendingGroveLink) window.clearTimeout(this.#pendingGroveLink.timer)
			const timer = window.setTimeout(() => {
				const pend = this.#pendingGroveLink
				if (!pend) return
				this.#pendingGroveLink = null
				this.debug('link', 'file-open 未到达，兜底直接打开')
				pend.open()
			}, 900)
			this.#pendingGroveLink = { path, open, timer }
			return
		}
		if (!ev) return
		ev.preventDefault()
		ev.stopPropagation()
		ev.stopImmediatePropagation()
		open()
	}

	/** 链接里的书路径 → 库内文件：先按原路径找，再让 Obsidian 按链接名解析 */
	#resolveLinkedFile(path: string): TFile | null {
		const direct = this.app.vault.getAbstractFileByPath(normalizePath(path))
		if (direct instanceof TFile) return direct
		const name = path.split('/').pop() ?? path
		const found = this.app.metadataCache.getFirstLinkpathDest(name, '')
		return found instanceof TFile ? found : null
	}

	/** 从实时预览的链接节点反查它的 `路径#定位` 源码；不是链接节点返回 null */
	#hrefFromLivePreview(target: HTMLElement): string | null {
		const span = target.closest('.cm-hmd-internal-link') as HTMLElement | null
		if (!span) return null
		try {
			const leaves = this.app.workspace.getLeavesOfType('markdown')
			const leaf = leaves.find(l => l.view.containerEl.contains(span))
			const view = leaf?.view as MarkdownView | undefined
			if (!view?.editor) {
				this.debug('link', 'LP 反查：找不到所属 markdown leaf')
				return null
			}
			// editor.cm 是 CM6 的 EditorView，官方 API 没收录，只能按运行时形状取
			const cm = (view.editor as unknown as { cm?: { posAtDOM(node: Node, offset?: number): number } }).cm
			if (!cm?.posAtDOM) {
				this.debug('link', 'LP 反查：editor.cm 不可用')
				return null
			}
			const pos = cm.posAtDOM(span, 0)
			const at = view.editor.offsetToPos(pos)
			// Live Preview 的源码行可能把一条 `[[…]]` 折成多行（长路径 + 长别名），
			// 只看当前行会只拿到 `回原文]]`，所以拼上前后几行再按游标位置找。
			const from = Math.max(0, at.line - 4)
			const to = Math.min(view.editor.lineCount() - 1, at.line + 1)
			const lines: string[] = []
			for (let i = from; i <= to; i++) lines.push(view.editor.getLine(i) ?? '')
			const text = lines.join('\n')
			const cursor = lines.slice(0, at.line - from).reduce((n, line) => n + line.length + 1, 0) + at.ch
			this.debug('link', 'LP 反查', { line: at.line, ch: at.ch, from, to, text: text.slice(0, 80) })
			const re = /\[\[([^[\]]+)\]\]/g
			for (let m = re.exec(text); m; m = re.exec(text)) {
				const start = m.index
				const end = m.index + m[0].length
				if (cursor >= start && cursor <= end) return m[1]
			}
			return null
		} catch (e) {
			this.debug('link', 'LP 反查异常', e instanceof Error ? e.message : String(e))
			return null
		}
	}

	/** 打开双链指向的书并落到那一句；CFI 失效时由视图内继续三级降级 */
	async openGroveLink(link: ParsedGroveLink): Promise<void> {
		const { vaultPath, target } = link
		const file = this.app.vault.getAbstractFileByPath(vaultPath)
		if (!(file instanceof TFile)) {
			new Notice(`${APP_NAME}：找不到这本书（${vaultPath}）`)
			return
		}
		await this.openBookByPath(vaultPath, target.cfi, target)
	}

	/** 这本书被哪些笔记引用（按章节分组），供侧栏「引用」页签使用 */
	collectExcerptBacklinks(bookPath: string) {
		return collectExcerptBacklinks(this.app, bookPath)
	}

	/** 从引用页签跳到笔记里的那条摘录双链：打开笔记并滚到链接位置 */
	async openCitation(row: ExcerptBacklinkRow): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(row.sourcePath)
		if (!(file instanceof TFile)) {
			new Notice(`${APP_NAME}：笔记不存在（${row.sourcePath}）`)
			return
		}
		// 不用 getLeaf('tab') + openFile：工作区里若残留游离叶子（detach 过的），
		// getLeaf 会把它发回来，openFile 在游离叶子上静默无效。openLinkText 走
		// Obsidian 自己的解析路径，永远落在真实标签页上。
		try {
			await this.app.workspace.openLinkText(file.path, '', false)
		} catch {
			new Notice(`${APP_NAME}：打不开笔记（${row.noteTitle}）`)
			return
		}
		const link = row.links[0]
		if (!link) return
		try {
			const view = this.app.workspace.getMostRecentLeaf()?.view as MarkdownView | undefined
			if (!view?.editor) return
			const start = view.editor.offsetToPos(link.position.start.offset)
			const end = view.editor.offsetToPos(link.position.end.offset)
			view.editor.setCursor(start)
			view.editor.scrollIntoView({ from: start, to: end }, true)
		} catch {
			// 阅读模式下没有编辑器：只打开笔记，不滚动
		}
	}

	/** 让打开中的三个视图刷新「引用」页签（metadataCache 解析完或手动触发） */
	refreshCitations(): void {
		for (const type of [VIEW_TYPE_GROVE_READER, VIEW_TYPE_GROVE_TEXT, VIEW_TYPE_GROVE_PDF]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				const view = leaf.view as { refreshCitations?: () => void }
				view.refreshCitations?.()
			}
		}
	}

	/** 读书籍字节：优先走库文件，找不到时按本机路径读（库外书籍只有桌面端支持） */
	async readBookBytes(bookPath: string): Promise<ArrayBuffer> {
		const f = this.app.vault.getAbstractFileByPath(bookPath)
		if (f instanceof TFile) return this.app.vault.readBinary(f)
		if (!this.desktopFs) throw new Error(`手机端暂不支持读取库外文件：${bookPath}`)
		const abs = isAbsolutePath(bookPath) ? bookPath : joinPath(this.vaultBase, bookPath)
		return this.desktopFs.readBytes(abs)
	}

	/** 书籍文件的修改时间与大小；库内走 TFile，库外走文件层 */
	async statBook(bookPath: string): Promise<{ mtime: number; size: number } | null> {
		const f = this.app.vault.getAbstractFileByPath(bookPath)
		if (f instanceof TFile) return { mtime: f.stat.mtime, size: f.stat.size }
		const abs = isAbsolutePath(bookPath) ? bookPath : joinPath(this.vaultBase, bookPath)
		const st = await this.io.stat(abs)
		return st ? { mtime: st.mtime, size: st.size } : null
	}

	/**
	 * pdfjs 运行时资源（wasm / cmaps / standard_fonts / worker）的访问 URL。
	 * 资源随插件分发在插件目录 pdfjs/ 下；桌面 FileSystemAdapter 与手机 CapacitorAdapter
	 * 都提供 getResourcePath，因此两端都能拿到可 fetch 的 URL。
	 */
	pdfjsAssetUrl(rel: string): string | null {
		const adapter = this.app.vault.adapter
		const full = normalizePath(`${this.manifest.dir || joinPath('.obsidian', 'plugins', this.manifest.id)}/pdfjs/${rel}`)
		try {
			let base = adapter.getResourcePath(full).split('?')[0]
			if (!base.endsWith('/')) base += '/'
			return base
		} catch {
			return null
		}
	}

	/**
	 * 读插件自带的 pdfjs 资源（`wasm/` `cmaps/` `standard_fonts/`）。
	 * 走 vault.adapter，桌面与手机同一条路：不依赖 getResourcePath 给的 URL
	 * 能不能 fetch（手机上是 /storage/... 读不到），供 pdf.js 的 BinaryDataFactory 调用。
	 */
	async readPdfjsAsset(rel: string): Promise<Uint8Array> {
		const dir = this.manifest.dir || joinPath('.obsidian', 'plugins', this.manifest.id)
		const path = normalizePath(`${dir}/pdfjs/${rel}`)
		const buf = await this.app.vault.adapter.readBinary(path)
		return new Uint8Array(buf)
	}

	/** 手机端 getResourcePath 给的是 /storage/... 文件路径，Worker 加载不了，要读成 Blob URL。
	 *  插件级缓存一份：PDF 阅读视图与书架封面解析共用，卸载时统一释放。
	 *  （视图关闭时不要 revoke，否则另一个视图/书架再要就拿到失效 URL） */
	private pdfWorkerBlobUrl: string | null = null

	async resolvePdfWorkerSrc(): Promise<string | null> {
		const direct = this.pdfjsAssetUrl('pdf.worker.mjs')
		if (!this.isMobile) return direct
		if (this.pdfWorkerBlobUrl) return this.pdfWorkerBlobUrl
		const dir = this.manifest.dir
		if (!dir) return direct
		try {
			const buf = await this.app.vault.adapter.readBinary(`${dir}/pdfjs/pdf.worker.mjs`)
			this.pdfWorkerBlobUrl = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }))
			return this.pdfWorkerBlobUrl
		} catch (e) {
			console.warn('[Grove Reader] 读取 pdf.worker 失败，退回资源路径', e)
			return direct
		}
	}

	/**
	 * 汇总所有书的批注数 / 进度 / 最近阅读，供书架卡片展示。
	 * 批注 JSON 在启动时已由 BookStore 预载进内存，这里不再扫磁盘/parse JSON，
	 * 也就不用 Node fs（移动端同一套逻辑）。
	 */
	collectBookStats(): Map<string, ShelfBookInfo> {
		const map = new Map<string, ShelfBookInfo>()
		for (const bookPath of this.store.listBookPaths()) {
			const data = this.store.load(bookPath)
			if (typeof data?.bookPath !== 'string') continue
			const notePath = typeof data.notePath === 'string' ? data.notePath : undefined
			const stats = this.stats.peek(data.bookPath)
			map.set(data.bookPath, {
				annotations: data.annotations.length,
				fraction: data.lastLocation?.fraction,
				// 笔记被删/改名后不再显示标记
				notePath: notePath && this.app.vault.getAbstractFileByPath(notePath) instanceof TFile ? notePath : undefined,
				lastRead: stats?.lastRead || undefined,
				seconds: stats?.seconds || undefined,
				readingStatus: data.readingStatus,
			})
		}
		return map
	}

	/** 打开某本书已生成的阅读笔记（卡片上的笔记标记） */
	async openBookNote(bookPath: string): Promise<void> {
		const data = this.store.load(bookPath)
		const notePath = data.notePath
		const file = notePath ? this.app.vault.getAbstractFileByPath(notePath) : null
		if (!(file instanceof TFile)) {
			new Notice('Grove Reader：这本书还没有生成阅读笔记')
			return
		}
		await this.app.workspace.getLeaf('tab').openFile(file)
	}

	// ------------------------------------------------------------------
	// 命令
	// ------------------------------------------------------------------

	private registerCommands(): void {
		this.addCommand({
			id: 'open-bookshelf',
			name: '打开书架',
			callback: () => void this.openBookshelf(),
		})
		this.addCommand({
			id: 'open-book',
			name: '打开书籍…',
			callback: () => this.openPicker(),
		})
		this.addCommand({
			id: 'next-page',
			name: '下一页',
			checkCallback: checking => this.withAnyReader(checking, v => v.nextPage()),
		})
		this.addCommand({
			id: 'prev-page',
			name: '上一页',
			checkCallback: checking => this.withAnyReader(checking, v => v.prevPage()),
		})
		for (const c of HIGHLIGHT_COLORS) {
			this.addCommand({
				id: `highlight-${c.key}`,
				name: `高亮：${c.name}`,
				checkCallback: checking => this.withAnyReader(checking, v => v.highlight(c.key)),
			})
		}
		this.addCommand({
			id: 'add-comment',
			name: '评论当前划选',
			checkCallback: checking => this.withAnyReader(checking, v => v.comment()),
		})
		this.addCommand({
			id: 'stop-tts',
			name: '停止朗读',
			checkCallback: checking => this.withAnyReader(checking, v => v.stopTts?.()),
		})
		this.addCommand({
			id: 'toggle-sidebar',
			name: '收起 / 展开批注栏',
			checkCallback: checking => this.withAnyReader(checking, v => v.toggleSidebar?.()),
		})
		this.addCommand({
			id: 'clear-book-annotations',
			name: '清空当前书籍的全部批注',
			checkCallback: checking => this.withAnyReader(checking, v => this.clearAnnotationsFor(v.bookPath)),
		})
		this.addCommand({
			id: 'generate-note',
			name: '生成 / 更新阅读笔记',
			checkCallback: checking => this.withAnyReader(checking, v => this.generateNoteFor(v)),
		})
		this.addCommand({
			id: 'book-ask',
			name: '问这本书（AI 全书问答）',
			checkCallback: checking => this.withAnyReader(checking, v => new BookAskModal(this.app, this, v).open()),
		})
		this.addCommand({
			id: 'book-guide',
			name: '按章导读（AI 逐章摘要）',
			checkCallback: checking => this.withAnyReader(checking, v => new GuideModal(this.app, this, v).open()),
		})
		this.addCommand({
			id: 'multi-book-ask',
			name: '多书一起问（跨书 AI 问答）',
			callback: () => new MultiBookAskModal(this.app, this).open(),
		})
		this.addCommand({
			id: 'theme-lists',
			name: 'AI 按主题整理书单',
			callback: () => this.organizeThemeLists(),
		})
		this.addCommand({
			id: 'toggle-immersive',
			name: '切换沉浸阅读（隐藏工具栏 / 侧栏）',
			callback: () => this.toggleImmersive(),
		})
		this.addCommand({
			id: 'rescan-bookshelf',
			name: '重新扫描书架',
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_BOOKSHELF)
				if (!leaves.length) {
					void this.openBookshelf()
					return
				}
				for (const leaf of leaves) {
					const view = leaf.view
					if (view instanceof BookshelfView) void view.refresh({ rescan: true })
				}
			},
		})
		this.addCommand({
			id: 'view-oplog',
			name: '查看操作记录',
			callback: () => new OpLogModal(this.app, this.oplog.list()).open(),
		})
		this.addCommand({
			id: 'search-annotations',
			name: '全局搜索批注',
			callback: () => this.showSearch(),
		})
		this.addCommand({
			id: 'import-highlights',
			name: '导入外部标注…',
			callback: () => new ImportHighlightsModal(this.app, this).open(),
		})
		this.addCommand({
			id: 'generate-shelf-base',
			name: '生成书架 Base（.base 卡片墙）',
			callback: () => void this.generateShelfBase(),
		})
		this.addCommand({
			id: 'choose-note-template',
			name: '选择当前书的笔记模板',
			checkCallback: checking => this.withAnyReader(checking, v => this.showTemplatePicker(v.bookPath)),
		})
		this.addCommand({
			id: 'migrate-data-folder',
			name: '迁移数据文件夹…',
			callback: () => this.promptMigrateDataFolder(),
		})
		this.addCommand({
			id: 'search-library-fulltext',
			name: '全库搜索（正文，含 PDF）',
			callback: () => new LibrarySearchModal(this.app, this).open(),
		})
		this.addCommand({
			id: 'search-current-book-fulltext',
			name: '搜索当前书全文',
			checkCallback: checking => this.withAnyReader(checking, v => {
				if (v instanceof TextView) {
					new PromptModal(this.app, '搜索当前书全文', '输入关键词，在当前书正文里搜索', query => v.searchFullText(query)).open()
					return
				}
				if (!(v instanceof ReaderView)) {
					new Notice(`${APP_NAME}：PDF 请用阅读器内的全文搜索`)
					return
				}
				new PromptModal(this.app, '搜索当前书全文', '输入关键词，在当前书正文里搜索', query => v.searchFullText(query)).open()
			}),
		})
		this.addCommand({
			id: 'export-annotations-canvas',
			name: '把批注发送到 Canvas…',
			checkCallback: checking => this.withAnyReader(checking, v => void this.exportToCanvas(v)),
		})
		this.addCommand({
			id: 'refresh-all-notes',
			name: '刷新全部阅读笔记（补齐统计字段）',
			callback: () => void this.refreshAllNotes(),
		})
		this.addCommand({
			id: 'sync-note-to-annotations',
			name: '从笔记同步批注…',
			checkCallback: checking => this.withAnyReader(checking, v => void this.openNoteSync(v)),
		})
		this.addCommand({
			id: 'open-trash',
			name: '打开回收站',
			callback: () => this.showTrash(),
		})
		this.addCommand({
			id: 'health-check',
			name: '运行数据体检',
			callback: () => this.showHealthReport(),
		})
		this.addCommand({
			id: 'open-debug-log',
			name: '打开调试日志',
			callback: () => void this.openDebugLog(),
		})
		this.addCommand({
			id: 'clear-debug-log',
			name: '清空调试日志',
			callback: () => {
				this.debugLog.clear()
				new Notice(`${APP_NAME}：调试日志已清空`)
			},
		})
		this.addCommand({
			id: 'restore-hidden-books',
			name: '恢复从书架移除的书籍',
			callback: () => void this.restoreHiddenBooks(),
		})
		this.addCommand({
			id: 'regenerate-usage-doc',
			name: '重新生成使用指南',
			callback: () => this.confirmRegenerateUsageDoc(),
		})
		this.addCommand({
			id: 'backup-data',
			name: '备份批注数据到库内',
			callback: () => void this.exportDataBackup(),
		})
		this.addCommand({
			id: 'global-bookmarks',
			name: '全局书签',
			callback: () => this.openGlobalBookmarks(),
		})
		this.addCommand({
			id: 'review-queue',
			name: '今日复习（间隔重复）',
			callback: () => this.openReview(),
		})
		this.addCommand({
			id: 'reset-review',
			name: '清空全部复习排期',
			callback: () => this.resetReviewSchedule(),
		})
		this.addCommand({
			id: 'reading-stats',
			name: '阅读统计',
			callback: () => new ReadingStatsModal(this.app, this).open(),
		})
	}

	/** 把单条批注画成书摘卡 PNG，存到 Grove Reader/书摘卡 */
	async exportQuoteCard(view: ReaderEngine, annotationId: string): Promise<void> {
		const data = view.snapshot()
		const a = data?.annotations.find(x => x.id === annotationId)
		if (!data || !a) {
			new Notice('Grove Reader：找不到这条批注')
			return
		}
		let canvas: HTMLCanvasElement
		try {
			canvas = renderQuoteCard({
				text: a.text,
				note: a.note,
				bookTitle: data.title || '未命名',
				author: data.author,
				chapter: a.chapter,
				color: a.color,
			})
		} catch (e) {
			new Notice(`Grove Reader：生成书摘卡失败（${e instanceof Error ? e.message : String(e)}）`)
			return
		}
		const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
		if (!blob) {
			new Notice('Grove Reader：生成书摘卡失败（导出图片为空）')
			return
		}
		const folder = normalizePath(`${LIBRARY_ROOT}/书摘卡`)
		if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder)
		let path = normalizePath(`${folder}/${sanitizeFileName(quoteCardFileName(data.title || '未命名', Date.now()))}`)
		// 同一秒内连续生成同名卡片时加序号，别让用户看到「保存失败」
		if (this.app.vault.getAbstractFileByPath(path)) {
			const base = path.replace(/\.png$/i, '')
			let i = 2
			while (this.app.vault.getAbstractFileByPath(`${base}-${i}.png`)) i++
			path = `${base}-${i}.png`
		}
		try {
			await this.app.vault.createBinary(path, await blob.arrayBuffer())
		} catch (e) {
			new Notice(`Grove Reader：保存书摘卡失败（${e instanceof Error ? e.message : String(e)}）`)
			return
		}
		new Notice(`Grove Reader：书摘卡已保存到 ${path}`)
	}

	// ------------------------------------------------------------------
	// 笔记生成
	// ------------------------------------------------------------------

	/** 把批注发到 Canvas；ids 为空表示整本书 */
	async exportToCanvas(view: ReaderEngine, ids?: string[]): Promise<void> {
		const data = view.snapshot()
		if (!data) {
			new Notice('Grove Reader：当前没有已打开的书籍')
			return
		}
		const list = ids?.length ? data.annotations.filter(a => ids.includes(a.id)) : data.annotations
		if (!list.length) {
			new Notice('Grove Reader：这本书还没有批注')
			return
		}
		const canvases = this.app.vault
			.getFiles()
			.filter(f => f.extension === 'canvas')
			.map(f => ({ path: f.path, name: f.basename }))
			.sort((a, b) => a.name.localeCompare(b.name))
		const title = data.title || '未命名'
		new CanvasExportModal(this.app, title, list, canvases, sanitizeFileName(`${title} - 批注`), payload =>
			void this.#writeCanvas(data, list, payload),
		).open()
	}

	async #writeCanvas(
		data: BookData,
		annotations: Array<{ id: string; text: string; note?: string; chapter?: string; color: string; pdf?: { page: number } }>,
		payload: CanvasExportPayload,
	): Promise<void> {
		const picked = annotations.filter(a => payload.ids.includes(a.id))
		if (!picked.length) return
		const noteFile = this.#noteFileFor(data)
		const specOf = (a: (typeof picked)[number]): CardSpec => ({
			text: buildCardText(
				a as never,
				data.title || '未命名',
				noteFile ? `[[${noteFile.path}#^grove-${a.id}|打开笔记]]` : undefined,
			),
			color: canvasColor(a.color),
		})
		const groupBy = payload.groupBy ?? 'none'
		let groups: CardGroup[]
		if (groupBy === 'chapter' || groupBy === 'color') {
			const map = new Map<string, CardSpec[]>()
			for (const a of picked) {
				const key = groupBy === 'chapter'
					? ((a.chapter ?? '').trim() || '未分章')
					: colorName(a.color)
				const list = map.get(key) ?? []
				list.push(specOf(a))
				map.set(key, list)
			}
			groups = [...map.entries()].map(([label, cards]) => ({ label, cards }))
		} else {
			groups = [{ cards: picked.map(specOf) }]
		}
		const wall = { columns: 3, connect: payload.connect }
		let written = 0

		let target = payload.target
		if (target) {
			const file = this.app.vault.getAbstractFileByPath(target)
			if (!(file instanceof TFile)) {
				new Notice('Grove Reader：目标画布已不存在')
				return
			}
			const existing = await this.app.vault.read(file)
			let doc
			try {
				doc = parseCanvas(existing)
			} catch {
				new Notice('Grove Reader：目标不是有效的 Canvas 文件，未做修改')
				return
			}
			written = appendCardWall(doc, groups, wall).cards
			await this.app.vault.modify(file, serializeCanvas(doc))
		} else {
			const folder = normalizePath(`${LIBRARY_ROOT}/画布`)
			if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder)
			target = normalizePath(`${folder}/${sanitizeFileName(payload.name || '批注画布')}.canvas`)
			if (this.app.vault.getAbstractFileByPath(target)) {
				new Notice('Grove Reader：同名画布已存在，请换个名字')
				return
			}
			const doc = emptyCanvas()
			written = appendCardWall(doc, groups, wall).cards
			await this.app.vault.create(target, serializeCanvas(doc))
		}
		new Notice(`Grove Reader：已把 ${written} 条批注写入画布`)
		const file = this.app.vault.getAbstractFileByPath(target)
		if (file instanceof TFile) await this.app.workspace.getLeaf('split').openFile(file)
	}

	/** 批量刷新已生成的笔记：补统计字段、重排生成区；有未回写改动的跳过 */
	async refreshAllNotes(): Promise<void> {
		const targets: Array<{ data: BookData; file: TFile }> = []
		for (const p of this.store.listBookPaths()) {
			const data = this.store.load(p)
			const file = this.#noteFileFor(data)
			if (file) targets.push({ data, file })
		}
		if (!targets.length) {
			new Notice('Grove Reader：没有找到已生成的阅读笔记')
			return
		}
		new ConfirmModal(
			this.app,
			`将刷新 ${targets.length} 份阅读笔记的生成区：区间外的手写内容保留，笔记里有未回写改动的会跳过。`,
			() => void this.#applyRefreshAll(targets),
			'开始刷新',
			'mod-cta',
		).open()
	}

	async #applyRefreshAll(targets: Array<{ data: BookData; file: TFile }>): Promise<void> {
		let ok = 0
		let skipped = 0
		let failed = 0
		for (const { data, file } of targets) {
			try {
				const existing = await this.app.vault.read(file)
				const pending = planSync(data, existing)
				if (pending.entries > 0 && pending.changes.length > 0) {
					skipped++
					continue
				}
				const markdown = await this.#composeNoteMarkdown(data, existing, false, true)
				if (markdown !== existing) await this.app.vault.modify(file, markdown)
				if (data.notePath !== file.path) {
					data.notePath = file.path
					this.store.save(data)
				}
				ok++
			} catch (e) {
				failed++
				console.error('[Grove Reader] 刷新笔记失败', file.path, e)
			}
		}
		new Notice(
			`Grove Reader：已刷新 ${ok} 份${skipped ? `，跳过 ${skipped} 份（有未回写改动）` : ''}${failed ? `，失败 ${failed} 份` : ''}`,
		)
	}

	/**
	 * 找一本书对应的笔记文件。
	 * data.notePath 可能因为改过笔记文件夹而失效，此时按「当前文件夹 + 文件名」
	 * 再按 frontmatter 的 grove-book 认领，避免用户被迫重新生成一遍。
	 */
	#noteFileFor(data: BookData): TFile | null {
		const direct = data.notePath ? this.app.vault.getAbstractFileByPath(data.notePath) : null
		if (direct instanceof TFile) return direct
		const folder = normalizePath(this.settings.notesFolder?.trim() || '阅读笔记')
		const bookName = data.title || data.bookPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || ''
		const guess = this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${sanitizeFileName(bookName)} - 阅读笔记.md`))
		if (guess instanceof TFile) return guess
		const dir = this.app.vault.getAbstractFileByPath(folder)
		if (!(dir instanceof TFolder)) return null
		const bookId = bookIdFor(data.bookPath)
		for (const child of dir.children) {
			if (!(child instanceof TFile) || child.extension !== 'md') continue
			const fm = this.app.metadataCache.getFileCache(child)?.frontmatter
			if (fm && fm['grove-book'] === bookId) return child
		}
		return null
	}

	/** 重新读入全部批注数据（外部同步后调用），并刷新已打开的阅读视图 */
	async reloadAllBooks(): Promise<void> {
		for (const p of this.store.listBookPaths()) {
			const id = this.store.bookId(p)
			await this.store.reloadFromDisk(id)
		}
		for (const type of [VIEW_TYPE_GROVE_READER, VIEW_TYPE_GROVE_TEXT]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				const v = leaf.view as unknown as { refreshAnnotations?: () => void }
				v.refreshAnnotations?.()
			}
		}
	}

	/** 程序直接写入批注后：刷新已打开的阅读视图，并触发这些书的笔记自动更新 */
	refreshOpenReaders(bookPaths?: string[]): void {
		const touched = bookPaths ? new Set(bookPaths) : null
		for (const type of [VIEW_TYPE_GROVE_READER, VIEW_TYPE_GROVE_TEXT, VIEW_TYPE_GROVE_PDF]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				const v = leaf.view as unknown as ReaderEngine & { refreshAnnotations?: () => void }
				v.refreshAnnotations?.()
				if (touched && v.bookPath && touched.has(v.bookPath)) this.scheduleNoteRefresh(v)
			}
		}
	}

	/** 从阅读笔记回写批注：先算差异、弹窗勾选，再写数据（不改笔记本身） */
	async openNoteSync(view: ReaderEngine): Promise<void> {
		const data = view.snapshot()
		if (!data) {
			new Notice('Grove Reader：当前没有已打开的书籍')
			return
		}
		const file = this.#noteFileFor(data)
		if (!file) {
			new Notice(
				data.notePath
					? 'Grove Reader：没找到这本书的阅读笔记（可能被移动或改名），请重新生成阅读笔记'
					: 'Grove Reader：这本书还没有阅读笔记，先生成一份再回写',
			)
			return
		}
		if (data.notePath !== file.path) {
			data.notePath = file.path
			this.store.save(data)
		}
		const markdown = await this.app.vault.read(file)
		const plan = planSync(data, markdown)
		if (!plan.changes.length) {
			new Notice(
				plan.missing.length
					? `Grove Reader：笔记里没有这 ${plan.missing.length} 条批注的改动，未做任何修改`
					: 'Grove Reader：笔记与批注一致，没有需要回写的改动',
			)
			return
		}
		new NoteSyncModal(this.app, plan, changes => {
			const n = applySync(data, changes)
			this.store.save(data)
			view.refreshAnnotations()
			this.oplog.add('从笔记回写批注', `《${data.title || data.bookPath}》 ${n} 项`)
			new Notice(`Grove Reader：已从笔记回写 ${n} 项，笔记未改动`)
		}).open()
	}

	async generateNoteFor(view: ReaderEngine): Promise<void> {
		const data = view.snapshot()
		if (!data) {
			new Notice('Grove Reader：当前没有已打开的书籍')
			return
		}
		const folder = normalizePath(this.settings.notesFolder?.trim() || '阅读笔记')
		if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder)

		const bookName = data.title
			|| data.bookPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '')
			|| '未命名'
		const fileName = `${sanitizeFileName(bookName)} - 阅读笔记.md`

		let noteFile: TFile | null = null
		let createPath = normalizePath(`${folder}/${fileName}`)
		if (data.notePath) {
			const f = this.app.vault.getAbstractFileByPath(data.notePath)
			if (f instanceof TFile) noteFile = f
		}
		if (!noteFile) {
			// 同名书（如同书的 epub + pdf）会撞默认文件名：按 frontmatter 的
			// grove-book 认领自己的笔记；被其他书占用的名字依次尝试 (2)(3)…
			// 没有 grove-book 字段的既有文件沿用旧认领逻辑（可能是用户自建的同名笔记）
			const bookId = bookIdFor(data.bookPath)
			const stem = fileName.replace(/\.md$/, '')
			for (let i = 1; i < 100; i++) {
				const p = normalizePath(i === 1 ? `${folder}/${fileName}` : `${folder}/${stem} ${i}.md`)
				const f = this.app.vault.getAbstractFileByPath(p)
				if (!(f instanceof TFile)) {
					createPath = p
					break
				}
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter
				const owner = fm && typeof fm['grove-book'] === 'string' ? fm['grove-book'] : null
				if (!owner || owner === bookId) {
					noteFile = f
					break
				}
			}
			// 所有候选名都被其他书占用时（几乎不可能），退化为时间戳文件名
			if (!noteFile && this.app.vault.getAbstractFileByPath(createPath)) {
				createPath = normalizePath(`${folder}/${stem} ${Date.now()}.md`)
			}
		}

		// 笔记文件夹被修改后，把旧笔记挪到新文件夹（目标已有同名文件时直接续用该文件）
		if (noteFile) {
			const parentPath = noteFile.parent?.path ?? '/'
			if (parentPath !== folder) {
				const targetPath = normalizePath(`${folder}/${noteFile.name}`)
				const atTarget = this.app.vault.getAbstractFileByPath(targetPath)
				if (atTarget instanceof TFile) {
					noteFile = atTarget
				} else {
					try {
						await this.app.fileManager.renameFile(noteFile, targetPath)
						const moved = this.app.vault.getAbstractFileByPath(targetPath)
						if (moved instanceof TFile) noteFile = moved
					} catch (e) {
						console.error('[Grove Reader] 迁移笔记到新文件夹失败', e)
						new Notice('Grove Reader：笔记无法移动到新文件夹，将在原位置继续更新')
					}
				}
			}
		}

		// 书名清洗后笔记文件名里还带数字前缀的，先改名再写入
		if (noteFile) noteFile = await this.#syncNoteFileName(data, noteFile)

		const existing = noteFile ? await this.app.vault.read(noteFile) : null

		// 使用指南：每个笔记文件夹只创建一次
		await this.ensureUsageDoc(folder)

		// 模板：读取指定模板文件；解析失败则回退默认
		const markdown = await this.#composeNoteMarkdown(data, existing, true)
		if (noteFile) await this.app.vault.modify(noteFile, markdown)
		else noteFile = await this.app.vault.create(createPath, markdown)

		data.notePath = noteFile.path
		this.store.save(data)
		new Notice(`Grove Reader：阅读笔记已生成（${data.annotations.length} 条批注）`)

		const target = noteFile
		const openLeaf = this.app.workspace
			.getLeavesOfType('markdown')
			.find(l => (l.view as { file?: TFile }).file?.path === target.path)
		if (openLeaf) {
			this.activateLeaf(openLeaf)
			return
		}
		const leaf = this.app.workspace.getLeaf('split')
		await leaf.openFile(target)
	}

	/** 书名清洗（去掉数字 ID 前缀）后，把仍带旧前缀的笔记文件一起改名并更新 notePath */
	async #syncNoteFileName(data: BookData, file: TFile): Promise<TFile> {
		const stem = file.basename.replace(/ - 阅读笔记( \d+)?$/, '')
		const stripped = stripNumericTitlePrefix(stem)
		if (!stripped || stripped === stem) return file
		const folder = file.parent?.path ?? '/'
		const targetPath = normalizePath(`${folder}/${stripped} - 阅读笔记.md`)
		if (this.app.vault.getAbstractFileByPath(targetPath)) return file
		try {
			await this.app.fileManager.renameFile(file, targetPath)
			if (data.notePath === file.path) {
				data.notePath = targetPath
				this.store.save(data)
			}
			const moved = this.app.vault.getAbstractFileByPath(targetPath)
			return moved instanceof TFile ? moved : file
		} catch (e) {
			console.error('[Grove Reader] 笔记跟随书名清洗改名失败', e)
			return file
		}
	}

	/** 读取模板并把批注数据渲染成完整笔记 Markdown（含 frontmatter 与标记区） */
	/** 笔记 frontmatter 里的统计字段：进度取最后位置，时长取阅读统计，出版社取书架缓存 */
	#noteExtra(data: BookData): NoteExtraFields {
		const ext = (data.bookPath.split('.').pop() ?? '').toLowerCase()
		const fraction = data.lastLocation?.fraction
		const progress = typeof fraction === 'number' ? Math.max(0, Math.min(1, fraction)) * 100 : 0
		const stat = this.stats.book(data.bookPath)
		const status = data.readingStatus
			? READING_STATUS_LABELS[data.readingStatus]
			: progress >= 99 ? '读完' : progress > 0 ? '在读' : '想读'
		// 阅读统计按本地日期分桶：最早一天是开始读，最后一天在「读完」时当作完成日
		const days = Object.keys(stat.days ?? {}).sort()
		// 封面写进 frontmatter，Bases 卡片视图才能取到图；数据目录在库外时双链无效，留空
		const coverFile = this.shelfCache.get(data.bookPath)?.cover ?? ''
		const dataFolder = (this.settings.dataFolder?.trim() || 'Grove Reader').replace(/\\/g, '/').replace(/\/+$/, '')
		const cover = coverFile && !isAbsolutePath(dataFolder)
			? `[[${normalizePath(`${dataFolder}/data/covers/${coverFile}`)}]]`
			: ''
		return {
			annotations: data.annotations.length,
			format: FORMAT_LABELS[ext] ?? ext.toUpperCase(),
			progress,
			status,
			started: days[0] ?? '',
			finished: status === '读完' ? (days[days.length - 1] ?? '') : '',
			seconds: stat.seconds,
			lastRead: stat.lastRead || data.lastLocation?.updatedAt || 0,
			publisher: this.shelfCache.get(data.bookPath)?.publisher ?? '',
			cover,
		}
	}

	async #composeNoteMarkdown(data: BookData, existing: string | null, announce: boolean, force = announce): Promise<string> {
		const { template, link } = await this.#noteTemplate(data, existing, force, announce)
		return buildNote(data, bookIdFor(data.bookPath), existing, template, this.#noteExtra(data), link)
	}

	/** 笔记模板与回跳链接样式：生成与增量追加共用，避免两处规则漂移 */
	async #noteTemplate(
		data: BookData,
		existing: string | null,
		force: boolean,
		announce: boolean,
	): Promise<{ template: string | null; link: NoteLinkOptions }> {
		const tplPath = this.templatePathFor(data)
		const style = resolveExcerptLinkStyle(
			this.settings.excerptLinkStyle === 'protocol' ? 'protocol' : 'wikilink',
			existing,
			// 自动刷新不改旧笔记的链接样式；手动生成/刷新才跟随设置
			force,
		)
		const link: NoteLinkOptions = { style }
		let template: string | null = null
		const tplFile = this.app.vault.getAbstractFileByPath(tplPath)
		if (tplFile instanceof TFile) template = await this.app.vault.read(tplFile)
		if (template) {
			try {
				renderNoteTemplate(template, buildTemplateContext(data, bookIdFor(data.bookPath), link))
			} catch (e) {
				console.error('[Grove Reader] 笔记模板解析失败', e)
				if (announce) new Notice('Grove Reader：笔记模板解析失败，本次使用默认模板')
				template = null
			}
		}
		return { template, link }
	}

	private noteRefreshTimer: number | null = null
	/** 已经提示过「笔记有未回写改动」的文件，避免每次改批注都弹一次 */
	private pendingNoteEdits = new Set<string>()

	/** 批注/元数据变更后防抖刷新已存在的笔记（不新建、不弹 Notice、不跳转） */
	scheduleNoteRefresh(view: ReaderEngine): void {
		if (!this.settings.autoUpdateNote) return
		if (this.noteRefreshTimer != null) window.clearTimeout(this.noteRefreshTimer)
		this.noteRefreshTimer = window.setTimeout(() => {
			this.noteRefreshTimer = null
			void this.#autoRefreshNote(view)
		}, 1500)
	}

	async #autoRefreshNote(view: ReaderEngine): Promise<void> {
		const data = view.snapshot()
		if (!data) return
		const file = this.#noteFileFor(data)
		if (!file) return
		if (data.notePath !== file.path) {
			data.notePath = file.path
			this.store.save(data)
		}
		try {
			const synced = await this.#syncNoteFileName(data, file)
			const existing = await this.app.vault.read(synced)
			// 笔记里有还没回写的改动时不要覆盖：用户在笔记里改的评论/摘录比自动刷新重要
			const pending = planSync(data, existing)
			if (pending.entries > 0 && pending.changes.length > 0) {
				if (!this.pendingNoteEdits.has(synced.path)) {
					this.pendingNoteEdits.add(synced.path)
					new Notice('Grove Reader：笔记里有未回写的改动，已跳过自动更新（用「从笔记同步批注…」写回）')
				}
				return
			}
			this.pendingNoteEdits.delete(synced.path)
			// 纯新增（没有删除条目、没有手写块 id）时只追加新批注，不重写整个生成区，
			// 这样用户在生成区里手写的行也能保留下来
			if (!pending.changes.length && !pending.unknown.length && pending.missing.length) {
				const { template, link } = await this.#noteTemplate(data, existing, false, false)
				const appended = appendAnnotationBlocks(existing, data, bookIdFor(data.bookPath), template, link, this.#noteExtra(data))
				if (appended) {
					if (appended.markdown !== existing) await this.app.vault.modify(synced, appended.markdown)
					this.debug('note', 'append', { path: synced.path, appended: appended.appended })
					return
				}
			}
			const markdown = await this.#composeNoteMarkdown(data, existing, false)
			if (markdown !== existing) await this.app.vault.modify(synced, markdown)
		} catch (e) {
			console.error('[Grove Reader] 自动更新笔记失败', e)
		}
	}

	/** 书架手动编辑书名/作者后，同步进书籍数据（笔记标题与阅读界面标题都取 data.title） */
	syncBookMeta(bookPath: string, title: string, author: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_READER)) {
			const v = leaf.view
			if (v instanceof ReaderView && v.bookPath === bookPath) {
				v.syncMeta(title, author)
				return
			}
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_PDF)) {
			const v = leaf.view
			if (this.#isPdfView(v) && v.bookPath === bookPath) {
				v.syncMeta(title, author)
				return
			}
		}
		if (this.store.hasDataFor(bookPath)) {
			const data = this.store.load(bookPath)
			data.title = title
			if (author) data.author = author
			this.store.save(data)
		}
	}

	/** 确保某库内路径的父文件夹存在 */
	private async ensureFolderOf(filePath: string): Promise<void> {
		const dir = filePath.split('/').slice(0, -1).join('/')
		if (dir && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir)
	}

	/** 在笔记文件夹生成使用指南（已存在则跳过） */
	private async ensureUsageDoc(folder: string): Promise<void> {
		const path = normalizePath(`${folder}/${USAGE_DOC_NAME}`)
		if (this.app.vault.getAbstractFileByPath(path)) return
		try {
			await this.app.vault.create(path, usageDocMarkdown())
		} catch (e) {
			console.error('[Grove Reader] 使用指南创建失败', e)
		}
	}

	/** 创建（如缺失）并打开笔记模板文件 */
	async openNoteTemplate(): Promise<void> {
		const tplPath = this.defaultTemplatePath()
		let f = this.app.vault.getAbstractFileByPath(tplPath)
		if (!(f instanceof TFile)) {
			await this.ensureFolderOf(tplPath)
			f = await this.app.vault.create(tplPath, DEFAULT_NOTE_TEMPLATE)
			new Notice('Grove Reader：已创建笔记模板文件，可直接编辑')
		}
		if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f)
	}

	/** 当前可用的模板列表；没有配置时退回旧的单模板路径 */
	templateList(): NoteTemplate[] {
		const list = (this.settings.noteTemplates ?? []).filter(t => t && t.id && t.path)
		if (list.length) return list
		return [{
			id: 'legacy',
			name: '默认模板',
			path: this.settings.noteTemplatePath?.trim() || DEFAULT_TEMPLATE_PATH,
		}]
	}

	defaultTemplatePath(): string {
		const list = this.templateList()
		const tpl = list.find(t => t.id === this.settings.defaultNoteTemplateId) ?? list[0]
		return normalizePath(tpl?.path || DEFAULT_TEMPLATE_PATH)
	}

	/** 单本书：自己的模板优先，其次默认模板 */
	templatePathFor(data: BookData): string {
		const list = this.templateList()
		const tpl = (data.templateId && list.find(t => t.id === data.templateId))
			|| list.find(t => t.id === this.settings.defaultNoteTemplateId)
			|| list[0]
		return normalizePath(tpl?.path || DEFAULT_TEMPLATE_PATH)
	}

	showTemplatePicker(bookPath: string): void {
		new TemplatePickerModal(this.app, this, bookPath).open()
	}

	setBookTemplate(bookPath: string, templateId: string): void {
		const data = this.store.load(bookPath)
		if (templateId) data.templateId = templateId
		else delete data.templateId
		this.store.save(data)
		const tpl = this.templateList().find(t => t.id === templateId)
		const label = templateId ? (tpl?.name ?? '未知模板') : '跟随默认'
		this.oplog.add('切换笔记模板', `《${data.title || bookPath}》 → ${label}`)
		this.debug('template', 'set', { bookPath, templateId })
		this.refreshNoteForBook(bookPath)
		new Notice(`${APP_NAME}：笔记模板已切换为「${label}」`)
	}

	promptMigrateDataFolder(): void {
		new FolderPromptModal(
			this.app,
			'迁移数据文件夹',
			this.settings.dataFolder?.trim() || 'Grove Reader',
			async value => this.migrateDataFolder(value),
		).open()
	}

	/** 复制 data/ 到新的库内目录；不删旧数据，重启后生效（PlatformIO，手机端同样可用） */
	async migrateDataFolder(targetFolder: string): Promise<void> {
		const folder = targetFolder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
		if (!folder) {
			new Notice(`${APP_NAME}：请填写库内文件夹路径`)
			return
		}
		if (isAbsolutePath(folder)) {
			new Notice(`${APP_NAME}：数据文件夹请填库内相对路径（例如 Grove Reader）`)
			return
		}
		if (folder.split('/').includes('..')) {
			new Notice(`${APP_NAME}：数据文件夹不能包含 ..`)
			return
		}
		const sourceRoot = this.dataRoot
		const targetRoot = this.vaultBase ? joinPath(this.vaultBase, normalizePath(folder)) : normalizePath(folder)
		const { checkMigrateTarget, migrateDataFolder } = await import('./backup')
		const check = await checkMigrateTarget(this.io, sourceRoot, targetRoot)
		if (!check.ok) {
			new Notice(`${APP_NAME}：${check.message}`)
			return
		}
		const { source, target } = check
		new ConfirmModal(
			this.app,
			`把当前数据复制到「${folder}/data」？\n\n源：${source}\n目标：${target}\n\n复制期间请不要继续阅读/批注；复制完成后立即重启 Obsidian。旧数据不会删除，回收站（.trash）不迁移。`,
			() => {
				void (async () => {
					try {
						new Notice(`${APP_NAME}：正在复制数据…`)
						const result = await migrateDataFolder(this.io, sourceRoot, targetRoot)
						this.settings.dataFolder = folder
						await this.saveSettings()
						this.oplog.add('迁移数据文件夹', `${sourceRoot} → ${targetRoot}；${result.books} 份批注`)
						this.debug('data', 'migrate', { from: sourceRoot, to: targetRoot, files: result.files, books: result.books })
						new Notice(`${APP_NAME}：已复制 ${result.files} 个文件。请重启 Obsidian 生效；旧数据确认无误后再删。`)
					} catch (e) {
						new Notice(`${APP_NAME}：迁移失败（${e instanceof Error ? e.message : String(e)}）。目标目录可能有残留文件，请检查后重试。`)
					}
				})()
			},
		).open()
	}

	/** 生成（如缺失）并打开使用指南 */	async openUsageDoc(): Promise<void> {
		const folder = normalizePath(this.settings.notesFolder?.trim() || '阅读笔记')
		if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder)
		const path = normalizePath(`${folder}/${USAGE_DOC_NAME}`)
		let f = this.app.vault.getAbstractFileByPath(path)
		if (!(f instanceof TFile)) f = await this.app.vault.create(path, usageDocMarkdown())
		if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f)
	}

	/** 覆盖前确认：使用指南可能被用户改过 */
	confirmRegenerateUsageDoc(): void {
		new ConfirmModal(this.app, '重新生成会覆盖当前使用指南，包括你在里面手写的内容。继续？', () => {
			void this.regenerateUsageDoc()
		}).open()
	}

	/** 用当前版本的内容覆盖已生成的使用指南（用户可在设置里手动触发） */
	async regenerateUsageDoc(): Promise<void> {
		const folder = normalizePath(this.settings.notesFolder?.trim() || '阅读笔记')
		if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder)
		const path = normalizePath(`${folder}/${USAGE_DOC_NAME}`)
		const markdown = usageDocMarkdown()
		const file = this.app.vault.getAbstractFileByPath(path)
		if (file instanceof TFile) await this.app.vault.modify(file, markdown)
		else await this.app.vault.create(path, markdown)
		new Notice(`${APP_NAME}：使用指南已更新`)
	}

	/** 库内备份文件夹（设置里可改；空/异常时回退默认名） */
	backupFolderRel(): string {
		return this.settings.backupFolder?.trim() || BACKUP_FOLDER_NAME
	}

	/**
	 * 把全部批注/书架数据导出到库内普通文件夹（随库同步，删除/重装插件都不受影响）。
	 * 批注 JSON 的权威副本仍在插件 data/ 下；这里是可带走的保险副本，防插件目录被误删。
	 * 设置 backupTargetDir 时额外复制一份过去（同盘备份防不了磁盘故障）。
	 * 复制走 PlatformIO（backup.ts），桌面与手机同一套逻辑。
	 */
	async exportDataBackup(): Promise<void> {
		// 刷盘挂起的写入，保证导出的是最新状态
		this.shelfCache.saveNow()
		this.lists.saveNow()
		const rel = this.backupFolderRel()
		const root = this.vaultBase ? joinPath(this.vaultBase, rel) : joinPath(rel)
		try {
			const { exportDataBackup } = await import('./backup')
			const result = await exportDataBackup({
				io: this.io,
				root,
				dataRoot: this.dataRoot,
				pluginDir: this.pluginDir,
				target: this.settings.backupTargetDir?.trim() || undefined,
			})
			if (result.status === 'blocked') {
				new Notice(`Grove Reader：目标文件夹「${rel}」里已有同名文件，为避免误删已中止。请换一个空文件夹，或清空后重试`)
				return
			}
			this.oplog?.add('备份数据', `${result.bookCount} 本书；库内「${rel}」`)
			this.debug('backup', 'export', { rel, bookCount: result.bookCount })
			new Notice(`Grove Reader：已备份 ${result.bookCount} 本书的批注数据到库内「${rel}」${result.extra}`)
		} catch (e) {
			console.error('[Grove Reader] 备份批注数据失败', e)
			new Notice(`Grove Reader：备份失败（${e instanceof Error ? e.message : String(e)}）`)
		}
	}

	/** 设置里改了库内备份文件夹后，把旧文件夹的内容转移到新路径（同名覆盖，旧文件夹清空后删除） */
	async migrateBackupFolder(from: string, to: string): Promise<void> {
		if (this.isMobile || !this.vaultBase) return
		const { moveBackupFolder } = await import('./desktopFs')
		const result = await moveBackupFolder({ vaultBase: this.vaultBase, from, to })
		if (result.status === 'moved') {
			new Notice(`Grove Reader：库内备份已转移到「${to}」`)
		} else if (result.status === 'failed') {
			new Notice(`Grove Reader：转移备份文件夹失败（${result.error ?? ''}），已保留原路径`)
		}
	}

	// ------------------------------------------------------------------
	// 设置
	// ------------------------------------------------------------------

	persistSettingsSoon(delay = 600): void {
		if (this.persistTimer != null) window.clearTimeout(this.persistTimer)
		this.persistTimer = window.setTimeout(() => {
			this.persistTimer = null
			void this.saveData(this.settings)
		}, delay)
	}

	async persistSettingsNow(): Promise<void> {
		if (this.persistTimer != null) {
			window.clearTimeout(this.persistTimer)
			this.persistTimer = null
		}
		await this.saveData(this.settings)
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<GroveSettings>
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data)
		this.settings.appearance = Object.assign({}, DEFAULT_APPEARANCE, data.appearance ?? {})
		this.settings.shelfDisplay = Object.assign({}, DEFAULT_SHELF_DISPLAY, data.shelfDisplay ?? {})
		if (!Array.isArray(this.settings.scanFolders)) {
			// 首次使用：默认扫描库内的「书籍」文件夹
			this.settings.scanFolders = ['书籍']
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings)
		if (this.store) this.store.maxBackups = this.settings.maxBackups
	}

	/** 设置里改了 TXT 版式后，让已打开的 TXT 视图重新分栏 */
	refreshTextViewLayout(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_TEXT)) {
			if (leaf.view instanceof TextView) leaf.view.relayout()
		}
	}
}
