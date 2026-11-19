// 打包并运行 scripts/smoke-entry.ts，对数据层与书架窗口数学做不依赖 Obsidian 的冒烟测试
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-smoke-'))
await build({
	entryPoints: [path.join(root, 'scripts', 'smoke-entry.ts')],
	bundle: true,
	format: 'cjs',
	platform: 'node',
	outfile: path.join(tmp, 'smoke.cjs'),
	logLevel: 'warning',
	// 与主构建同一个开关：GROVE_COMMUNITY=1 时按社区版（无 PDF）编译，
	// 用来验证社区版的代码路径也能跑通，而不是只测完整版。
	define: { __COMMUNITY_BUILD__: process.env.GROVE_COMMUNITY === '1' ? 'true' : 'false' },
})
// ------------------------------------------------------------------
// 样式守卫：四个 Grove 视图都必须隐藏 Obsidian 自带的视图头（← → / 标题 / ⋮）。
// 这条规则 2026-09-28 加过、2026-11-09 被单独删掉，界面问题因此复发过一次；
// 放进构建期检查，谁再删就在 CI 里立刻炸掉，而不是等用户截图。
// ------------------------------------------------------------------
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8')
const VIEW_TYPES = ['grove-reader-view', 'grove-reader-text', 'grove-pdf-view', 'grove-bookshelf-view']
const notHidden = VIEW_TYPES.filter(type => {
	const re = new RegExp(`\\[data-type=["']${type}["']\\]\\s+\\.view-header[^{]*\\{([^}]*)\\}`)
	const m = re.exec(css)
	return !m || !/display\s*:\s*none/.test(m[1])
})
if (notHidden.length) {
	console.error(`✗ styles.css 缺少视图头隐藏规则：${notHidden.join('、')}（问题会表现为阅读区顶部多出一条「← → 标题」）`)
	process.exit(1)
}
console.log(`STYLE OK  视图头已在 4 个视图里隐藏`)

await import(pathToFileURL(path.join(tmp, 'smoke.cjs')).href)
