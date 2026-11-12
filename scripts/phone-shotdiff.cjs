// 手机回归工具：比较两张 raw 截屏的内容变化比例（翻页/跳转是否生效）
// raw 截屏差异：抽样比较两帧，输出变化比例
const fs = require('fs')
const [, , aPath, bPath] = process.argv
const a = fs.readFileSync(aPath), b = fs.readFileSync(bPath)
const w = a.readUInt32LE(0), h = a.readUInt32LE(4)
let diff = 0, total = 0
for (let y = 300; y < h - 300; y += 6) {
  for (let x = 40; x < w - 40; x += 6) {
    const i = 12 + (y * w + x) * 4
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    if (d > 40) diff++
    total++
  }
}
console.log(((diff / total) * 100).toFixed(1) + '% changed (' + diff + '/' + total + ')')
// 用法：node scripts/phone-shotdiff.cjs a.raw b.raw
