# Grove Reader 移动端接手记录（2026-11-09）

> 本记录用于让后续 Codex、Qoder 或其它 AI 对话接手。状态是用户手机实际反馈 + 本机工程现场，接手时要重查源码、插件副本和手机，不可把“已部署”当作“体验验收通过”。

## 工程与设备

- 源码：`D:\Obsidian插件开发\grove-reader`，TypeScript + esbuild，当前 `master`，manifest/package 版本 `0.28.0`，`isDesktopOnly: false`。
- 电脑运行副本：`D:\Obsidian\.obsidian\plugins\grove-reader`。
- 手机：Redmi K70 / Android 16；ADB serial 当前现场为 `19b50ecb`（早期记录中的 serial 已变）。手机 Obsidian 库：`/sdcard/Documents/Obsidian`，与电脑库经 Syncthing 双向同步。
- ADB：`C:\Users\35011\AppData\Local\Android\Sdk\platform-tools\adb.exe`。
- 手机部署方式：构建后分别 adb push `main.js`、`styles.css` 到 `/sdcard/Documents/Obsidian/.obsidian/plugins/grove-reader/`，force-stop 并重启 Obsidian。源码改动在插件工程，不要在 Obsidian 运行时编辑 `.obsidian` 配置。
- 双向同步注意：电脑部署也要同步到当前库；不要在两端同时编辑同一本书的批注。确认设置的 dataFolder 为 `Grove Reader`，避免误改旧的 `.obsidian/plugins/grove-reader/data`。

## 已由用户确认

- 手机左右滑动翻页正常。
- 用户反复确认阅读工具栏目前能从阅读区顶部露出/点正文展开，但**不能收起**。
- Android 选中文本会出现系统原生菜单；插件不应再自动叠加批注浮条。当前交互目标是保留 Android 选区菜单，再从 Grove 工具栏颜色/评论操作待处理选区；完整批注链路仍需真机验证。
- 手机阅读布局已恢复 Obsidian 标题栏；批注侧栏默认收起，可手动关闭；右下角上一页/下一页浮动按钮隐藏。

## 当前手机工具栏问题：优先接手

用户最近确认：多次点击正文均不能收回；点顶边也不能收回；曾尝试在外部定位小横条，但手机上始终不可见。随后改成“工具栏最右侧显示‘收起’”并部署，但最新用户反馈仍认为没有把手/收起入口，说明当前方案未通过用户验收。

曾造成视觉回归的改动：把把手插进 `.grove-toolbar` 后设置 `flex-direction: column`，导致工具栏大变样。后来恢复横向排列。**不要再加绝对定位的下沿小横条，也不要将工具栏改成纵向。**

当前源码位置：

- `src/readerView.ts`：DOM 点击在约 250 行；EPUB iframe click 在约 830 行；`#setMobileBarOpen()` 在约 1260 行。
- `src/textView.ts`：DOM click 在约 230 行；`#setMobileBarOpen()` 在约 1580 行。
- `styles.css`：移动工具栏规则在文件末尾。当前关闭按钮类 `.grove-mobile-toolbar-close` 会基于 `.is-visible` 显示；实际是否呈现在手机、是否可点击尚未验收。

## 近期实现尝试与失败边界

- EPUB 与 TXT 手机判断需兼容 `Platform.isMobile || Platform.isMobileApp`（插件 getter `plugin.isMobile` 也覆盖两者）。
- EPUB 正文在 iframe 内，宿主 root 收不到正文 click；必须在 `doc` 上处理。选区非空时应跳过点击工具栏动作。
- 当前正文策略是“点正文展开”；关闭面板时不应把同一次点击继续当作工具栏切换。
- `#setMobileBarOpen(open)` 会改 `data-bar-open`、类和 `transform !important`。但用户实际反馈仍不工作；下一轮应首先用真实运行时 DOM 调试确认：事件到底是否触发、`bar.dataset.barOpen` 值是否变化、computed transform 是否变化、按钮是否创建/是否被 `.grove-hidden` /媒体选择器隐藏。
- `adb shell input tap` 在此环境不是可靠的阅读器 UI 验收方式：曾打开阅读书时弹出“HTML Reader error undefined”等干扰提示。不要据此宣布真机触摸成功；只用于部署/截图辅助。
- 当前手机部署已经推过多个实验版本。接手者先核对源码和手机文件时间/哈希；最近一版已尝试在工具栏末尾插入“收起”文字按钮，但用户反馈入口仍不可见，需按现场重新验证。

## 推荐下一步

1. 先取得用户同意后让其打开手机阅读页并保持屏幕可见；用 `adb exec-out screencap -p` 只观察当前结果，不要盲目继续 CSS 猜测。必要时记录 Android WebView logcat；ADB 触摸和用户触摸分开判断。
2. 把 UI 分解：工具栏展开是否能稳定；展开后「收起」按钮 DOM 是否存在；computed `display/visibility/opacity/transform/z-index/rect` 是什么；监听器调用是否改变状态。若设备没有 CDP，添加临时可见状态提示或诊断日志，验证后移除。
3. 恢复并保持原来的横向工具栏。不加浮动小横条；收起按钮需使用现有 Obsidian clickable-icon 视觉规范或短文字按钮，并确认手机可见区域、触控尺寸和父容器裁剪。
4. 先完成手机上的工具栏开/合，再测试外观面板「正文」点击关闭；之后完整验证：划选文本（系统菜单不重叠）、颜色高亮、添加评论、刷新后数据仍在。
5. 修好后 `npm run build`；交互/数据层改动可跑 `npm run smoke`。手机推送后由用户真机实际触摸复验。不要因构建通过就标记交互完成。
6. 其它后续：检查翻页/滚动后工具栏是否应自动收起；窄屏外观设置的可用性；EPUB/TXT 批注全链路；PDF 目前移动端跳过；回收站/体检、统计/操作记录入口、备份/数据迁移策略仍待里程碑 B 决策。

## 可复现命令

```powershell
Set-Location 'D:\Obsidian插件开发\grove-reader'
npm run build
npm run smoke
$adb = 'C:\Users\35011\AppData\Local\Android\Sdk\platform-tools\adb.exe'
& $adb devices
& $adb push '.\main.js' '/sdcard/Documents/Obsidian/.obsidian/plugins/grove-reader/main.js'
& $adb push '.\styles.css' '/sdcard/Documents/Obsidian/.obsidian/plugins/grove-reader/styles.css'
& $adb shell am force-stop md.obsidian
& $adb shell monkey -p md.obsidian 1
```

> `npm run smoke` 曾有既有的笔记模板 `{{#each}}` 未闭合回退日志，但最后仍输出 `SMOKE OK`；这是测试夹具现象，不要误判成这轮移动 UI 构建失败。

## 本记录之后的资料入口

- 当前用户可读的项目进度：`D:\Obsidian\AI_知识库\20_Projects\Grove Reader 移动端移植记录.md`（若可访问，按 Vault AI 规则先确认 `_待归档` 是否已有未处理项）。
- 基础移动移植任务书：`docs/mobile-port.md`。
- Phase A 数据层说明：`docs/phase-a-notes.md`。
- 用户已要求暂停在当前进度；后续对话重新开始前，应先读本记录和上述三个实现位置，现场确认版本，不从本记录直接推断当前手机状态。
