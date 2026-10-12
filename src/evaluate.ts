// Evaluation: measure how good a gaze model is, using test dots it has never seen.
//
// Eye-tracking quality has two separate parts:
//   accuracy  = on average, how far the estimate is from where you really looked (aim)
//   jitter    = how much the estimate shakes while you stare at one spot (steadiness)
// A model can be accurate but shaky, or steady but aimed wrong, so we measure both.

import { COLLECT_MS, type Recording } from './calibration.ts'
import type { GazeModel, ScreenPoint } from './gazeModel.ts'
import { GazeSmoother } from './smoothing.ts'

// All numbers are percentages of the screen (10 = a tenth of the screen).
export type Score = { name: string; errX: number; errY: number; jitter: number; jitterSmoothed: number }

export function scoreModel(model: GazeModel, recordings: Recording[]): Score {
  let errX = 0
  let errY = 0
  let jitter = 0
  let jitterSmoothed = 0

  for (const r of recordings) {
    const raw = r.frames.map((f) => model.predict(f))

    // Accuracy: average all estimates for this dot, then compare with the true spot.
    const m = mean(raw)
    errX += Math.abs(m.x - r.target.x)
    errY += Math.abs(m.y - r.target.y)
    jitter += spread(raw)

    // Replay the same estimates through the smoother to see how much it calms them.
    // Skip the first quarter: the filter needs a moment to settle onto the dot.
    const smoother = new GazeSmoother()
    const dt = COLLECT_MS / 1000 / raw.length
    const smoothed = raw.map((p) => smoother.smooth(p, dt))
    jitterSmoothed += spread(smoothed.slice(Math.floor(smoothed.length / 4)))
  }

  const n = recordings.length
  return {
    name: model.set.name,
    errX: (errX / n) * 100,
    errY: (errY / n) * 100,
    jitter: (jitter / n) * 100,
    jitterSmoothed: (jitterSmoothed / n) * 100,
  }
}

function mean(ps: ScreenPoint[]): ScreenPoint {
  return {
    x: ps.reduce((s, p) => s + p.x, 0) / ps.length,
    y: ps.reduce((s, p) => s + p.y, 0) / ps.length,
  }
}

// Average distance of the points from their own center: how much they shake.
function spread(ps: ScreenPoint[]): number {
  const m = mean(ps)
  return ps.reduce((s, p) => s + Math.hypot(p.x - m.x, p.y - m.y), 0) / ps.length
}
