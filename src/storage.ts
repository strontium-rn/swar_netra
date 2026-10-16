// Persistence: save the calibration (and the caregiver's words) in the browser, so a page
// refresh doesn't mean calibrating again. The user just puts their head back where it was
// (nose in the circle), and the saved model works again.
//
// localStorage is a small key → text store that belongs to this website, on this
// computer only. Nothing is uploaded anywhere.

import type { SavedModel } from './gazeModel.ts'
import type { HeadPose } from './headGuard.ts'
import type { ColumnFixData } from './columnFix.ts'
import { COLUMNS, DEFAULT_VOCABULARY, SLOTS, type Category, type Vocabulary, type Word } from './vocabulary.ts'

// The "v3" is a schema version. When what we save changes meaning, we bump it, so the app
// never reads old data the wrong way. v2: the model recipes changed. v3: the iris center
// is now measured differently, so weights learned for the old measurement no longer fit.
const KEY = 'swar-netra-calibration-v3'

export type SavedCalibration = {
  xModel: SavedModel // model used for left/right
  columnFix?: ColumnFixData // per-button correction (missing in calibrations saved before it existed)
  yModel: SavedModel // model used for up/down
  headRef: HeadPose // where the head was during calibration
  hitRate: number // test result, shown to the caregiver
  savedAt: string // when it was made
}

export function saveCalibration(c: SavedCalibration): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    // Storage can be blocked (e.g. private browsing). The app still works, just without saving.
  }
}

export function loadCalibration(): SavedCalibration | null {
  try {
    const text = localStorage.getItem(KEY)
    return text ? (JSON.parse(text) as SavedCalibration) : null
  } catch {
    return null
  }
}

export function clearCalibration(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // nothing to do
  }
}

// ---- The caregiver's words ----
// Saved as text in localStorage, like the calibration. Photos and recordings are too big
// for it (about 5 MB in total), so they live in media.ts; here we only keep their ids.

const VOCAB_KEY = 'swar-netra-vocabulary-v1'

export function saveVocabulary(v: Vocabulary): boolean {
  try {
    localStorage.setItem(VOCAB_KEY, JSON.stringify(v))
    return true
  } catch {
    return false
  }
}

// Saved data is checked before use: a broken or very old file must never break the board.
// Anything that doesn't look right falls back to the default words.
export function loadVocabulary(): Vocabulary {
  try {
    const text = localStorage.getItem(VOCAB_KEY)
    if (text) return checkVocabulary(JSON.parse(text))
  } catch {
    // fall through to the defaults
  }
  return DEFAULT_VOCABULARY
}

export function clearVocabulary(): void {
  try {
    localStorage.removeItem(VOCAB_KEY)
  } catch {
    // nothing to do
  }
}

const isText = (v: unknown): v is string => typeof v === 'string'

function checkWord(w: unknown): Word | null {
  const o = w as Partial<Word> | null
  if (!o || !isText(o.id) || !isText(o.label) || !isText(o.icon) || !isText(o.speak)) return null
  return {
    kind: 'word',
    id: o.id,
    label: o.label,
    icon: o.icon,
    speak: o.speak,
    ...(isText(o.picture) && { picture: o.picture }),
    ...(isText(o.audio) && { audio: o.audio }),
  }
}

function checkCategory(c: unknown): Category {
  const o = c as Partial<Category> | null
  if (!o || !isText(o.id) || !isText(o.label) || !isText(o.icon) || !isText(o.color) || !Array.isArray(o.words)) {
    throw new Error('bad category')
  }
  return {
    kind: 'category',
    id: o.id,
    label: o.label,
    icon: o.icon,
    color: o.color,
    ...(isText(o.picture) && { picture: o.picture }),
    words: Array.from({ length: SLOTS }, (_, i) => checkWord(o.words![i])),
  }
}

export function checkVocabulary(data: unknown): Vocabulary {
  const o = data as Partial<Vocabulary> | null
  const help = checkWord(o?.help)
  if (!help || !Array.isArray(o?.categories) || o.categories.length !== COLUMNS - 1) throw new Error('bad vocabulary')
  return { help: { ...help, id: 'help' }, categories: o.categories.map(checkCategory) }
}
