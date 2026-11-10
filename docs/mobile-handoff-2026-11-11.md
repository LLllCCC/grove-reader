# Grove Reader 移动端接手记录（2026-11-11）

> 上一份 `mobile-handoff-2026-11-09.md` 里"工具栏收不起来"的结论已过时，以本份为准。

## 现状

里程碑 A 已完成并真机验收。手机（Redmi K70 / Android 16，adb 序列号 `19b50ecb`）上：

- 打开 EPUB / TXT（GBK 自动识别）、左右滑动翻页、划线、评论、生成笔记全部实测通过。
- 工具栏：收起态是顶部 20px 窄条（`▾ 工具栏`，整条可点）；展开态是 44px 单行，控件横向滑动，`收起` 按钮 sticky 固定左侧。
- 翻页后自动收起：EPUB 走 `#onRelocate`（拖动进度条时不动），TXT 走 `nextPage/prevPage`。

## 关键实现点（改之前先读）

- 状态只认 `bar.dataset.barOpen`。`#setMobileBarOpen()` 一处派生 class / 按钮文案 / 内联样式。
  旧代码在 `#clearPending()` 里只改 dataset，留下"记录说收起、画面还开着"的假死，已修。
- 手机上**不要**把 `.grove-toolbar` 改回 `flex-wrap: wrap`，也不要给末项加 `margin-left: auto`——
  14 个控件会折成三行占掉 13% 屏高，且末项会被挤出屏幕。
- 收起态**不要**再用 `translateY(calc(-100% + 18px))` 露一条，露出来的是被裁一半的控件，看着像坏了。
- 收窄屏幕下靠这三条把「颜色 + 评论」留在首屏：隐藏进度滑杆、位置标签只显示百分比、目录 36vw。

## 调试通道（不用点书架）

```bash
# 直接打开某本书，bookId = data/books 下的文件名去掉 .json
adb shell "am start -a android.intent.action.VIEW -d 'obsidian://grove?book=<bookId>'"
# 打开库内文件（EPUB 走插件视图；TXT 会被原生编辑器接管，需走上面的 grove 协议）
adb shell "am start -a android.intent.action.VIEW -d 'obsidian://open?vault=Obsidian&file=<percent-encoded>'"
```

坑：Git Bash 里 `adb pull <目录>` 会报 `Not a directory`，拉单文件正常；整目录先 `adb shell tar -czf` 再拉。

## 未完成

- 里程碑 B：PDF（pdfjs worker 在移动 WebView 的加载）、回收站 `trash.ts`、体检 `health.ts`、统计/操作记录入口、备份导出与数据迁移策略。
- `/sdcard/Documents/GroveTest/` 仍存在（废弃测试库）；手机插件目录里 `data-obsolete-20261111` 是旧数据副本。
- 书架卡片在 ADB `input tap` 下点不开（真机正常），原因未查。

## 补记（同日，用户真机反馈后）

三个回归已修，回归原因与对应的坑：

1. **点正文工具栏闪退**：`#clearPending()` 只是清待处理选区（点正文、选区为空时必走），
   里面不能收工具栏，否则开完立刻被关。收栏只在划线/评论真正落地后显式调用。
2. **滑动不翻页**：Obsidian 手机端把长距离横向拖动识别成拉侧栏。
   - TXT：在阅读区 `touchmove` 捕获阶段 `stopPropagation()` 截停横向手势；
   - EPUB：**不要**自己监听 iframe 的 touchend 做翻页，交给 foliate 原生 swipe，
     两套同时开会一次滑两页（已删除该段代码）。
3. **拖选择手柄跳页、选区丢失**：foliate `paginator.js` 把拖选当 swipe，
   且 700ms 后为「跨页选取」主动 next/prev。已打本地补丁（`hasSelection` 保护 +
   `selectionPaging` 开关，移动端关闭），登记在 `lib/foliate-js/UPSTREAM.md`。

手机端手势有三层竞争：Obsidian 工作区手势 / WebView 原生选区 / foliate swipe。
排查时先用临时浮层打印 `dx、page、screen、scrollLeft`，比盲改 CSS 快得多（浮层记得删）。

## 里程碑 B 进展（同日）

已完成并真机验证：

1. **回收站**：`trash.ts` 全量改 `PlatformIO` + async；`VaultIO.mkdir` 逐级建父目录；
   移动失败回退 copy+remove；settings / modal / 删除流程同步改 await。冒烟有专用用例。
2. **数据体检**：`health.ts` 重写为 `io.list/read/exists`；`missingNotes.bookExists`
   在扫描时算好，`healthCleanupCount` 变纯函数，不再依赖 `desktopFs`。
3. **PDF**：
   - 顶层 node 依赖清除，桌面 range 读取改成注入 `RangeReader` + 动态 import `node:fs/promises`；
   - 手机整文件读入（>64MB 拒绝），worker 走 **Blob URL**（resourcePath 是 /storage 路径，
     Worker 加载不了）；wasm/cmaps/字体等在手机跳过；
   - 视图注册到手机，批注栏默认收起，工具栏改静态单行（手机没有 hover）。

未完成：备份导出 / 数据迁移的手机策略；扫描版 PDF 的 wasm 资源；PDF 文字层划选批注的真机验证。

调试入口：`obsidian://grove?path=<库内路径>` 可直接按路径打开书籍/PDF。

## 里程碑 B 收尾

- **备份导出 / 数据迁移**：新增 `src/backup.ts`，三个函数全走 `PlatformIO`，
  桌面绝对路径与手机库内相对路径共用一套逻辑。安全策略保留（`.grove-backup`
  标记、目标被占用中止、迁移三重校验、份数比对）。手机端放开，自动备份也放开；
  只有「额外保存到库外盘」仍限桌面。真机用「临时开 daily 自动备份」端到端验证过。
- **PDF 划选**：Android 长按选中发的是 `pointercancel`，`pointerup` 不来，
  所以 pending 永远为空。补 `document.selectionchange`（120ms 防抖、只在选区
  落在 `.grove-pdf-page` 内时采集）。真机：选中 → 点颜色 → 高亮落盘。

仍留的口子：扫描版 PDF 的 wasm 资源在手机端跳过（resourcePath 是文件路径，
fetch 不到）；TXT 主文档选区「松手消失」未解，但 PDF 能正常选中，说明问题在
TXT 视图自身而非 Obsidian 全局——这是下一步的关键线索。
