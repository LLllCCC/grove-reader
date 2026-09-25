import { FileSystemAdapter, Notice, Plugin, TFile, normalizePath } from 'obsidian'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import pathModule from 'node:path'
import { BookStore } from './store'
import { ShelfCache } from './bookshelf'
import { ListsStore } from './lists'
import {
	DEFAULT_APPEARANCE,
	DEFAULT_SETTINGS,
	BookData,
	GroveSettings,
	HIGHLIGHT_COLORS,
	SUPPORTED_BOOK_EXTS,
	BACKUP_FOLDER_NAME,
} from './types'
import { ReaderView, VIEW_TYPE_GROVE_READER } from './readerView'
import { BookshelfView, VIEW_TYPE_GROVE_BOOKSHELF } from './bookshelf'
import { PdfView, VIEW_TYPE_GROVE_PDF } from './pdfView'
import { BookPickerModal } from './modals'
import { GroveSettingTab } from './settings'
import { buildNote, buildTemplateContext, DEFAULT_NOTE_TEMPLATE, DEFAULT_TEMPLATE_PATH, renderNoteTemplate } from './notes'
import { bookIdFor, isAbsolutePath, sanitizeFileName } from './util'
import { isReaderExt } from './types'
import { usageDocMarkdown, USAGE_DOC_NAME } from './usageDoc'

export default class GroveReaderPlugin extends Plugin {
	settings: GroveSettings = { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_APPEARANCE } }
	store!: BookStore
	shelfCache!: ShelfCache
	lists!: ListsStore
	vaultBase = ''
	/** 书架搜索词：只活在本次会话，关掉书架页再打开还在，重启 Obsidian 清空 */
	shelfSearch = ''

	private dataRoot!: string
	private persistTimer: number | null = null

	async onload(): Promise<void> {
		await this.loadSettings()
		const adapter = this.app.vault.adapter
		if (adapter instanceof FileSystemAdapter) this.vaultBase = adapter.getBasePath()
		const pluginDir = this.manifest.dir || pathModule.join('.obsidian', 'plugins', this.manifest.id)
		this.dataRoot = this.vaultBase ? pathModule.join(this.vaultBase, pluginDir) : pluginDir
		this.store = new BookStore(this.dataRoot, this.settings.maxBackups)
		let lastSaveErrorAt = 0
		this.store.onError = e => {
			console.error('[Grove Reader] 批注数据保存失败', e)
			const now = Date.now()
			if (now - lastSaveErrorAt > 30_000) {
				lastSaveErrorAt = now
				new Notice('Grove Reader：批注数据保存失败（文件可能被 iCloud/杀软锁定），稍后会自动重试')
			}
		}
		this.shelfCache = new ShelfCache(this.dataRoot)
		this.shelfCache.load()
		this.lists = new ListsStore(this.dataRoot)
		this.lists.load()

		this.registerView(VIEW_TYPE_GROVE_READER, leaf => new ReaderView(leaf, this))
		this.registerView(VIEW_TYPE_GROVE_BOOKSHELF, leaf => new BookshelfView(leaf, this))
		this.registerView(VIEW_TYPE_GROVE_PDF, leaf => new PdfView(leaf, this))
		// 注册扩展名：电子书文件会显示在文件列表中，点击直接用阅读器打开
		// 注意：pdf 不注册——保持 Obsidian 原生双击行为，PDF 经书架/协议进入插件
		this.registerExtensions(SUPPORTED_BOOK_EXTS, VIEW_TYPE_GROVE_READER)
		this.registerObsidianProtocolHandler('grove', params =>
			void this.openByBookId(params['book'] ?? '', params['cfi'] ?? ''))
		this.addRibbonIcon('library', 'Grove Reader：书架', () => void this.openBookshelf())

		this.registerCommands()
		this.addSettingTab(new GroveSettingTab(this.app, this))
		this.registerEvent(this.app.workspace.on('css-change', () => {
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_READER)) {
				const view = leaf.view
				if (view instanceof ReaderView) view.applyAppearance()
			}
		}))
	}

	onunload(): void {
		// 各视图的 onClose 会负责落盘与销毁渲染器
	}

	private activeReader(): ReaderView | null {
		return this.app.workspace.getActiveViewOfType(ReaderView)
	}

	private withAnyReader(checking: boolean, run: (view: ReaderView | PdfView) => unknown): boolean {
		const r = this.activeReader()
		if (r?.ready) {
			if (!checking) run(r)
			return true
		}
		const p = this.app.workspace.getActiveViewOfType(PdfView)
		if (p?.ready) {
			if (!checking) run(p)
			return true
		}
		return false
	}

	// ------------------------------------------------------------------
	// 打开书籍 / 书架
	// ------------------------------------------------------------------

	async openBookshelf(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_GROVE_BOOKSHELF).first()
		if (existing) {
			this.app.workspace.revealLeaf(existing)
			return
		}
		const leaf = this.app.workspace.getLeaf('tab')
		await leaf.setViewState({ type: VIEW_TYPE_GROVE_BOOKSHELF, active: true })
		this.app.workspace.revealLeaf(leaf)
	}

	openPicker(): void {
		const books = this.app.vault
			.getFiles()
			.filter(f => SUPPORTED_BOOK_EXTS.includes(f.extension.toLowerCase()))
		if (!books.length) {
			new Notice('Grove Reader：库中没有找到电子书文件（支持 epub / mobi / azw3 / fb2 / cbz）')
			return
		}
		new BookPickerModal(this.app, file => void this.openBook(file)).open()
	}

	async openBook(file: TFile, cfi?: string): Promise<void> {
		await this.openBookByPath(file.path, cfi)
	}

	async openBookByPath(bookPath: string, cfi?: string): Promise<void> {
		const ext = (bookPath.split('.').pop() ?? '').toLowerCase()
		if (ext === 'pdf') {
			await this.#openPdfBook(bookPath, cfi)
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
			this.app.workspace.revealLeaf(existing)
			if (cfi) existing.view.jumpTo(cfi)
			return
		}
		const leaf = this.app.workspace.getLeaf('tab')
		await leaf.setViewState({
			type: VIEW_TYPE_GROVE_READER,
			active: true,
			state: { bookPath, cfi },
		})
		this.app.workspace.revealLeaf(leaf)
	}

	/** 在 Grove Reader 内打开 PDF（专用视图：渲染 + 文字层划选批注） */
	async #openPdfBook(bookPath: string, cfi?: string): Promise<void> {
		const existing = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_GROVE_PDF)
			.find(leaf => leaf.view instanceof PdfView && leaf.view.bookPath === bookPath)
		if (existing && existing.view instanceof PdfView) {
			this.app.workspace.revealLeaf(existing)
			if (cfi) existing.view.jumpToCfi(cfi)
			return
		}
		const leaf = this.app.workspace.getLeaf('tab')
		await leaf.setViewState({
			type: VIEW_TYPE_GROVE_PDF,
			active: true,
			state: { bookPath, cfi },
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
			this.app.workspace.revealLeaf(existing)
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

	/** 读书籍字节：优先走库文件，找不到时按本机路径读（支持库外书籍） */
	async readBookBytes(bookPath: string): Promise<ArrayBuffer> {
		const f = this.app.vault.getAbstractFileByPath(bookPath)
		if (f instanceof TFile) return this.app.vault.readBinary(f)
		const abs = isAbsolutePath(bookPath) ? bookPath : pathModule.join(this.vaultBase, bookPath)
		const buf = fs.readFileSync(abs)
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
	}

	/**
	 * pdfjs 运行时资源（wasm / cmaps / standard_fonts）的访问 URL。
	 * 资源随插件分发在插件目录 pdfjs/ 下，经库资源协议暴露给渲染进程。
	 */
	pdfjsAssetUrl(rel: string): string | null {
		const adapter = this.app.vault.adapter
		if (!(adapter instanceof FileSystemAdapter)) return null
		const full = normalizePath(`${this.manifest.dir || pathModule.join('.obsidian', 'plugins', this.manifest.id)}/pdfjs/${rel}`)
		let base = adapter.getResourcePath(full).split('?')[0]
		if (!base.endsWith('/')) base += '/'
		return base
	}

	/** 汇总所有书的批注数与进度，供书架卡片展示 */
	collectBookStats(): Map<string, { annotations: number; fraction?: number }> {
		const map = new Map<string, { annotations: number; fraction?: number }>()
		const dir = pathModule.join(this.dataRoot, 'data', 'books')
		try {
			for (const name of fs.readdirSync(dir)) {
				if (!name.endsWith('.json')) continue
				try {
					const data = JSON.parse(fs.readFileSync(pathModule.join(dir, name), 'utf-8')) as {
						bookPath?: string
						annotations?: unknown[]
						lastLocation?: { fraction?: number }
					}
					if (typeof data?.bookPath === 'string') {
						map.set(data.bookPath, {
							annotations: Array.isArray(data.annotations) ? data.annotations.length : 0,
							fraction: data.lastLocation?.fraction,
						})
					}
				} catch {
					// 跳过损坏文件
				}
			}
		} catch {
			// 目录不存在
		}
		return map
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
			id: 'generate-note',
			name: '生成 / 更新阅读笔记',
			checkCallback: checking => this.withAnyReader(checking, v => this.generateNoteFor(v)),
		})
		this.addCommand({
			id: 'backup-data',
			name: '备份批注数据到库内',
			callback: () => void this.exportDataBackup(),
		})
	}

	// ------------------------------------------------------------------
	// 笔记生成
	// ------------------------------------------------------------------

	async generateNoteFor(view: ReaderView | PdfView): Promise<void> {
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
			this.app.workspace.revealLeaf(openLeaf)
			return
		}
		const leaf = this.app.workspace.getLeaf('split')
		await leaf.openFile(target)
	}

	/** 读取模板并把批注数据渲染成完整笔记 Markdown（含 frontmatter 与标记区） */
	async #composeNoteMarkdown(data: BookData, existing: string | null, announce: boolean): Promise<string> {
		const tplPath = normalizePath(this.settings.noteTemplatePath?.trim() || DEFAULT_TEMPLATE_PATH)
		let template: string | null = null
		const tplFile = this.app.vault.getAbstractFileByPath(tplPath)
		if (tplFile instanceof TFile) template = await this.app.vault.read(tplFile)
		if (template) {
			try {
				renderNoteTemplate(template, buildTemplateContext(data, bookIdFor(data.bookPath)))
			} catch (e) {
				console.error('[Grove Reader] 笔记模板解析失败', e)
				if (announce) new Notice('Grove Reader：笔记模板解析失败，本次使用默认模板')
				template = null
			}
		}
		return buildNote(data, bookIdFor(data.bookPath), existing, template)
	}

	private noteRefreshTimer: number | null = null

	/** 批注/元数据变更后防抖刷新已存在的笔记（不新建、不弹 Notice、不跳转） */
	scheduleNoteRefresh(view: ReaderView | PdfView): void {
		if (!this.settings.autoUpdateNote) return
		if (this.noteRefreshTimer != null) window.clearTimeout(this.noteRefreshTimer)
		this.noteRefreshTimer = window.setTimeout(() => {
			this.noteRefreshTimer = null
			void this.#autoRefreshNote(view)
		}, 1500)
	}

	async #autoRefreshNote(view: ReaderView | PdfView): Promise<void> {
		const data = view.snapshot()
		if (!data?.notePath) return
		const file = this.app.vault.getAbstractFileByPath(data.notePath)
		if (!(file instanceof TFile)) return
		try {
			const existing = await this.app.vault.read(file)
			const markdown = await this.#composeNoteMarkdown(data, existing, false)
			if (markdown !== existing) await this.app.vault.modify(file, markdown)
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
			if (v instanceof PdfView && v.bookPath === bookPath) {
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
		const tplPath = normalizePath(this.settings.noteTemplatePath?.trim() || DEFAULT_TEMPLATE_PATH)
		let f = this.app.vault.getAbstractFileByPath(tplPath)
		if (!(f instanceof TFile)) {
			await this.ensureFolderOf(tplPath)
			f = await this.app.vault.create(tplPath, DEFAULT_NOTE_TEMPLATE)
			new Notice('Grove Reader：已创建笔记模板文件，可直接编辑')
		}
		if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f)
	}

	/** 生成（如缺失）并打开使用指南 */
	async openUsageDoc(): Promise<void> {
		const folder = normalizePath(this.settings.notesFolder?.trim() || '阅读笔记')
		if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder)
		const path = normalizePath(`${folder}/${USAGE_DOC_NAME}`)
		let f = this.app.vault.getAbstractFileByPath(path)
		if (!(f instanceof TFile)) f = await this.app.vault.create(path, usageDocMarkdown())
		if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f)
	}

	/**
	 * 把全部批注/书架数据导出到库内普通文件夹（随库同步，删除/重装插件都不受影响）。
	 * 批注 JSON 的权威副本仍在插件 data/ 下；这里是可带走的保险副本，防插件目录被误删。
	 * 设置了 backupTargetDir 时额外复制一份过去（同盘备份防不了磁盘故障）。
	 */
	async exportDataBackup(): Promise<void> {
		if (!this.vaultBase) {
			new Notice('Grove Reader：无法定位库目录，备份失败')
			return
		}
		// 刷盘挂起的写入，保证导出的是最新状态
		this.shelfCache.saveNow()
		this.lists.saveNow()
		const root = pathModule.join(this.vaultBase, BACKUP_FOLDER_NAME)
		try {
			// 只清我们自己的文件，不动用户可能放进该文件夹的其他内容
			const prune = async (dir: string, filter: (name: string) => boolean): Promise<void> => {
				let names: string[] = []
				try {
					names = await fsp.readdir(dir)
				} catch {
					return // 目录不存在
				}
				for (const name of names) {
					if (!filter(name)) continue
					await fsp.rm(pathModule.join(dir, name), { force: true, recursive: true }).catch(() => { })
				}
			}
			await prune(pathModule.join(root, 'books'), name => name.endsWith('.json'))
			await prune(pathModule.join(root, 'covers'), () => true)
			for (const name of ['shelf.json', 'lists.json', 'data.json']) {
				await fsp.rm(pathModule.join(root, name), { force: true }).catch(() => { })
			}

			let bookCount = 0
			const booksDir = pathModule.join(this.dataRoot, 'data', 'books')
			await fsp.mkdir(pathModule.join(root, 'books'), { recursive: true })
			let bookNames: string[] = []
			try {
				bookNames = await fsp.readdir(booksDir)
			} catch {
				// 尚无任何批注数据
			}
			for (const name of bookNames) {
				if (!name.endsWith('.json')) continue
				await fsp.copyFile(pathModule.join(booksDir, name), pathModule.join(root, 'books', name))
				bookCount++
			}
			for (const [src, dst] of [
				[pathModule.join(this.dataRoot, 'data', 'shelf.json'), 'shelf.json'],
				[pathModule.join(this.dataRoot, 'data', 'lists.json'), 'lists.json'],
				[pathModule.join(this.dataRoot, 'data.json'), 'data.json'],
			] as const) {
				await fsp.copyFile(src, pathModule.join(root, dst)).catch(() => { })
			}
			const coversDir = pathModule.join(this.dataRoot, 'data', 'covers')
			try {
				const covers = await fsp.readdir(coversDir)
				await fsp.mkdir(pathModule.join(root, 'covers'), { recursive: true })
				for (const name of covers) {
					await fsp.copyFile(pathModule.join(coversDir, name), pathModule.join(root, 'covers', name))
				}
			} catch {
				// 尚无封面
			}
			const guide = [
				'本文件夹由 Grove Reader 的「备份批注数据到库内」命令生成，是批注数据的保险副本。',
				'它是普通库内文件：随库同步、随笔记一起备份，删除/重装插件都不受影响。',
				'',
				'恢复方法：',
				'1. 关闭 Obsidian；',
				'2. 把 books/、shelf.json、lists.json、covers/ 放回 <库>/.obsidian/plugins/grove-reader/data/；',
				'3. 把 data.json 放回 <库>/.obsidian/plugins/grove-reader/（插件根目录）；',
				'4. 重新打开 Obsidian。',
				'',
				`最近备份时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
			].join('\n')
			await fsp.writeFile(pathModule.join(root, '说明.md'), guide, 'utf-8')

			let extra = ''
			const target = this.settings.backupTargetDir?.trim()
			if (target) {
				try {
					await copyDirAsync(root, pathModule.join(target, BACKUP_FOLDER_NAME))
					extra = `，并已复制一份到 ${target}`
				} catch (e) {
					console.error('[Grove Reader] 复制备份到额外位置失败', e)
					extra = `（额外位置 ${target} 复制失败，库内备份已完成；请检查路径/磁盘是否可用）`
				}
			}
			new Notice(`Grove Reader：已备份 ${bookCount} 本书的批注数据到库内「${BACKUP_FOLDER_NAME}」${extra}`)
		} catch (e) {
			console.error('[Grove Reader] 备份批注数据失败', e)
			new Notice(`Grove Reader：备份失败（${e instanceof Error ? e.message : String(e)}）`)
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
		if (!Array.isArray(this.settings.scanFolders)) {
			// 首次使用：默认扫描库内的「书籍」文件夹
			this.settings.scanFolders = ['书籍']
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings)
		if (this.store) this.store.maxBackups = this.settings.maxBackups
	}
}

/** 递归复制目录（fs.promises 版，不阻塞 UI 线程），返回复制的文件数 */
async function copyDirAsync(src: string, dst: string): Promise<number> {
	await fsp.mkdir(dst, { recursive: true })
	let n = 0
	for (const name of await fsp.readdir(src)) {
		const s = pathModule.join(src, name)
		const d = pathModule.join(dst, name)
		const st = await fsp.stat(s)
		if (st.isDirectory()) n += await copyDirAsync(s, d)
		else {
			await fsp.copyFile(s, d)
			n++
		}
	}
	return n
}
