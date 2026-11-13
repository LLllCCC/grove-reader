/** 离线词法向量：字符 1/2/3-gram 哈希，纯函数，smoke 可直接测。 */
export const LOCAL_EMBED_DIMS = 256

function localHash(value: number): number {
	let h = 0x811c9dc5
	const n = Math.abs(value | 0)
	for (let i = 0; i < 4; i++) {
		h ^= (n >> (i * 8)) & 0xff
		h = Math.imul(h, 0x01000193) >>> 0
	}
	return h % LOCAL_EMBED_DIMS
}

export function localVector(text: string): Float32Array {
	const s = String(text ?? '').toLowerCase().replace(/\s+/g, '')
	const v = new Float32Array(LOCAL_EMBED_DIMS)
	for (const ch of s) v[localHash(ch.charCodeAt(0))] += 0.6
	for (let i = 0; i + 1 < s.length; i++) {
		const code = (s.charCodeAt(i) << 16) | s.charCodeAt(i + 1)
		v[localHash(code)] += 1
	}
	for (let i = 0; i + 2 < s.length; i++) {
		const code = (s.charCodeAt(i) << 16) ^ (s.charCodeAt(i + 1) << 8) ^ s.charCodeAt(i + 2)
		v[localHash(code)] += 0.8
	}
	return v
}
