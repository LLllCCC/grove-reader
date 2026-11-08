# Phase A：数据层去 Node 化（进行中）

目标：让插件不再在模块顶层 `require('node:fs')`，桌面用 Node fs、移动用 `vault.adapter`。

## 已完成（2026-11-08）

- `src/platformIO.ts`：`PlatformIO` 接口 + 纯字符串路径工具（`joinPath/baseName/dirName/stripExt`），不 import obsidian、不 import node。
- `src/vaultIO.ts`：`VaultIO`（`app.vault.adapter` 实现）与 `createVaultIO()`。
- `src/desktopIO.ts`：`DesktopIO`（`node:fs/promises`），**只在桌面端被动态 import**。
- `src/platformFactory.ts`：`createPlatformIO(app)`，按 `Platform.isMobile` 分支。
- `src/store.ts`：改为「启动 preload 进内存 + 同步查表 + 异步排队落盘」：
  - `preload()` 读 `data/books/*.json`，损坏时移开并从滚动备份恢复；
  - `load()` 纯内存，保持现有同步调用点不变；
  - `save()` 更新内存后按书排队写（临时文件 + 原子 rename，失败降级 copy）；
  - `flush()` 等待落盘，`onunload` 已调用；
  - 预载失败时**暂停写入**，避免用空数据覆盖磁盘。
- 冒烟测试改为 async main，覆盖损坏恢复（新实例预载）、maxBackups=0、陈旧 tmp 清理、移动找回。
- 用真实数据的副本验证过：17 本书 / 49 条批注预载正确，写入后新实例能读回。

## 还没做（下一阶段）

模块顶层仍在 import node:fs / node:path，移动端加载会直接崩：

| 文件 | 用途 | 迁移方向 |
| --- | --- | --- |
| `src/main.ts` | 库外绝对路径读文件、备份导出、数据迁移、`readBookBytes` | 走 PlatformIO；库外路径在移动端禁用并提示 |
| `src/trash.ts` | 插件回收站（移动/复制/清理） | PlatformIO |
| `src/health.ts` | 数据体检读 JSON | PlatformIO |
| `src/debugLog.ts` | 调试日志追加写 | PlatformIO（移动端可关） |
| `src/pdfThumbnail.ts` | PDF 首页渲染 | 移动端可不参与 |

另外：
- `dataRoot` 在移动端必须落在库内（当前 `FileSystemAdapter` 分支拿不到 basePath，会退化成相对路径，正好可用）。
- `readBookBytes` 现在用 fs 读任意路径，移动端要改成 `adapter.readBinary`（仅库内）。
- `isDesktopOnly` 只有在以上全部迁移完、且移动端 UI 验证过之后才能改成 false。

## 里程碑 A / B（2026-11-08 与用户确认）

- **A（先做）**：手机端能读能批注。EPUB/TXT 打开、划线、评论、批注侧栏、生成笔记、回跳；回收站/体检/统计/操作记录/备份导出/PDF 在手机上隐藏。
- **B（后做）**：功能对齐，补 PDF、回收站、统计等。

### A 的实施顺序

1. `stats / oplog / lists / debugLog`：桌面端**动态 import**（`await import('./stats')`），移动端不构造；字段改为可选，调用点用 `?.` 兜底。类型用 `import type`，避免运行时加载。
2. `bookshelf / search`：
   - `ShelfCache` 改走 PlatformIO（JSON + 封面目录）。
   - 目录扫描改用 `app.vault.getFiles()`，不再自己 `readdir`；移动端禁用库外绝对路径。
   - 全局批注检索直接读 `BookStore` 内存缓存，不再扫 books 目录。
3. `main.ts`：备份导出、数据迁移、`readBookBytes` 走 PlatformIO；移动端只允许库内路径，库外路径给中文提示。
4. `pdfView`：桌面端动态加载；移动端不注册 PDF 视图，打开 PDF 时提示「手机端暂不支持 PDF」。
5. 去掉 `manifest.isDesktopOnly`，推到独立测试库（`/sdcard/Documents/GroveTest`，不加入 Syncthing），真机跑完整链路。

关键原则：**不要用一份移动构建覆盖电脑库里的插件**——手机上的 Obsidian 库与电脑通过 Syncthing 双向同步，直接装会反向覆盖 `D://Obsidian//.obsidian//plugins//grove-reader`。测试库必须独立。
