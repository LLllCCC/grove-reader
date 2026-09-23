// 打包并运行 scripts/smoke-entry.ts，对数据层做不依赖 Obsidian 的冒烟测试
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
})
await import(pathToFileURL(path.join(tmp, 'smoke.cjs')).href)
