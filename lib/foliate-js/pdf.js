// Grove Reader: PDF 支持未启用。foliate-js 的 PDF 适配依赖 13MB 的 pdfjs-dist，
// 且通过 import.meta.url 解析 Worker 路径，无法打包进 Obsidian 插件。
export const makePDF = async () => {
    throw new Error('Grove Reader 暂不支持 PDF 格式')
}
