/**
 * 只有桌面端才可能做的文件操作：库外绝对路径读取、库内备份导出、数据目录迁移、
 * 启动时按磁盘实际情况接管迁移后的书库目录。
 *
 * 这个模块 import node:fs / node:path，**只能**通过 `await import('./desktopFs')`
 * 在桌面分支里加载；否则移动端 require('node:fs') 会直接崩掉。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import pathModule from 'node:path'
import { LEGACY_LIBRARY_ROOT, LIBRARY_ROOT, isShelfExt } from './types'
import { isAbsolutePath } from './util'
import { t } from './i18n'

/** 库外（或库内但没进 Obsidian 索引）的绝对路径：同步判断存在性 */
export function pathExists(absPath: string): boolean {
	try {
		return fs.existsSync(absPath)
	} catch {
		return false
	}
}

/** 按绝对路径读文件字节（readBookBytes 的库外兜底） */
export function readBytes(absPath: string): ArrayBuffer {
	const buf = fs.readFileSync(absPath)
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export interface AdoptInput {
	vaultBase: string
	settings: {
		dataFolder?: string
		scanFolders?: string[]
		notesFolder?: string
	}
}

/**
 * 书库被整体迁到 <库>/Grove Reader/ 后，若设置里仍是旧路径（例如迁移时旧实例
 * 又把 data.json 写回去了），按磁盘实际情况自动接管，避免书架空白。
 * 返回是否改动了 settings（调用方负责保存与日志）。
 */
export function adoptMigratedFolders({ vaultBase, settings }: AdoptInput): boolean {
	if (!vaultBase) return false
	const root = pathModule.join(vaultBase, LIBRARY_ROOT)
	const dataOk = fs.existsSync(pathModule.join(root, 'data', 'shelf.json'))
	const booksDir = pathModule.join(root, t('书籍'))
	const notesDir = pathModule.join(root, '阅读笔记')
	const hasBooks = (dir: string): boolean => {
		try {
			return fs.readdirSync(dir).some(n => isShelfExt(pathModule.extname(n).slice(1)))
		} catch {
			return false
		}
	}
	if (!dataOk && !hasBooks(booksDir) && !fs.existsSync(notesDir)) return false

	let changed = false
	const configuredData = settings.dataFolder?.trim() ?? ''
	const hasBookJson = (folder: string): boolean => {
		try {
			return fs.readdirSync(pathModule.join(folder, 'data', 'books')).some(n => n.endsWith('.json'))
		} catch {
			return false
		}
	}
	// 配置的数据目录必须真的指向存在的书，否则视为迁移后的旧路径
	const configuredDataOk = ((): boolean => {
		if (!configuredData) return false
		try {
			const shelf = JSON.parse(fs.readFileSync(pathModule.join(vaultBase, configuredData, 'data', 'shelf.json'), 'utf-8')) as { entries?: Record<string, unknown> }
			return Object.keys(shelf.entries ?? {}).some(k => fs.existsSync(pathModule.join(vaultBase, k)))
		} catch {
			return false
		}
	})()
	// 旧目录可能被旧实例重建出 shelf.json（但没有 books/*.json），此时以有批注数据的目录为准；
	// 但用户主动设置的其他自定义目录要尊重，只有空值或旧目录名才自动纠正
	const canonicalHasData = hasBookJson(root)
	const configuredHasData = configuredData ? hasBookJson(pathModule.join(vaultBase, configuredData)) : false
	const configuredIsLegacy = !configuredData || configuredData === LEGACY_LIBRARY_ROOT || configuredData === LIBRARY_ROOT
	if (dataOk && (!configuredDataOk || (configuredIsLegacy && canonicalHasData && !configuredHasData))) {
		settings.dataFolder = LIBRARY_ROOT
		changed = true
	}
	const foldersOk = (settings.scanFolders ?? []).some(f => hasBooks(isAbsolutePath(f) ? f : pathModule.join(vaultBase, f)))
	if (hasBooks(booksDir) && !foldersOk) {
		settings.scanFolders = [`${LIBRARY_ROOT}/书籍`]
		changed = true
	}
	const notesAbs = settings.notesFolder
		? pathModule.join(vaultBase, settings.notesFolder)
		: ''
	if (fs.existsSync(notesDir) && (!notesAbs || !fs.existsSync(notesAbs))) {
		settings.notesFolder = `${LIBRARY_ROOT}/阅读笔记`
		changed = true
	}
	return changed
}

export interface BackupInput {
	vaultBase: string
	dataRoot: string
	pluginDir: string
	/** 库内备份文件夹（相对路径） */
	rel: string
	/** 可选的库外额外备份目录 */
	target?: string
}

export type BackupResult =
	| { status: 'done'; bookCount: number; extra: string }
	| { status: 'blocked' }

/**
 * 把全部批注/书架数据导出到库内普通文件夹（随库同步，删除/重装插件都不受影响）。
 * 批注 JSON 的权威副本仍在插件 data/ 下；这里是可带走的保险副本，防插件目录被误删。
 * 设置了 target 时额外复制一份过去（同盘备份防不了磁盘故障）。
 */
export async function exportDataBackup(input: BackupInput): Promise<BackupResult> {
	const { vaultBase, dataRoot, pluginDir, rel, target } = input
	const root = pathModule.join(vaultBase, rel)
	// 目标目录若不是我们建的（没有标记文件，且已存在同名数据文件），
	// 直接中止——避免用户把备份路径指到已有笔记文件夹时被 prune 误删
	const marker = pathModule.join(root, '.grove-backup')
	const hasMarker = await fsp.access(marker).then(() => true).catch(() => false)
	if (!hasMarker) {
		let entries: string[] = []
		try {
			entries = await fsp.readdir(root)
		} catch {
			entries = []
		}
		let legacy = false
		try {
			legacy = (await fsp.readFile(pathModule.join(root, t('说明.md')), 'utf-8')).includes('由 Grove Reader')
		} catch {
			legacy = false
		}
		const clash = entries.some(n => ['books', 'covers', 'shelf.json', 'lists.json', 'data.json', 'oplog.json'].includes(n))
		if (clash && !legacy) return { status: 'blocked' }
		await fsp.mkdir(root, { recursive: true })
		await fsp.writeFile(marker, t('Grove Reader 备份目录标记：存在此文件时才会覆盖写入。\n'), 'utf-8')
	}

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
	for (const name of ['shelf.json', 'lists.json', 'data.json', 'oplog.json']) {
		await fsp.rm(pathModule.join(root, name), { force: true }).catch(() => { })
	}

	let bookCount = 0
	const booksDir = pathModule.join(dataRoot, 'data', 'books')
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
		[pathModule.join(dataRoot, 'data', 'shelf.json'), 'shelf.json'],
		[pathModule.join(dataRoot, 'data', 'lists.json'), 'lists.json'],
		[pathModule.join(dataRoot, 'data', 'oplog.json'), 'oplog.json'],
		[pathModule.join(pluginDir, 'data.json'), 'data.json'],
	] as const) {
		await fsp.copyFile(src, pathModule.join(root, dst)).catch(() => { })
	}
	const coversDir = pathModule.join(dataRoot, 'data', 'covers')
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
		t('本文件夹由 Grove Reader 的「备份批注数据到库内」命令生成，是批注数据的保险副本。'),
		t('它是普通库内文件：随库同步、随笔记一起备份，删除/重装插件都不受影响。'),
		'',
		t('恢复方法：'),
		t('1. 关闭 Obsidian；'),
		t('2. 把 books/、shelf.json、lists.json、covers/ 放回 <库>/.obsidian/plugins/grove-reader/data/；'),
		t('3. 把 data.json 放回 <库>/.obsidian/plugins/grove-reader/（插件根目录）；'),
		t('4. 重新打开 Obsidian。'),
		'',
		`最近备份时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
	].join('\n')
	await fsp.writeFile(pathModule.join(root, t('说明.md')), guide, 'utf-8')

	let extra = ''
	if (target) {
		try {
			await copyDir(root, pathModule.join(target, rel))
			extra = `，并已复制一份到 ${target}`
		} catch (e) {
			console.error(t('[Grove Reader] 复制备份到额外位置失败'), e)
			extra = `（额外位置 ${target} 复制失败，库内备份已完成；请检查路径/磁盘是否可用）`
		}
	}
	return { status: 'done', bookCount, extra }
}

export interface MigrateInput {
	vaultBase: string
	sourceRoot: string
	/** 校验过的库内相对文件夹 */
	folder: string
}

export type MigrateCheck = { ok: true; source: string; target: string } | { ok: false; message: string }

/** 迁移前置校验：目标是否合法、是否已存在数据；返回绝对路径供确认框展示 */
export function checkMigrateTarget({ vaultBase, sourceRoot, folder }: MigrateInput): MigrateCheck {
	const targetRoot = pathModule.join(vaultBase, folder)
	const source = pathModule.join(sourceRoot, 'data')
	const target = pathModule.join(targetRoot, 'data')
	if (pathModule.resolve(sourceRoot) === pathModule.resolve(targetRoot)) {
		return { ok: false, message: t('目标就是当前数据文件夹') }
	}
	if (!fs.existsSync(source)) {
		return { ok: false, message: t('当前数据文件夹里没有 data/，无法迁移') }
	}
	const srcAbs = pathModule.resolve(source)
	const dstAbs = pathModule.resolve(target)
	if (dstAbs.startsWith(srcAbs + pathModule.sep) || srcAbs.startsWith(dstAbs + pathModule.sep)) {
		return { ok: false, message: t('不能迁移到自身或子目录') }
	}
	if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
		return { ok: false, message: t('目标已有数据，请换一个空文件夹') }
	}
	return { ok: true, source, target }
}

export type MigrateResult = { ok: true; files: number; books: number; source: string; target: string }

/** 复制 data/ 到新的库内目录；不删旧数据，重启后生效。失败时抛错，由调用方提示 */
export async function migrateDataFolder({ vaultBase, sourceRoot, folder }: MigrateInput): Promise<MigrateResult> {
	const targetRoot = pathModule.join(vaultBase, folder)
	const source = pathModule.join(sourceRoot, 'data')
	const target = pathModule.join(targetRoot, 'data')
	const files = await copyDir(source, target)
	const srcBooks = countJson(pathModule.join(source, 'books'))
	const dstBooks = countJson(pathModule.join(target, 'books'))
	if (srcBooks !== dstBooks) {
		throw new Error(`校验失败：源 ${srcBooks} 份批注，目标 ${dstBooks} 份`)
	}
	return { ok: true, files, books: dstBooks, source, target }
}

export type BackupMoveStatus = 'skipped' | 'moved' | 'failed'

/**
 * 设置里改了库内备份文件夹后，把旧文件夹的内容转移到新路径
 * （同名覆盖，旧文件夹清空后删除）。
 */
export async function moveBackupFolder(input: { vaultBase: string; from: string; to: string }): Promise<{ status: BackupMoveStatus; error?: string }> {
	const src = pathModule.join(input.vaultBase, input.from)
	const dst = pathModule.join(input.vaultBase, input.to)
	if (src === dst) return { status: 'skipped' }
	try {
		await fsp.access(src)
	} catch {
		return { status: 'skipped' } // 旧文件夹还没生成过备份，无需转移
	}
	try {
		await fsp.mkdir(pathModule.dirname(dst), { recursive: true })
		try {
			await fsp.access(dst)
			// 新路径已存在：逐条合并，同名以旧文件夹里的为准（都是可再生的备份）
			for (const name of await fsp.readdir(src)) {
				await fsp.rm(pathModule.join(dst, name), { force: true, recursive: true }).catch(() => { })
				await fsp.rename(pathModule.join(src, name), pathModule.join(dst, name))
			}
		} catch {
			await fsp.rename(src, dst)
		}
		await fsp.rmdir(src).catch(() => { }) // 只在旧文件夹已空时才删得掉
		return { status: 'moved' }
	} catch (e) {
		console.error(t('[Grove Reader] 转移备份文件夹失败'), e)
		return { status: 'failed', error: e instanceof Error ? e.message : String(e) }
	}
}

/** 递归复制目录（fs.promises 版，不阻塞 UI 线程），返回复制的文件数 */
export async function copyDir(src: string, dst: string): Promise<number> {
	await fsp.mkdir(dst, { recursive: true })
	let n = 0
	for (const name of await fsp.readdir(src)) {
		const s = pathModule.join(src, name)
		const d = pathModule.join(dst, name)
		const st = await fsp.stat(s)
		if (st.isDirectory()) n += await copyDir(s, d)
		else {
			await fsp.copyFile(s, d)
			n++
		}
	}
	return n
}

export function countJson(dir: string): number {
	try {
		return fs.readdirSync(dir).filter(name => name.endsWith('.json')).length
	} catch {
		return 0
	}
}
