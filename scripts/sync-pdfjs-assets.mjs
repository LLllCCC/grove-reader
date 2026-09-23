// 构建后同步 pdfjs 运行时资源到项目 pdfjs/ 目录：
// - wasm/            JBIG2 / OpenJPEG(JPX) 图像解码（扫描版 PDF 的整页图片必需）
// - standard_fonts/  未内嵌字体的标准 14 字体
// - cmaps/           CJK 等 CID 字符映射
// 安装插件时需把该目录一并拷入 <库>/.obsidian/plugins/grove-reader/pdfjs/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const src = path.join(root, 'node_modules', 'pdfjs-dist')
const dest = path.join(root, 'pdfjs')

// Node v25.2.1 的 fs.cpSync({recursive:true}) 有 bug（只建空目录不拷文件），用显式递归。
function copyDir(s, d) {
	fs.mkdirSync(d, { recursive: true })
	for (const name of fs.readdirSync(s)) {
		const sp = path.join(s, name)
		const dp = path.join(d, name)
		const st = fs.lstatSync(sp)
		if (st.isDirectory()) copyDir(sp, dp)
		else if (st.isFile()) fs.copyFileSync(sp, dp)
	}
}

fs.rmSync(dest, { recursive: true, force: true })
for (const dir of ['wasm', 'standard_fonts', 'cmaps']) {
	copyDir(path.join(src, dir), path.join(dest, dir))
}
console.log('pdfjs 资源已同步到 pdfjs/（wasm、standard_fonts、cmaps）')
