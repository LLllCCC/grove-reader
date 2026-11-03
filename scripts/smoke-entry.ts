import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { BookStore } from '../src/store'
import { buildNote, buildTemplateContext, DEFAULT_NOTE_TEMPLATE, NOTE_BEGIN, NOTE_END, renderNoteTemplate } from '../src/notes'
import { StatsStore, todayKey } from '../src/stats'
import { BookData } from '../src/types'
import { compareCfi, formatDuration, relativeTime } from '../src/util'

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

// 10. GROVE:END 标记丢失 → BEGIN 之后整体视为生成区，反复生成不再无限追加
const brokenEnd = `手写内容\n\n${NOTE_BEGIN}\n\n旧生成内容（END 标记被误删）`
const fixed1 = buildNote(data, 'id123', brokenEnd)
const fixed2 = buildNote(data, 'id123', fixed1)
assert.ok(fixed1.startsWith('手写内容'), 'END 丢失时 BEGIN 前的手写内容应保留')
assert.ok(!fixed1.includes('旧生成内容'), '损坏的生成区应被覆盖')
assert.equal((fixed2.match(new RegExp(NOTE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1,
	'END 丢失后反复生成不得累积多个生成区')
assert.equal((fixed2.match(new RegExp(NOTE_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1)

// 11. maxBackups = 0：完全不写备份
const tmp0 = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-nobackup-'))
const store0 = new BookStore(tmp0, 0)
const p0 = 'Zero/备份关闭.epub'
const s0 = store0.load(p0)
s0.title = 't'
store0.save(s0)
store0.save(store0.load(p0))
const backups0 = path.join(tmp0, 'data', 'backups', store0.bookId(p0))
assert.ok(!fs.existsSync(backups0) || fs.readdirSync(backups0).length === 0, 'maxBackups=0 不应留下备份')

// 12. 陈旧 .tmp 清理：超过一天的删，一天内的留
const tmpT = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-tmp-'))
const storeT = new BookStore(tmpT, 2)
const pT = 'Tmp/清理测试.epub'
storeT.load(pT)
const booksDirT = path.join(tmpT, 'data', 'books')
const staleTmp = path.join(booksDirT, 'deadbeef.json.tmp')
fs.writeFileSync(staleTmp, '{}', 'utf-8')
const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
fs.utimesSync(staleTmp, old, old)
const freshTmp = path.join(booksDirT, 'alive.json.tmp')
fs.writeFileSync(freshTmp, '{}', 'utf-8')
storeT.load(pT)
assert.ok(!fs.existsSync(staleTmp), '超过一天的 .tmp 应被清理')
assert.ok(fs.existsSync(freshTmp), '一天内的 .tmp 不应被误删')

// 13. 阅读统计：跨天记录、按日合并、持久化往返
const tmpS = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-stats-'))
const stats = new StatsStore(path.join(tmpS, 'data', 'stats.json'))
stats.load()
stats.record('A/书一.epub', 300, 0, new Date('2026-09-24T10:00:00').getTime())
stats.record('A/书一.epub', 120, 5, new Date('2026-09-25T10:00:00').getTime())
stats.record('B/书二.pdf', 60, 3, new Date('2026-09-25T11:00:00').getTime())
const bookA = stats.sortedBooks().find(([p]) => p === 'A/书一.epub')![1]
assert.equal(bookA.seconds, 420)
assert.equal(bookA.pages, 5)
assert.equal(Object.keys(bookA.days).length, 2)
const days = stats.recentDays(14, new Date('2026-09-25T12:00:00'))
assert.equal(days[days.length - 1].seconds, 180, '今天应合并两本书的时长')
assert.equal(days[days.length - 1].pages, 8)
stats.saveNow()
const stats2 = new StatsStore(path.join(tmpS, 'data', 'stats.json'))
stats2.load()
assert.equal(stats2.sortedBooks().length, 2)
assert.equal(stats2.sortedBooks().find(([p]) => p === 'A/书一.epub')![1].seconds, 420, '统计应从磁盘完整恢复')
assert.equal(todayKey(new Date('2026-09-25')).length, 10)

// 14. 批注排序：CFI 按数字段比较（/10 必须排在 /9 之后），颜色名输出中文
const cfiBook: BookData = {
	version: 1,
	bookPath: 'Books/CFI.epub',
	title: 'CFI 测试',
	author: '',
	annotations: [
		{ id: 'b', cfi: 'epubcfi(/6/10!/4/2)', text: '十', color: 'yellow', createdAt: 1, updatedAt: 1, sectionIndex: 0, chapter: '第一章' },
		{ id: 'a', cfi: 'epubcfi(/6/9!/4/2)', text: '九', color: 'yellow', createdAt: 1, updatedAt: 1, sectionIndex: 0, chapter: '第一章' },
	],
}
const cfiCtx = buildTemplateContext(cfiBook, 'id')
assert.deepEqual(cfiCtx.chapters[0].annotations.map(a => a.text), ['九', '十'], 'CFI 应按数字段排序')
assert.equal(cfiCtx.chapters[0].annotations[0].colorName, '黄', '模板里的 colorName 应是中文名')
assert.ok(compareCfi('epubcfi(/6/9!/4/2)', 'epubcfi(/6/10!/4/2)') < 0)

// 15. frontmatter 转义：反斜杠 / 引号 / 换行不能破坏 YAML
const weirdNote = buildNote({
	version: 1, bookPath: 'Books/怪书名.epub', title: 'a\\b"c\nd', author: '', annotations: [],
}, 'id', null)
const titleLine = weirdNote.split('\n').find(l => l.startsWith('title:'))!
assert.equal(JSON.parse(titleLine.slice('title:'.length).trim()), 'a\\b"c\nd', 'frontmatter 应能还原原始书名')

// 16. 相对时间 / 阅读时长文案
const now = new Date('2026-09-25T12:00:00').getTime()
assert.equal(relativeTime(now - 30_000, now), '刚刚')
assert.equal(relativeTime(now - 3 * 3600_000, now), '3 小时前')
assert.equal(relativeTime(now - 30 * 3600_000, now), '昨天')
assert.equal(formatDuration(90), '2 分钟')
assert.equal(formatDuration(7200), '2.0 小时')

console.log('SMOKE OK')
