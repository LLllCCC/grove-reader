/** 弹窗与对话框文案（英文）。键为中文原文。 */
export const EN_MODALS: Record<string, string> = {
	// —— 通用按钮 ——
	'保存': 'Save',
	'取消': 'Cancel',
	'确定': 'OK',
	'继续': 'Continue',
	'删除': 'Delete',
	'添加': 'Add',
	'导出': 'Export',
	'导出…': 'Export…',
	'恢复': 'Restore',
	'评论': 'Comment',
	'摘录': 'Excerpt',
	'评分': 'Rating',
	'全选': 'Select all',
	'全不选': 'Select none',
	'应用改动': 'Apply changes',
	'永久删除': 'Delete permanently',
	'删除中…': 'Deleting…',
	'确认操作': 'Confirm',
	'确认清空': 'Confirm clearing',
	'已关闭': 'Closed',
	'复制报告': 'Copy report',
	'体检报告已复制': 'Health report copied',
	'复制失败，请手动选择文本': 'Copy failed — select the text manually',
	'名称不能为空': 'The name cannot be empty',
	'请输入关键词': 'Enter a keyword',
	'请填写模板名称': 'Enter a template name',
	'请填写模板文件路径': 'Enter the template file path',
	'请填写文件夹路径': 'Enter a folder path',
	'请填写以 http:// 或 https:// 开头的图片链接': 'Enter an image URL starting with http:// or https://',
	'（空）': '(empty)',
	' · 含阅读笔记': ' · has a reading note',

	// —— 书籍信息 ——
	'书名': 'Title',
	'作者': 'Author',
	'出版社': 'Publisher',
	'一句话简介': 'One-line summary',
	'未评分': 'Unrated',
	'未阅读': 'Unread',
	'下载并设为封面': 'Download and set as cover',
	'下载中…': 'Downloading…',
	'用图片链接更换封面': 'Change cover from image URL',
	'粘贴图片直链（http / https），支持 jpg、png、webp、gif，建议使用 2:3 的竖图。':
		'Paste a direct image URL (http / https). jpg, png, webp and gif are supported; a 2:3 portrait image works best.',
	'AI 生成': 'AI generated',
	'选择要阅读的电子书或 PDF…': 'Choose an e-book or PDF to read…',

	// —— 笔记与模板 ——
	'笔记模板': 'Note template',
	'笔记文件不存在': 'Note file not found',
	'笔记 ID 失联': 'Note ID no longer resolves',
	'笔记里的书籍 ID 找不到数据': 'The book ID in the note has no data',
	'从笔记同步批注': 'Sync annotations from the note',
	'勾选要写回批注数据的改动。笔记里被删掉的条目不会删批注，只在这里提示。':
		'Tick the changes to write back to the annotation data. Entries deleted from the note never delete annotations; they are only listed here.',
	'没有检测到被改动的摘录或评论': 'No edited excerpts or comments found',
	'这本书还没有生成阅读笔记': 'No reading note has been generated for this book',
	'模板名称，例如：教材 / 小说': 'Template name, e.g. Textbook / Novel',
	'模板文件路径，例如：Grove Reader/阅读笔记/教材模板.md': 'Template file path, e.g. Grove Reader/阅读笔记/Textbook.md',
	'模板是库内 Markdown 文件；可以复制一份现有模板再改。': 'Templates are Markdown files in your vault; copy an existing one and edit it.',
	'填入库内文件夹路径，或本机绝对路径（如 D:\\Books）。输入时可从建议中选择。':
		'Enter a vault folder path or an absolute path on this machine (e.g. D:\\Books). Suggestions appear as you type.',
	'填一个本机其他盘或优盘的路径（如 G:\\Grove备份），「立即备份」时会额外复制一份过去——同一块盘上的备份防不了磁盘故障。留空则只备份到库内':
		'Path on another disk or USB drive (e.g. G:\\Grove backup); "Back up now" copies a second set there. A backup on the same disk cannot survive disk failure. Leave empty to back up into the vault only.',
	'例如 G:\\Grove备份': 'e.g. G:\\Grove backup',
	'例如：一本讲如何用环境设计替代意志力的实用小书':
		'e.g. A short practical book on designing your environment instead of relying on willpower',

	// —— 画布 / 书单 ——
	'发送批注到 Canvas': 'Send annotations to Canvas',
	'画布名称': 'Canvas name',
	'新建画布': 'New canvas',
	'按章分组': 'Group by chapter',
	'按颜色分组': 'Group by colour',
	'不分组': 'No grouping',
	'分组': 'Grouping',
	'分类': 'Categories',
	'组内按顺序连线': 'Connect items in order within a group',
	'新建书单…': 'New reading list…',
	'选择书单…': 'Choose a reading list…',
	'移出书单（回到未分类）': 'Remove from list (back to Uncategorised)',
	'Grove Reader：请先给新画布起个名字': 'Grove Reader: give the new canvas a name first',

	// —— 搜索 ——
	'搜索划线、评论、章节或书名…': 'Search highlights, comments, chapters or titles…',
	'搜索书名 / 位置 / 片段': 'Search title / location / snippet',
	'输入关键词，搜索所有书的划线与评论。空格分隔多个词时按 AND 匹配。':
		'Enter keywords to search highlights and comments across all books. Space-separated words are matched with AND.',
	'只看有评论的': 'Only with comments',
	'没有匹配的批注。试试减少关键词，或取消「只看有评论的」。':
		'No matching annotations. Try fewer keywords, or clear "Only with comments".',
	'没有匹配的书签': 'No matching bookmarks',
	'还没有书签。': 'No bookmarks yet.',
	'删除书签': 'Delete bookmark',
	'跳到书签位置': 'Jump to bookmark',
	'在阅读时点工具栏的书签按钮，就能把当前位置记下来。':
		'Tap the bookmark button in the toolbar while reading to save your position.',

	// —— 统计 ——
	'今日': 'Today',
	'今天': 'Today',
	'昨天': 'Yesterday',
	'今日阅读': "Today's reading",
	'今日页数': "Today's pages",
	'今日打卡': 'Check in today',
	'今日已打卡': 'Checked in today',
	'累计阅读': 'Total reading',
	'连续阅读': 'Reading streak',
	'活跃天数': 'Active days',
	'天数': 'Days',
	'有阅读记录的天数': 'Days with reading activity',
	'年度目标': 'Yearly goal',
	'未设目标': 'No goal set',
	'阅读时段': 'Reading time of day',
	'最近 12 周': 'Last 12 weeks',
	'最近 14 天': 'Last 14 days',
	'读完预测（按近 7 天速度）': 'Finish prediction (last 7 days)',
	'还没有阅读记录。打开一本书读一会儿，这里就会出现数据。':
		'No reading records yet. Open a book and read for a while — data will show up here.',
	'少': 'Less',
	'多': 'More',
	'批注评论': 'Annotation comments',
	'生成阅读海报': 'Create reading poster',
	'Grove Reader：今日打卡成功': 'Grove Reader: checked in for today',
	'Grove Reader：海报生成失败，请稍后再试': 'Grove Reader: failed to create the poster. Try again later.',
	'Grove Reader/书摘卡': 'Grove Reader/Excerpt cards',

	// —— 评论输入 ——
	'写下你的想法…（Ctrl+Enter 保存，留空保存即清除评论）':
		'Write your thoughts… (Ctrl+Enter to save; saving an empty box clears the comment)',

	// —— 回收站 ——
	'回收站是空的。': 'Trash is empty.',
	'回收站暂不可用。': 'Trash is temporarily unavailable.',
	'同时删除原文件（移入插件回收站，30 天后清理）':
		'Also delete the original file (moved to the plugin trash, purged after 30 days)',
	'勾选删除阅读笔记会自动勾选删除原文件；取消删除原文件会同时取消笔记。删除后可在 设置 → 回收站 恢复，30 天后自动清理。':
		'Deleting the reading note also selects deleting the original file; clearing that also clears the note. Deleted items can be restored in Settings → Trash and are purged after 30 days.',

	// —— 数据体检 ——
	'没有发现结构性问题：书籍路径、笔记、书架、书单、统计、AI 要点索引和语义索引都能对上。':
		'No structural problems found: book paths, notes, shelf, reading lists, stats, AI outline index and semantic index all line up.',
	'孤儿批注 JSON 不会被自动删除；确认无用后可在 data/books/ 手动清理（建议先备份）。':
		'Orphan annotation JSON is never deleted automatically. Once you are sure, clean it up manually in data/books/ (back up first).',
	'找不到原文件的批注': 'Annotations whose original file is missing',
	'原文件缺失': 'Original file missing',
	'无路径': 'No path',
	'重复路径': 'Duplicate path',
	'同一路径有多份批注数据': 'Several annotation records share one path',
	'书单失效': 'Reading list broken',
	'书单指向不存在的文件': 'The reading list points to a missing file',
	'书架缓存失效': 'Shelf cache broken',
	'书架缓存指向不存在的文件': 'The shelf cache points to a missing file',
	'统计失效': 'Stats broken',
	'阅读统计指向不存在的文件': 'The reading stats point to a missing file',
	'语义索引失效': 'Semantic index broken',
	'语义索引损坏或对应的书已不存在': 'The semantic index is corrupted or the book no longer exists',
	'AI 要点索引孤儿': 'Orphan AI outline index',
	'AI 要点索引对应的书已不存在': 'The book for this AI outline index no longer exists',
	'复习排期异常': 'Review schedule error',
	'复习排期异常不会影响阅读与笔记；这条划线下次评分时会被正常覆盖，也可用命令「清空全部复习排期」重来。':
		'A broken review schedule does not affect reading or notes; the highlight is overwritten the next time you rate it, or start over with "Clear every review schedule".',
	'只记录删除书籍、清空批注、恢复隐藏、备份失败等关键动作，最多保留 200 条；翻页、搜索等高频操作不记录。':
		'Only key actions are logged (deleting books, clearing annotations, restoring hidden books, failed backups), up to 200 entries. High-frequency actions such as page turns and searches are not logged.',
	'还没有记录。': 'No entries yet.',
	'设置 → 每日复习条数': 'Settings → Daily review limit',
	'重新索引': 'Reindex',
	'清空批注': 'Clear annotations',
}
