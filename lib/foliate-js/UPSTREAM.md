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
| `#observer` | `ResizeObserver` 回调里先判 `#selectionActive()`，有选区就不 `render()`——重排会重建文档，把正在选的文字冲掉（同 TXT 视图的处理） |
| 新增 `#selectionActive()` | 遍历 `getContents()` 的 doc，判断是否有非折叠选区 |

插件侧对应：`src/readerView.ts` 在 `foliate.open()` 之后设置 `renderer.selectionPaging = !isMobile`。
**不要再在插件里自己监听 iframe 的 touchend 做翻页**——会和 foliate 的 snap 叠加成一次滑两页。

### 2026-11-11 追加二：稳定性四补丁（对照公开的 foliate-js 补丁清单）

来源：一份公开的 foliate-js 补丁清单里列的 7 条，去掉我们已有的
两条（`customElements` 守卫、拖选禁翻页），取适用的四条。行尾仍为 LF。

| 位置 | 改动 | 为什么 |
| --- | --- | --- |
| `load()` | 不再只等 `load` 事件：`display:block` + `visibility:hidden` 起步，另加 200ms 轮询 `contentDocument`（判 `body.childElementCount`），`readyState==='loading'` 最多再等 2s 后强行挂载；20s 无正文则 `reject`；挂载时翻回 `visible` | 上游只挂 `load`、不挂 `error`：地址加载失败时 Promise 既不 resolve 也不 reject，`await` 永远悬着 → 白屏且无报错，恢复工作区时把 Obsidian 钉在「加载工作区中…」；安卓 WebView 对 `display:none` 的 iframe 可能干脆不加载 |
| `destroy()` | `this.#view.destroy()` → `this.#view?.destroy()` | `#view` 在从未装载/已销毁时为 null，抛错会跳过 `sections[index].unload()` 与 `mediaQuery` 解绑，整本泄漏 |
| `#top` 样式 | `--_max-column-count: 2` → `var(--_column-count, 2)` | 双栏要做成用户偏好；`#top` 的 shadow 规则直接声明 2，宿主变量进不去（继承只在无直接声明时生效），换 `var()` 后缺省仍是 2，行为不变 |
| `View.columnize()` | 横排 `padding` 由 `0 gap/2` 改为 `var(--_pad-top, 0px) gap/2 var(--_pad-bottom, 0px)` | 分页模式下内联 `!important` 把上下 padding 覆成 0，宿主注入的 body padding 只对章首页生效，章中页文字顶到悬浮头栏；不设变量时与上游一致 |

未采用：`#replaceBackground` 的 rAF 判空（本基准没有该方法，调用处已是 `this.#view?.document?.fonts` 可选链）、
另一份参考实现里的 srcdoc 兜底与调试埋点（与本插件 CSP/调试体系不同）。

其余 14 个 `.js` 文件与基准 commit 字节一致。

## 上游检查记录

- 2026-11-13：GitHub API 查上游 HEAD 仍为 `78914aef4466`（与本基准一致）；`npm run foliate:check -- --offline` 本地基线 19 个文件一致；在线检查 14 个未改文件与上游字节一致、5 个登记修改文件符合预期，无需升级。

## 升级方法

```bash
npm run foliate:check              # 本地基线 + 上游对比
npm run foliate:check -- --offline # 只校验本地基线（完全不联网）
npm run foliate:baseline           # 刻意修改 foliate-js 后更新 BASELINE.json
```

`BASELINE.json` 记录每个内置 `.js` 的 SHA-256（忽略行尾差异）。`foliate:check` 每次都先做这一层，
所以 GitHub 不可达时仍能发现本地文件被误改；**刻意修改 foliate-js 后必须重跑
`npm run foliate:baseline`，并把 `BASELINE.json` 与代码一起提交**，否则下次检查会报「改动」。

网络层：单请求 12s 超时、整场上游对比默认 40s 预算；直连 `raw.githubusercontent.com` 失败时会自动切到
`ghproxy.net` / `gh-proxy.com` 镜像，首次探测成功后复用同一条通道，避免逐文件重试。
网络全部不可用时跳过上游对比，本地基线通过即输出 `FOLIATE CHECK OK（本地基线一致；上游对比跳过）`。
可用环境变量覆盖：

| 变量 | 作用 |
| --- | --- |
| `GROVE_FOLIATE_OFFLINE=1` | 只跑本地基线，不联网 |
| `GROVE_FOLIATE_MIRROR` | 自定义镜像前缀，逗号分隔多个；镜像地址后直接拼原始 URL |
| `GROVE_FOLIATE_FORCE_MIRROR=1` | 跳过直连，直接从镜像读（用于验证镜像通道） |
| `GROVE_FOLIATE_TIMEOUT` | 单次请求超时毫秒数，默认 12000 |
| `GROVE_FOLIATE_BUDGET` | 整场上游对比的网络预算，默认 40000 |

上游 API 只用于提示「上游有而本地未内置」的文件；API 不可达时会跳过该项，不阻断逐文件对比。

升级上游时：替换本目录文件 → 更新上面的 commit/date → 运行 `npm run foliate:baseline` 更新哈希 →
运行 `npm run foliate:check` → 把新出现的差异逐个过目（上游可能改了 `foliate-view` 的方法签名，
`src/readerView.ts` 顶部的 `FoliateView` 接口就是插件依赖的全部契约，需要同步核对）→ 重新构建并跑冒烟。
