import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
const files = process.argv.slice(2)
for (const p of files) {
	const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true)
	const walk = (node, inFn) => {
		const fn = inFn || ts.isFunctionLike(node) || ts.isClassLike(node)
		if (ts.isCallExpression(node) && !fn) {
			const callee = node.expression.getText(sf)
			if (callee === 't' || callee === 'tr') {
				const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf))
				console.log(`${p}:${pos.line + 1}  ${node.getText(sf).slice(0, 80)}`)
			}
		}
		ts.forEachChild(node, n => walk(n, fn))
	}
	walk(sf, false)
}
