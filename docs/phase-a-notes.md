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
