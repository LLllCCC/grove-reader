/** 划词摘录的落盘入口：`笔记文件夹/摘录/<书名> 摘录.md`，追加写。 */
import { App, normalizePath, TFile } from 'obsidian'
import { excerptDocMarkdown, excerptFileName, excerptMarkdown, type ExcerptEntry } from './excerptStore'
import { t } from './i18n'

/** 追加一条到摘录文件，返回文件路径；写入失败抛错由调用方提示 */
export async function appendExcerpt(app: App, notesFolder: string, entry: ExcerptEntry): Promise<string> {
	const body = excerptMarkdown(entry)
	if (!body) throw new Error(t('没有可保存的选中文字'))
	const base = (notesFolder?.trim() || '阅读笔记').replace(/\\/g, '/').replace(/\/+$/, '')
	const folder = normalizePath(`${base}/摘录`)
	if (!(await app.vault.adapter.exists(folder))) await app.vault.createFolder(folder)
	const path = normalizePath(`${folder}/${excerptFileName(entry.bookTitle)}`)
	const file = app.vault.getAbstractFileByPath(path)
	if (file instanceof TFile) {
		await app.vault.append(file, `\n${body}\n`)
		return path
	}
	await app.vault.create(path, `${excerptDocMarkdown(entry.bookTitle)}${body}\n`)
	return path
}
