/** 语义检索、导读、AI 补全、导入导出等次级面板（英文）。键为中文原文。 */
export const EN_EXTRA: Record<string, string> = {
	// —— 语义检索 / 索引 ——
	'语义索引': 'Semantic index',
	'语义匹配': 'Semantic match',
	'跨书语义问答': 'Cross-book semantic Q&A',
	'全库搜索': 'Vault-wide search',
	'在全部书的正文中搜索（含 PDF）…': 'Search the text of every book (including PDF)…',
	'没有语义相近的段落。可以换个说法，或先为书建立索引':
		'No semantically similar passages. Try different wording, or build an index for the book first.',
	'这次检索没有可用的语义段落，先换个问法或为书建立索引。':
		'This search found no usable passages. Rephrase the question or build an index for the book.',
	'还没有索引；首次检索时会提示建立': 'No index yet; you will be prompted to build one on the first search',
	'索引就绪，正在检索…': 'Index ready, searching…',
	'建立并搜索': 'Build and search',
	'索引测试': 'Index test',
	'重建': 'Rebuild',
	'重建全部': 'Rebuild all',
	'开始重建': 'Start rebuilding',
	'清理': 'Clean up',
	'清理失效': 'Clean up stale',
	'正在读取索引状态…': 'Reading index status…',
	'当前向量服务缺少接口地址或 Key，请到 设置 → AI 解释 配置，或切到「本地」':
		'The current vector service is missing an endpoint or key. Configure it under Settings → AI explanation, or switch to "Local".',
	'；可在 设置 → AI 解释 → 向量服务 切到「本地（离线）」直接使用':
		'; or switch to "Local (offline)" under Settings → AI explanation → Vector service and use it right away',
	'[Grove Reader] 建语义索引失败': '[Grove Reader] Failed to build the semantic index',

	// —— 问答 ——
	'就这些段落问 AI': 'Ask the AI about these passages',
	'材料来自刚才的语义检索结果；回答会标注书名与章节，不会编造材料之外的内容。':
		'The material comes from the semantic search results above; answers cite book and chapter and never invent content beyond it.',
	'请只依据上面的材料回答，不要编造。材料没有提到就直说「书中这部分没有提到」。':
		'Answer only from the material above and never invent. If it is not covered, say "the book does not cover this part".',
	'回答用中文：先给结论，再用 1-3 条依据（标注章节），总长度控制在 400 字以内。':
		"Answer in the book's language: lead with the conclusion, then 1–3 supporting points citing chapters, within 400 words.",
	'例如：这几本书对「习惯养成」的看法有什么不同？': 'e.g. How do these books differ on habit formation?',
	'正在根据这些段落生成回答…': 'Composing an answer from these passages…',
	'正在检查嵌入接口…': 'Checking the embedding endpoint…',
	'配置 AI 后可就这些段落提问（设置 → 阅读 → AI 解释）':
		'Configure AI to ask about these passages (Settings → Reading → AI explanation)',
	'（没有检索到相关材料）': '(no relevant material found)',
	'（没有提取到正文）': '(no text extracted)',
	'（无）': '(none)',

	// —— 按章导读 ——
	'导读': 'Chapter guide',
	'生成导读': 'Generate guide',
	'继续生成': 'Continue generating',
	'开始生成': 'Start generating',
	'删除导读': 'Delete guide',
	'删除这本书的按章导读？下次点「生成导读」会重新生成。':
		'Delete this book\'s chapter guide? Pressing "Generate guide" will create it again.',
	'还没有生成导读。生成后会按章节各写 2-4 句，点其中一章可以跳回原文。':
		'No chapter guide yet. Once generated, each chapter gets 2–4 sentences; click one to jump back to the source.',
	'生成后，每一章的导读会列在这里。': 'Once generated, each chapter summary appears here.',
	'（这一章还没生成）': '(not generated for this chapter yet)',
	'正在读取导读…': 'Loading the guide…',
	'正在读取正文并规划章节…': 'Reading the text and planning chapters…',
	'正在让 AI 读这本书…': 'Letting the AI read this book…',
	'Grove Reader：已取消，下次点「继续生成」可接着写':
		'Grove Reader: cancelled. Press "Continue generating" to resume.',
	'Grove Reader：已删除导读': 'Grove Reader: guide deleted',
	'Grove Reader：正文太短，没有可生成导读的内容': 'Grove Reader: the text is too short to generate a guide',

	// —— AI 补全书籍信息 ——
	'AI 补全书籍信息': 'AI book metadata',
	'建议已生成，确认或修改后保存': 'Suggestions ready — review or edit, then save',
	'已有内容，不覆盖': 'Existing values kept',
	'也可以先手动填写下面的空白字段。': 'You can also fill in the empty fields below by hand.',
	'一句话简介，40 字以内': 'One-line summary, under 40 characters',
	'读取书名与正文开头，生成作者、分类和一句话简介。只填空字段，不覆盖已有内容；保存前可以改。':
		'Reads the title and the opening text to suggest author, category and a one-line summary. Only empty fields are filled, existing values are kept, and you can edit before saving.',
	'你是一位图书信息整理助手。只根据提供的书名和正文片段判断，不确定就留空，不要编造。':
		'You are a book metadata assistant. Judge only from the title and excerpt provided; leave a field empty when unsure and never invent details.',
	'请返回 JSON，不要 Markdown 代码块：': 'Return JSON only, without Markdown code fences:',
	'{"author":"作者，不确定就留空","category":"2-4 个字的分类","intro":"一句话简介，40 字以内"}':
		'{"author":"author; leave empty if unsure","category":"category in 2-4 words","intro":"one-line summary, under 40 characters"}',
	'正在生成建议…': 'Generating suggestions…',

	// —— 导入外部标注 ——
	'导入': 'Import',
	'选择文件…': 'Choose file…',
	'选择 My Clippings.txt / Readwise CSV / 微信读书 Markdown':
		'Choose My Clippings.txt, Readwise CSV or WeRead Markdown',
	'把 My Clippings.txt / Readwise CSV / 微信读书 Markdown 的内容粘贴到这里…':
		'Paste the contents of My Clippings.txt, Readwise CSV or WeRead Markdown here…',
	'或从库内文件读取：': 'Or read from a vault file:',
	'库里没有可读取的 .txt / .csv / .md 文件。': 'No readable .txt / .csv / .md files in the vault.',
	'粘贴文本或从库内选择文件后会自动识别格式。':
		'Paste text or pick a vault file and the format is detected automatically.',
	'没识别出格式。支持 Kindle My Clippings.txt、Readwise CSV、微信读书 Markdown。':
		'Format not recognised. Supported: Kindle My Clippings.txt, Readwise CSV, WeRead Markdown.',
	'支持 Kindle 的 My Clippings.txt、Readwise 导出的 CSV、微信读书 Markdown（引用行）。按书名/作者匹配库内书籍，重复的摘录会自动跳过。':
		'Supports Kindle My Clippings.txt, Readwise CSV and WeRead Markdown quote lines. Books are matched by title/author and duplicate highlights are skipped.',
	'识别为 {fmt} · {count} 条划线': 'Detected {fmt} · {count} highlights',
	'识别为 {fmt}，但没有解析到划线。': 'Detected {fmt}, but no highlights could be parsed.',
	'识别为 {fmt}，但没有需要导入的新划线。': 'Detected {fmt}, but there are no new highlights to import.',
	'微信读书 Markdown': 'WeRead Markdown',

	// —— 导出 ——
	'导出批注': 'Export annotations',
	'条件': 'Filters',
	'仅今天': 'Today only',
	'位置与颜色': 'Location and colour',
	'格式': 'Format',
	'Markdown 内容': 'Markdown content',
	'找到': 'Found',
	'没有符合当前筛选的批注。放宽书籍、章节、颜色或「仅今天」再试。':
		'No annotations match the current filters. Loosen the book, chapter, colour or "Today only" filter.',
	'扫描文件夹里还没有书。': 'No books in the scan folders yet.',

	// —— 杂项 ——
	'批注': 'Annotations',
	'停止': 'Stop',
	'已停止': 'Stopped',
	'已取消': 'Cancelled',
	'生成中…': 'Generating…',
	'正在准备…': 'Preparing…',
	'阅读外观（字体 / 背景 / 行距）': 'Reading appearance (font / background / line height)',
	'AI 划词': 'AI selection',
	'AI 问答': 'AI Q&A',
	'AI 解释 / 翻译 / 摘要（先划选一段文字）': 'AI explain / translate / summarise (select text first)',
	'没有找到匹配内容。换一个更短的关键词试试。': 'No matches. Try a shorter keyword.',

	// —— 通知 ——
	'Grove Reader：{hint}': 'Grove Reader: {hint}',
	'Grove Reader：没有可导入的标注': 'Grove Reader: no highlights to import',
	'Grove Reader：没有需要保存的空白字段': 'Grove Reader: no empty fields to fill',
	'Grove Reader：没有需要清理的旧索引': 'Grove Reader: no stale indexes to clean up',
	'Grove Reader：请输入要搜索的文字': 'Grove Reader: enter something to search for',
	'Grove Reader：书籍信息已保存': 'Grove Reader: book info saved',
	'Grove Reader：已删除索引': 'Grove Reader: index deleted',
	'回到原文': 'Back to source',

	// —— 时间格式 ——
	'{n} 秒': '{n} s',
	'{n} 分钟': '{n} min',
	'{n} 小时': '{n} h',
	'{n} 天': '{n} d',
	'刚刚': 'just now',
	'{n} 分钟前': '{n} min ago',
	'{n} 小时前': '{n} h ago',
	'{n} 天前': '{n} days ago',
	'{n} 个月前': '{n} months ago',
	'{n} 年前': '{n} years ago',

	// —— 时间格式 ——
}
