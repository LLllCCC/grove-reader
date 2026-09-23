// Spike：验证 pdfjs-dist 主线程 worker 方案 + 真实 PDF 文字层提取
// 注意：Node 缺少浏览器全局（DOMMatrix 等），需先 polyfill 再动态 import；
// Obsidian/Electron 环境自带这些全局，无此问题。
class DOMMatrixStub {
	constructor() {}
	multiply() { return this }
	translate() { return this }
	scale() { return this }
	rotate() { return this }
	skewX() { return this }
	inverse() { return this }
	flipX() { return this }
	flipY() { return this }
	transformPoint() { return { x: 0, y: 0 } }
}
globalThis.DOMMatrix = DOMMatrixStub

const pdfjs = await import('pdfjs-dist')
const worker = await import('pdfjs-dist/build/pdf.worker.mjs')
globalThis.pdfjsWorker = worker
// Map upsert polyfill（与 src/pdfjsPolyfill.ts 同逻辑）
const mapProto = Map.prototype
if (typeof mapProto.getOrInsertComputed !== 'function') { mapProto.getOrInsertComputed = function(k, cb) { if (this.has(k)) return this.get(k); const v = cb(k); this.set(k, v); return v } }
if (typeof mapProto.getOrInsert !== 'function') { mapProto.getOrInsert = function(k, v) { if (this.has(k)) return this.get(k); this.set(k, v); return v } }
if (typeof Math.sumPrecise !== 'function') { Math.sumPrecise = vals => vals.reduce((a, b) => a + b, 0) }
globalThis.DOMMatrix = DOMMatrixStub

import fs from 'node:fs'
const pdfPath = 'D:/iCloudDrive/iCloud~md~obsidian/Obsidian Vault/书籍/[OCR]_大国县治 (杨华) (Z-Library)_20260911_0340.layered.pdf'
const data = new Uint8Array(fs.readFileSync(pdfPath))
const t0 = Date.now()
const doc = await pdfjs.getDocument({ data }).promise
console.log(`打开成功：${doc.numPages} 页，用时 ${Date.now() - t0}ms`)

const meta = await doc.getMetadata()
console.log('标题：', meta.info?.Title || '(无)')

const page = await doc.getPage(1)
const vp = page.getViewport({ scale: 1 })
console.log(`第 1 页尺寸：${Math.round(vp.width)}x${Math.round(vp.height)}`)

const tc = await page.getTextContent()
const text = tc.items.map(i => i.str ?? '').join('')
console.log(`第 1 页文字项：${tc.items.length} 个，样本：「${text.slice(0, 60)}…」`)

const p5 = await (await doc.getPage(5)).getTextContent()
const t5 = p5.items.map(i => i.str ?? '').join('')
console.log(`第 5 页文字长度：${t5.length}，样本：「${t5.slice(0, 50)}…」`)

const outline = await doc.getOutline()
console.log('书签条目：', outline?.length ?? 0)
console.log('SPIKE OK')
