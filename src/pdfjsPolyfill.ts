// pdfjs-dist v5 依赖 Map upsert 提案方法（getOrInsertComputed / getOrInsert），
// 旧版 Chromium（部分 Obsidian 版本）尚未内置，这里统一补齐。
// 本模块必须先于 pdfjs 使用被导入。
const mapProto = Map.prototype as unknown as Record<string, unknown>

if (typeof mapProto.getOrInsertComputed !== 'function') {
	mapProto.getOrInsertComputed = function (this: Map<unknown, unknown>, key: unknown, callback: (key: unknown) => unknown): unknown {
		if (this.has(key)) return this.get(key)
		const value = callback(key)
		this.set(key, value)
		return value
	}
}

if (typeof mapProto.getOrInsert !== 'function') {
	mapProto.getOrInsert = function (this: Map<unknown, unknown>, key: unknown, value: unknown): unknown {
		if (this.has(key)) return this.get(key)
		this.set(key, value)
		return value
	}
}

const mathRec = Math as unknown as Record<string, unknown>
if (typeof mathRec.sumPrecise !== 'function') {
	mathRec.sumPrecise = function (values: Iterable<number>): number {
		let sum = 0
		for (const v of values) sum += v
		return sum
	}
}

export {}
