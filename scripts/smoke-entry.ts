import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { BookStore } from '../src/store'
import { buildNote, buildTemplateContext, DEFAULT_NOTE_TEMPLATE, renderNoteTemplate } from '../src/notes'
import { BookData } from '../src/types'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-data-'))
const store = new BookStore(tmp, 2)
const bookPath = 'Books/林间漫步.epub'

// 1. 首次 load → fresh
const d1 = store.load(bookPath)
assert.equal(d1.annotations.length, 0)
assert.equal(d1.bookPath, bookPath)

// 2. save → load 往返
d1.title = '测试书'
d1.annotations.push({
	id: 'a1',
	cfi: 'epubcfi(/6/4!/2,/2,/4)',
	text: '第一段高亮',
	color: 'yellow',
	note: '想法',
	createdAt: 1,
	updatedAt: 1,
	sectionIndex: 0,
	chapter: '第一章',
})
store.save(d1)
const d2 = store.load(bookPath)
assert.equal(d2.annotations.length, 1)
assert.equal(d2.annotations[0].note, '想法')

// 3. 再存一次（写入备份），随后破坏主文件 → 从备份自动恢复
store.save(d2)
const id = store.bookId(bookPath)
const mainFile = path.join(tmp, 'data', 'books', `${id}.json`)
assert.ok(fs.existsSync(mainFile))
fs.writeFileSync(mainFile, '{corrupted json!', 'utf-8')
const d3 = store.load(bookPath)
assert.equal(d3.annotations.length, 1, '损坏后应从备份恢复')
assert.equal(fs.readFileSync(mainFile, 'utf-8').slice(0, 1), '{')

// 4. 书籍移动（basename 不变）→ 按 bookPath 扫描找回
store.save({ ...d3, bookPath })
const moved = store.load('Other/林间漫步.epub')
assert.equal(moved.annotations.length, 1, '移动后应找回旧数据')
assert.equal(moved.bookPath, 'Other/林间漫步.epub')

// 5. buildNote：新建 / 覆盖区间保留用户内容 / 无标记时追加
const data: BookData = {
	version: 1,
	bookPath,
	title: '测试书',
	author: '作者',
	annotations: [
		{
			id: 'a1',
			cfi: "epubcfi(/6/4!/2[Chap],/2,/4)",
			text: '高亮一\n第二行',
			color: 'yellow',
			note: '评论一',
			createdAt: 1,
			updatedAt: 1,
			sectionIndex: 0,
			chapter: '第一章',
		},
		{
			id: 'a2',
			cfi: 'epubcfi(/6/6!/4)',
			text: '高亮二',
			color: 'blue',
			createdAt: 2,
			updatedAt: 2,
			sectionIndex: 1,
			chapter: '第二章',
		},
	],
}

const fresh = buildNote(data, 'id123', null)
assert.ok(fresh.startsWith('---\ntitle: "测试书"'))
assert.ok(fresh.includes('obsidian://grove?book=id123&cfi=epubcfi%28'))
assert.ok(fresh.includes('%%\n评论一\n%%'))
assert.ok(fresh.includes('GROVE:BEGIN'))

const withUser = `用户自己的开头\n\n${fresh}`
const updated = buildNote({ ...data, annotations: [data.annotations[0]] }, 'id123', withUser)
assert.ok(updated.startsWith('用户自己的开头'), '区间外内容应保留')
assert.ok(!updated.includes('高亮二'), '区间内应随重新生成覆盖')
assert.ok(updated.includes('GROVE:BEGIN'))

const appended = buildNote(data, 'id123', '已有内容')
assert.ok(appended.startsWith('已有内容'), '无标记文件应在末尾追加')
assert.ok(appended.includes('GROVE:BEGIN'))

// 6. 默认模板：书名 → 章节 → 摘录标题 + 引用块 + 评论 + 回跳 + block id
const ctx = buildTemplateContext(data, 'id123')
const rendered = renderNoteTemplate(DEFAULT_NOTE_TEMPLATE, ctx)
assert.ok(rendered.includes('# 测试书'))
assert.ok(rendered.includes('## 第一章'))
assert.ok(rendered.includes('### 高亮一'), '摘录首行应成为批注标题')
assert.ok(rendered.includes('> 高亮一\n>\n> 第二行'))
assert.ok(rendered.includes('%%\n评论一\n%%'))
assert.ok(rendered.includes('epubcfi%28'))
assert.ok(rendered.includes('^grove-a1'))
assert.ok(rendered.includes('^grove-a2'))
assert.ok(!rendered.includes('{{'), '模板变量应全部被替换')

// 7. 自定义模板：变量、嵌套 each、if
const custom = [
	'{{title}} 共{{count}}条',
	'{{#each chapters}}[{{chapter}}]',
	'{{#each annotations}}- {{index}} {{excerptHeading}}{{#if note}}（有评论）{{/if}}\n{{/each}}',
	'{{/each}}',
].join('\n')
const r2 = renderNoteTemplate(custom, ctx)
assert.ok(r2.startsWith('测试书 共2条'))
assert.ok(r2.includes('[第一章]'))
assert.ok(r2.includes('- 1 高亮一（有评论）'))
assert.ok(r2.includes('- 2 高亮二'))
assert.ok(!r2.includes('{{'))

// 8. 语法错误的模板：buildNote 自动回退默认模板，不抛出
const bad = buildNote(data, 'id123', null, '{{#each chapters}}未闭合')
assert.ok(bad.includes('GROVE:BEGIN'))
assert.ok(bad.includes('### 高亮一'))

// 9. buildNote 使用自定义模板生成，且标记区间合并行为不变
const withTpl = buildNote(data, 'id123', null, custom)
assert.ok(withTpl.startsWith('---'))
assert.ok(withTpl.includes('- 1 高亮一'))
const updatedTpl = buildNote({ ...data, annotations: [data.annotations[0]] }, 'id123', withTpl, custom)
assert.ok(updatedTpl.includes('- 1 高亮一'))
assert.ok(!updatedTpl.includes('高亮二'))

console.log('SMOKE OK')
