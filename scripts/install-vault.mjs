// 把构建产物部署到 Obsidian 活动库的插件目录。
// 会先读 %APPDATA%\obsidian\obsidian.json 校验目标是否为当前活动库，
// 防止再出现「装到旧库快照、界面毫无变化」的事故。
// 目标库可用环境变量 GROVE_VAULT 覆盖（默认 D:\Obsidian）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 某些 Node 版本（实测 v25.2.1）的 fs.cpSync({recursive:true}) 有 bug：
// 只建出空的子目录而不拷文件，导致 wasm/cmaps 解码资源丢失、扫描版 PDF 白屏。
// 用显式递归拷贝替代。
function copyDir(src, dst) {
	fs.mkdirSync(dst, { recursive: true })
	for (const name of fs.readdirSync(src)) {
		const s = path.join(src, name)
		const d = path.join(dst, name)
		const st = fs.lstatSync(s)
		if (st.isDirectory()) copyDir(s, d)
		else if (st.isFile()) fs.copyFileSync(s, d)
	}
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const target = process.env.GROVE_VAULT || 'D:\\Obsidian'
const pluginDir = path.join(target, '.obsidian', 'plugins', 'grove-reader')

try {
	const cfgPath = path.join(process.env.APPDATA ?? '', 'obsidian', 'obsidian.json')
	const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
	const active = Object.values(cfg.vaults ?? {}).filter(v => v.open).map(v => v.path)
	if (active.length && !active.some(p => path.resolve(p).toLowerCase() === path.resolve(target).toLowerCase())) {
		console.warn(`⚠️  Obsidian 当前活动库：${active.join('、')}\n⚠️  本次部署目标：${target}\n⚠️  两者不一致——请确认（如需改目标，设置环境变量 GROVE_VAULT）`)
	}
} catch {
	// 读不到 Obsidian 配置就跳过校验
}

if (!fs.existsSync(pluginDir)) {
	console.error(`✗ 插件目录不存在：${pluginDir}（请确认库路径，或先在该库安装一次插件）`)
	process.exit(1)
}

for (const f of ['main.js', 'manifest.json', 'styles.css']) {
	fs.copyFileSync(path.join(root, f), path.join(pluginDir, f))
}
fs.rmSync(path.join(pluginDir, 'pdfjs'), { recursive: true, force: true })
copyDir(path.join(root, 'pdfjs'), path.join(pluginDir, 'pdfjs'))
console.log(`✓ 已部署到 ${pluginDir}\n  在 Obsidian 里重载 Grove Reader 插件即可生效`)
