import { App, Platform } from 'obsidian'
import { PlatformIO } from './platformIO'
import { createVaultIO } from './vaultIO'

/**
 * 桌面端实现放在单独的模块里，只有非移动平台才会动态加载：
 * 这样打包后的 main.js 在移动端不会执行 require('node:fs')。
 */
export async function createPlatformIO(app: App): Promise<PlatformIO> {
	if (Platform.isMobile || Platform.isMobileApp) return createVaultIO(app.vault.adapter)
	const { DesktopIO } = await import('./desktopIO')
	return new DesktopIO()
}
