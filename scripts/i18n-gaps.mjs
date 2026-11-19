/**
 * 找出「中文字面量存在、但英文词典里没有」的键。
 * 覆盖 t('字面量') 之外的场景：t(SOME_VAR)、t(name)、以及词典里漏收的数据标签。
 * 用法：node scripts/i18n-gaps.mjs [--all]
 */
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const srcDir = path.join(root, 'src')

function walk(dir, out = []) {
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name)
		const st = fs.statSync(p)
		if (st.isDirectory()) {
			if (name !== 'locales') walk(p, out)
		} else if (name.endsWith('.ts')) out.push(p)
	}
	return out
}

// 词典里的键
const dict = new Set()
for (const f of fs.readdirSync(path.join(srcDir, 'locales'))) {
	if (!f.endsWith('.ts')) continue
	const p = path.join(srcDir, 'locales', f)
	const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true)
	const visit = node => {
		if (ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name)) {
			const nm = node.name
			dict.add(ts.isStringLiteral(nm) || ts.isNoSubstitutionTemplateLiteral(nm) ? nm.text : nm.getText(sf))
		}
		ts.forEachChild(node, visit)
	}
	visit(sf)
}

// 源码里出现的中文字面量
const CJK = /[\u4e00-\u9fff]/
const missing = new Map()
for (const file of walk(srcDir)) {
	const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
	const visit = node => {
		let text = null
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text
		if (text && CJK.test(text) && !dict.has(text)) {
			const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
			if (!missing.has(text)) missing.set(text, [])
			missing.get(text).push(`${path.relative(root, file)}:${line}`)
		}
		ts.forEachChild(node, visit)
	}
	visit(sf)
}

const list = [...missing.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))
console.log(`词典键 ${dict.size} 个；源码中未收录的中文字面量 ${list.length} 条`)
for (const [text, where] of list) {
	console.log(`  ${JSON.stringify(text)}  ← ${where[0]}${where.length > 1 ? ` 等 ${where.length} 处` : ''}`)
}
