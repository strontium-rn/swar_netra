// Evaluation: measure how good a gaze model is, on test spots recorded after calibration.
//
// The number that matters most for the board is the HIT RATE: while you look at a word,
// what % of the time does the system think you're on that same word?
// We also keep the eye-tracking classics:
//   aim error = how far the average estimate is from the true spot
//   jitter    = how much the estimate shakes while you stare at one spot

import { COLLECT_MS, toSamples, type Recording } from './calibration.ts'
import { GazeModel, type FeatureSet, type ScreenPoint } from './gazeModel.ts'
import { GazeSmoother } from './smoothing.ts'

// Cross-validation ("leave one spot out"): hide one calibration spot, train on the rest,
// and check the prediction at the hidden spot. Repeat for every spot and average.
// Each spot is tested by a model that never saw it, so a recipe that only memorizes
// its training spots (overfitting) scores badly here even if it fits them perfectly.
// Returns the average aim error in % of the screen.
export function crossValidate(recordings: Recording[], set: FeatureSet): { errX: number; errY: number } {
  const usable = recordings.filter((r) => r.frames.length > 0) // a spot can be empty if the face was lost
  let errX = 0
  let errY = 0
  for (let i = 0; i < usable.length; i++) {
    const training = usable.filter((_, j) => j !== i)
    const model = GazeModel.fit(toSamples(training), set)
    const held = usable[i]
    const m = mean(held.frames.map((f) => model.predict(f)))
    errX += Math.abs(m.x - held.target.x)
    errY += Math.abs(m.y - held.target.y)
  }
  return { errX: (errX / usable.length) * 100, errY: (errY / usable.length) * 100 }
}

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
    if (r.frames.length < 4) {
      hitByWord[r.target.id] = 0 // face was lost here: count it as a miss
      continue
    }
    // Replay the estimates through the smoother, as the live board does.
    // Skip the first quarter: the filter needs a moment to settle onto the spot.
    const smoother = new GazeSmoother()
    const dt = COLLECT_MS / 1000 / r.frames.length
    const smoothed = r.frames.map((f) => smoother.smooth(model.predict(f), dt))
    const settled = smoothed.slice(Math.floor(smoothed.length / 4))

    const hits = settled.filter((p) => wordAt(p.x) === r.target.id).length
    hitByWord[r.target.id] = settled.length ? (hits / settled.length) * 100 : 0

    const m = mean(settled)
    errX += Math.abs(m.x - r.target.x)
    errY += Math.abs(m.y - r.target.y)
    jitter += spread(settled)
  }

  const n = Math.max(1, recordings.filter((r) => r.frames.length >= 4).length) // spots actually scored
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
