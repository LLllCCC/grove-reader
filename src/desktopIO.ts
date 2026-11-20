import { promises as fsp } from 'node:fs'
import { FileStat, PlatformIO } from './platformIO'

/** 桌面端实现：Node fs，保持原有权限、原子重命名与目录递归删除语义 */
export class DesktopIO implements PlatformIO {
	readonly kind = 'desktop' as const

	async exists(path: string): Promise<boolean> {
		try {
			await fsp.access(path)
			return true
		} catch {
			return false
		}
	}

	read(path: string): Promise<string> {
		return fsp.readFile(path, 'utf-8')
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const buf = await fsp.readFile(path)
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
	}

	write(path: string, data: string): Promise<void> {
		return fsp.writeFile(path, data, 'utf-8')
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		await fsp.writeFile(path, Buffer.from(data))
	}

	async mkdir(path: string): Promise<void> {
		await fsp.mkdir(path, { recursive: true })
	}

	async remove(path: string): Promise<void> {
		await fsp.rm(path, { force: true })
	}

	async removeDir(path: string): Promise<void> {
		await fsp.rm(path, { recursive: true, force: true })
	}

	rename(from: string, to: string): Promise<void> {
		return fsp.rename(from, to)
	}

	copy(from: string, to: string): Promise<void> {
		return fsp.copyFile(from, to)
	}

	async append(path: string, data: string): Promise<void> {
		await fsp.appendFile(path, data, 'utf-8')
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const entries = await fsp.readdir(path, { withFileTypes: true })
		const files: string[] = []
		const folders: string[] = []
		for (const e of entries) {
			const full = `${path}/${e.name}`
			if (e.isDirectory()) folders.push(full)
			else files.push(full)
		}
		return { files, folders }
	}

	async stat(path: string): Promise<FileStat | null> {
		try {
			const s = await fsp.stat(path)
			return { type: s.isDirectory() ? 'folder' : 'file', mtime: s.mtimeMs, size: s.size }
		} catch {
			return null
		}
	}
}
