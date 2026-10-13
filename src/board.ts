// Pipeline box 5 (+ display): The communication board.
// Job: draw the current page of buttons, tell which button the gaze is on (hit-testing),
// and show the "looking", dwell-fill and "chosen" visuals.
// It only DISPLAYS pages; deciding which page to show is main.ts's job.

export type TileView = { id: string; label: string; icon: string; color: string }

// Hysteresis: to switch from one button to its neighbor, the gaze must go this far
// PAST the border between them (fraction of screen width). Without it, a gaze sitting
// near a border flickers between two buttons and neither ever fills up.
const SWITCH_MARGIN = 0.025

export class Board {
  private container: HTMLElement
  private buttons: { id: string | null; el: HTMLElement }[] = [] // id null = empty column
  private current: string | null = null // button the gaze is on right now

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
      } else {
        el.className = 'word empty'
      }
      this.container.append(el)
      return { id: tile?.id ?? null, el }
    })

    this.current = gazeColumn >= 0 ? (this.buttons[gazeColumn]?.id ?? null) : null
    return this.current
  }

  // Used live: remembers the current button, so it applies hysteresis.
  // `x` is a fraction of the screen width (0 = left edge, 1 = right edge).
  wordAt(x: number): string | null {
    const nearest = this.nearestWord(x)
    const cur = this.columns().find((c) => c.id !== null && c.id === this.current)
    // Hysteresis: stay on the current button unless the gaze is clearly inside another one.
    if (cur && nearest !== cur.id) {
      const clearlyOutside = x < cur.left - SWITCH_MARGIN || x > cur.right + SWITCH_MARGIN
      if (!clearlyOutside) return this.current
    }
    this.current = nearest
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
