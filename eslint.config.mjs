// 本地复现 Obsidian 官方目录的源码检查（SOURCE CODE 区块）。
// 规则集来自官方 eslint-plugin-obsidianmd；其中含类型感知规则，所以要开 typed linting。
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
	{ ignores: ['node_modules/**', 'main.js', 'dist-*/**', '.tmp/**', 'pdfjs/**', 'lib/**', 'scripts/**'] },
]
