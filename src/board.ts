// Pipeline box 5 (+ display): The communication board.
// Job: draw the word buttons, tell which button is at a screen position (hit-testing),
// and show the dwell fill and "chosen" animations.

import type { Word } from './vocabulary.ts'

export class Board {
  private buttons = new Map<string, HTMLElement>()

  constructor(container: HTMLElement, words: Word[]) {
    for (const word of words) {
      const button = document.createElement('div')
      button.className = 'word'
      button.dataset.id = word.id // stored on the element so hit-testing can read it back
      button.style.setProperty('--color', word.color)
      button.innerHTML = `<span class="icon">${word.icon}</span><span class="label">${word.label}</span>`
      container.append(button)
      this.buttons.set(word.id, button)
    }
  }

  // Hit-testing: which button is at this screen pixel? The browser already knows where
  // everything is drawn, so we ask it (elementFromPoint) instead of doing the geometry ourselves.
  wordAt(x: number, y: number): string | null {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('.word')
    return element?.dataset.id ?? null
  }

  // Fill one button from the bottom (0..1) and empty all the others.
  showProgress(id: string | null, fraction: number): void {
    for (const [buttonId, button] of this.buttons) {
      button.style.setProperty('--progress', String(buttonId === id ? fraction : 0))
    }
  }

  // Play the "chosen" flash. Removing the class and forcing a re-layout (offsetWidth)
  // restarts the animation even if the same button is chosen twice in a row.
  flash(id: string): void {
    const button = this.buttons.get(id)
    if (!button) return
    button.classList.remove('chosen')
    void button.offsetWidth
    button.classList.add('chosen')
  }
}
