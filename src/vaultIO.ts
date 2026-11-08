import { DataAdapter, normalizePath } from 'obsidian'
import { FileStat, PlatformIO } from './platformIO'

/** 移动端：所有路径都必须是库内相对路径 */
export class VaultIO implements PlatformIO {
	readonly kind = 'mobile' as const

	constructor(private adapter: DataAdapter) {}

	private p(path: string): string {
		return normalizePath(path)
	}

	async exists(path: string): Promise<boolean> {
		return this.adapter.exists(this.p(path))
	}

	read(path: string): Promise<string> {
		return this.adapter.read(this.p(path))
	}

	readBinary(path: string): Promise<ArrayBuffer> {
		return this.adapter.readBinary(this.p(path))
	}

	write(path: string, data: string): Promise<void> {
		return this.adapter.write(this.p(path), data)
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		await this.adapter.writeBinary(this.p(path), data)
	}

	async mkdir(path: string): Promise<void> {
		await this.adapter.mkdir(this.p(path))
	}

	async remove(path: string): Promise<void> {
		if (await this.adapter.exists(this.p(path))) await this.adapter.remove(this.p(path))
	}

	async removeDir(path: string): Promise<void> {
		if (await this.adapter.exists(this.p(path))) await this.adapter.rmdir(this.p(path), true)
	}

	async rename(from: string, to: string): Promise<void> {
		await this.adapter.rename(this.p(from), this.p(to))
	}

	async copy(from: string, to: string): Promise<void> {
		// 旧版本 adapter 没有 copy，统一用二进制读写兜底
		const data = await this.adapter.readBinary(this.p(from))
		await this.adapter.writeBinary(this.p(to), data)
	}

	async append(path: string, data: string): Promise<void> {
		await this.adapter.append(this.p(path), data)
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const r = await this.adapter.list(this.p(path))
		return { files: r.files, folders: r.folders }
	}

	async stat(path: string): Promise<FileStat | null> {
		const s = await this.adapter.stat(this.p(path))
		if (!s) return null
		return { type: s.type === 'folder' ? 'folder' : 'file', mtime: s.mtime, size: s.size }
	}
}

/** 测试或特殊场景：直接用给定的 adapter 创建移动端实现 */
export function createVaultIO(adapter: DataAdapter): PlatformIO {
	return new VaultIO(adapter)
}
