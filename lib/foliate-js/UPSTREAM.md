# foliate-js 内置版本基准

本目录是 [foliate-js](https://github.com/johnfactotum/foliate-js) 的内置副本。
上游没有版本号发布，阅读器完全依赖其非公开 API，因此在此记录基准，
防止「上游重构后插件无声坏掉却不知从何查起」。

## 基准

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/johnfactotum/foliate-js |
| 基准 commit | `78914aef4466eb960965702401634c2cb348e9b1` |
| 提交信息 | Use original hrefs for external links and add isExternal in fb2.js (#129) |
| 提交日期 | 2026-05-01 |
| 内置日期 | 2026-09-11 |

只内置了顶层的运行时 `.js` 文件；`ui/`、`reader/`、`tests/`、打包配置未取。

## 本地修改（相对基准 commit，共 5 个文件）

| 文件 | 修改内容 |
| --- | --- |
| `pdf.js` | 整体替换为 stub：PDF 由插件内的 pdfjs-dist 独立实现，不走 foliate 适配器 |
| `view.js` | `customElements.define('foliate-view', …)` 加 `customElements.get()` 守卫 |
| `paginator.js` | 同上（`foliate-paginator`） |
| `fixed-layout.js` | 同上（`foliate-fxl`） |
| `quote-image.js` | 同上（`foliate-quoteimage`） |

守卫的原因：Obsidian 禁用/重载插件后 `customElements` 注册表仍在全局存活，
重复 `define` 会抛 `NotSupportedError` 导致插件启用失败。
（这 4 个文件在编辑时行尾被存成了 CRLF，与上游 LF 不同，属 cosmetic 差异。）

### 2026-11-11 追加：`paginator.js` 移动端选区保护

手机上拖选择手柄到页边时，上游会把整段手势当成 swipe 翻页，直接跳页并把选区冲掉。
改动（只影响触摸路径，桌面行为不变）：

| 位置 | 改动 |
| --- | --- |
| 类字段 | 新增 `selectionPaging = true`，插件在移动端置 `false`，关掉「拖选到页边自动翻页」（上游 `checkPointerSelection` 的 700ms 防抖 next/prev） |
| `#onTouchStart` | 记录 `hasSelection`：按下瞬间是否已有非折叠选区 |
| `#onTouchMove` / `#onTouchEnd` | `hasSelection` 为真时直接返回，不 `scrollBy`、不 `snap`，避免把拖选拖成翻页 |

插件侧对应：`src/readerView.ts` 在 `foliate.open()` 之后设置 `renderer.selectionPaging = !isMobile`。
**不要再在插件里自己监听 iframe 的 touchend 做翻页**——会和 foliate 的 snap 叠加成一次滑两页。

其余 14 个 `.js` 文件与基准 commit 字节一致。

## 升级方法

```bash
npm run foliate:check   # 对比当前内置文件与基准 commit，应只报上表 5 个已知差异
```

升级上游时：替换本目录文件 → 更新上面的 commit/date → 运行 `npm run foliate:check` →
把新出现的差异逐个过目（上游可能改了 `foliate-view` 的方法签名，`src/readerView.ts`
顶部的 `FoliateView` 接口就是插件依赖的全部契约，需要同步核对）→ 重新构建并跑冒烟。
