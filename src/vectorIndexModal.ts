/**
 * 语义索引管理：看每本书的索引状态，单独或批量重建、删除。
 *
 * 索引文件在 `<数据目录>/vectors/<书 id>.json`，换嵌入模型或原书改过后需要重建。
 */
import { App, Modal, Notice, setIcon } from 'obsidian'
import type GroveReaderPlugin from './main'
import { embedForSearch, embeddingProviderLabel, isLocalEmbedding, resolveEmbedding } from './embedding'
import { buildVectorIndex, vectorIndexOverview, type VectorIndexRow, type VectorIndexState } from './semanticSearch'
import { removeVectorDoc } from './vectorIndex'
import { confirmAsync } from './modals'
import { t } from './i18n'

const STATE_LABELS: Record<VectorIndexState, string> = {
	ready: '可用',
	missing: '未建立',
	model: '模型已换',
	stale: '原书已改',
}

export class VectorIndexModal extends Modal {
	#rows: VectorIndexRow[] = []
	#busy = false
	#summaryEl: HTMLElement | null = null
	#listEl: HTMLElement | null = null
	#statusEl: HTMLElement | null = null

	constructor(app: App, private plugin: GroveReaderPlugin) {
		super(app)
	}

	onOpen(): void {
		this.contentEl.empty()
		this.modalEl.addClass('grove-vector-modal')
		this.contentEl.createEl('h3', { text: t('语义索引') })
		const embed = resolveEmbedding(this.plugin)
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `当前服务：${embeddingProviderLabel(embed.provider)} · ${embed.model}。索引按书建立，正文改过或换模型后会失效；建立索引会调用嵌入接口，使用你自己的 API Key。`,
		})
		this.#summaryEl = this.contentEl.createDiv('grove-vector-summary')
		this.#listEl = this.contentEl.createDiv('grove-vector-list')
		this.#statusEl = this.contentEl.createDiv('grove-vector-status')
		const buttons = this.contentEl.createDiv('modal-button-container')
		const rebuildAll = buttons.createEl('button', { text: t('重建全部'), cls: 'mod-cta' })
		rebuildAll.addEventListener('click', () => void this.#rebuildAll())
		const cleanup = buttons.createEl('button', { text: t('清理失效') })
		cleanup.addEventListener('click', () => void this.#cleanup())
		const close = buttons.createEl('button', { text: t('关闭') })
		close.addEventListener('click', () => this.close())
		void this.#refresh()
	}

	onClose(): void {
		this.contentEl.empty()
	}

	#status(text: string): void {
		this.#statusEl?.setText(text)
	}

	async #refresh(): Promise<void> {
		if (!this.#listEl || !this.#summaryEl) return
		this.#listEl.empty()
		this.#summaryEl.setText(t('正在读取索引状态…'))
		const embed = resolveEmbedding(this.plugin)
		this.#rows = await vectorIndexOverview(this.plugin, embed)
		const count = (state: VectorIndexState): number => this.#rows.filter(row => row.state === state).length
		const total = this.#rows.length
		const ready = count('ready')
		this.#summaryEl.setText(total
			? `共 ${total} 本：可用 ${ready}，未建立 ${count('missing')}，原书已改 ${count('stale')}，模型已换 ${count('model')}`
			: t('扫描文件夹里还没有书。'))
		if (!total) return
		for (const row of this.#rows) this.#renderRow(row)
	}

	#renderRow(row: VectorIndexRow): void {
		if (!this.#listEl) return
		const el = this.#listEl.createDiv('grove-vector-row')
		if (row.state === 'ready') el.addClass('is-ready')
		const head = el.createDiv('grove-vector-row-head')
		head.createSpan('grove-vector-title').setText(row.title)
		const badge = head.createSpan(`grove-vector-badge is-${row.state}`)
		badge.setText(t(STATE_LABELS[row.state]))
		const meta = el.createDiv('grove-vector-meta')
		const doc = row.doc
		if (doc) {
			const when = new Date(doc.updatedAt).toLocaleString('zh-CN', { hour12: false })
			meta.setText(`${doc.chunks.length} 段 · ${doc.dims} 维 · ${doc.model} · ${when}`)
		} else {
			meta.setText(t('还没有索引；首次检索时会提示建立'))
		}
		const actions = el.createDiv('grove-vector-actions')
		const rebuild = actions.createEl('button', { text: t('重建') })
		if (row.state !== 'ready') rebuild.addClass('mod-cta')
		rebuild.addEventListener('click', () => void this.#rebuild([row]))
		if (doc) {
			const remove = actions.createEl('button', { text: t('删除索引') })
			remove.addEventListener('click', () => void this.#remove(row))
		}
	}

	async #rebuild(rows: VectorIndexRow[]): Promise<void> {
		if (this.#busy || !rows.length) return
		const embed = resolveEmbedding(this.plugin)
		this.#busy = true
		try {
			if (!isLocalEmbedding(embed)) {
				this.#status(t('正在检查嵌入接口…'))
				await embedForSearch(embed, [t('索引测试')], 1)
			}
			let done = 0
			let reusedTotal = 0
			let chunksTotal = 0
			for (const row of rows) {
				this.#status(`建立索引 ${done + 1} / ${rows.length} · ${row.title}`)
				let reused = 0
				try {
					await buildVectorIndex(this.plugin, row.path, embed, {
						onReuse: (n, total) => {
							reused = n
							reusedTotal += n
							chunksTotal += total
						},
						onProgress: (n, total) => this.#status(
							`建立索引 ${done + 1} / ${rows.length} · ${row.title}（${n}/${total} 块${reused ? `，复用 ${reused}` : ''}）`,
						),
					})
				} catch (e) {
					console.error(t('[Grove Reader] 建语义索引失败'), row.path, e)
					new Notice(`Grove Reader：${row.title} 索引失败（${e instanceof Error ? e.message : String(e)}）`, 8000)
					continue
				}
				done++
			}
			const reuseText = reusedTotal ? `，复用 ${reusedTotal} / ${chunksTotal} 块` : ''
			this.#status(`已重建 ${done} 本书的索引${reuseText}`)
			new Notice(`Grove Reader：已重建 ${done} 本书的语义索引${reuseText}`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			this.#status(`建立索引失败：${msg}`)
			new Notice(`Grove Reader：建立索引失败（${msg}）`, 8000)
		} finally {
			this.#busy = false
			await this.#refresh()
		}
	}

	async #rebuildAll(): Promise<void> {
		if (this.#busy) return
		if (!this.#rows.length) return
		const ok = await confirmAsync(
			this.app,
			`将为 ${this.#rows.length} 本书重建语义索引，会重复调用嵌入接口（使用你自己的 API Key）。继续吗？`,
			t('开始重建'),
		)
		if (!ok) return
		await this.#rebuild(this.#rows.slice())
	}

	async #remove(row: VectorIndexRow): Promise<void> {
		if (this.#busy) return
		const ok = await confirmAsync(this.app, `删除《${row.title}》的语义索引？下次检索时会重新建立。`, t('删除'))
		if (!ok) return
		await removeVectorDoc(this.plugin.io, this.plugin.getDataRoot(), this.plugin.store.bookId(row.path))
		new Notice(t('Grove Reader：已删除索引'))
		await this.#refresh()
	}

	/** 清掉换模型留下的旧索引，以及书架里已经不存在的书对应的孤儿索引 */
	async #cleanup(): Promise<void> {
		if (this.#busy) return
		const stale = this.#rows.filter(row => row.doc && row.state === 'model')
		const keep = new Set(this.#rows.map(row => `${this.plugin.store.bookId(row.path)}.json`))
		const orphans: string[] = []
		const dir = `${this.plugin.getDataRoot().replace(/\\/g, '/').replace(/\/+$/, '')}/vectors`
		if (await this.plugin.io.exists(dir)) {
			const { files } = await this.plugin.io.list(dir)
			for (const file of files) {
				const name = file.split(/[\\/]/).pop() ?? ''
				if (!name.endsWith('.json') || keep.has(name)) continue
				orphans.push(file)
			}
		}
		if (!stale.length && !orphans.length) {
			new Notice(t('Grove Reader：没有需要清理的旧索引'))
			return
		}
		const ok = await confirmAsync(
			this.app,
			`将删除 ${stale.length} 个旧模型索引、${orphans.length} 个已不在书架上的索引文件。只删索引，不影响书和批注。继续吗？`,
			t('清理'),
		)
		if (!ok) return
		for (const row of stale) {
			await removeVectorDoc(this.plugin.io, this.plugin.getDataRoot(), this.plugin.store.bookId(row.path))
		}
		for (const file of orphans) {
			try {
				await this.plugin.io.remove(file)
			} catch {
				// 删不掉就留着，下次再清
			}
		}
		new Notice(`Grove Reader：已清理 ${stale.length + orphans.length} 个索引`)
		await this.#refresh()
	}
}
