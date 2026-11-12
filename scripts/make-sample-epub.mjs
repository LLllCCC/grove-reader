// 生成一本最小的 EPUB 3 示例书，用于快速验证 Grove Reader
import { zipSync, strToU8 } from 'fflate'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const ch = (title, id, paragraphs, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head><title>${title}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<section epub:type="chapter">
<h1>${title}</h1>
${paragraphs.map(p => `<p>${p}</p>`).join('\n')}
${extra}
</section>
</body>
</html>
`

const filler = n => Array.from({ length: n }, (_, i) =>
	`第${i + 1}段：阅读的意义不在于把书从头到尾扫一遍，而在于和作者对话。当你划下一道高亮，其实是在说：“这一句，我想留下来。”` +
	`随后写下的评论，则是你自己的回答。Grove Reader 的目标，就是让“阅读 → 批注 → 笔记 → 复习”这条回路尽量短，` +
	`让每一次停下来思考的动作，都能沉淀为库里可检索、可回顾的 Markdown 笔记，而不是散落在书页边缘、再也无法找回的字迹。`).join('\n')

const files = {
	'mimetype': [strToU8('application/epub+zip'), { level: 0 }],
	'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`),
	'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:grove-reader-sample-0001</dc:identifier>
    <dc:title>Grove Reader 示例书：林间阅读指南</dc:title>
    <dc:creator>Grove</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-09-11T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>
`),
	'OEBPS/nav.xhtml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc">
<h1>目录</h1>
<ol>
  <li><a href="ch1.xhtml">第一章：为什么要在笔记软件里读书</a></li>
  <li><a href="ch2.xhtml">第二章：划线与评论的纪律</a></li>
  <li><a href="ch3.xhtml">第三章：让笔记流动起来</a></li>
</ol>
</nav>
</body>
</html>
`),
	'OEBPS/toc.ncx': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:grove-reader-sample-0001"/>
    <meta name="dtb:depth" content="1"/>
  </head>
  <docTitle><text>Grove Reader 示例书：林间阅读指南</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>第一章：为什么要在笔记软件里读书</text></navLabel><content src="ch1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>第二章：划线与评论的纪律</text></navLabel><content src="ch2.xhtml"/></navPoint>
    <navPoint id="n3" playOrder="3"><navLabel><text>第三章：让笔记流动起来</text></navLabel><content src="ch3.xhtml"/></navPoint>
  </navMap>
</ncx>
`),
	'OEBPS/style.css': strToU8(`body { font-family: serif; line-height: 1.7; margin: 1em; }
h1 { font-size: 1.5em; }
p { text-indent: 2em; margin: 0.6em 0; }
`),
	'OEBPS/ch1.xhtml': strToU8(ch('第一章：为什么要在笔记软件里读书', 'ch1', [
		'在这本书里，我们只讨论一个朴素的问题：如何让读过的书，真正留在你的知识体系里。',
		'很多人读完一本书之后，几个月便忘得干干净净。原因不在于记忆力，而在于书里的洞见从来没有进入过你自己的系统——它们停在纸上，而不是库里。',
		filler(12),
	])),
	'OEBPS/ch2.xhtml': strToU8(ch('第二章：划线与评论的纪律', 'ch2', [
		'划线是选择的艺术。一本书真正值得划线的句子，往往不超过十句。划得多，不等于学得多。',
		'比起划线，更难的是评论。评论要求你用自己的话回应作者，这一步才是理解的开始。',
		filler(10),
	])),
	'OEBPS/ch3.xhtml': strToU8(ch('第三章：让笔记流动起来', 'ch3', [
		'生成笔记不是终点。把摘录放进 Obsidian 之后，你可以给它们加标签、建立链接、把它们改写成自己的文章。',
		'当一本读完的书变成一篇可检索的笔记，它才真正属于你。',
		filler(10),
	])),
}

const out = path.join(root, 'Grove Reader 示例书.epub')
fs.writeFileSync(out, zipSync(files))
console.log(`已生成：${out}`)

// ---------------------------------------------------------------------------
// 样书-脚注.epub：覆盖脚注浮窗的三条路径
//   1) 同文件 + epub:type="noteref"  2) 跨文件 + 未标注类型、文字 [3]
// ---------------------------------------------------------------------------

const fnCh1 = ch('第一章：同页脚注', 'fnch1', [
	'这一句带一个标准脚注<a epub:type="noteref" href="#fn1" id="ref1"><sup>[1]</sup></a>，点它应该弹小窗，而不是跳走。',
	'这一段带第二个脚注<a epub:type="noteref" href="#fn2" id="ref2"><sup>[2]</sup></a>，用来验证连续点击时旧结果不会覆盖新内容。',
	...Array.from({ length: 6 }, (_, i) => `第${i + 1}段正文：脚注浮窗不该打断阅读位置，关掉之后还停在原页。`),
], `
<aside epub:type="footnote" id="fn1">
<p><a epub:type="backlink" href="#ref1">[1]</a>脚注一：这是同文件、位于正文末尾的脚注正文。</p>
</aside>
<aside epub:type="footnote" id="fn2">
<p><a epub:type="backlink" href="#ref2">[2]</a>脚注二：第二条脚注，内容更长一些，用来检查浮窗高度与滚动。${'脚注正文用来占位。'.repeat(12)}</p>
</aside>`)

const fnCh2 = ch('第二章：跨文件脚注', 'fnch2', [
	'这一句的脚注在另一个文件里<a href="notes.xhtml#fn3" id="ref3"><sup>[3]</sup></a>，书里没写 epub:type，靠 [3] 和片段名识别。',
	...Array.from({ length: 8 }, (_, i) => `第${i + 1}段正文：跨文件脚注要先解析目标章节，再截取段落。`),
])

const fnFiles = {
	'mimetype': [strToU8('application/epub+zip'), { level: 0 }],
	'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`),
	'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:grove-reader-footnote-0001</dc:identifier>
    <dc:title>样书：脚注浮窗</dc:title>
    <dc:creator>Grove</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-11-13T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="notes"/>
  </spine>
</package>
`),
	'OEBPS/nav.xhtml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc">
<h1>目录</h1>
<ol>
  <li><a href="ch1.xhtml">第一章：同页脚注</a></li>
  <li><a href="ch2.xhtml">第二章：跨文件脚注</a></li>
</ol>
</nav>
</body>
</html>
`),
	'OEBPS/style.css': strToU8(`body { font-family: serif; line-height: 1.7; margin: 1em; }
h1 { font-size: 1.5em; }
p { text-indent: 2em; margin: 0.6em 0; }
aside[epub|type~="footnote"] { border-top: 1px solid #ccc; margin-top: 1.5em; font-size: 0.9em; }
`),
	'OEBPS/ch1.xhtml': strToU8(fnCh1),
	'OEBPS/ch2.xhtml': strToU8(fnCh2),
	'OEBPS/notes.xhtml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head><title>注释</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<section epub:type="endnotes">
<h1>注释</h1>
<div class="fnote"><p><a id="fn3" href="ch2.xhtml#ref3">[3]</a>脚注三：这条在独立文件里，标记也没有 epub:type，靠片段名 fn3 和 [3] 识别。</p></div>
</section>
</body>
</html>
`),
}

const fnOut = path.join(root, '样书-脚注.epub')
fs.writeFileSync(fnOut, zipSync(fnFiles))
console.log(`已生成：${fnOut}`)
