// 本地复现 Obsidian 官方目录的源码检查（SOURCE CODE 区块）。
// 站点连 lib/foliate-js 一起扫：lib 用默认 JS 解析器，src 用 TS 类型感知。
import obsidianmd from 'eslint-plugin-obsidianmd'
import tseslint from 'typescript-eslint'

export default [
	...obsidianmd.configs.recommended,
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
	},
	{ files: ['lib/**/*.js'] },
	{ ignores: ['node_modules/**', 'main.js', 'dist-*/**', '.tmp/**', 'pdfjs/**', 'scripts/**', 'lib/foliate-js/vendor/**'] },
]
