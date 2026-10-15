// The words on the board. This is DATA, kept separate from the code that displays it,
// so a caregiver or therapist can change words (in the editor) without touching any logic.
//
// Structure (a small tree):
//   home page → tiles that are either a WORD (speaks) or a CATEGORY (opens a page)
//   category page → [Back] + its words
//
// Positions never change: Back is always far left, each word always in the same column.
// Children learn WHERE a word is, so "Food → Water" becomes an automatic eye movement
// ("motor planning"). Rearranging buttons would break that learning.

export type Word = {
  kind: 'word'
  id: string // unique name used inside the code
  label: string // text shown on the button
  icon: string // emoji shown on the button (children recognize pictures before words)
  picture?: string // id of a photo the caregiver added; shown instead of the emoji
  speak: string // what is said out loud; can be a short sentence
  audio?: string // id of a caregiver's voice recording; if missing, the computer voice speaks
}

export type Category = {
  kind: 'category'
  id: string
  label: string
  icon: string
  picture?: string
  color: string // every word in a category shares its color, which helps visual search
  words: (Word | null)[] // always SLOTS long; null = empty slot (keeps the others in place)
}

export type Back = { kind: 'back'; id: 'back'; label: string; icon: string }

export type Tile = Word | Category | Back

// The whole board's content: what the caregiver edits and what gets saved.
export type Vocabulary = {
  help: Word
  categories: Category[] // always SLOTS long
}

// Every page has this many columns, so button positions stay the same everywhere.
export const COLUMNS = 6
// Home: Help + 5 categories. Category page: Back + 5 words.
export const SLOTS = COLUMNS - 1

const word = (id: string, label: string, icon: string, speak = label): Word => ({ kind: 'word', id, label, icon, speak })

export const HELP_COLOR = '#c62828'
export const BACK: Back = { kind: 'back', id: 'back', label: 'Back', icon: '⬅️' }
export const BACK_COLOR = '#455a64'

// The starting words, used until a caregiver changes them (and by "Reset to default").
export const DEFAULT_VOCABULARY: Vocabulary = {
  help: word('help', 'Help', '🆘', 'I need help'),
  categories: [
    {
      kind: 'category',
      id: 'quick',
      label: 'Quick talk',
      icon: '💬',
      color: '#2f6fd6',
      words: [
        word('yes', 'Yes', '👍'),
        word('no', 'No', '👎'),
        word('more', 'More', '➕'),
        word('all-done', 'All done', '✅'),
        word('stop', 'Stop', '✋'),
      ],
    },
    {
      kind: 'category',
      id: 'food',
      label: 'Food & drink',
      icon: '🍎',
      color: '#c9631a',
      words: [
        word('hungry', 'Hungry', '🍽️', "I'm hungry"),
        word('thirsty', 'Thirsty', '🥤', "I'm thirsty"),
        word('water', 'Water', '💧'),
        word('snack', 'Snack', '🍪'),
        word('fruit', 'Fruit', '🍌'),
      ],
    },
    {
      kind: 'category',
      id: 'feelings',
      label: 'Feelings',
      icon: '😊',
      color: '#3c9a3f',
      words: [
        word('happy', 'Happy', '😊', "I'm happy"),
        word('sad', 'Sad', '😢', "I'm sad"),
        word('angry', 'Angry', '😠', "I'm angry"),
        word('scared', 'Scared', '😨', "I'm scared"),
        word('tired', 'Tired', '😴', "I'm tired"),
      ],
    },
    {
      kind: 'category',
      id: 'activities',
      label: 'Activities',
      icon: '🧩',
      color: '#7a4fc4',
      words: [
        word('play', 'Play', '🧸', 'I want to play'),
        word('music', 'Music', '🎵'),
        word('outside', 'Outside', '🌳', 'I want to go outside'),
        word('book', 'Book', '📖'),
        word('tablet', 'Tablet', '📱'),
      ],
    },
    {
      kind: 'category',
      id: 'body',
      label: 'Body & needs',
      icon: '🚽',
      color: '#11899c',
      words: [
        word('toilet', 'Toilet', '🚽', 'I need the toilet'),
        word('hurts', 'It hurts', '🤕'),
        word('sleep', 'Sleep', '🛏️', 'I want to sleep'),
        word('too-loud', 'Too loud', '🔊', "It's too loud"),
        word('break', 'Break', '⏸️', 'I need a break'),
      ],
    },
  ],
}

// The vocabulary in use right now. One place holds it ("single source of truth"); the
// board, speech and reports all read from here, so they can never disagree.
let current: Vocabulary = DEFAULT_VOCABULARY

export function useVocabulary(v: Vocabulary): void {
  current = v
}

export function vocabulary(): Vocabulary {
  return current
}

export type PageId = 'home' | string // 'home' or a category id

// The tiles shown on a page, in column order. `null` = an empty column (nothing to select).
// Help sits on the home page so it takes ONE look, not two: urgent messages must be fast.
export function pageTiles(page: PageId): (Tile | null)[] {
  const tiles: (Tile | null)[] =
    page === 'home'
      ? [current.help, ...current.categories]
      : [BACK, ...(current.categories.find((c) => c.id === page)?.words ?? [])]
  return Array.from({ length: COLUMNS }, (_, i) => tiles[i] ?? null)
}

// The button color for a tile on a given page.
export function tileColor(tile: Tile, page: PageId): string {
  if (tile.kind === 'back') return BACK_COLOR
  if (tile.kind === 'category') return tile.color
  if (tile.id === current.help.id) return HELP_COLOR
  return current.categories.find((c) => c.id === page)?.color ?? '#555'
}

// Look up any tile by id (for labels in reports and messages).
export function findTile(id: string): Tile | undefined {
  if (id === BACK.id) return BACK
  if (id === current.help.id) return current.help
  return (
    current.categories.find((c) => c.id === id) ??
    current.categories.flatMap((c) => c.words).find((w) => w?.id === id) ??
    undefined
  )
}

// Every photo and recording the vocabulary uses (to delete the ones no longer needed).
export function mediaIds(v: Vocabulary): Set<string> {
  const ids = new Set<string>()
  const add = (t: { picture?: string; audio?: string } | null) => {
    if (t?.picture) ids.add(t.picture)
    if (t?.audio) ids.add(t.audio)
  }
  add(v.help)
  for (const c of v.categories) {
    add(c)
    c.words.forEach(add)
  }
  return ids
}
