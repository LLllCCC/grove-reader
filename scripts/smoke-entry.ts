import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { BookStore } from '../src/store'
import { DesktopIO } from '../src/desktopIO'
import { buildNote, buildTemplateContext, DEFAULT_NOTE_TEMPLATE, NOTE_BEGIN, NOTE_END, renderNoteTemplate, resolveExcerptLinkStyle } from '../src/notes'
import { STATS_IDLE_MS, STATS_TICK_MS, StatsStore, accrueTick, todayKey } from '../src/stats'
import { BookData } from '../src/types'
import { bookIdFor, compareCfi, formatDuration, pageFromFraction, relativeTime } from '../src/util'
import { applySync, normalizeExcerpt, parseNoteEntries, planSync } from '../src/noteSync'
import { buildSearchIndex, searchDocs } from '../src/search'
import { TrashStore } from '../src/trash'
import { buildHealthReport, healthCleanupCount } from '../src/health'
import { checkMigrateTarget, exportDataBackup, migrateDataFolder } from '../src/backup'
import { appendCards, buildCardText, emptyCanvas, parseCanvas, serializeCanvas, shortTitle } from '../src/canvas'
import { buildSubpath, parseGroveHref, parseSubpath, snippetOf, wikilinkFor } from '../src/wikilink'

async function main(): Promise<void> {
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-data-'))
const store = new BookStore(tmp, 2, new DesktopIO())
await store.preload()
const save = async (d: BookData): Promise<void> => {
	store.save(d)
	await store.flush()
}
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
await save(d1)
const d2 = store.load(bookPath)
assert.equal(d2.annotations.length, 1)
assert.equal(d2.annotations[0].note, '想法')

// 3. 再存一次（写入备份），随后破坏主文件 → 从备份自动恢复
await save(d2)
const id = store.bookId(bookPath)
const mainFile = path.join(tmp, 'data', 'books', `${id}.json`)
assert.ok(fs.existsSync(mainFile))
fs.writeFileSync(mainFile, '{corrupted json!', 'utf-8')
// 新实例启动时才会扫描磁盘并修复，模拟重启
const store2 = new BookStore(tmp, 2, new DesktopIO())
await store2.preload()
const save2 = async (d: BookData): Promise<void> => {
	store2.save(d)
	await store2.flush()
}
const d3 = store2.load(bookPath)
assert.equal(d3.annotations.length, 1, '损坏后应从备份恢复')
assert.equal(fs.readFileSync(mainFile, 'utf-8').slice(0, 1), '{')

// 4. 书籍移动（basename 不变）→ 按 bookPath 扫描找回
await save2({ ...d3, bookPath })
const moved = store2.load('Other/林间漫步.epub')
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
// 默认写双链；显式要 protocol 时才写 obsidian://
assert.ok(fresh.includes('[[Books/林间漫步.epub#grove-cfi='), '默认应写双链')
assert.ok(!fresh.includes('obsidian://grove?'), '默认不应再写协议链接')
const freshProtocol = buildNote(data, 'id123', null, null, undefined, { style: 'protocol' })
assert.ok(freshProtocol.includes('obsidian://grove?book=id123&cfi=epubcfi%28'), 'protocol 样式应保留旧链接')
assert.ok(!freshProtocol.includes('#grove-cfi='), 'protocol 样式不应出现双链')
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
assert.ok(rendered.includes('grove-cfi=epubcfi(/6/4!/2%5BChap%5D,/2,/4)'), 'CFI 里的方括号应转义进双链')
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
const store0 = new BookStore(tmp0, 0, new DesktopIO())
await store0.preload()
const p0 = 'Zero/备份关闭.epub'
const s0 = store0.load(p0)
s0.title = 't'
store0.save(s0)
await store0.flush()
store0.save(store0.load(p0))
await store0.flush()
const backups0 = path.join(tmp0, 'data', 'backups', store0.bookId(p0))
assert.ok(!fs.existsSync(backups0) || fs.readdirSync(backups0).length === 0, 'maxBackups=0 不应留下备份')

// 12. 陈旧 .tmp 清理：超过一天的删，一天内的留
const tmpT = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-tmp-'))
const pT = 'Tmp/清理测试.epub'
const booksDirT = path.join(tmpT, 'data', 'books')
fs.mkdirSync(booksDirT, { recursive: true })
const staleTmp = path.join(booksDirT, 'deadbeef.json.tmp')
fs.writeFileSync(staleTmp, '{}', 'utf-8')
const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
fs.utimesSync(staleTmp, old, old)
const freshTmp = path.join(booksDirT, 'alive.json.tmp')
fs.writeFileSync(freshTmp, '{}', 'utf-8')
const storeT = new BookStore(tmpT, 2, new DesktopIO())
await storeT.preload()
assert.ok(!fs.existsSync(staleTmp), '超过一天的 .tmp 应被清理')
assert.ok(fs.existsSync(freshTmp), '一天内的 .tmp 不应被误删')

// 13. 阅读统计：跨天记录、按日合并、持久化往返
const tmpS = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-stats-'))
const statsIo = new DesktopIO()
const stats = new StatsStore(path.join(tmpS, 'data', 'stats.json'), statsIo)
await stats.load()
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
await stats.flush()
const stats2 = new StatsStore(path.join(tmpS, 'data', 'stats.json'), statsIo)
await stats2.load()
assert.equal(stats2.sortedBooks().length, 2)
assert.equal(stats2.sortedBooks().find(([p]) => p === 'A/书一.epub')![1].seconds, 420, '统计应从磁盘完整恢复')
assert.equal(todayKey(new Date('2026-09-25')).length, 10)

// 计时口径：记这一拍的长度，而不是「距上次交互多久」
{
	const T = 15_000
	const t0 = 1_000_000
	// 正常一拍：上次交互在 3 秒前 → 记满 15 秒
	assert.equal(accrueTick({ now: t0 + T, lastTickAt: t0, lastActive: t0 + T - 3_000 }), 15, '活跃的一拍应记满 tick')
	// 人走了 90 秒：一拍都不记（开着书吃饭不该算阅读）
	assert.equal(accrueTick({ now: t0 + T, lastTickAt: t0, lastActive: t0 - 75_000 }), 0, '空闲超过 IDLE 应记 0')
	// 定时器被系统挂起后回来：单拍封顶 2×tick，不把整段空档补上
	assert.equal(accrueTick({ now: t0 + 600_000, lastTickAt: t0, lastActive: t0 + 600_000 - 1_000 }), 30, '长空档应封顶 2×tick')
	// 极端/坏数据不抛、不记
	assert.equal(accrueTick({ now: t0, lastTickAt: t0 + 1, lastActive: t0 }), 0, '时间倒流应记 0')
	assert.equal(accrueTick({ now: t0 + T, lastTickAt: t0, lastActive: Number.NaN }), 0, '坏时间戳应记 0')
}

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


// 17. 笔记 ↔ 批注回写：刚生成的笔记应当零差异
const syncBook: BookData = {
	version: 1,
	bookPath: 'Books/Sync.epub',
	title: '同步测试',
	author: '',
	annotations: [
		{ id: 'aa11', cfi: 'txt:10-20', text: '第一行摘录\n第二行摘录', color: 'yellow', note: '原评论', createdAt: 1, updatedAt: 1, sectionIndex: 0, chapter: '第一章' },
		{ id: 'bb22', cfi: 'txt:40-50', text: '另一段', color: 'green', createdAt: 1, updatedAt: 1, sectionIndex: 0, chapter: '第一章' },
	],
}
const note0 = buildNote(syncBook, 'sync-book', null)
assert.equal(parseNoteEntries(note0).length, 2, '应解析出两条生成条目')
const plan0 = planSync(syncBook, note0)
assert.equal(plan0.changes.length, 0, '刚生成的笔记不应产生回写差异')
assert.equal(plan0.missing.length, 0)

// 18. 改评论 / 改摘录 → 各自产出一条改动
const edited = note0.replace('原评论', '改后的评论').replace('第二行摘录', '第二行摘录（改）')
const plan1 = planSync(syncBook, edited)
assert.equal(plan1.changes.length, 2, '评论与摘录各一条')
assert.deepEqual(plan1.changes.map(c => c.field).sort(), ['note', 'text'])
const applied = applySync(syncBook, plan1.changes)
assert.equal(applied, 2)
assert.equal(syncBook.annotations[0].note, '改后的评论')
assert.ok(syncBook.annotations[0].text.includes('（改）'))

// 19. 笔记里少一条 → 只记 missing，不删数据
const partial = buildNote({ ...syncBook, annotations: [syncBook.annotations[0]] }, 'sync-book', null)
const plan2 = planSync(syncBook, partial)
assert.equal(plan2.missing.length, 1, '缺失条目应进 missing')
assert.equal(plan2.changes.length, 0)

// 20. 未知块 id 被忽略；没有 %% 块的评论记为 skipped
const withUnknown = note0.replace(NOTE_END, '\n[某条](x) ^grove-zzzz\n' + NOTE_END)
assert.deepEqual(planSync(syncBook, withUnknown).unknown, ['zzzz'])
const noCommentBlock = note0.replace('%%\n原评论\n%%', '')
const plan3 = planSync(syncBook, noCommentBlock)
assert.equal(plan3.skipped.length, 1, '无法判断的评论应跳过')
assert.equal(plan3.changes.filter(c => c.field === 'note').length, 0)

// 21. 摘录里的空段落：模板用 `>` 空行分隔，回读时丢失空行不应算改动
const blankBook: BookData = {
	version: 1,
	bookPath: 'Books/Blank.epub',
	title: '空行测试',
	author: '',
	annotations: [
		{ id: 'cc33', cfi: 'txt:1-9', text: '第一段\n\n第二段', color: 'yellow', createdAt: 1, updatedAt: 1, sectionIndex: 0, chapter: '第一章' },
	],
}
assert.equal(normalizeExcerpt('a\n\nb'), 'a\nb')
assert.equal(planSync(blankBook, buildNote(blankBook, 'blank', null)).changes.length, 0, '空行差异不应算改动')

// 22. frontmatter 统计字段：新笔记直接写全，老笔记刷新时补齐且不动用户字段
const metaNote = buildNote(syncBook, 'sync-book', null, null, {
	annotations: 2,
	format: 'EPUB',
	progress: 42,
	status: '在读',
	seconds: 720,
	lastRead: new Date('2026-11-06T12:00:00Z').getTime(),
	publisher: '某出版社',
})
for (const line of [
	'grove_annotations: 2',
	'grove_format: "EPUB"',
	'grove_progress: 42',
	'grove_status: "在读"',
	'grove_seconds: 720',
	'grove_last_read: 2026-11-06',
	'grove_publisher: "某出版社"',
]) assert.ok(metaNote.includes(line), '缺少字段 ' + line)
const withUserField = metaNote.replace('grove-book: sync-book', 'grove-book: sync-book\ncustom-field: keep-me')
const refreshed = buildNote(syncBook, 'sync-book', withUserField, null, { annotations: 3 })
assert.ok(refreshed.includes('custom-field: keep-me'), '不能删掉用户自定义字段')
assert.ok(refreshed.includes('grove_annotations: 3'), '统计字段应更新')
// 旧版连字符字段应在刷新时被清掉（Dataview 会把 grove-status 当减法）
const legacyNote = metaNote.replace('grove_status: "在读"', 'grove-status: "在读"')
const cleaned = buildNote(syncBook, 'sync-book', legacyNote, null, {
	annotations: 1,
	format: 'EPUB',
	progress: 10,
	status: '在读',
	seconds: 60,
	lastRead: Date.now(),
})
assert.ok(!cleaned.includes('grove-status:'), '旧字段应被清理')
assert.ok(cleaned.includes('grove_status:'), '新字段应在')

// 23. Canvas 卡片：正文结构、排布不重叠、坏文件不静默清空
const cardText = buildCardText(
	{ id: 'aa11', cfi: 'txt:1-9', text: '第一行\n第二行', color: 'yellow', note: '我的评论', createdAt: 1, updatedAt: 1 },
	'测试书',
	'[[笔记#^grove-aa11|打开笔记]]',
)
assert.ok(cardText.includes('> 第一行') && cardText.includes('> 第二行'), '摘录应转成引用块')
assert.ok(cardText.includes('我的评论'), '评论应带上')
assert.ok(cardText.includes('打开笔记'), '应带回笔记链接')

const canvasDoc = emptyCanvas()
const added = appendCards(canvasDoc, [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd', color: '3' }])
assert.equal(added, 4)
assert.equal(canvasDoc.nodes.length, 4)
const [n0, n1, n2, n3] = canvasDoc.nodes
assert.equal(n0.y, n1.y, '前三个同行')
assert.ok(n3.y > n0.y, '第四个换行')
assert.ok(n0.x + n0.width <= n1.x, '卡片左右不能重叠')
assert.equal(n3.color, '3')
const round = parseCanvas(serializeCanvas(canvasDoc))
assert.equal(round.nodes.length, 4)
let threw = false
try { parseCanvas('not json') } catch { threw = true }
assert.ok(threw, '坏文件应抛错而不是清空')

// 24. 卡片抬头取短书名，别让整段副标题占满第一行
assert.equal(shortTitle('枪炮、病菌与钢铁（全新版本，重磅上市）'), '枪炮、病菌与钢铁')
assert.equal(shortTitle('置身事内：中国政府与经济发展'), '置身事内')

// 25. 纯 JS SHA-1 必须与 node:crypto 完全一致（书 id 变了会认不回旧数据）
for (const c of ['Grove Reader/书籍/枪炮.epub', 'Books/a b/c.epub', '中文/路径 with space.epub', 'a'.repeat(200)]) {
	const expected = createHash('sha1').update(c.replace(/\\/g, '/')).digest('hex')
	assert.equal(bookIdFor(c), expected, 'sha1 不一致: ' + c)
}
assert.equal(bookIdFor('中文/路径 with space.epub'), bookIdFor('中文/路径 with space.epub'))

// 26. 全局检索索引从内存数据生成，不再扫目录
const idx = buildSearchIndex(
	[{ version: 1, bookPath: 'Books/a.epub', title: '书名A（作者）', author: '作者', annotations: [
		{ id: 'x', cfi: 'epubcfi(/6/2)', text: '关键词命中', color: 'yellow', note: '备注', createdAt: 1, updatedAt: 2 },
		{ id: 'y', cfi: 'epubcfi(/6/4)', text: '另一段', color: 'yellow', createdAt: 1, updatedAt: 1 },
	] }],
	p => p === 'Books/a.epub',
)
assert.equal(idx.length, 2)
assert.equal(idx[0].bookTitle, '书名A')
assert.equal(idx[0].bookExists, true)
assert.equal(searchDocs(idx, '关键词').length, 1)
assert.equal(searchDocs(idx, '关键词', { onlyNotes: true }).length, 1)

// 27. 回收站（PlatformIO 版）：移入 → 恢复 → 再移入 → 清空
const vaultTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-vault-'))
const trashRoot = path.join(vaultTmp, 'Grove Reader')
const trashBooksDir = path.join(trashRoot, 'data', 'books')
const trashCoversDir = path.join(trashRoot, 'data', 'covers')
fs.mkdirSync(trashBooksDir, { recursive: true })
fs.mkdirSync(trashCoversDir, { recursive: true })
fs.mkdirSync(path.join(vaultTmp, 'Grove Reader', '书籍'), { recursive: true })
const trashBookRel = 'Grove Reader/书籍/回收站测试.epub'
fs.writeFileSync(path.join(vaultTmp, trashBookRel), 'book-bytes-0123456789')
fs.writeFileSync(path.join(trashBooksDir, 'abc.json'), '{"version":1}')
fs.writeFileSync(path.join(trashCoversDir, 'abc.jpg'), 'cover-bytes')

const trashStore = new TrashStore(trashRoot, new DesktopIO(), vaultTmp)
const trashEntry = await trashStore.move({
	title: '回收站测试',
	bookPath: trashBookRel,
	dataFile: 'abc.json',
	cover: 'abc.jpg',
})
assert.equal(fs.existsSync(path.join(vaultTmp, trashBookRel)), false, '移入后原文件应已消失')
assert.equal(fs.existsSync(path.join(trashBooksDir, 'abc.json')), false, '批注 JSON 应已移入回收站')
assert.ok(trashEntry.size > 0, '回收站条目应记录大小')
assert.equal((await trashStore.list()).length, 1)

await trashStore.restore(trashEntry.id)
assert.equal(fs.existsSync(path.join(vaultTmp, trashBookRel)), true, '恢复后原文件应回到原路径')
assert.equal(fs.existsSync(path.join(trashBooksDir, 'abc.json')), true, '恢复后批注 JSON 应回到原路径')
assert.equal((await trashStore.list()).length, 0, '恢复后回收站应为空')

const trashEntry2 = await trashStore.move({ title: '回收站测试', bookPath: trashBookRel, dataFile: 'abc.json' })
assert.equal((await trashStore.list()).length, 1)
await trashStore.purge(trashEntry2.id)
assert.equal((await trashStore.list()).length, 0, '永久删除后回收站应为空')
assert.equal(fs.existsSync(path.join(vaultTmp, trashBookRel)), false, '永久删除后原文件不应存在')

let restoreRejected = false
try {
	await trashStore.restore('not-exist-id')
} catch {
	restoreRejected = true
}
assert.equal(restoreRejected, true, '恢复不存在的条目应抛错')
assert.equal(await trashStore.empty(), 0, '清空空回收站应返回 0')

// 28. 数据体检（PlatformIO 版）：正常书 / 缺书 / 失效书架
const hv = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-health-'))
const hRoot = path.join(hv, 'Grove Reader')
fs.mkdirSync(path.join(hRoot, 'data', 'books'), { recursive: true })
fs.mkdirSync(path.join(hRoot, '书籍'), { recursive: true })
fs.writeFileSync(path.join(hRoot, '书籍', 'ok.epub'), 'x')
fs.writeFileSync(path.join(hRoot, 'data', 'books', 'ok.json'), JSON.stringify({
	version: 1, bookPath: 'Grove Reader/书籍/ok.epub', title: '正常', annotations: [{ id: '1' }],
}))
fs.writeFileSync(path.join(hRoot, 'data', 'books', 'gone.json'), JSON.stringify({
	version: 1, bookPath: 'Grove Reader/书籍/gone.epub', title: '丢了',
}))
fs.writeFileSync(path.join(hRoot, 'data', 'shelf.json'), JSON.stringify({
	entries: { 'Grove Reader/书籍/gone.epub': {} },
}))
const hr = await buildHealthReport(new DesktopIO(), hv, hRoot, '')
assert.equal(hr.jsonCount, 2)
assert.equal(hr.annotationCount, 1)
assert.equal(hr.missingBooks.length, 1)
assert.equal(hr.staleShelf.length, 1)
assert.equal(healthCleanupCount(hr), 1)

// 29. 备份导出（PlatformIO 版）：正常导出、标记文件、目标被占用时阻断
const bv = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-backup-'))
const bDataRoot = path.join(bv, 'Grove Reader')
const bPluginDir = path.join(bv, '.obsidian', 'plugins', 'grove-reader')
fs.mkdirSync(path.join(bDataRoot, 'data', 'books'), { recursive: true })
fs.mkdirSync(path.join(bDataRoot, 'data', 'covers'), { recursive: true })
fs.mkdirSync(bPluginDir, { recursive: true })
fs.writeFileSync(path.join(bDataRoot, 'data', 'books', 'b1.json'), '{"version":1}')
fs.writeFileSync(path.join(bDataRoot, 'data', 'shelf.json'), '{"entries":{}}')
fs.writeFileSync(path.join(bPluginDir, 'data.json'), '{"scanFolders":[],"aiApiKey":"sk-should-not-leak","aiModel":"glm-4-flash"}')
const bIo = new DesktopIO()
const bRoot = path.join(bv, 'Grove Reader 数据备份')
const bk1 = await exportDataBackup({ io: bIo, root: bRoot, dataRoot: bDataRoot, pluginDir: bPluginDir })
assert.equal(bk1.status, 'done')
assert.equal(bk1.bookCount, 1)
assert.equal(fs.existsSync(path.join(bRoot, 'books', 'b1.json')), true, '批注 JSON 应被复制到备份目录')
assert.equal(fs.existsSync(path.join(bRoot, 'shelf.json')), true, '书架缓存应被复制')
assert.equal(fs.existsSync(path.join(bRoot, '.grove-backup')), true, '应写入备份目录标记')
assert.equal(fs.existsSync(path.join(bRoot, '说明.md')), true, '应生成说明文件')
{
	// 备份里可以带走设置，但不能带走 AI Key
	const copied = JSON.parse(fs.readFileSync(path.join(bRoot, 'data.json'), 'utf-8'))
	assert.equal(copied.aiApiKey, undefined, '备份里的 data.json 不应包含 aiApiKey')
	assert.equal(copied.aiModel, 'glm-4-flash', '其余设置应原样保留')
	const original = JSON.parse(fs.readFileSync(path.join(bPluginDir, 'data.json'), 'utf-8'))
	assert.equal(original.aiApiKey, 'sk-should-not-leak', '原 data.json 不应被改动')
}

const clashRoot = path.join(bv, '已有笔记')
fs.mkdirSync(path.join(clashRoot, 'books'), { recursive: true })
const bk2 = await exportDataBackup({ io: bIo, root: clashRoot, dataRoot: bDataRoot, pluginDir: bPluginDir })
assert.equal(bk2.status, 'blocked', '目标里已有同名目录且没有标记时应中止')

// 30. 数据迁移（PlatformIO 版）：复制 + 份数校验 + 目标非空时拒绝
const mTarget = path.join(bv, 'MovedRoot')
const check1 = await checkMigrateTarget(bIo, bDataRoot, mTarget)
assert.equal(check1.ok, true)
const m1 = await migrateDataFolder(bIo, bDataRoot, mTarget)
assert.equal(m1.books, 1)
assert.equal(fs.existsSync(path.join(mTarget, 'data', 'books', 'b1.json')), true, '迁移后目标应存在批注 JSON')
const check2 = await checkMigrateTarget(bIo, bDataRoot, mTarget)
assert.equal(check2.ok, false, '目标已有数据时应拒绝迁移')
const check3 = await checkMigrateTarget(bIo, bDataRoot, bDataRoot)
assert.equal(check3.ok, false, '迁移到自身应被拒绝')

// 31. 写盘回读去重：自己写的内容不该被当成外部修改（否则会和 vault.modify 死循环）
const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-store-'))
const storeDedupe = new BookStore(sd, 2, new DesktopIO())
await storeDedupe.preload()
const sb = storeDedupe.load('Books/x.epub')
sb.title = 'X'
storeDedupe.save(sb)
await storeDedupe.flush()
assert.equal(await storeDedupe.reloadFromDisk(bookIdFor('Books/x.epub')), false, '内容未变时不应判定为外部修改')
const sfile = path.join(sd, 'data', 'books', `${bookIdFor('Books/x.epub')}.json`)
const editedRW = JSON.parse(fs.readFileSync(sfile, 'utf8')) as { title: string }
editedRW.title = 'Y'
fs.writeFileSync(sfile, JSON.stringify(editedRW, null, 2))
assert.equal(await storeDedupe.reloadFromDisk(bookIdFor('Books/x.epub')), true, '外部改写后应判定为有更新')

// 32. 摘录双链：生成 → 解析往返、特殊字符、库外书降级、笔记回写不误判
{
	const target = {
		cfi: 'epubcfi(/6/4!/2[Chap],/2,/4)',
		text: snippetOf('高亮一\n第二行（很长很长的一段摘录文字，超过二十四个字符后要被截断）'),
		chapter: '第一章 起风了',
	}
	const link = wikilinkFor('Grove Reader/书籍/围城.epub', target, '⤴ 回原文')
	assert.ok(link.startsWith('[[Grove Reader/书籍/围城.epub#grove-cfi='), '应是指向书文件的双链')
	assert.ok(link.endsWith('|⤴ 回原文]]'))
	assert.ok(!link.includes('[Chap]'), '方括号必须转义，否则会提前闭合链接')
	const back = parseGroveHref(link)!
	assert.equal(back.vaultPath, 'Grove Reader/书籍/围城.epub')
	assert.equal(back.target.cfi, target.cfi, 'CFI 应能原样还原')
	assert.equal(back.target.text, target.text, '摘录片段应能原样还原')
	assert.equal(back.target.chapter, '第一章 起风了')
	// DOM 里给的是 app:// 外壳，路径是 URL 编码的
	const dom = parseGroveHref('app://obsidian.md/Grove%20Reader/%E4%B9%A6%E7%B1%8D/%E5%9B%B4%E5%9F%8E.epub#grove-cfi=epubcfi(/6/4)')!
	assert.equal(dom.vaultPath, 'Grove Reader/书籍/围城.epub')
	// 书名带 # → 退化成 markdown 链接形态，仍能解析回来
	const hashLink = wikilinkFor('Grove Reader/书籍/C# 入门.pdf', { cfi: 'page:3' }, '⤴ 回原文')
	assert.ok(hashLink.startsWith('[⤴ 回原文](Grove%20Reader/'), '带 # 的书名应退化为 markdown 链接')
	assert.equal(parseGroveHref(hashLink)!.vaultPath, 'Grove Reader/书籍/C# 入门.pdf')
	// 不是自家定位串的链接一律不接管
	assert.equal(parseGroveHref('[[某篇笔记#某个标题]]'), null)
	assert.equal(parseGroveHref('[[Grove Reader/书籍/围城.epub]]'), null)
	assert.equal(parseGroveHref('obsidian://grove?book=id&cfi=x'), null)
	assert.equal(parseSubpath('bzr-cfi=x'), null)
	// 库外书（绝对路径）写不了双链，模板层退回协议链接
	const absNote = buildNote({ ...data, bookPath: 'D:/Books/围城.epub' }, 'id123', null)
	assert.ok(absNote.includes('obsidian://grove?'), '库外书应退回协议链接')
	assert.ok(!absNote.includes('#grove-cfi='), '库外书不应写双链')
	// 双链笔记的回写解析：链接行不能被当成摘录或未知条目
	const wikiNote = buildNote(data, 'id123', null)
	const wikiPlan = planSync(data, wikiNote)
	assert.equal(wikiPlan.changes.length, 0, '双链笔记不应产生回写差异')
	assert.equal(wikiPlan.unknown.length, 0)
	assert.equal(wikiPlan.entries, 2)
}

// 33. PDF 换版本：页码失效 → 百分比换算落一页
{
	assert.equal(pageFromFraction(0, 7), 1)
	assert.equal(pageFromFraction(1, 7), 7)
	assert.equal(pageFromFraction(0.5, 7), 4)
	assert.equal(pageFromFraction(2, 7), 7, '超界百分比应夹到末页')
	assert.equal(pageFromFraction(Number.NaN, 7), 1, '坏数值退回首页')
	assert.equal(pageFromFraction(0.5, 0), 1, '页数未知退回首页')
}

// 34. 旧笔记不悄悄换格式：自动刷新保持旧链接，手动生成才跟随设置
{
	const oldNote = buildNote(data, 'id123', null, null, undefined, { style: 'protocol' })
	const newNote = buildNote(data, 'id123', null, null, undefined, { style: 'wikilink' })
	assert.equal(resolveExcerptLinkStyle('wikilink', oldNote, false), 'protocol', '自动刷新不该改写旧笔记的链接样式')
	assert.equal(resolveExcerptLinkStyle('wikilink', newNote, false), 'wikilink')
	assert.equal(resolveExcerptLinkStyle('wikilink', oldNote, true), 'wikilink', '手动生成应跟随设置')
	assert.equal(resolveExcerptLinkStyle('wikilink', null, false), 'wikilink')
	assert.equal(resolveExcerptLinkStyle('protocol', newNote, true), 'protocol')
}

console.log('SMOKE OK')
}

main().catch(e => {
	console.error(e)
	process.exit(1)
})
