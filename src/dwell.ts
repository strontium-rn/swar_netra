// Pipeline box 6: Dwell selection.
// Job: decide when the user has "clicked" a button with their eyes.
// Looking at something isn't the same as choosing it (the "Midas touch" problem),
// so a button is chosen only after the gaze has stayed on it for long enough.
//
// "Leaky bucket": each button has a bucket that fills while you look at it and
// slowly drains while you don't. A shaky gaze that keeps slipping off for a moment
// still fills the bucket overall, instead of restarting from zero every time.
// (The same idea is used on servers to limit how many requests a user can send.)

export const DWELL_MS = 1200 // looking time needed to choose a button
const DRAIN_RATE = 0.6 // buckets empty at 60% of the speed they fill
const UNLOCK_MS = 400 // how long you must look away before the same word can be chosen again

export class DwellSelector {
  private buckets = new Map<string, number>() // ms of looking collected per button
  private locked: string | null = null // just chosen: must look away before it can be chosen again
  private awayMs = 0 // how long the gaze has been off the locked button, without interruption
  private lastMs: number | null = null

  // Call once per frame with the id of the button under the gaze (or null).
  // Returns the button's id on the frame its bucket becomes full, otherwise null.
  update(target: string | null, now: number): string | null {
    const dt = this.lastMs === null ? 0 : Math.min(now - this.lastMs, 100) // cap: ignore long pauses
    this.lastMs = now

    // The lock is released only after a REAL look-away. A single jittery frame
    // on the neighbor isn't enough, or a child staring at a word would hear it repeated.
    if (this.locked !== null) {
      this.awayMs = target === this.locked ? 0 : this.awayMs + dt
      if (this.awayMs >= UNLOCK_MS) this.locked = null
    }
    if (target === this.locked) target = null

    // Drain every other bucket, fill the one being looked at.
    for (const [id, ms] of this.buckets) {
      if (id !== target) this.buckets.set(id, Math.max(0, ms - dt * DRAIN_RATE))
    }
    if (target === null) return null
    const filled = (this.buckets.get(target) ?? 0) + dt
    this.buckets.set(target, filled)

    if (filled >= DWELL_MS) {
      this.buckets.clear() // start fresh after a choice
      this.locked = target
      this.awayMs = 0
      return target
    }
    return null
  }

  // The fullest bucket (0..1), for drawing the fill animation.
  progress(): { id: string; fraction: number } | null {
    let best: { id: string; fraction: number } | null = null
    for (const [id, ms] of this.buckets) {
      if (ms > 0 && (!best || ms / DWELL_MS > best.fraction)) best = { id, fraction: ms / DWELL_MS }
    }
    return best
  }

  // Start fresh, e.g. after a page change. `lock` = a button that must not be chosen
  // until the gaze has looked away from it (the button now sitting under the gaze).
  reset(lock: string | null = null): void {
    this.buckets.clear()
    this.locked = lock
    this.awayMs = 0
  }
}
