/**
 * 书架 Base 模板：把阅读笔记的 frontmatter（grove_*）变成 Bases 视图。
 * 生成的是普通 .base 文本，不依赖额外插件；重新运行命令会覆盖。
 */

export const SHELF_BASE_NAME = '书架.base'

export interface ShelfBaseOptions {
	/** 阅读笔记文件夹（库内路径） */
	notesFolder: string
	/** 「今年读完」的年份；跨年后重新生成即可更新 */
	year?: number
}

/** 拼出 `.base` 文件内容；纯函数，方便 smoke 直接断言 */
export function buildShelfBase(options: ShelfBaseOptions): string {
	const folder = (options.notesFolder || '阅读笔记').replace(/\\/g, '/').replace(/\/+$/, '')
	const year = options.year ?? new Date().getFullYear()
	const folderLiteral = JSON.stringify(folder)
	const yearStart = `${year}-01-01`
	return `# 由 Grove Reader 生成：重新运行命令「生成书架 Base」会覆盖本文件
filters:
  and:
    - file.inFolder(${folderLiteral})
    - grove_format != null
formulas:
  grove_meta: if(author, author + " · " + grove_status, grove_status)
  grove_progress_text: if(grove_progress, grove_progress + "%", "")
properties:
  title:
    displayName: 书名
  author:
    displayName: 作者
  grove_status:
    displayName: 状态
  grove_progress:
    displayName: 进度
  grove_annotations:
    displayName: 批注数
  grove_format:
    displayName: 格式
  grove_started:
    displayName: 开始阅读
  grove_finished:
    displayName: 读完
  grove_seconds:
    displayName: 阅读秒数
  grove_last_read:
    displayName: 最近阅读
  grove_publisher:
    displayName: 出版社
  grove_cover:
    displayName: 封面
  formula.grove_meta:
    displayName: 作者 · 状态
  formula.grove_progress_text:
    displayName: 进度
views:
  - type: cards
    name: 封面书架
    order:
      - title
      - formula.grove_meta
      - formula.grove_progress_text
    sort:
      - property: grove_last_read
        direction: DESC
    image: note.grove_cover
    imageAspectRatio: 1.45
    imageFit: ""
    cardSize: 180
  - type: table
    name: 在读
    filters:
      and:
        - grove_status == "在读"
    order:
      - title
      - author
      - grove_progress
      - grove_last_read
    sort:
      - property: grove_progress
        direction: DESC
    summaries:
      grove_progress: Average
  - type: table
    name: 想读
    filters:
      and:
        - grove_status == "想读"
    order:
      - title
      - author
      - grove_format
      - grove_publisher
    sort:
      - property: title
        direction: ASC
  - type: table
    name: 今年读完
    filters:
      and:
        - grove_status == "读完"
        - grove_finished >= "${yearStart}"
    order:
      - title
      - author
      - grove_finished
      - grove_annotations
    sort:
      - property: grove_finished
        direction: DESC
  - type: table
    name: 全部书籍
    order:
      - title
      - author
      - grove_status
      - grove_progress
      - grove_format
      - grove_last_read
    sort:
      - property: title
        direction: ASC
    summaries:
      grove_progress: Average
`
}
