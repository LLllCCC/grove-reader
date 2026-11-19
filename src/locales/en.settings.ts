/** 设置页文案（英文）。键为中文原文。 */
export const EN_SETTINGS: Record<string, string> = {
	'{name} 设置': '{name} settings',
	'界面语言': 'Interface language',
	'选择插件界面使用的语言。跟随 Obsidian 时随应用语言自动切换，改动后重新打开视图或重启 Obsidian 才会全部生效。':
		'Language used by the plugin interface. "Follow Obsidian" switches with the app language. Reopen views or restart Obsidian for the change to apply everywhere.',
	'界面语言已切换，重新打开视图或重启 Obsidian 后全部生效。':
		'Interface language changed. Reopen views or restart Obsidian for it to apply everywhere.',
	'外观': 'Appearance',
	'书架': 'Bookshelf',
	'阅读与笔记': 'Reading & notes',
	'数据与维护': 'Data & maintenance',

	// —— 标志 / 外观 ——
	'标志': 'Logo',
	'选一个显示在标签页、功能区和空书架上的标志。标签页图标会在重新打开书架后更新。':
		'Pick the logo shown in the tab, ribbon and empty shelf. The tab icon updates when you reopen the shelf.',
	'原始图标': 'Original icon',
	'Obsidian 自带的 library 图标': 'The library icon built into Obsidian',
	'图标': 'Icons',
	'文字': 'Text',
	'图标更省空间；文字按钮更好认，适合不熟悉图标的场景':
		'Icons save space; text buttons are easier to recognise when icons are unfamiliar',
	'书架显示': 'Shelf display',
	'卡片上显示哪些信息。默认只留最常用的几项，信息多时卡片会换行变高。':
		'What each card shows. Only the most useful fields are on by default; with more fields the card wraps and gets taller.',
	'格式徽章': 'Format badge',
	'在卡片信息行显示 EPUB / PDF / MOBI 等格式标签': 'Show the EPUB / PDF / MOBI format badge on the card',
	'作者与出版社合并一行': 'Merge author and publisher on one line',
	'关闭后作者、出版社各占一行，卡片会更高': 'When off, author and publisher take one line each and cards get taller',
	'阅读进度': 'Reading progress',
	'封面底部进度条 + 卡片上的百分比；读完后显示「已读」':
		'Progress bar at the bottom of the cover plus a percentage on the card; shows "Read" once finished',
	'批注条数': 'Annotation count',
	'显示这本书有多少条批注': 'Show how many annotations a book has',
	'文件大小': 'File size',
	'在卡片上显示文件体积（关闭时仍可在悬浮提示里看到）': 'Show the file size on the card (still in the tooltip when off)',
	'最近阅读': 'Recently read',
	'书架顶部显示最近在读、尚未读完的书（最多 6 本）':
		'Show recently read but unfinished books at the top of the shelf (up to 6)',
	'书单色条': 'Reading-list colour bar',
	'卡片左侧显示所属书单的色条（颜色由书单自动生成）': 'Colour bar for the reading list a book belongs to',
	'显示「3 天前」这类相对时间': 'Show relative times such as "3 days ago"',
	'已生成阅读笔记的书显示文档图标，点击直接打开笔记':
		'Books with a generated note show a document icon; tap it to open the note',
	'工具栏样式': 'Toolbar style',
	'工具栏按钮顺序': 'Toolbar button order',
	'颜色与「评论」固定在左侧；其余按钮按这里从上到下排列，重开书本后生效':
		'Colour and "Comment" stay on the left; the other buttons follow this order top to bottom. Applies after reopening the book.',
	'隐藏的工具栏按钮': 'Hidden toolbar buttons',
	'用逗号分隔：评论 / 外观 / AI 问答 / 导读 / 笔记 / 书签 / 批注；重开书本后生效':
		'Comma separated: Comment / Appearance / Ask AI / Guide / Notes / Bookmarks / Annotations. Applies after reopening the book.',
	'隐藏与恢复': 'Hide & restore',
	'恢复默认': 'Restore defaults',
	'默认高亮颜色': 'Default highlight colour',
	'手机工具栏颜色菜单里的「默认色」按钮使用这个颜色；桌面 5 个色点不变':
		'Used by the "Default colour" button in the mobile colour menu; the five desktop dots are unchanged',
	'EPUB 高亮样式': 'EPUB highlight style',
	'马克笔（下划色带）': 'Marker (underline band)',
	'整行色块': 'Full row',
	'马克笔＝下半段色带 + 底部细线；整行色块＝整行半透明填充。重开书本后生效':
		'Marker = colour band on the lower half plus a thin baseline; Full row = translucent fill across the line. Applies after reopening the book.',
	'关闭动画、阴影与悬停位移；手机工具栏只留颜色、评论、外观、笔记、批注 5 个按钮，并启用点正文上下区域翻页':
		'Disable animations, shadows and hover movement; the mobile toolbar keeps only colour, comment, appearance, notes and annotations, and tapping the top/bottom of the text turns pages',
	'e-ink / 极简模式': 'E-ink / minimal mode',
	'手机上点正文上下区域翻页': 'Tap top/bottom of text to turn pages (mobile)',
	'开启后，手机点正文上方 1/4 翻到上一页、下方 1/4 翻到下一页；中间区域仍是展开工具栏。默认关闭，避免误触':
		'When on, tapping the top quarter on mobile goes to the previous page and the bottom quarter to the next; the middle still opens the toolbar. Off by default to avoid mis-taps.',
	'手机上双指轻按切换沉浸阅读': 'Two-finger tap toggles immersive reading (mobile)',
	'开启后，双指同时轻点正文会隐藏/显示工具栏与侧栏，适合手机全屏阅读。默认开启':
		'When on, a two-finger tap hides or shows the toolbar and sidebar, for full-screen reading on mobile. On by default.',
	'打开书本时同时展开批注列表': 'Expand the annotations panel when a book opens',
	'关闭后，打开书时只显示正文；可随时点工具栏的「批注列表」按钮唤出侧栏。在正文中点击已批注的文段时，侧栏仍会自动展开并定位到对应批注':
		'When off, opening a book shows only the text; use the "Annotations" toolbar button to bring the sidebar back at any time. Tapping an annotated passage still opens the sidebar at that annotation.',
	'朗读语速': 'Speech rate',
	'系统语音的朗读速度；1.0 为正常': 'Speech rate of the system voice; 1.0 is normal',
	'TXT 页面版式': 'TXT page layout',
	'单页': 'Single page',
	'双页': 'Spread',
	'自动': 'Auto',
	'单页＝一屏一页；双页＝左右两栏像翻书；自动＝窗口够宽时双页、变窄自动回到单页（与 EPUB 缩放时自动分栏的规律一致）':
		'Single = one screen per page; Spread = two columns like a paper book; Auto = spread when the window is wide enough, single when it narrows (same rule as EPUB columns).',
	'TXT 键盘翻页方向': 'TXT arrow-key direction',
	'鼠标滚轮始终上下滚动即翻页；这里决定方向键用 ←/→ 还是 ↑/↓':
		'The mouse wheel always turns pages; this decides whether the arrow keys are ←/→ or ↑/↓',

	// —— 书架 / 扫描 ——
	'扫描文件夹': 'Scan folders',
	'添加扫描文件夹': 'Add scan folder',
	'添加文件夹': 'Add folder',
	'书架从这些文件夹扫描书籍；支持库内文件夹或本机绝对路径（子文件夹会一并扫描）。PDF、TXT 也会被收纳进书架，点击用 Obsidian 原生视图或 Grove TXT 视图打开':
		'Scan these folders for books; vault folders or absolute paths on this machine (subfolders included). PDF and TXT are collected too; tapping them opens Obsidian\'s native view or the Grove TXT view.',
	'例如：书籍': 'e.g. Books',
	'从书架移除的书籍': 'Books removed from the shelf',
	'在书架右键「删除书籍…」且不勾选删除原文件时，书会暂时收在这里':
		'Books removed with "Delete book…" without deleting the original file wait here',
	'全部恢复': 'Restore all',
	'已删除的书籍': 'Deleted books',
	'移除': 'Remove',

	// —— 阅读与笔记 ——
	'笔记文件夹': 'Notes folder',
	'生成的阅读笔记保存位置（相对库根目录，输入时可从建议中选择；修改后旧笔记会在下次生成时自动移过去）':
		'Where generated reading notes are saved (relative to the vault root; pick from the suggestions). Existing notes move there the next time they are generated.',
	'默认笔记模板': 'Default note template',
	'模板文件': 'Template file',
	'默认模板': 'Default template',
	'模板文件路径（库内）。文件不存在时使用内置默认模板；可添加多套模板，按书单独切换':
		'Template file path inside the vault. The built-in template is used when the file is missing; add several templates and switch per book.',
	'添加模板': 'Add template',
	'添加笔记模板': 'Add note template',
	'设为默认': 'Set as default',
	'从列表移除（不删模板文件）': 'Remove from list (keeps the template file)',
	'新书默认使用这一套；单本书可在书架右键「笔记模板…」单独切换':
		'New books use this template; switch per book via "Note template…" in the shelf context menu',
	'打开当前默认模板；文件不存在时会按内置内容创建':
		'Open the current default template; created from the built-in content if the file does not exist',
	'生成 / 打开': 'Generate / open',
	'创建 / 打开': 'Create / open',
	'新增/修改批注时自动更新笔记': 'Update notes automatically when annotations change',
	'仅更新已经点过「生成/更新阅读笔记」的书：加删批注、改评论后约 1.5 秒自动重写笔记的生成区（标记区外你手写的内容会保留）。关闭后需手动点按钮更新':
		'Only books that already have a generated note are updated: about 1.5 s after adding, removing or commenting, the generated section is rewritten (your own text outside the markers is kept). When off, update with the button.',
	'笔记标记': 'Note markers',
	'每日阅读目标': 'Daily reading goal',
	'分钟；0 = 不设目标。用于阅读统计页的今日进度和热力图深浅':
		'minutes; 0 = no goal. Drives today\'s progress and the heat map shading on the reading stats page',
	'每日页数目标': 'Daily page goal',
	'页/天；0 = 不设目标。按翻页 / 换节计数（PDF 按页，EPUB 与 TXT 按屏），统计页显示今日进度':
		'pages/day; 0 = no goal. Counts page turns and section changes (pages for PDF, screens for EPUB and TXT); today\'s progress appears on the stats page.',
	'年度阅读目标': 'Yearly reading goal',
	'本/年；0 = 不设目标。阅读统计页用方格显示今年读完进度':
		'books/year; 0 = no goal. The stats page shows this year\'s progress as a grid',
	'每日复习条数': 'Daily review limit',
	'间隔重复复习每天最多看几条；0 = 关闭复习。命令「今日复习」和书架右上角的复习按钮都按它出题':
		'Maximum reviews per day; 0 disables review. Used by the "Review today" command and the review button in the shelf header.',
	'复习队列包含旧划线': 'Include older highlights in the review queue',
	'开启时，昨天及更早、还没复习过的划线也会排进复习；关闭后只考到期的':
		'When on, highlights from yesterday and earlier that were never reviewed are queued too; when off, only due items are shown',
	'摘录回跳链接样式': 'Excerpt backlink style',
	'双链（推荐）': 'Wikilink (recommended)',
	'协议链接（旧）': 'URI link (legacy)',
	'PDF 链接': 'PDF link',
	'PDF++ 兼容': 'PDF++ compatible',
	'Grove 双链（默认）': 'Grove wikilink (default)',
	'PDF 链接别名': 'PDF link alias',
	'复制链接的格式': 'Link format',
	'复制页链接 / 批注链接时写在竖线后的文字': 'Text placed after the pipe when copying page or annotation links',
	'原文开头': 'Start of the passage',
	'仅页码': 'Page only',
	'书名 · 页码': 'Title · page',
	'双链：笔记里的「↩ 回原文」写成指向书文件的 [[双链]]，能在图谱和反向链接里看到「哪些笔记引了这本书」，插件关掉时也能打开书；协议链接：旧的 obsidian://grove 写法。改完只影响你手动「生成/更新笔记」的笔记，自动刷新不会悄悄改写旧笔记；想一次性换掉，用命令「刷新全部阅读笔记」':
		'Wikilink: "↩ Source" in notes becomes a [[wikilink]] to the book file, so the graph and backlinks show which notes cite it, and the link still works with the plugin disabled. URI: the older obsidian://grove form. Changes only affect notes you generate or update manually; automatic refresh never rewrites old notes. To convert everything at once, run "Refresh all reading notes".',
	'Grove 双链：[[书.pdf#grove-cfi=page:12&r=…]]，点击回到原句并标出框选；PDF++ 兼容：[[书.pdf#page=12&rect=…]]，供安装了 PDF++ 的库使用':
		'Grove wikilink: [[book.pdf#grove-cfi=page:12&r=…]] jumps back to the passage and outlines the selection; PDF++ compatible: [[book.pdf#page=12&rect=…]] for vaults that use PDF++.',

	// —— 数据与维护 ——
	'数据文件夹': 'Data folder',
	'批注数据每本书一个 JSON 文件，默认在插件目录的 data/ 下；填写「数据文件夹」后会改存到库内对应目录（如「Grove Reader」→ Grove Reader/data/）。即使停用或删除插件，已生成的 Markdown 笔记也不受影响。阅读中的字体、背景等外观设置请在阅读界面的「Aa」面板中调整。':
		'One JSON file per book, stored under data/ in the plugin folder by default; with a data folder set they move into the vault (e.g. "Grove Reader" → Grove Reader/data/). Generated Markdown notes are unaffected if you disable or remove the plugin. Reading appearance such as font and background lives in the "Aa" panel of the reader.',
	'批注 JSON、封面、书单、阅读统计的存放位置（库内相对路径）。留空 = 插件目录下的 data/。直接改路径不会搬数据；请用右侧「迁移数据…」复制后重启':
		'Where annotation JSON, covers, reading lists and stats are stored (vault-relative). Empty = data/ inside the plugin folder. Editing the path does not move data; use "Migrate data…" and restart.',
	'迁移数据…': 'Migrate data…',
	'请填写库内相对路径（例如 Grove Reader），不要填盘符或 ..':
		'Enter a vault-relative path such as Grove Reader — no drive letters or ..',
	'自动备份': 'Automatic backups',
	'每天': 'Daily',
	'每周': 'Weekly',
	'关闭': 'Off',
	'每天/每周首次启动时自动把批注、书架、书单导出到库内备份文件夹；关闭则只手动备份':
		'On first launch each day/week, export annotations, shelf and reading lists to the vault backup folder; when off, back up manually only',
	'立即备份': 'Back up now',
	'备份批注数据到库内': 'Back up annotation data into the vault',
	'最大备份数': 'Max backups',
	'每本书的批注数据最多保留多少份自动备份（每 10 分钟最多写一份）':
		'How many automatic backups to keep per book (at most one every 10 minutes)',
	'库内备份文件夹': 'Vault backup folder',
	'备份额外保存到（可选）': 'Also save backups to (optional)',
	'填一个本机其他盘或优盘的路径（如 G:\\Grove备份），「立即备份」时会额外复制一份过去——同一块盘上的备份防不了磁盘故障。留空则只备份到库内':
		'Path on another disk or USB drive (e.g. G:\\Grove backup); "Back up now" copies a second set there. A backup on the same disk cannot survive disk failure. Leave empty to back up into the vault only.',
	'例如 G:\\Grove备份': 'e.g. G:\\Grove backup',
	'「立即备份」写入的库内文件夹（相对路径，可含子目录，如「00-Obsidian插件/插件运行时产生的文件/Grove Reader/数据备份」）。修改后光标离开输入框时，旧文件夹里的备份自动转移到新路径':
		'Vault folder used by "Back up now" (relative, subfolders allowed, e.g. "00-Obsidian插件/插件运行时产生的文件/Grove Reader/数据备份"). When you change it, existing backups move to the new path once the field loses focus.',
	'把全部书籍批注 JSON、书架缓存、书单与自定义封面导出到上面的「库内备份文件夹」。该文件夹是普通库内文件，随库同步，删除或重装插件都不受影响。建议定期执行（命令面板也有同名命令）':
		'Export every book\'s annotation JSON, shelf cache, reading lists and custom covers to the vault backup folder above. It is an ordinary vault folder, so it syncs with your vault and survives uninstalling the plugin. Running it regularly is recommended (the command palette has the same command).',
	'数据安全': 'Data safety',
	'数据体检': 'Data health check',
	'检查批注 JSON、笔记、书架缓存、书单、统计之间的引用是否还对得上；只读，不会删除书籍或批注':
		'Check that annotation JSON, notes, shelf cache, reading lists and stats still reference each other correctly. Read-only: never deletes books or annotations.',
	'维护': 'Maintenance',
	'运行': 'Run',
	'清空': 'Clear',
	'操作记录': 'Action log',
	'关键操作记录': 'Key action log',
	'只记录删除书籍、清空批注、恢复隐藏、备份等低频但重要的动作，最多 200 条；翻页、搜索不记录。':
		'Only low-frequency but important actions are logged (deleting, clearing annotations, restoring hidden books, backups), up to 200 entries. Page turns and searches are not logged.',
	'查看': 'View',
	'打开日志': 'Open log',
	'清空操作记录？只删日志，不影响批注数据。': 'Clear the action log? Only the log is deleted; annotations are untouched.',
	'已清空操作记录': 'Action log cleared',
	'回收站': 'Trash',
	'调试模式': 'Debug mode',
	'把打开书籍、删除、清空、备份等事件写入 data/debug.log（512KB 轮转），默认关闭；反馈问题时再开':
		'Write events such as opening books, deletes, clears and backups to data/debug.log (512 KB rotation). Off by default; turn it on when reporting a problem.',
	'使用指南': 'User guide',
	'全局批注检索': 'Global annotation search',
	'检索与导出': 'Search & export',
	'跨书搜索划线与评论；结果可跳回原文；「导出…」可先按范围/书/章节/颜色/今天筛选、分组并实时预览，再写 Markdown / CSV 到笔记文件夹':
		'Search highlights and comments across books; results jump back to the source. "Export…" filters by range/book/chapter/colour/today, groups them with a live preview, then writes Markdown or CSV to the notes folder.',
	'导入…': 'Import…',
	'导入外部标注': 'Import external highlights',
	'把 Kindle My Clippings.txt、Readwise CSV、微信读书 Markdown 转成 Grove 批注；按书名/作者匹配书籍，重复摘录自动跳过，导入的条目会带来源标记':
		'Convert Kindle My Clippings.txt, Readwise CSV and WeRead Markdown into Grove annotations. Books are matched by title/author, duplicate highlights are skipped, and imported entries keep a source tag.',

	// —— AI ——
	'AI 解释': 'AI explanation',
	'划词后点「解释」按钮，让 AI 用中文说明这段文字的意思。走 OpenAI 兼容接口，默认填的是智谱 GLM-4-Flash（免费额度，注册即可用）。Key 只保存在本机插件配置里。':
		'Select text and press "Explain" to have the AI describe it. Uses an OpenAI-compatible endpoint, preconfigured with Zhipu GLM-4-Flash (free quota, usable right after signing up). The key stays in this device\'s plugin settings.',
	'接口地址': 'Endpoint',
	'例如 https://open.bigmodel.cn/api/paas/v4（智谱）或 https://api.deepseek.com/v1（DeepSeek）':
		'e.g. https://open.bigmodel.cn/api/paas/v4 (Zhipu) or https://api.deepseek.com/v1 (DeepSeek)',
	'模型': 'Model',
	'智谱免费版填 glm-4-flash；DeepSeek 填 deepseek-chat': 'glm-4-flash for Zhipu\'s free tier; deepseek-chat for DeepSeek',
	'提示词': 'Prompt',
	'留空用内置提示词；想让它更贴近你的阅读习惯可以自己写':
		'Leave empty to use the built-in prompt; write your own to match your reading habits',
	'你是一位中文阅读助手…': 'You are a reading assistant…',
	'留空则「解释」按钮会提示去配置。不要把它写进笔记或分享给别人':
		'Leave empty and the "Explain" button will ask you to configure it. Never put it into notes or share it.',

	// —— 语义检索 ——
	'语义检索（向量）': 'Semantic search (vectors)',
	'向量服务': 'Vector service',
	'向量模型': 'Embedding model',
	'智谱填 embedding-3；硅基流动填 BAAI/bge-m3；OpenAI 填 text-embedding-3-small':
		'embedding-3 for Zhipu; BAAI/bge-m3 for SiliconFlow; text-embedding-3-small for OpenAI',
	'向量维度': 'Dimensions',
	'默认 1024；服务不支持时会自动退回默认维度。维度越大索引越精确也越占空间':
		'1024 by default; falls back to the service default when unsupported. Larger dimensions are more precise but take more space.',
	'嵌入接口地址': 'Embedding endpoint',
	'OpenAI 兼容 /embeddings；留空则用上面的聊天接口地址（硅基流动默认 https://api.siliconflow.cn/v1）':
		'OpenAI-compatible /embeddings; leave empty to reuse the chat endpoint above (SiliconFlow defaults to https://api.siliconflow.cn/v1)',
	'嵌入 API Key': 'Embedding API key',
	'留空则用上面的聊天 Key；硅基流动等第三方必须单独填':
		'Leave empty to reuse the chat key above; third-party services such as SiliconFlow need their own',
	'本地＝离线词法向量，不联网不花钱（同义说法未必命中）；智谱 embedding-3 需要资源包；硅基流动 bge-m3 有免费额度但需要单独填 Key。换服务后旧索引会失效，需重建':
		'Local = offline lexical vectors, no network and no cost (synonyms may not match); Zhipu embedding-3 needs a resource pack; SiliconFlow bge-m3 has a free quota but needs its own key. Changing the service invalidates the old index, which must be rebuilt.',
	'语义索引管理': 'Semantic index manager',
	'查看每本书的向量索引状态（可用 / 未建立 / 原书已改 / 模型已换），可单独重建、删除或清理失效索引':
		'Check the vector index status of every book (ready / not built / source changed / model changed) and rebuild, delete or clean up stale indexes individually.',
	'管理': 'Manage',
	'重新生成': 'Regenerate',
	'默认': 'Default',
	'书单': 'Reading list',
	'例如：外观, 笔记': 'e.g. Appearance, Notes',
	'例如：Grove Reader': 'e.g. Grove Reader',
	'笔记': 'Notes',
	'打开': 'Open',
	'继续阅读': 'Continue reading',
	'留空用聊天接口地址': 'Leave empty to reuse the chat endpoint',
	'上移': 'Move up',
	'下移': 'Move down',
	'搜索': 'Search',
	'阅读': 'Reading',
	'TXT 阅读': 'TXT reading',
	'Grove Reader：高亮样式已保存，重开书本后生效':
		'Grove Reader: highlight style saved. Reopen the book to apply it.',
	'Grove Reader：工具栏样式已保存，重开书本后生效':
		'Grove Reader: toolbar style saved. Reopen the book to apply it.',
	'Grove Reader：这里请填库内相对路径（绝对路径请用下面的「备份额外保存到」）':
		'Grove Reader: enter a vault-relative path here (for an absolute path use "Also save backups to" below).',
}
