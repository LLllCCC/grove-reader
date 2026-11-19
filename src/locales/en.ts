import { EN_SETTINGS } from './en.settings'
import { EN_BOOKSHELF } from './en.bookshelf'
import { EN_MAIN } from './en.main'
import { EN_MODALS } from './en.modals'
import { EN_READER } from './en.reader'
import { EN_EXTRA } from './en.extra'

/**
 * English dictionary. Keys are the Chinese source strings used in `t()`.
 * Missing entries fall back to the Chinese key, so untranslated UI keeps working.
 *
 * 词典按模块拆分在 en.*.ts，这里只负责合并。
 */
export const EN: Record<string, string> = {
	...EN_SETTINGS,
	...EN_BOOKSHELF,
	...EN_MAIN,
	...EN_MODALS,
	...EN_READER,
	...EN_EXTRA,
}
