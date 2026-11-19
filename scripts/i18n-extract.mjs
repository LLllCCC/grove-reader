/**
 * 从源码里抽取 t('...') 的键，输出 JSON。
 * 用法：node scripts/i18n-extract.mjs [--missing]
 *   --missing 只输出 EN 词典里还没有的键（用于补翻译）
 */
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const srcDir = path.join(root, 'src')
const onlyMissing = process.argv.includes('--missing')

/** 递归收集 .ts（跳过 locales 自身） */
function walk(dir, out = []) {
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name)
		const st = fs.statSync(p)
		if (st.isDirectory()) {
			if (name === 'locales') continue
			walk(p, out)
		} else if (name.endsWith('.ts')) {
			out.push(p)
		}
	}
	return out
}

const keys = new Map() // key -> Set<file>
for (const file of walk(srcDir)) {
	const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
	const visit = node => {
		const callee = ts.isCallExpression(node) ? node.expression.getText(sf) : ''
		if (ts.isCallExpression(node) && (callee === 't' || callee === 'tr')) {
			const arg = node.arguments[0]
			if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
				const k = arg.text
				if (!keys.has(k)) keys.set(k, new Set())
				keys.get(k).add(path.relative(root, file))
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(sf)
}

// 已翻译的键
const translated = new Set()
for (const f of fs.readdirSync(path.join(srcDir, 'locales'))) {
	if (!f.endsWith('.ts')) continue
	const enSf = ts.createSourceFile(f, fs.readFileSync(path.join(srcDir, 'locales', f), 'utf8'), ts.ScriptTarget.Latest, true)
	const visitEn = node => {
		if (ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name)) {
			const nm = node.name
			translated.add(
				ts.isStringLiteral(nm) || ts.isNoSubstitutionTemplateLiteral(nm) ? nm.text : nm.getText(enSf),
			)
		}
		ts.forEachChild(node, visitEn)
	}
	visitEn(enSf)
}

const list = [...keys.entries()]
	.filter(([k]) => !onlyMissing || !translated.has(k))
	.map(([k, files]) => ({ key: k, files: [...files] }))
	.sort((a, b) => a.key.localeCompare(b.key, 'zh'))

fs.writeFileSync('/tmp/i18n-keys.json', JSON.stringify(list, null, '\t'))
console.log(`键总数 ${keys.size}，已翻译 ${translated.size}，待翻译 ${list.length}`)
console.log('已写入 /tmp/i18n-keys.json')
