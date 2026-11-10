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
