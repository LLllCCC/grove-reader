/**
 * i18n codemod：把界面文案包成 t('中文原文')。
 *
 * 只处理「展示用」字符串，明确跳过：
 *   - import / export 路径
 *   - 对象字面量的键、属性访问名、下标访问
 *   - 比较运算（=== !== == !=）、case 分支
 *   - includes / startsWith / endsWith / indexOf / split / match 的参数
 *   - dataset.* 赋值（事件委托靠它匹配）
 *   - 已知的路径与固定标记常量
 *   - 已经包在 t() 里的字符串
 *
 * 模板字符串带插值的一律跳过（需要人工改成 {name} 形式，避免自动改写破坏语义）。
 *
 * 用法：
 *   node scripts/i18n-codemod.mjs src/settings.ts          # 预演，只报告
 *   node scripts/i18n-codemod.mjs src/settings.ts --write  # 实际写入
 */
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'

const file = process.argv[2]
const write = process.argv.includes('--write')
if (!file) {
	console.error('用法: node scripts/i18n-codemod.mjs <file.ts> [--write]')
	process.exit(1)
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/

/** 这些常量存的是路径或写入笔记的固定标记，翻译会破坏数据 */
const SKIP_DECL_NAMES = new Set([
	'LIBRARY_ROOT',
	'LEGACY_LIBRARY_ROOT',
	'BACKUP_FOLDER_NAME',
	'DEFAULT_TEMPLATE_PATH',
	'NOTE_BEGIN',
	'NOTE_END',
	'UNKNOWN_CHAPTER',
	'GROVE_ROOT',
])

/** 直接按原文跳过：路径、章节占位、会被写进笔记或用于比较的值 */
const SKIP_VALUES = new Set([
	'林间书屋',
	'Grove Reader 数据备份',
	'阅读笔记',
	'未命名章节',
	'未指明章节',
	'Grove Reader/阅读笔记/Grove 笔记模板.md',
])

const source = fs.readFileSync(file, 'utf8')
const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

const edits = []
const skipped = []

function isInsideT(node) {
	for (let p = node.parent; p; p = p.parent) {
		if (ts.isCallExpression(p)) {
			const callee = p.expression.getText(sf)
			if (callee === 't' || callee === 'tr') return true
		}
		if (ts.isFunctionLike(p)) return false
	}
	return false
}

function skipReason(node) {
	const text = node.getText(sf)
	if (SKIP_VALUES.has(node.text)) return '固定值'
	const p = node.parent
	if (!p) return '无父节点'
	if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p))
		return '模块路径'
	if (ts.isPropertyAssignment(p) && p.name === node) return '对象键'
	if (ts.isPropertyAccessExpression(p) && p.name === node) return '属性名'
	if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return '下标'
	if (ts.isVariableDeclaration(p) && p.name.getText(sf) && SKIP_DECL_NAMES.has(p.name.getText(sf))) return '路径常量'
	if (ts.isCaseClause(p) && p.expression === node) return 'case 分支'
	if (ts.isBinaryExpression(p)) {
		const op = p.operatorToken.kind
		// 比较与运算里的字符串属于逻辑值，不能翻译
		const compareOps = [
			ts.SyntaxKind.EqualsEqualsEqualsToken,
			ts.SyntaxKind.ExclamationEqualsEqualsToken,
			ts.SyntaxKind.EqualsEqualsToken,
			ts.SyntaxKind.ExclamationEqualsToken,
			ts.SyntaxKind.LessThanToken,
			ts.SyntaxKind.GreaterThanToken,
			ts.SyntaxKind.LessThanEqualsToken,
			ts.SyntaxKind.GreaterThanEqualsToken,
			ts.SyntaxKind.InstanceOfKeyword,
			ts.SyntaxKind.InKeyword,
			ts.SyntaxKind.PlusToken,
			ts.SyntaxKind.MinusToken,
			ts.SyntaxKind.AsteriskToken,
			ts.SyntaxKind.SlashToken,
		]
		// ?? 和 || 的右操作数是默认值，属于展示文案，放行
		if (compareOps.includes(op)) return '比较/运算'
	}
	if (ts.isCallExpression(p)) {
		const callee = p.expression.getText(sf)
		if (/\.(includes|startsWith|endsWith|indexOf|match|split|replace)$/.test(callee)) return '字符串运算'
		if (/(^|\.)setValue$/.test(callee)) return '下拉取值'
		if (callee === 'require') return '模块加载'
	}
	// this.x.dataset.y = '中文'
	let q = p
	while (q && (ts.isPropertyAccessExpression(q) || ts.isPropertyAssignment(q))) {
		if (ts.isPropertyAccessExpression(q) && q.name.getText(sf) === 'dataset') return 'dataset'
		q = q.parent
	}
	if (isInsideT(node)) return '已包装'
	return null
}

function visit(node) {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		if (CJK.test(node.text)) {
			const reason = skipReason(node)
			if (reason) {
				skipped.push({ text: node.text.slice(0, 40), reason })
			} else {
				edits.push({ start: node.getStart(sf), end: node.getEnd() })
			}
		}
	}
	ts.forEachChild(node, visit)
}
visit(sf)

if (edits.length === 0) {
	console.log(`无可替换字符串：${file}（跳过 ${skipped.length}）`)
	process.exit(0)
}

// 从后往前插，避免位置偏移
let out = source
for (const e of edits.sort((a, b) => b.start - a.start)) {
	const literal = out.slice(e.start, e.end)
	out = out.slice(0, e.start) + `t(` + literal + `)` + out.slice(e.end)
}

if (write) {
	// 补 import
	const rel = path.relative(path.dirname(file), path.join(process.cwd(), 'src', 'i18n'))
	const spec = rel.startsWith('.') ? rel : `./${rel}`
	if (!/from ['"]\.{1,2}\/.*i18n['"]/.test(out)) {
		const lines = out.split('\n')
		let lastImport = -1
		for (let i = 0; i < lines.length; i++) {
			if (/^import\s/.test(lines[i])) lastImport = i
		}
		if (lastImport >= 0) {
			lines.splice(lastImport + 1, 0, `import { t } from '${spec}'`)
			out = lines.join('\n')
		}
	}
	fs.writeFileSync(file, out)
}

console.log(`${write ? '已写入' : '预演'}：${file}`)
console.log(`  包装 ${edits.length} 条，跳过 ${skipped.length} 条`)
for (const s of skipped.slice(0, 12)) console.log(`  · [${s.reason}] ${s.text}`)
