import esbuild from 'esbuild'
import process from 'process'
import builtins from 'builtin-modules'

const prod = process.argv[2] === 'production'

const context = await esbuild.context({
	entryPoints: ['src/main.ts'],
	bundle: true,
	external: [
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/view',
		'@lezer/common',
		'@lezer/highlight',
		'@lezer/lr',
		...builtins,
		'node:fs',
		'node:path',
		'node:crypto',
		'node:os',
		'node:url',
	],
	format: 'cjs',
	target: 'es2022',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'main.js',
	minify: prod,
})

const pdfWorkerBuild = {
	entryPoints: ['node_modules/pdfjs-dist/build/pdf.worker.mjs'],
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	logLevel: 'info',
	outfile: '.tmp/pdf.worker.mjs',
}

if (prod) {
	await context.rebuild()
	await context.dispose()
	await esbuild.build(pdfWorkerBuild)
} else {
	await esbuild.build(pdfWorkerBuild)
	await context.watch()
}
