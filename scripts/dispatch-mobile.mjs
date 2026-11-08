// 把移动端适配任务派给 Qoder CLI
// 用法（仓库根目录）：node scripts/dispatch-mobile.mjs
// 前置：Qoder CLI 已登录（在 PowerShell 里运行 `qodercli login`，浏览器完成授权）
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const CLI_JS =
	process.env.QODER_CLI_JS ||
	'C:/Users/35011/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@qoder-ai/qodercli/bundle/qodercli.js'
const repo = path.resolve(import.meta.dirname, '..')

// 先确认登录状态：未登录时 CLI 会抛一大段堆栈，不如直接给一句人话
const status = spawnSync(process.execPath, [CLI_JS, 'status'], { encoding: 'utf8' })
const statusText = `${status.stdout ?? ''}${status.stderr ?? ''}`.trim()
if (/Not logged in/i.test(statusText)) {
	console.error('✗ Qoder CLI 还没有登录。\n')
	console.error('请先在你自己的 PowerShell 窗口里执行：\n')
	console.error('    qodercli login\n')
	console.error('浏览器完成授权后，运行 `qodercli status` 应能看到账号名，再重跑：\n')
	console.error('    node scripts/dispatch-mobile.mjs\n')
	process.exit(1)
}

const prompt = [
	'阅读 docs/mobile-port.md（Grove Reader 移动端适配任务书），按阶段 A 开始实施。',
	'先给出分阶段计划与改动文件清单，再动手；每个阶段结束跑 npm run build 与 npm run smoke。',
	'不要修改 D:\\Obsidian 主库，测试用独立库；分支 feature/mobile。',
].join('\n')

const args = [CLI_JS, '-p', prompt, '-w', repo, '--permission-mode', 'accept_edits']

console.log('▶ Qoder CLI:', CLI_JS)
console.log('▶ 工作目录:', repo)
console.log('▶ 任务书: docs/mobile-port.md\n')

const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: repo })
child.on('exit', code => {
	if (code === 0) {
		console.log('\n✓ Qoder 执行结束。检查 git status 与 npm run smoke 后再合并。')
		return
	}
	console.error(`\n✗ Qoder 退出码 ${code}`)
	process.exitCode = code ?? 1
})
