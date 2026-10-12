// Pipeline box 4: Smoothing.
// Job: remove jitter from the gaze point without making it feel laggy.
//
// The One Euro Filter (Casiez et al., 2012) is the standard tool for this.
// The idea: a simple average either shakes (light smoothing) or lags (heavy smoothing).
// So we adapt: when the gaze is nearly still, smooth heavily (kills jitter);
// when it moves fast (eyes jumping to a new button), smooth lightly (no lag).

import type { ScreenPoint } from './gazeModel.ts'

// Tuning knobs. Values are in "screens", e.g. a speed of 1 = one screen-width per second.
const MIN_CUTOFF = 0.4 // lower = smoother when still (but slower to settle)
const BETA = 2.0 // higher = less lag during fast movements
const D_CUTOFF = 1.0 // smoothing for the speed estimate itself

// Exponential smoothing: new = old + alpha × (input − old). alpha near 0 = heavy smoothing.
// The cutoff (in Hz) and the time step decide alpha.
function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}

// Smooths one number (we use one filter for x and one for y).
class OneEuro {
  private value: number | null = null
  private speed = 0

  filter(x: number, dt: number): number {
    if (this.value === null) {
      this.value = x
      return x
    }
    // Estimate how fast the value is changing (smoothed, because speed is noisy too).
    const rawSpeed = (x - this.value) / dt
    this.speed += alpha(D_CUTOFF, dt) * (rawSpeed - this.speed)
    // Fast movement → higher cutoff → less smoothing.
    const cutoff = MIN_CUTOFF + BETA * Math.abs(this.speed)
    this.value += alpha(cutoff, dt) * (x - this.value)
    return this.value
  }
}

export class GazeSmoother {
  private fx = new OneEuro()
  private fy = new OneEuro()

  // dt = seconds since the previous point
  smooth(p: ScreenPoint, dt: number): ScreenPoint {
    return { x: this.fx.filter(p.x, dt), y: this.fy.filter(p.y, dt) }
  }
}
