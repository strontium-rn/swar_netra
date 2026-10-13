// Evaluation: measure how good a gaze model is, on test spots recorded after calibration.
//
// The number that matters most for the board is the HIT RATE: while you look at a word,
// what % of the time does the system think you're on that same word?
// We also keep the eye-tracking classics:
//   aim error = how far the average estimate is from the true spot
//   jitter    = how much the estimate shakes while you stare at one spot

import { COLLECT_MS, type Recording } from './calibration.ts'
import type { GazeModel, ScreenPoint } from './gazeModel.ts'
import { GazeSmoother } from './smoothing.ts'

// All numbers are percentages.
export type Score = {
  name: string
  hitRate: number // % of frames on the right word, averaged over all words
  hitByWord: Record<string, number> // the same, per word
  errX: number // % of screen width
  errY: number // % of screen height
  jitter: number // % of screen, after smoothing
}

// `wordAt` turns an x position into a word id: the same hit-testing the board uses.
export function scoreModel(model: GazeModel, recordings: Recording[], wordAt: (x: number) => string | null): Score {
  let errX = 0
  let errY = 0
  let jitter = 0
  const hitByWord: Record<string, number> = {}

  for (const r of recordings) {
    // Replay the estimates through the smoother, as the live board does.
    // Skip the first quarter: the filter needs a moment to settle onto the spot.
    const smoother = new GazeSmoother()
    const dt = COLLECT_MS / 1000 / r.frames.length
    const smoothed = r.frames.map((f) => smoother.smooth(model.predict(f), dt))
    const settled = smoothed.slice(Math.floor(smoothed.length / 4))

    const hits = settled.filter((p) => wordAt(p.x) === r.target.id).length
    hitByWord[r.target.id] = (hits / settled.length) * 100

    const m = mean(settled)
    errX += Math.abs(m.x - r.target.x)
    errY += Math.abs(m.y - r.target.y)
    jitter += spread(settled)
  }

  const n = recordings.length
  const hitValues = Object.values(hitByWord)
  return {
    name: model.set.name,
    hitRate: hitValues.reduce((s, v) => s + v, 0) / hitValues.length,
    hitByWord,
    errX: (errX / n) * 100,
    errY: (errY / n) * 100,
    jitter: (jitter / n) * 100,
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
