// 校验 lib/foliate-js 与 lib/foliate-js/UPSTREAM.md 记录的上游基准 commit 的偏差。
// 通过 = 除 UPSTREAM.md 里「本地修改」表列出的文件外，其余文件与基准一致（忽略行尾差异）。
// 任一未登记的文件出现差异即失败——这意味着上游漂移或本地被意外改动。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const libDir = path.join(root, 'lib', 'foliate-js')
const doc = fs.readFileSync(path.join(libDir, 'UPSTREAM.md'), 'utf-8')

// 从 UPSTREAM.md 基准表中解析 commit
const sha = doc.match(/\| 基准 commit \| `([0-9a-f]{40})` \|/)?.[1]
if (!sha) throw new Error('UPSTREAM.md 中找不到基准 commit')
// 解析「本地修改」表中登记的文件名
const known = new Set([...doc.matchAll(/^\| `([^`]+\.js)` \|/gm)].map(m => m[1]))

const norm = s => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
const get = async url => {
	const res = await fetch(url, { headers: { 'User-Agent': 'grove-reader-foliate-check' } })
	if (!res.ok) throw new Error(`${res.status} ${url}`)
	return res.text()
}

console.log(`基准 commit: ${sha.slice(0, 10)}，登记的本地修改: ${[...known].join(', ') || '无'}`)
const tree = JSON.parse(await get(`https://api.github.com/repos/johnfactotum/foliate-js/git/trees/${sha}?recursive=1`))
const upstreamFiles = new Map(tree.tree.filter(t => t.type === 'blob' && t.path.endsWith('.js')).map(t => [t.path, t.sha]))

let identical = 0
const drift = []
for (const f of fs.readdirSync(libDir).filter(f => f.endsWith('.js'))) {
	const local = norm(fs.readFileSync(path.join(libDir, f), 'utf-8'))
	const remote = norm(await get(`https://raw.githubusercontent.com/johnfactotum/foliate-js/${sha}/${f}`))
	if (local === remote) identical++
	else if (known.has(f)) console.log(`  ~ ${f}: 与上游不同（已在登记表中）`)
	else drift.push(f)
}
const missingLocal = [...upstreamFiles.keys()].filter(p => !fs.existsSync(path.join(libDir, p)))
console.log(`字节一致（忽略行尾）: ${identical} 个文件`)
if (drift.length) {
	console.error(`✗ 未登记的差异（上游重构或本地被改，需人工核对）:\n  ${drift.join('\n  ')}`)
	process.exit(1)
}
if (missingLocal.length) console.log(`  - 上游有而本地未内置（正常，按需取舍）: ${missingLocal.join(', ')}`)
console.log('FOLIATE CHECK OK')
