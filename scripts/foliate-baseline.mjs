// 生成 lib/foliate-js/BASELINE.json：记录当前内置文件的 SHA-256（忽略行尾差异）。
// 刻意修改 foliate-js 后运行一次，并把 BASELINE.json 与代码改动一起提交；
// 这样即使 GitHub 不可达，npm run foliate:check 也能发现本地文件被误改。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const libDir = process.env.GROVE_FOLIATE_LIB
	? path.resolve(process.env.GROVE_FOLIATE_LIB)
	: path.join(root, 'lib', 'foliate-js')
const doc = fs.readFileSync(path.join(libDir, 'UPSTREAM.md'), 'utf-8')
const sha = doc.match(/\| 基准 commit \| `([0-9a-f]{40})` \|/)?.[1]
if (!sha) throw new Error('UPSTREAM.md 中找不到基准 commit')

const norm = s => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
const files = fs.readdirSync(libDir).filter(f => f.endsWith('.js')).sort()
const hashes = {}
for (const f of files) {
	hashes[f] = createHash('sha256').update(norm(fs.readFileSync(path.join(libDir, f), 'utf-8'))).digest('hex')
}
const baseline = {
	note: '本地内置 foliate-js 的 SHA-256（忽略行尾）。刻意修改后运行 npm run foliate:baseline 更新。',
	upstream: sha,
	files: hashes,
}
fs.writeFileSync(path.join(libDir, 'BASELINE.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8')
console.log(`✓ 已写入 ${path.join(libDir, 'BASELINE.json')}（${files.length} 个文件，基准 ${sha.slice(0, 10)}）`)
