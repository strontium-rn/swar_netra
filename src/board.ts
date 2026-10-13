// Pipeline box 5 (+ display): The communication board.
// Job: draw the current page of buttons, tell which button the gaze is on (hit-testing),
// and show the "looking", dwell-fill and "chosen" visuals.
// It only DISPLAYS pages; deciding which page to show is main.ts's job.

export type TileView = {
  id: string
  label: string
  icon: string
  color: string
  // For a category: the words inside it, shown small on the button so the user
  // can see what's in there before choosing it, instead of guessing.
  preview?: { icon: string; label: string }[]
}

// Debouncing: to switch to another button, the gaze must stay in that button's column
// for this long. A gaze sitting on a border flickers back and forth faster than this, so
// it can't cause flicker; but a real move (even one that lands near a border because
// the estimate is a bit off) switches quickly, without the user having to push their eyes.
const SWITCH_MS = 120

export class Board {
  private container: HTMLElement
  private buttons: { id: string | null; el: HTMLElement }[] = [] // id null = empty column
  private current: string | null = null // button the gaze is on right now
  private candidate: string | null = null // a different button the gaze has moved to
  private candidateSinceMs = 0 // when the gaze arrived on the candidate

  constructor(container: HTMLElement) {
    this.container = container
  }

  // Draw a page. Returns the id of the NEW button sitting where the gaze currently is,
  // so the caller can lock it (otherwise it would get selected without being chosen).
  setPage(tiles: (TileView | null)[]): string | null {
    const gazeColumn = this.buttons.findIndex((b) => b.id !== null && b.id === this.current)

    this.container.replaceChildren()
    this.buttons = tiles.map((tile) => {
      const el = document.createElement('div')
      if (tile) {
        el.className = 'word'
        el.style.setProperty('--color', tile.color)
        el.innerHTML = `<span class="icon">${tile.icon}</span><span class="label">${tile.label}</span>`
        if (tile.preview) {
          el.classList.add('category')
          el.innerHTML += `<span class="preview-icons">${tile.preview.map((w) => w.icon).join('')}</span>
            <span class="preview-words">${tile.preview.map((w) => w.label).join(' · ')}</span>`
        }
      } else {
        el.className = 'word empty'
      }
      this.container.append(el)
      return { id: tile?.id ?? null, el }
    })

    this.current = gazeColumn >= 0 ? (this.buttons[gazeColumn]?.id ?? null) : null
    this.candidate = null
    return this.current
  }

  // Used live: remembers the current button, so it can debounce switches.
  // `x` is a fraction of the screen width (0 = left edge, 1 = right edge); `now` in ms.
  wordAt(x: number, now: number): string | null {
    const nearest = this.nearestWord(x)
    if (nearest === this.current || this.current === null) {
      this.current = nearest
      this.candidate = null
      return this.current
    }
    // The gaze is on a different button: switch only once it has stayed there long enough.
    if (nearest !== this.candidate) {
      this.candidate = nearest
      this.candidateSinceMs = now
    }
    if (now - this.candidateSinceMs >= SWITCH_MS) {
      this.current = nearest
      this.candidate = null
    }
    return this.current
  }

  // Used for testing: no memory, so every position is judged on its own.
  // Gaps between buttons and points off-screen count as "the nearest column";
  // an empty column returns null (nothing to select there).
  nearestWord = (x: number): string | null => {
    const cols = this.columns()
    const distance = (c: { left: number; right: number }) => (x < c.left ? c.left - x : x > c.right ? x - c.right : 0)
    return cols.reduce((best, c) => (distance(c) < distance(best) ? c : best)).id
  }

  // Calibration spots: the center of each (non-empty) button, as screen fractions.
  centers(): { id: string; x: number; top: number; bottom: number }[] {
    return this.buttons.flatMap(({ id, el }) => {
      if (id === null) return []
      const r = el.getBoundingClientRect()
      return [
        {
          id,
          x: (r.left + r.width / 2) / window.innerWidth,
          top: r.top / window.innerHeight,
          bottom: r.bottom / window.innerHeight,
        },
      ]
    })
  }

  // Outline the button being looked at, and fill one button from the bottom (0..1).
  show(looking: string | null, filling: string | null, fraction: number): void {
    for (const { id, el } of this.buttons) {
      if (id === null) continue
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

  // Each column's left and right edge, as screen fractions.
  private columns() {
    return this.buttons.map(({ id, el }) => {
      const r = el.getBoundingClientRect()
      return { id, left: r.left / window.innerWidth, right: r.right / window.innerWidth }
    })
  }
}
