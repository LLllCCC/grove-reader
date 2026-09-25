// 直连运行中 Obsidian 的 CDP 调试口（Obsidian 需带 --remote-debugging-port=9222 启动），
// 在应用上下文执行一段 JS 并打印结果。替代未安装的 obsidian CLI：
//   node scripts/obsidian-eval.mjs "app.plugins.plugins['grove-reader'].manifest.version"
//   node scripts/obsidian-eval.mjs --file snippet.js   # 执行整段脚本（最后表达式的值作为结果）
// 用途：插件重载、DOM 检查、行为验证。纯开发工具，不参与打包。
import WebSocket from '../.tmp/cdp/node_modules/ws/index.js'

const PORT = process.env.GROVE_CDP_PORT || 9222
const arg = process.argv[2]
if (!arg) {
	console.error('用法: node scripts/obsidian-eval.mjs "<表达式>" | --file <脚本路径>')
	process.exit(1)
}
const expr = arg === '--file'
	? (await import('node:fs')).readFileSync(process.argv[3], 'utf-8')
	: arg

// 找到 Obsidian 主窗口（有 app 对象的那个页面）
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find(t => t.type === 'page' && t.url.startsWith('obsidian://') || t.type === 'page' && t.url.includes('index.html'))
	?? targets.find(t => t.type === 'page')
if (!page) {
	console.error('未找到 Obsidian 窗口（调试目标列表：' + targets.map(t => `${t.type} ${t.url}`).join(', ') + '）')
	process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
let seq = 0
const pending = new Map()
ws.on('message', data => {
	const msg = JSON.parse(data.toString())
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)(msg)
		pending.delete(msg.id)
	}
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++seq
	pending.set(id, msg => msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result))
	ws.send(JSON.stringify({ id, method, params }))
})

await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })

// 表达式支持顶层 await：包在 async IIFE 里执行
const wrapped = `(async () => {\n${expr}\n})()`
const result = await send('Runtime.evaluate', {
	expression: wrapped,
	awaitPromise: true,
	returnByValue: true,
	rethrowPromiseRejection: true,
	userGesture: true,
})
if (result.exceptionDetails) {
	const d = result.exceptionDetails
	console.error('✗ 执行出错:', d.exception?.description ?? d.text ?? JSON.stringify(d))
	process.exit(1)
}
const v = result.result.value
console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1))
ws.close()
process.exit(0)
