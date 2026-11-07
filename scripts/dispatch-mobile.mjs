// 把移动端适配任务派给 Qoder CLI
// 用法（仓库根目录）：node scripts/dispatch-mobile.mjs
// 前置：Qoder CLI 已登录（在终端运行 `qoder`，输入 /login 完成一次授权）
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const CLI = process.env.QODER_CLI || 'C:/Users/35011/.workbuddy/binaries/node/versions/22.22.2-6/qodercli.cmd'
const repo = path.resolve(import.meta.dirname, '..')
const prompt = [
	'阅读 docs/mobile-port.md（Grove Reader 移动端适配任务书），按阶段 A 开始实施。',
	'先给出分阶段计划与改动文件清单，再动手；每个阶段结束跑 npm run build 与 npm run smoke。',
	'不要修改 D:\\Obsidian 主库，测试用独立库；分支 feature/mobile。',
].join('\n')

const args = [
	'-p',
	prompt,
	'-w',
	repo,
	'--permission-mode',
	'accept_edits',
]

console.log('▶ Qoder CLI:', CLI)
console.log('▶ 工作目录:', repo)
console.log('▶ 任务书: docs/mobile-port.md\n')

const child = spawn(CLI, args, { stdio: 'inherit', shell: true })
child.on('exit', code => {
	if (code === 0) {
		console.log('\n✓ Qoder 执行结束。检查 git status 与 npm run smoke 后再合并。')
		return
	}
	console.error(`\n✗ Qoder 退出码 ${code}`)
	console.error('若提示 Not logged in：先运行 `qoder`，在交互界面输入 /login 完成授权，再重跑本脚本。')
	process.exitCode = code ?? 1
})
