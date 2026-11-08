import { PlatformIO, joinPath } from './platformIO'

const MAX_BYTES = 512 * 1024

/**
 * 调试日志：默认关闭。开启后把关键事件追加到 data/debug.log，
 * 单文件超过 512KB 时轮转为 debug.log.1（只保留一份旧文件）。
 * 只记路径、数量、错误，不记批注正文，避免把阅读内容写进日志。
 */
export class DebugLog {
	private file: string
	private enabled: boolean
	private queue: Promise<void> = Promise.resolve()
	private rotated = false

	constructor(
		rootDir: string,
		private io: PlatformIO,
		enabled: boolean,
	) {
		this.file = joinPath(rootDir, 'data', 'debug.log')
		this.enabled = enabled
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled
	}

	path(): string {
		return this.file
	}

	write(category: string, message: string, data?: unknown): void {
		if (!this.enabled) return
		const suffix = data === undefined ? '' : ` ${stringify(data)}`
		const line = `[${new Date().toISOString()}] [${category}] ${message}${suffix}\n`
		this.queue = this.queue
			.catch(() => undefined)
			.then(async () => {
				await this.#rotateIfNeeded()
				await this.io.append(this.file, line)
			})
			.catch(e => {
				console.error('[Grove Reader] 调试日志写入失败', e)
			})
	}

	clear(): void {
		this.queue = this.queue
			.catch(() => undefined)
			.then(async () => {
				await this.io.remove(this.file)
				await this.io.remove(`${this.file}.1`)
			})
			.catch(() => {
				// 文件不存在是常态
			})
	}

	async flush(): Promise<void> {
		await this.queue
	}

	async #rotateIfNeeded(): Promise<void> {
		if (this.rotated) return
		const stat = await this.io.stat(this.file)
		if (!stat || stat.size <= MAX_BYTES) return
		try {
			await this.io.remove(`${this.file}.1`)
			await this.io.rename(this.file, `${this.file}.1`)
			this.rotated = true
		} catch {
			// 轮转失败就继续追加，不阻塞记录
		}
	}
}

function stringify(value: unknown): string {
	try {
		const text = typeof value === 'string' ? value : JSON.stringify(value)
		if (!text) return String(value)
		return text.length > 800 ? `${text.slice(0, 800)}…` : text
	} catch {
		return String(value)
	}
}
