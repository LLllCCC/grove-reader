/**
 * 构建期常量，由 esbuild 的 define 注入。
 * - false：完整版（含 PDF 阅读），用于 GitHub Release 与自用部署
 * - true ：社区版（不含 PDF 阅读），用于 Obsidian 官方目录
 *   因为目录安装只分发 main.js / manifest.json / styles.css，
 *   pdfjs 运行时资源（wasm / cmaps / standard_fonts / worker，共 5.9 MB）无法随插件下发。
 */
declare const __COMMUNITY_BUILD__: boolean
