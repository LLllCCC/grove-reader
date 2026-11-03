declare module 'electron' {
	export const shell: {
		showItemInFolder(fullPath: string): void
		openPath(path: string): Promise<string>
		trashItem(path: string): Promise<void>
	}
}
