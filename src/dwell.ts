// Pipeline box 6: Dwell selection.
// Job: decide when the user has "clicked" a button with their eyes.
// Looking at something isn't the same as choosing it (the "Midas touch" problem),
// so a button is chosen only after the gaze stays on it for DWELL_MS.

export const DWELL_MS = 1200 // how long to look at a button to choose it
const GRACE_MS = 300 // a blink or a short jitter off the button doesn't reset the timer

export class DwellSelector {
  private current: string | null = null // button currently being looked at
  private startMs = 0 // when the gaze arrived on it
  private lastSeenMs = 0 // last time the gaze was on it
  private locked: string | null = null // just chosen: must look away before it can be chosen again

  // Call once per frame with the id of the button under the gaze (or null).
  // Returns the button's id on the frame its dwell completes, otherwise null.
  update(target: string | null, now: number): string | null {
    // The lock is released as soon as the gaze is anywhere else.
    if (this.locked !== null && target !== this.locked) this.locked = null
    if (target === this.locked) target = null

    if (target !== null && target === this.current) {
      this.lastSeenMs = now // still looking at the same button
    } else if (target !== null) {
      // Gaze moved to a different button: start timing that one.
      this.current = target
      this.startMs = now
      this.lastSeenMs = now
    } else if (this.current !== null && now - this.lastSeenMs > GRACE_MS) {
      this.current = null // gaze has really left (not just a blink)
    }

    if (this.current !== null && now - this.startMs >= DWELL_MS) {
      const chosen = this.current
      this.locked = chosen
      this.current = null
      return chosen
    }
    return null
  }

  // How far the current dwell has progressed (0..1), for drawing the fill animation.
  progress(now: number): { id: string; fraction: number } | null {
    if (this.current === null) return null
    return { id: this.current, fraction: Math.min(1, (now - this.startMs) / DWELL_MS) }
  }
}
