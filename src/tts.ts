/**
 * 朗读（TTS）控制器：把当前页/当前节拆成句子，用系统语音逐句朗读，
 * 同时用 CSS Custom Highlight API 标出正在读的句子。
 *
 * 三个视图只负责三件事：给句子、翻到下一页、把当前句滚进视野；
 * 队列、暂停/继续、读完自动翻页都在这里统一处理。
 */
import { Notice } from 'obsidian'
import { applyTtsHighlight, type TtsSentence } from './ttsText'
import { t } from './i18n'

export { applyTtsHighlight, scrollRangeIntoView, sentenceRanges, splitSentenceSpans } from './ttsText'
export type { TtsSentence } from './ttsText'

export type TtsState = 'idle' | 'playing' | 'paused'

export interface TtsHost {
	/** 当前页可读的句子（按阅读顺序） */
	collect: () => TtsSentence[]
	/** 当前页读完：翻到下一页；返回 false 表示已经到头 */
	next: () => Promise<boolean>
	/** 高亮变化后的滚动等副作用（标色由控制器统一做） */
	highlight?: (sentence: TtsSentence | null) => void
	onState?: (state: TtsState) => void
}

export class TtsController {
	private state: TtsState = 'idle'
	private queue: TtsSentence[] = []
	private index = 0
	private token = 0
	private lastDoc: Document | null = null

	constructor(private host: TtsHost, private rate: () => number = () => 1) {}

	getState(): TtsState {
		return this.state
	}

	/** 开始 / 继续；已在播放则暂停 */
	toggle(): void {
		if (this.state === 'playing') {
			this.pause()
			return
		}
		if (this.state === 'paused') {
			this.resume()
			return
		}
		void this.start()
	}

	async start(): Promise<void> {
		const synth = window.speechSynthesis
		if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
			new Notice(t('Grove Reader：当前环境不支持系统朗读'))
			return
		}
		this.cancel()
		this.setState('playing')
		this.queue = this.host.collect()
		this.index = 0
		if (!this.queue.length && await this.host.next()) {
			this.queue = this.host.collect()
			this.index = 0
		}
		if (!this.queue.length) {
			new Notice(t('Grove Reader：当前页没有可朗读的文字'))
			this.cancel()
			return
		}
		this.speak()
	}

	pause(): void {
		if (this.state !== 'playing') return
		this.state = 'paused'
		try {
			window.speechSynthesis.pause()
		} catch {
			// 某些 WebView 不支持 pause，保持状态即可
		}
		this.emit()
	}

	resume(): void {
		if (this.state !== 'paused') return
		this.state = 'playing'
		try {
			window.speechSynthesis.resume()
		} catch {
			// 不支持 resume 时重新读当前句，避免卡住
			this.speak()
		}
		this.emit()
	}

	stop(): void {
		this.cancel()
		this.setState('idle')
	}

	private cancel(): void {
		this.token++
		this.queue = []
		this.index = 0
		try {
			window.speechSynthesis?.cancel()
		} catch {
			// ignore
		}
		this.setHighlight(null)
	}

	private setState(state: TtsState): void {
		this.state = state
		this.emit()
	}

	private emit(): void {
		this.host.onState?.(this.state)
	}

	private speak(): void {
		if (this.state !== 'playing') return
		if (this.index >= this.queue.length) {
			void this.advance()
			return
		}
		const sentence = this.queue[this.index]
		this.setHighlight(sentence)
		const u = new SpeechSynthesisUtterance(sentence.text)
		u.rate = Math.max(0.6, Math.min(1.6, this.rate()))
		u.lang = /[\u3400-\u9fff]/.test(sentence.text) ? 'zh-CN' : (navigator.language || 'zh-CN')
		const token = ++this.token
		u.onend = () => {
			if (token !== this.token || this.state !== 'playing') return
			this.index++
			this.speak()
		}
		u.onerror = (e) => {
			if (token !== this.token || this.state !== 'playing') return
			// interrupted / canceled 是用户主动停止，不当作失败继续
			if (e.error === 'interrupted' || e.error === 'canceled') return
			this.index++
			this.speak()
		}
		window.speechSynthesis.speak(u)
	}

	private async advance(): Promise<void> {
		const token = this.token
		const ok = await this.host.next()
		if (token !== this.token || this.state !== 'playing') return
		if (!ok) {
			this.stop()
			return
		}
		this.queue = this.host.collect()
		this.index = 0
		if (!this.queue.length) {
			this.stop()
			return
		}
		this.speak()
	}

	private setHighlight(sentence: TtsSentence | null): void {
		if (this.lastDoc && this.lastDoc !== sentence?.doc) applyTtsHighlight(this.lastDoc, undefined)
		applyTtsHighlight(sentence?.doc, sentence?.range)
		this.lastDoc = sentence?.doc ?? null
		this.host.highlight?.(sentence)
	}
}
