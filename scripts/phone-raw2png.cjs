// 手机回归工具：把 adb exec-out screencap 的 raw RGBA 截屏缩放成 PNG（用法见 scripts/README 或交接文档）
// 把 Android screencap raw (RGBA) 缩放并编码成 PNG，方便直接看手机屏幕
const fs = require('fs'), zlib = require('zlib')
const [, , inPath, outPath, maxW = '420'] = process.argv
const b = fs.readFileSync(inPath)
const w = b.readUInt32LE(0), h = b.readUInt32LE(4)
const targetW = Math.min(Number(maxW), w)
const scale = targetW / w
const tw = Math.round(w * scale), th = Math.round(h * scale)
const rows = []
for (let y = 0; y < th; y++) {
  const row = Buffer.alloc(1 + tw * 4)
  row[0] = 0
  const sy = Math.min(h - 1, Math.round(y / scale))
  for (let x = 0; x < tw; x++) {
    const sx = Math.min(w - 1, Math.round(x / scale))
    const i = 12 + (sy * w + sx) * 4
    row[1 + x * 4] = b[i]
    row[2 + x * 4] = b[i + 1]
    row[3 + x * 4] = b[i + 2]
    row[4 + x * 4] = 255
  }
  rows.push(row)
}
const raw = Buffer.concat(rows)
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return t
})()
const crc32 = buf => { let c = -1; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(tw, 0); ihdr.writeUInt32BE(th, 4); ihdr[8] = 8; ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
  chunk('IEND', Buffer.alloc(0)),
])
fs.writeFileSync(outPath, png)
console.log('wrote', outPath, tw + 'x' + th, (png.length / 1024).toFixed(0) + 'KB')
// 用法：node scripts/phone-raw2png.cjs in.raw out.png [maxW=420]
