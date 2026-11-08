/**
 * 跨平台文件访问层。
 *
 * 桌面端用 Node fs（保持原有同步语义与原子写），移动端用 Obsidian 的 vault.adapter
 * （异步、只能访问库内路径）。上层的 BookStore 等模块只依赖这个接口，
 * 不再直接 import node:fs —— 否则移动端加载插件时会因为 require('node:fs') 直接崩掉。
 */
export interface FileStat {
	type: 'file' | 'folder'
	mtime: number
	size: number
}

export interface PlatformIO {
	readonly kind: 'desktop' | 'mobile'
	exists(path: string): Promise<boolean>
	read(path: string): Promise<string>
	readBinary(path: string): Promise<ArrayBuffer>
	write(path: string, data: string): Promise<void>
	writeBinary(path: string, data: ArrayBuffer): Promise<void>
	mkdir(path: string): Promise<void>
	remove(path: string): Promise<void>
	removeDir(path: string): Promise<void>
	rename(from: string, to: string): Promise<void>
	copy(from: string, to: string): Promise<void>
	append(path: string, data: string): Promise<void>
	list(path: string): Promise<{ files: string[]; folders: string[] }>
	stat(path: string): Promise<FileStat | null>
}

/** 读 JSON：文件不存在或解析失败都返回 null，调用方用默认值兜底 */
export async function readJsonFile<T>(io: PlatformIO, path: string): Promise<T | null> {
	try {
		return JSON.parse(await io.read(path)) as T
	} catch {
		return null
	}
}

/** 原子写 JSON：先写 .tmp 再改名，改名失败时降级为直接覆盖 */
export async function writeJsonFile(io: PlatformIO, path: string, data: unknown): Promise<void> {
	const text = JSON.stringify(data)
	const dir = dirName(path)
	if (dir) await io.mkdir(dir)
	const tmp = `${path}.tmp`
	await io.write(tmp, text)
	try {
		await io.rename(tmp, path)
	} catch {
		await io.write(path, text)
		try {
			await io.remove(tmp)
		} catch {
			// ignore
		}
	}
}

/** 用 '/' 拼路径：Node fs 与 vault.adapter 都接受，避免在移动端 import node:path */
export function joinPath(...parts: string[]): string {
	const cleaned = parts
		.filter(p => p !== undefined && p !== null && p !== '')
		.map((p, i) => {
			let s = String(p).replace(/\\/g, '/')
			if (i > 0) s = s.replace(/^\/+/, '')
			if (i < parts.length - 1) s = s.replace(/\/+$/, '')
			return s
		})
	return cleaned.join('/').replace(/\/{2,}/g, '/')
}

export function baseName(path: string): string {
	const parts = path.replace(/\\/g, '/').split('/')
	return parts[parts.length - 1] || path
}

export function dirName(path: string): string {
	const parts = path.replace(/\\/g, '/').split('/')
	parts.pop()
	return parts.join('/')
}

export function stripExt(name: string): string {
	const i = name.lastIndexOf('.')
	return i > 0 ? name.slice(0, i) : name
}
