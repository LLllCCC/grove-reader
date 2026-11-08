// 把移动端适配任务派给 Qoder CLI
//
// 用法（仓库根目录，PowerShell 或 CMD 均可）：
//   node scripts/dispatch-mobile.mjs --login    # 第一次：完成 Qoder CLI 授权（会打开浏览器）
//   node scripts/dispatch-mobile.mjs            # 之后：检查登录并派活
//
// 说明：qodercli 不在系统 PATH 里，所以这里固定用 node 直接跑它的入口文件。
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const CLI_JS =
	process.env.QODER_CLI_JS ||
	'C:/Users/35011/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@qoder-ai/qodercli/bundle/qodercli.js'
const repo = path.resolve(import.meta.dirname, '..')

// --login：直接进入授权流程，浏览器授权完再正常派活
if (process.argv.includes('--login')) {
	console.log('▶ 打开 Qoder 授权流程，完成后回到这个窗口重跑：node scripts/dispatch-mobile.mjs\n')
	const login = spawn(process.execPath, [CLI_JS, 'login'], { stdio: 'inherit', cwd: repo })
	login.on('exit', code => {
		process.exitCode = code ?? 0
	})
} else {
	// 先确认登录状态：未登录时 CLI 会抛一大段堆栈，不如直接给一句人话
	const status = spawnSync(process.execPath, [CLI_JS, 'status'], { encoding: 'utf8' })
	const statusText = `${status.stdout ?? ''}${status.stderr ?? ''}`.trim()
	if (/Not logged in/i.test(statusText)) {
		console.error('✗ Qoder CLI 还没有登录。\n')
		console.error('请在当前窗口执行下面这一条（会打开浏览器，用 yopo 账号授权）：\n')
		console.error('    node scripts/dispatch-mobile.mjs --login\n')
		console.error('授权完成后重跑：\n')
		console.error('    node scripts/dispatch-mobile.mjs\n')
		console.error('（qodercli 不在系统 PATH，直接用 npm 全局命令会提示「不是内部或外部命令」）')
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
}
