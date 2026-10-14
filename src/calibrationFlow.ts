// The full calibration process, start to finish:
//   1. Sweep: a star visits 11 spots across the whole width (word centers, the gaps
//      between words, and both edges), so the model learns the full left-to-right range.
//   2. Test: one look at each word.
//   3. Choose: the recipe that hits the most words in the test; among equally good ones, the
//      lowest error over two "exams" (cross-validation + the word test), simplest if close.
//   4. Quality gate: buttons below GATE % can be redone, instead of shipping a bad board.
//   5. Final model: trained on ALL the data (sweep + test) with the chosen recipe.

import type { Board } from './board.ts'
import { ask, countdown, recordAtTargets, toSamples, type Recording, type Target } from './calibration.ts'
import { crossValidate, scoreModel, type Score } from './evaluate.ts'
import type { FrameStream } from './frameStream.ts'
import { FEATURE_SETS, GazeModel, weightCount, type FeatureSet } from './gazeModel.ts'
import { averagePose, type HeadPose } from './headGuard.ts'
import { findTile } from './vocabulary.ts'

const GATE = 70 // a word must be hit at least this % of the time
const MAX_REDOS = 2 // don't loop forever if a word just won't work today
const SIMPLER_IS_BETTER = 0.5 // % of screen: if a simpler recipe is this close, prefer it

export type Candidate = {
  set: FeatureSet
  cvErrX: number
  cvErrY: number
  test: Score // how this recipe did on the word test
  testErrX: number // RMS aim error on the word test, % of screen width
}

export type CalibrationResult = {
  xModel: GazeModel // decides which word you're looking at
  yModel: GazeModel // only moves the gaze dot up/down
  headRef: HeadPose
  candidates: Candidate[]
  score: Score // word test result for the x model
  recordings: { calibration: Recording[]; test: Recording[] } // raw data, for "Save data"
}

type Column = ReturnType<Board['centers']>[number]

export async function runCalibrationFlow(
  layer: HTMLElement,
  stream: FrameStream,
  board: Board,
): Promise<CalibrationResult> {
  const cols = board.centers()

  // Also record where the head is during calibration, for the head guard.
  const poses: HeadPose[] = []
  const stopPoses = stream.subscribe((info) => poses.push(info.pose))
  try {
    // 1. Sweep across the full width.
    await countdown(layer, 'Follow the star with your eyes.<br>Keep your head still.')
    const calibration = await recordAtTargets(layer, stream, sweepTargets(cols))

    // 3. Test each word.
    await countdown(layer, 'Quick test: look at the star on each picture.')
    let test = await recordAtTargets(layer, stream, cols.map((c) => wordTarget(c, 0.5)))

    let candidates: Candidate[] = []
    let xSet: FeatureSet
    let score: Score
    for (let round = 0; ; round++) {
      // 2. Score every recipe on cross-validation AND on the word test.
      candidates = FEATURE_SETS.map((set) => {
        const cv = crossValidate(calibration, set)
        const t = scoreModel(GazeModel.fit(toSamples(calibration), set), test, board.nearestWord)
        return { set, cvErrX: cv.errX, cvErrY: cv.errY, test: t, testErrX: rms(Object.values(t.biasByWord)) }
      })
      // Choose. Cross-validation alone isn't enough: it can only check spots BETWEEN other
      // spots, so a straight-line recipe that misses the edge words can still look fine
      // there. The word test checks the real buttons, edges included. So: first keep the
      // recipes that hit the most words, then pick the lowest average of the two errors.
      const bestHit = Math.max(...candidates.map((c) => c.test.hitRate))
      const contenders = candidates.filter((c) => c.test.hitRate >= bestHit - 1)
      const chosen = simplestGoodEnough(contenders, (c) => (c.cvErrX + c.testErrX) / 2)
      xSet = chosen.set
      score = chosen.test

      // 4. Quality gate.
      const weak = cols.filter((c) => (score.hitByWord[c.id] ?? 0) < GATE)
      if (weak.length === 0 || round === MAX_REDOS) break
      const names = weak.map((c) => `${findTile(c.id)?.icon ?? ''} ${findTile(c.id)?.label ?? c.id}`).join(', ')
      const choice = await ask(
        layer,
        `<p>${names} ${weak.length === 1 ? "wasn't" : "weren't"} detected well.</p>
         <p class="muted">Redoing them adds a few more practice looks at just those buttons.</p>`,
        ['Redo those buttons', 'Use anyway'],
      )
      if (choice === 1) break

      // Extra practice on the weak buttons only (two heights each), then re-test them.
      await countdown(layer, 'A few more looks. Follow the star.')
      calibration.push(...(await recordAtTargets(layer, stream, weak.flatMap((c) => [wordTarget(c, 0.3), wordTarget(c, 0.7)]))))
      const retest = await recordAtTargets(layer, stream, weak.map((c) => wordTarget(c, 0.5)))
      test = test.map((r) => retest.find((n) => n.target.id === r.target.id) ?? r)
    }

    // 5. Final models on all the data. The test has done its job (choosing and checking),
    //    so its recordings now become extra training examples.
    const all: Recording[] = [...calibration, ...test]
    const ySet = simplestGoodEnough(candidates, (c) => c.cvErrY).set
    return {
      xModel: GazeModel.fit(toSamples(all), xSet),
      yModel: GazeModel.fit(toSamples(all), ySet),
      headRef: averagePose(poses),
      candidates,
      score,
      recordings: { calibration, test },
    }
  } finally {
    stopPoses()
  }
}

// "Quick fix" (drift correction): 3 looks instead of a full calibration.
// After the head shifts a little, the models are still the right SHAPE, just off by a
// constant amount. We measure that amount at 3 words and shift the models back.
// The head position during these looks becomes the new reference for the head guard.
export async function runQuickFix(
  layer: HTMLElement,
  stream: FrameStream,
  board: Board,
  xModel: GazeModel,
  yModel: GazeModel,
): Promise<{ xModel: GazeModel; yModel: GazeModel; headRef: HeadPose }> {
  const cols = board.centers()
  const spots = [cols[0], cols[Math.floor(cols.length / 2)], cols[cols.length - 1]]
  const poses: HeadPose[] = []
  const stopPoses = stream.subscribe((info) => poses.push(info.pose))
  try {
    await countdown(layer, 'Quick fix: look at the star 3 times.')
    const recs = (await recordAtTargets(layer, stream, spots.map((c) => wordTarget(c, 0.5)))).filter((r) => r.frames.length > 0)
    // Average miss over all frames: how far off the models are now.
    let dx = 0
    let dy = 0
    let n = 0
    for (const r of recs) {
      for (const f of r.frames) {
        dx += r.target.x - xModel.predict(f).x
        dy += r.target.y - yModel.predict(f).y
        n++
      }
    }
    return { xModel: xModel.shifted(dx / n, 0), yModel: yModel.shifted(0, dy / n), headRef: averagePose(poses) }
  } finally {
    stopPoses()
  }
}

// 11 spots: each word center, the gaps between words, and both outer edges.
// Heights alternate between the upper and lower part of the buttons, so up/down
// also gets some variety. Ordered left to right so the star glides smoothly.
function sweepTargets(cols: Column[]): Target[] {
  const spacing = (cols[cols.length - 1].x - cols[0].x) / (cols.length - 1)
  const xs: number[] = []
  for (let i = 0; i < cols.length; i++) xs.push(cols[i].x - spacing / 2, cols[i].x)
  xs.push(cols[cols.length - 1].x + spacing / 2)
  const { top, bottom } = cols[0]
  return xs.map((x, i) => ({
    id: 'sweep', // not a word: only used for learning
    x: Math.min(0.97, Math.max(0.03, x)),
    y: top + (i % 2 === 0 ? 0.3 : 0.7) * (bottom - top),
  }))
}

// A spot on a word button; `frac` = how far down the button (0 = top, 1 = bottom).
function wordTarget(c: Column, frac: number): Target {
  return { id: c.id, x: c.x, y: c.top + frac * (c.bottom - c.top) }
}

// "Occam's razor": among recipes whose error is within SIMPLER_IS_BETTER of the best,
// pick the one with the fewest weights. Simpler models break less on new data.
function simplestGoodEnough(candidates: Candidate[], error: (c: Candidate) => number): Candidate {
  const best = Math.min(...candidates.map(error))
  const good = candidates.filter((c) => error(c) <= best + SIMPLER_IS_BETTER)
  return good.reduce((a, b) => (weightCount(b.set) < weightCount(a.set) ? b : a))
}

// Root mean square: like an average, but big misses count extra.
const rms = (vs: number[]) => Math.sqrt(vs.reduce((s, v) => s + v * v, 0) / Math.max(1, vs.length))
