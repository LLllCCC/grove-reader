import { baseName, joinPath, PlatformIO, readJsonFile, writeJsonFile } from './platformIO'

/**
 * 备份导出与数据迁移（跨平台版）。
 *
 * 全部走 PlatformIO：桌面端传绝对路径、手机端传库内相对路径，同一套逻辑。
 * 手机端因此也能把批注数据导出到库内普通文件夹（随库同步、重装插件不影响）。
 *
 * 备份的是**用户内容**，不含凭据：data.json 里的 AI Key 会被剥掉再写。
 * 这个备份文件夹是普通库内文件，用户会把它连同库一起同步、发给别人看、
 * 或者传到网盘——把 Key 顺手带出去，是这份备份最容易造成的实际损失。
 */

const MARKER = '.grove-backup'
const CLASH_NAMES = ['books', 'covers', 'shelf.json', 'lists.json', 'data.json', 'oplog.json']

/** 备份里必须剥掉的设置字段：值是凭据，一旦随备份流出就得换 Key */
export const SECRET_SETTING_KEYS = ['aiApiKey'] as const

export interface BackupInput {
	io: PlatformIO
	/** 备份目录（桌面为库内绝对路径，手机为库内相对路径） */
	root: string
	dataRoot: string
	pluginDir: string
	/** 额外复制一份的目标目录；只有桌面端会用到（可指向库外磁盘） */
	target?: string
}

export interface BackupResult {
	status: 'done' | 'blocked'
	bookCount: number
	extra: string
}

function norm(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 复制设置，但剥掉凭据字段。
 *
 * 解析失败（用户手改坏了 data.json）时**不写**：少一份设置，比写一份空设置好——
 * 空设置会把笔记模板、数据目录、书架显示项一起清掉，比没恢复更糟。
 */
async function copySettingsWithoutSecrets(io: PlatformIO, src: string, dst: string): Promise<void> {
	try {
		if (!(await io.exists(src))) return
	} catch {
		return
	}
	const parsed = await readJsonFile<Record<string, unknown>>(io, src)
	// 读不出来/解析失败就不写：少一份设置副本，好过写一份空设置把用户的
	// 模板、数据目录、书架显示项一起清掉
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
	for (const key of SECRET_SETTING_KEYS) delete parsed[key]
	try {
		await writeJsonFile(io, dst, parsed)
	} catch {
		// 设置副本写失败不影响批注数据的备份
	}
}

async function listNames(io: PlatformIO, dir: string): Promise<string[]> {
	try {
		const listed = await io.list(dir)
		return [...listed.files, ...listed.folders].map(p => baseName(p))
	} catch {
		return []
	}
}

async function copyDir(io: PlatformIO, from: string, to: string): Promise<number> {
	let files = 0
	await io.mkdir(to)
	let listed: { files: string[]; folders: string[] }
	try {
		listed = await io.list(from)
	} catch {
		return 0
	}
	for (const f of listed.files) {
		await io.copy(f, joinPath(to, baseName(f)))
		files++
	}
	for (const d of listed.folders) {
		files += await copyDir(io, d, joinPath(to, baseName(d)))
	}
	return files
}

async function countJson(io: PlatformIO, dir: string): Promise<number> {
	try {
		const listed = await io.list(dir)
		return listed.files.filter(f => f.endsWith('.json')).length
	} catch {
		return 0
	}
}

export async function exportDataBackup(input: BackupInput): Promise<BackupResult> {
	const { io, root, dataRoot, pluginDir, target } = input
	// 目标目录若不是我们建的（没有标记文件，且已存在同名数据文件），直接中止，
	// 避免用户把备份路径指到已有笔记文件夹时被 prune 误删
	if (!(await io.exists(joinPath(root, MARKER)))) {
		const entries = await listNames(io, root)
		let legacy = false
		try {
			legacy = (await io.read(joinPath(root, '说明.md'))).includes('由 Grove Reader')
		} catch {
			legacy = false
		}
		const clash = entries.some(n => CLASH_NAMES.includes(n))
		if (clash && !legacy) return { status: 'blocked', bookCount: 0, extra: '' }
		await io.mkdir(root)
		await io.write(joinPath(root, MARKER), 'Grove Reader 备份目录标记：存在此文件时才会覆盖写入。\n')
	}

	// 只清我们自己的文件，不动用户可能放进该文件夹的其他内容
	const prune = async (dir: string, filter: (name: string) => boolean): Promise<void> => {
		for (const name of await listNames(io, dir)) {
			if (!filter(name)) continue
			try {
				const full = joinPath(dir, name)
				const st = await io.stat(full)
				if (st?.type === 'folder') await io.removeDir(full)
				else await io.remove(full)
			} catch {
				// 忽略单项失败
			}
		}
	}
	await prune(joinPath(root, 'books'), name => name.endsWith('.json'))
	await prune(joinPath(root, 'covers'), () => true)
	for (const name of ['shelf.json', 'lists.json', 'data.json', 'oplog.json']) {
		try {
			await io.remove(joinPath(root, name))
		} catch {
			// 不存在
		}
	}

	let bookCount = 0
	const booksDir = joinPath(dataRoot, 'data', 'books')
	await io.mkdir(joinPath(root, 'books'))
	let bookFiles: string[] = []
	try {
		bookFiles = (await io.list(booksDir)).files
	} catch {
		bookFiles = []
	}
	for (const full of bookFiles) {
		if (!full.endsWith('.json')) continue
		await io.copy(full, joinPath(root, 'books', baseName(full)))
		bookCount++
	}

	for (const [src, dst] of [
		[joinPath(dataRoot, 'data', 'shelf.json'), 'shelf.json'],
		[joinPath(dataRoot, 'data', 'lists.json'), 'lists.json'],
		[joinPath(dataRoot, 'data', 'oplog.json'), 'oplog.json'],
	] as const) {
		try {
			if (await io.exists(src)) await io.copy(src, joinPath(root, dst))
		} catch {
			// 单项缺失不影响整体备份
		}
	}

	// data.json 单独处理：设置要带走，AI Key 必须留下（见文件头）
	await copySettingsWithoutSecrets(io, joinPath(pluginDir, 'data.json'), joinPath(root, 'data.json'))

	const coversDir = joinPath(dataRoot, 'data', 'covers')
	try {
		const covers = (await io.list(coversDir)).files
		await io.mkdir(joinPath(root, 'covers'))
		for (const full of covers) await io.copy(full, joinPath(root, 'covers', baseName(full)))
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
		'注意：data.json 里的 AI Key（aiApiKey）已在备份时剔除，恢复后需要在',
		'设置 → 阅读与笔记 → AI 解释 里重新填一次。这样备份文件夹可以放心同步、外发。',
		'',
		`最近备份时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
	].join('\n')
	await io.write(joinPath(root, '说明.md'), guide)

	let extra = ''
	if (target) {
		try {
			await copyDir(io, root, joinPath(target, baseName(root)))
			extra = `，并已复制一份到 ${target}`
		} catch (e) {
			console.error('[Grove Reader] 复制备份到额外位置失败', e)
			extra = `（额外位置 ${target} 复制失败，库内备份已完成；请检查路径/磁盘是否可用）`
		}
	}
	return { status: 'done', bookCount, extra }
}

export interface MigrateCheck {
	ok: boolean
	message?: string
	source?: string
	target?: string
}

/** 迁移前检查：目标必须是空目录、不能是自身或子目录 */
export async function checkMigrateTarget(io: PlatformIO, sourceRoot: string, targetRoot: string): Promise<MigrateCheck> {
	const source = joinPath(sourceRoot, 'data')
	const target = joinPath(targetRoot, 'data')
	if (norm(sourceRoot) === norm(targetRoot)) return { ok: false, message: '目标就是当前数据文件夹' }
	if (!(await io.exists(source))) return { ok: false, message: '当前数据文件夹里没有 data/，无法迁移' }
	const src = norm(source)
	const dst = norm(target)
	if (dst.startsWith(`${src}/`) || src.startsWith(`${dst}/`)) return { ok: false, message: '不能迁移到自身或子目录' }
	if (await io.exists(target)) {
		const names = await listNames(io, target)
		if (names.length > 0) return { ok: false, message: '目标已有数据，请换一个空文件夹' }
	}
	return { ok: true, source, target }
}

/** 复制 data/ 到目标并校验批注份数；不删旧数据 */
export async function migrateDataFolder(
	io: PlatformIO,
	sourceRoot: string,
	targetRoot: string,
): Promise<{ files: number; books: number }> {
	const source = joinPath(sourceRoot, 'data')
	const target = joinPath(targetRoot, 'data')
	const files = await copyDir(io, source, target)
	const srcBooks = await countJson(io, joinPath(source, 'books'))
	const dstBooks = await countJson(io, joinPath(target, 'books'))
	if (srcBooks !== dstBooks) throw new Error(`校验失败：源 ${srcBooks} 份批注，目标 ${dstBooks} 份`)
	return { files, books: dstBooks }
}
