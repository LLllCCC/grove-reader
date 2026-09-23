import base64

objs = [
	b"<< /Type /Catalog /Pages 2 0 R >>",
	b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
	b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
]
stream = b"BT /F1 20 Tf 20 120 Td (Hello Grove Reader PDF 123) Tj ET"
objs.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

out = b"%PDF-1.4\n"
offsets = []
for i, body in enumerate(objs, start=1):
	offsets.append(len(out))
	out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
xref = len(out)
out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
for off in offsets:
	out += f"{off:010d} 00000 n \n".encode()
out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()

b64 = base64.b64encode(out).decode()
script = """const log = (...m) => { document.getElementById('log').textContent += m.join(' ') + String.fromCharCode(10) }
console.error = (...a) => { log('[console.error]', ...a) }
try {
	const workerMod = await import('./pdf.worker.min.mjs')
	globalThis.pdfjsWorker = workerMod
	const pdfjs = await import('./pdf.min.mjs')
	const b64 = "@@B64@@"
	const bin = atob(b64)
	const data = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
	const doc = await pdfjs.getDocument({ data }).promise
	log('pages:', doc.numPages)
	const page = await doc.getPage(1)
	const vp = page.getViewport({ scale: 2 })
	const canvas = document.getElementById('c')
	canvas.width = Math.floor(vp.width)
	canvas.height = Math.floor(vp.height)
	const ctx = canvas.getContext('2d')
	await page.render({ canvasContext: ctx, viewport: vp }).promise
	log('render done')
	const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
	let dark = 0
	for (let i = 0; i < d.length; i += 4) {
		if (d[i] < 200) dark++
	}
	log('dark px:', dark)
	try {
		const div = document.createElement('div')
		div.style.position = 'relative'
		div.style.setProperty('--total-scale-factor', '2')
		document.body.append(div)
		const tl = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: div, viewport: vp })
		await tl.render()
		log('textlayer spans:', div.querySelectorAll('span').length)
	} catch (e) {
		log('textlayer FAILED:', e && e.message ? e.message : String(e))
	}
	log('SPIKE-OK')
} catch (e) {
	log('FATAL:', e && e.message ? e.message : String(e), e && e.stack ? e.stack : '')
	log('SPIKE-FAIL')
}"""
script = script.replace("@@B64@@", b64)

html = (
	'<!doctype html>\n<html><head><meta charset="utf-8">'
	'<style>body{background:#555}canvas{border:1px solid #888}</style></head>\n'
	'<body><pre id="log"></pre><canvas id="c"></canvas>\n'
	'<script type="module">\n' + script + '\n</script>\n</body></html>\n'
)
with open('scripts/pdf-spike-web/tiny.html', 'w', encoding='utf-8') as f:
	f.write(html)
print('tiny.html regenerated, pdf bytes:', len(out))
