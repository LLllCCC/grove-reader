import fs from 'node:fs'
import pathModule from 'node:path'

const MAX_BYTES = 512 * 1024

/**
 * 调试日志：默认关闭。开启后把关键事件追加到 data/debug.log，
 * 单文件超过 512KB 时轮转为 debug.log.1（只保留一份旧文件）。
 * 只记路径、数量、错误，不记批注正文，避免把阅读内容写进日志。
 */
export class DebugLog {
	private file: string
	private enabled: boolean

	constructor(rootDir: string, enabled: boolean) {
		this.file = pathModule.join(rootDir, 'data', 'debug.log')
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
		try {
			fs.mkdirSync(pathModule.dirname(this.file), { recursive: true })
			this.#rotateIfNeeded()
			const suffix = data === undefined ? '' : ` ${stringify(data)}`
			fs.appendFileSync(this.file, `[${new Date().toISOString()}] [${category}] ${message}${suffix}\n`, 'utf-8')
		} catch (e) {
			console.error('[Grove Reader] 调试日志写入失败', e)
		}
	}

	clear(): void {
		try {
			fs.rmSync(this.file, { force: true })
			fs.rmSync(`${this.file}.1`, { force: true })
		} catch {
			// 文件不存在是常态
		}
	}

	#rotateIfNeeded(): void {
		try {
			const stat = fs.statSync(this.file)
			if (stat.size <= MAX_BYTES) return
			const old = `${this.file}.1`
			fs.rmSync(old, { force: true })
			fs.renameSync(this.file, old)
		} catch {
			// 首次写入时文件不存在
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
