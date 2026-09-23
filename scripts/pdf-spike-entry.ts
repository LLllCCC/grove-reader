// 与插件相同的打包形态：esbuild CJS bundle + 主线程 fake worker
import '../src/pdfjsPolyfill'
import * as pdfjsLib from 'pdfjs-dist'
import * as pdfjsWorkerModule from 'pdfjs-dist/build/pdf.worker.mjs'
;(globalThis as unknown as Record<string, unknown>).pdfjsWorker = pdfjsWorkerModule

const log = (...m: unknown[]) => {
	document.getElementById('log')!.textContent += m.map(String).join(' ') + String.fromCharCode(10)
}
console.error = (...a: unknown[]) => log('[console.error]', ...a)

async function run(): Promise<void> {
	const b64 = (document.getElementById('b64') as HTMLElement).textContent!.trim()
	const bin = atob(b64)
	const data = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
	const doc = await pdfjsLib.getDocument({ data }).promise
	log('pages:', doc.numPages)
	const page = await doc.getPage(1)
	const vp = page.getViewport({ scale: 2 })
	const canvas = document.getElementById('c') as HTMLCanvasElement
	canvas.width = Math.floor(vp.width)
	canvas.height = Math.floor(vp.height)
	const ctx = canvas.getContext('2d')!
	await page.render({ canvas, canvasContext: ctx, viewport: vp as never }).promise
	log('render done')
	const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
	let dark = 0
	for (let i = 0; i < d.length; i += 4) if (d[i] < 200) dark++
	log('dark px:', dark)
	log('SPIKE-OK')
}
run().catch(e => {
	log('FATAL:', e instanceof Error ? e.message : String(e))
	log('SPIKE-FAIL')
})
