// Drift tracker: automatic, continuous "Quick fix".
// Over minutes, the head settles a little differently than during calibration, and the
// whole estimate slowly slides sideways ("drift"). Near the screen edges the eye moves
// least between neighbouring words, so that's where drift first causes the wrong word.
//
// Idea: people look at the CENTERS of buttons. So whenever the gaze rests (a "fixation")
// close to a button's center, the small gap between the two is probably drift. We correct
// a small fraction of it each time. Many small nudges from many fixations average out
// to the real drift, while the random errors of single fixations cancel each other.
//
// Safety rules, so it can't run away:
// - Only fixations already CLOSE to a center count (dead zone). A gaze sitting between two
//   buttons is ambiguous: we don't know which one was meant, so we learn nothing from it.
// - Each nudge is small (RATE), and the total correction is capped (MAX_SHIFT).

const FIXATION_MS = 400 // the gaze must stay still this long to count as a fixation
const STILL = 0.03 // "still" = moved less than this (fraction of screen width)
const CLOSE = 0.3 // only learn when within this fraction of the button spacing from a center
const RATE = 0.05 // correct 5% of the gap per fixation
const MAX_SHIFT = 0.08 // never correct more than 8% of the screen in total

export class DriftTracker {
  private shift = 0 // current correction, added to every estimate
  private window: { t: number; x: number }[] = []

  // Apply the correction to a raw estimate.
  correct(x: number): number {
    return x + this.shift
  }

  // Feed every (corrected) estimate; `centers` = x of each button center on screen.
  observe(x: number, now: number, centers: number[]): void {
    this.window.push({ t: now, x })
    while (this.window.length && this.window[0].t < now - FIXATION_MS) this.window.shift()
    if (this.window.length < 5 || now - this.window[0].t < FIXATION_MS * 0.8) return

    const xs = this.window.map((p) => p.x)
    if (Math.max(...xs) - Math.min(...xs) > STILL) return // still moving: not a fixation

    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const nearest = centers.reduce((a, b) => (Math.abs(b - mean) < Math.abs(a - mean) ? b : a))
    const spacing = (centers[centers.length - 1] - centers[0]) / (centers.length - 1)
    const gap = nearest - mean
    if (Math.abs(gap) < CLOSE * spacing) {
      this.shift = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, this.shift + RATE * gap))
    }
    this.window = [] // one nudge per fixation, then start a new one
  }

  reset(): void {
    this.shift = 0
    this.window = []
  }

  get current(): number {
    return this.shift
  }
}
