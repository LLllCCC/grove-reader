# Grove Reader 移动端适配任务书

> 这份文档是交给 Qoder（或其它编码智能体）的完整交接说明。动手前先读 README.md 与 `src/`，不要凭猜测改结构。
>
> 派发前先在本机终端完成一次 `qodercli login`；`node scripts/dispatch-mobile.mjs` 会先检查登录状态。

## 1. 背景

- 仓库：`D:\Obsidian插件开发\grove-reader`（TypeScript + esbuild，Obsidian 社区插件，个人自用）
- 运行副本：`D:\Obsidian\.obsidian\plugins\grove-reader`（**不要动这个库**，见第 4 节）
- 能力：EPUB / MOBI / AZW3 / FB2 / CBZ 用内嵌 foliate-js 渲染；PDF 用 pdfjs-dist 独立实现；TXT 自研分页视图
- 功能：划线高亮、评论、批注侧栏、全文搜索、划词 AI 解释、生成 Markdown 笔记、从笔记回写批注、导出 Canvas
- 现状：`manifest.json` 里 `isDesktopOnly: true`，移动端**完全不加载**

## 2. 目标

让插件在 Obsidian Android 上可用（iOS 暂不作为验收条件）：

- 打开 EPUB 与 TXT，翻页/进度/阅读位置记忆正常
- 划词 → 高亮 / 评论 / 解释；批注侧栏可查看、跳转、删除
- 生成阅读笔记、从笔记回写、导出 Canvas 可用
- 桌面端行为与数据格式**零回归**

PDF 作为第二阶段：如果 pdf.js worker 在移动 WebView 上无法跑通，允许降级为「移动端不显示 PDF 阅读器，给明确提示」，但不要静默失败。

## 3. 主要改造点（按依赖顺序）

### 阶段 A：数据层去 Node 化

`src/store.ts`、`src/main.ts`、`src/trash.ts`、`src/health.ts`、`src/debugLog.ts`、`src/pdfThumbnail.ts` 直接用 `node:fs` / `node:path`。

- 抽一个 `PlatformIO` 接口：`readText / writeText / exists / mkdir / remove / rename / list / stat`。桌面实现用现有 fs 同步代码（保持行为），移动实现用 `app.vault.adapter`（异步）。
- 现有调用多是同步的，改造时优先「把上层函数改成 async」，不要用同步阻塞 hack。
- 数据目录：库内相对路径已支持（当前用户把数据放在 `Grove Reader/data`）；移动端不允许库外绝对路径，遇到盘符路径要提示并回退到库内默认目录。
- 原子写（临时文件 + rename）在 `vault.adapter` 上用 `writeBinary` + `rename` 实现；滚动备份与损坏恢复逻辑保持不变。

### 阶段 B：阅读器

- EPUB（foliate-js）：iframe 里的选中事件在移动端是 `pointerup` / `selectionchange`；现有弹条基于 `getBoundingClientRect` + `position: fixed`，需要验证在移动 WebView 的缩放与滚动下是否偏移。
- TXT：分页依赖 `clientWidth` 与列布局，移动端窄屏要重新校准每屏字数与翻页手势（现在是滚轮/键盘，移动端需要滑动）。
- PDF：先验证 `pdfjs-dist` 的 worker 与 `pdfjs/` 资源能否通过 `app://` 加载；不能就按第 2 节降级。

### 阶段 C：交互与界面

- 依赖 hover 的地方（书架卡片 tooltip、批注菜单）改成点击/长按触发。
- 工具栏在窄屏要能换行或收进「更多」菜单，不能横向溢出。
- 设置页在移动端宽度下的分组与可点区域检查一遍。
- 触摸目标不小于 40px；滚动与翻页手势不能互相抢。

## 4. 硬约束

1. **不要改用户的真实库** `D:\Obsidian`。测试用独立库：复制 2–3 本书（一本 EPUB、一本 TXT）+ 空数据目录。
2. 不新增运行时依赖（现在只有 `pdfjs-dist` 与内置 `lib/foliate-js`；`fflate` 是开发依赖）。
3. 每个阶段结束必须通过：`npm run build`（tsc + esbuild）与 `npm run smoke`（数据层冒烟）。
4. 数据格式 `data/books/*.json` 不变。若必须变更，写迁移 + 保留回滚路径，并说明。
5. 删除/覆盖类操作沿用现有确认弹窗、插件回收站、滚动备份机制；不要新造一套。
6. 提交按阶段拆分，分支 `feature/mobile`，不要直接改主分支。

## 5. 测试环境

- 开发机：Windows 10/11，Node 22，仓库已 `npm i`
- 安卓设备：Redmi K70（`23113RKC6C`，adb 已连接）
- adb：`C:\Users\35011\AppData\Local\Android\Sdk\platform-tools\adb.exe`
- 真机安装 Obsidian 后，把测试库放到设备可访问目录；用 `adb logcat` 抓 Obsidian 日志
- 桌面调试可用 `npm run obsidian:eval`（需 Obsidian 以 `--remote-debugging-port=9222` 启动）；**移动端没有 CDP**，只能 logcat + 界面验收

## 6. 验收标准

- 冷启动打开 100 页以内 EPUB < 3 秒，翻页无长时间白屏
- 划词 → 高亮 → 评论 → 生成笔记 → 回跳原文，全链路可用
- 退出重进，阅读位置与批注不丢
- 桌面端 `npm run build` / `npm run smoke` 全绿；桌面阅读、批注、笔记、Canvas 导出回归通过
- 所有新增文案为中文，错误提示包含「发生了什么 + 怎么补救」

## 7. 已知风险

- 数据层是全同步实现，异步化会牵动很多调用点，容易回归；建议先做适配层 + 单测，再逐个替换
- pdf.js worker 在移动端可能不可用，PNG/字体资源路径也可能失效
- Obsidian 移动端插件 API 与桌面存在差异（`Platform.isMobile`、`vault.adapter` 能力）
- 仓库有定时 auto backup 提交，看到陌生提交不要慌，也不要 reset

## 8. 交付物

- `feature/mobile` 分支上的分阶段提交
- 每个阶段一段说明：改了哪些文件、如何验证、还剩什么风险
- 一份 `docs/mobile-notes.md`：移动端限制、已验证的设备与系统版本、未解决问题
