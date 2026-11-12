// 校验内置 foliate-js 是否仍然符合预期。
//
// 分两层：
// 1. 本地基线（不联网，必跑）：文件 SHA-256 与 BASELINE.json 一致（忽略行尾差异）。
//    用来发现「手滑改了 lib/foliate-js 却不知道」；刻意修改后跑 npm run foliate:baseline。
// 2. 上游对比（联网，best-effort）：与 UPSTREAM.md 记录的基准 commit 逐文件比对，
//    未登记在「本地修改」表里的差异视为上游漂移或本地误改。
//
// 网络说明：raw.githubusercontent.com 的个别 IP 在部分网络下会连接超时。
// 本脚本给单次请求加短超时，并设置整场网络预算；直连失败自动切镜像，
// 首次探测成功后复用该通道。网络全部不可用时跳过上游对比，但本地基线仍会校验。
//   GROVE_FOLIATE_OFFLINE=1        # 只跑本地基线，不联网（也可用 --offline）
//   GROVE_FOLIATE_MIRROR=...       # 自定义镜像前缀，逗号分隔多个
//   GROVE_FOLIATE_FORCE_MIRROR=1   # 跳过直连，直接从镜像读
//   GROVE_FOLIATE_TIMEOUT=12000    # 单次请求超时（毫秒）
//   GROVE_FOLIATE_BUDGET=40000     # 整场上游对比的网络预算（毫秒）
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const libDir = process.env.GROVE_FOLIATE_LIB
	? path.resolve(process.env.GROVE_FOLIATE_LIB)
	: path.join(root, 'lib', 'foliate-js')
const doc = fs.readFileSync(path.join(libDir, 'UPSTREAM.md'), 'utf-8')

// 从 UPSTREAM.md 基准表中解析 commit
const sha = doc.match(/\| 基准 commit \| `([0-9a-f]{40})` \|/)?.[1]
if (!sha) throw new Error('UPSTREAM.md 中找不到基准 commit')
// 解析「本地修改」表中登记的文件名
const known = new Set([...doc.matchAll(/^\| `([^`]+\.js)` \|/gm)].map(m => m[1]))

const args = new Set(process.argv.slice(2))
const OFFLINE = args.has('--offline') || process.env.GROVE_FOLIATE_OFFLINE === '1'
const TIMEOUT = Number(process.env.GROVE_FOLIATE_TIMEOUT || 12_000)
const BUDGET = Number(process.env.GROVE_FOLIATE_BUDGET || 40_000)
const FORCE_MIRROR = process.env.GROVE_FOLIATE_FORCE_MIRROR === '1'
const MIRRORS = (process.env.GROVE_FOLIATE_MIRROR ?? '')
	.split(',')
	.map(s => s.trim())
	.filter(Boolean)
	.map(s => (s.endsWith('/') ? s : `${s}/`))
	.concat(['https://ghproxy.net/', 'https://gh-proxy.com/'])
	.filter((v, i, a) => a.indexOf(v) === i)

const norm = s => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
const hashOf = text => createHash('sha256').update(norm(text)).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const errText = e => {
	const cause = e?.cause?.message ? `（${e.cause.message}）` : ''
	return `${e?.message ?? String(e)}${cause}`
}

const files = fs.readdirSync(libDir).filter(f => f.endsWith('.js')).sort()
if (!files.length) {
	console.error(`✗ ${libDir} 下没有 .js 文件`)
	process.exit(1)
}
console.log(`基准 commit: ${sha.slice(0, 10)}，登记的本地修改: ${[...known].join(', ') || '无'}`)

// ------------------------------------------------------------------
// 第一层：本地基线（离线可跑）
// ------------------------------------------------------------------
function checkLocalBaseline() {
	const baselinePath = path.join(libDir, 'BASELINE.json')
	if (!fs.existsSync(baselinePath)) {
		console.error('✗ 缺少 lib/foliate-js/BASELINE.json；先运行 npm run foliate:baseline')
		return false
	}
	let baseline
	try {
		baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'))
	} catch (e) {
		console.error(`✗ BASELINE.json 解析失败：${errText(e)}`)
		return false
	}
	if (baseline.upstream !== sha) {
		console.error(`✗ BASELINE.json 记录的基准是 ${baseline.upstream?.slice(0, 10) ?? '空'}，UPSTREAM.md 是 ${sha.slice(0, 10)}`)
		console.error('  改过基准 commit 后请运行 npm run foliate:baseline 重新生成。')
		return false
	}
	const expected = baseline.files && typeof baseline.files === 'object' ? baseline.files : {}
	const actual = new Map(files.map(f => [f, hashOf(fs.readFileSync(path.join(libDir, f), 'utf-8'))]))
	const changed = files.filter(f => expected[f] && expected[f] !== actual.get(f))
	const added = files.filter(f => !expected[f])
	const missing = Object.keys(expected).filter(f => !actual.has(f))
	if (changed.length || added.length || missing.length) {
		console.error('✗ 本地文件与 BASELINE.json 不一致：')
		if (changed.length) console.error(`  改动：${changed.join(', ')}`)
		if (added.length) console.error(`  新增：${added.join(', ')}`)
		if (missing.length) console.error(`  缺失：${missing.join(', ')}`)
		console.error('  若是刻意修改，运行 npm run foliate:baseline 更新基线，并与代码一起提交。')
		return false
	}
	console.log(`本地基线: ${files.length} 个文件一致（忽略行尾）`)
	return true
}

if (!checkLocalBaseline()) process.exit(1)
if (OFFLINE) {
	console.log('FOLIATE CHECK OK（离线：仅校验本地基线）')
	process.exit(0)
}

// ------------------------------------------------------------------
// 第二层：上游对比（联网，受总预算约束）
// ------------------------------------------------------------------
const deadline = Date.now() + BUDGET

async function get(url, label, options = {}) {
	const retries = options.retries ?? 1
	let last = null
	for (let attempt = 0; attempt <= retries; attempt++) {
		const remaining = deadline - Date.now()
		if (remaining <= 0) throw new Error(`${label}: 网络预算 ${BUDGET}ms 已用完`)
		const timeout = Math.max(1, Math.min(options.timeout ?? TIMEOUT, remaining))
		try {
			const res = await fetch(url, {
				headers: { 'User-Agent': 'grove-reader-foliate-check' },
				signal: AbortSignal.timeout(timeout),
			})
			if (!res.ok) {
				const error = new Error(`HTTP ${res.status}`)
				error.httpStatus = res.status
				throw error
			}
			return await res.text()
		} catch (e) {
			last = e
			if (e.httpStatus === 404) break
			if (attempt < retries && deadline - Date.now() > 0) await sleep(400 * (attempt + 1))
		}
	}
	throw new Error(`${label}: ${errText(last)}`)
}

function skipUpstream(reason) {
	console.log(`! 上游对比跳过：${reason}`)
	console.log('  本地基线已通过；网络恢复后重跑即可。')
	console.log('FOLIATE CHECK OK（本地基线一致；上游对比跳过）')
	process.exit(0)
}

// 上游文件清单只用于提示「上游有而本地未内置」；API 不通时不阻断逐文件对比。
let upstreamFiles = null
try {
	const tree = JSON.parse(await get(
		`https://api.github.com/repos/johnfactotum/foliate-js/git/trees/${sha}?recursive=1`,
		'上游文件清单',
		{ timeout: Math.min(TIMEOUT, 6_000), retries: 0 },
	))
	upstreamFiles = new Map(tree.tree.filter(t => t.type === 'blob' && t.path.endsWith('.js')).map(t => [t.path, t.sha]))
} catch (e) {
	console.log(`  ! 无法获取上游文件清单：${errText(e)}`)
	console.log('    跳过「上游有而本地未内置」检查，继续逐文件对比。')
}

// 先探测一条能用的通道，后续文件都走它；失败再临时切到其他镜像。
const rawBase = `https://raw.githubusercontent.com/johnfactotum/foliate-js/${sha}/`
const rawCandidates = (FORCE_MIRROR ? [] : [rawBase]).concat(MIRRORS.map(prefix => prefix + rawBase))
const labelFor = base => base === rawBase ? '直连' : base.slice(0, base.length - rawBase.length).replace(/\/$/, '')
const probeFile = files.includes('view.js') ? 'view.js' : files[0]
const cache = new Map()
let activeBase = ''
for (const base of rawCandidates) {
	try {
		const text = await get(base + probeFile, `${labelFor(base)} ${probeFile}`, { retries: 0 })
		activeBase = base
		cache.set(probeFile, text)
		console.log(`上游通道: ${labelFor(base)}`)
		break
	} catch (e) {
		console.log(`  ! ${labelFor(base)} 不可用：${errText(e)}`)
	}
}
if (!activeBase) skipUpstream('直连与镜像都不可用')

let identical = 0
const drift = []
for (const f of files) {
	const local = norm(fs.readFileSync(path.join(libDir, f), 'utf-8'))
	let remote = cache.get(f)
	if (remote == null) {
		try {
			remote = await get(activeBase + f, f)
		} catch (e) {
			// 当前通道临时抖动：换其他候选通道再试
			for (const base of rawCandidates) {
				if (base === activeBase) continue
				try {
					remote = await get(base + f, f)
					activeBase = base
					console.log(`  ~ 已切换到 ${labelFor(base)}`)
					break
				} catch {
					// 继续试下一个
				}
			}
			if (remote == null) skipUpstream(`读取上游文件失败：${f}（${errText(e)}）`)
		}
	}
	if (local === norm(remote)) identical++
	else if (known.has(f)) console.log(`  ~ ${f}: 与上游不同（已在登记表中）`)
	else drift.push(f)
}

if (upstreamFiles) {
	const removed = files.filter(f => !upstreamFiles.has(f))
	if (removed.length) {
		console.error(`✗ 上游基准里没有这些本地文件（可能已改名/删除）：\n  ${removed.join('\n  ')}`)
		process.exit(1)
	}
	const missingLocal = [...upstreamFiles.keys()].filter(p => !fs.existsSync(path.join(libDir, p)))
	if (missingLocal.length) console.log(`  - 上游有而本地未内置（正常，按需取舍）: ${missingLocal.join(', ')}`)
}
console.log(`字节一致（忽略行尾）: ${identical} 个文件`)
if (drift.length) {
	console.error(`✗ 未登记的差异（上游重构或本地被改，需人工核对）:\n  ${drift.join('\n  ')}`)
	process.exit(1)
}
console.log('FOLIATE CHECK OK')
