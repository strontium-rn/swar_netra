// Pipeline box 5 (+ display): The communication board.
// Job: draw the word buttons, tell which word the gaze is on (hit-testing),
// and show the "looking", dwell-fill and "chosen" visuals.

import type { Word } from './vocabulary.ts'

// Hysteresis: to switch from one word to its neighbor, the gaze must go this far
// PAST the border between them (fraction of screen width). Without it, a gaze sitting
// near a border flickers between two words and neither ever fills up.
const SWITCH_MARGIN = 0.025

export class Board {
  private buttons: { id: string; el: HTMLElement }[] = []
  private current: string | null = null // word the gaze is on right now

  constructor(container: HTMLElement, words: Word[]) {
    for (const word of words) {
      const el = document.createElement('div')
      el.className = 'word'
      el.style.setProperty('--color', word.color)
      el.innerHTML = `<span class="icon">${word.icon}</span><span class="label">${word.label}</span>`
      container.append(el)
      this.buttons.push({ id: word.id, el })
    }
  }

  // Hit-testing by COLUMN: only the left/right position matters, because our up/down
  // accuracy is poor. `x` is a fraction of the screen width (0 = left edge, 1 = right edge).
  // Used live: remembers the current word, so it applies hysteresis.
  wordAt(x: number): string | null {
    const nearest = this.nearestWord(x)
    const cur = this.columns().find((c) => c.id === this.current)
    // Hysteresis: stay on the current word unless the gaze is clearly inside another one.
    if (cur && nearest !== cur.id) {
      const clearlyOutside = x < cur.left - SWITCH_MARGIN || x > cur.right + SWITCH_MARGIN
      if (!clearlyOutside) return this.current
    }
    this.current = nearest
    return this.current
  }

  // Used for testing: no memory, so every position is judged on its own.
  // Gaps between buttons and points off-screen count as "the nearest word".
  nearestWord = (x: number): string => {
    const cols = this.columns()
    const distance = (c: { left: number; right: number }) => (x < c.left ? c.left - x : x > c.right ? x - c.right : 0)
    return cols.reduce((best, c) => (distance(c) < distance(best) ? c : best)).id
  }

  // Calibration spots: the center of each button, as screen fractions.
  centers(): { id: string; x: number; top: number; bottom: number }[] {
    return this.buttons.map(({ id, el }) => {
      const r = el.getBoundingClientRect()
      return {
        id,
        x: (r.left + r.width / 2) / window.innerWidth,
        top: r.top / window.innerHeight,
        bottom: r.bottom / window.innerHeight,
      }
    })
  }

  // Outline the word being looked at, and fill one button from the bottom (0..1).
  show(looking: string | null, filling: string | null, fraction: number): void {
    for (const { id, el } of this.buttons) {
      el.classList.toggle('looking', id === looking)
      el.style.setProperty('--progress', String(id === filling ? fraction : 0))
    }
  }

  // Play the "chosen" flash. Removing the class and forcing a re-layout (offsetWidth)
  // restarts the animation even if the same button is chosen twice in a row.
  flash(id: string): void {
    const el = this.buttons.find((b) => b.id === id)?.el
    if (!el) return
    el.classList.remove('chosen')
    void el.offsetWidth
    el.classList.add('chosen')
  }

  // Each button's left and right edge, as screen fractions.
  private columns() {
    return this.buttons.map(({ id, el }) => {
      const r = el.getBoundingClientRect()
      return { id, left: r.left / window.innerWidth, right: r.right / window.innerWidth }
    })
  }
}
