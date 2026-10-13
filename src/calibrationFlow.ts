// The full calibration process, start to finish:
//   1. Sweep: a star visits 11 spots across the whole width (word centers, the gaps
//      between words, and both edges), so the model learns the full left-to-right range.
//   2. Choose: cross-validation picks the recipe that works best on spots it never saw.
//   3. Test: one look at each word, scored by hit rate.
//   4. Quality gate: words below GATE % can be redone, instead of shipping a bad board.
//   5. Final model: trained on ALL the data (sweep + test) with the chosen recipe.

import type { Board } from './board.ts'
import { ask, countdown, recordAtTargets, toSamples, type Recording, type Target } from './calibration.ts'
import { crossValidate, scoreModel, type Score } from './evaluate.ts'
import type { FrameStream } from './frameStream.ts'
import { FEATURE_SETS, GazeModel, weightCount, type FeatureSet } from './gazeModel.ts'
import { averagePose, type HeadPose } from './headGuard.ts'
import { WORDS } from './vocabulary.ts'

const GATE = 70 // a word must be hit at least this % of the time
const MAX_REDOS = 2 // don't loop forever if a word just won't work today
const SIMPLER_IS_BETTER = 0.5 // % of screen: if a simpler recipe is this close, prefer it

export type Candidate = { set: FeatureSet; cvErrX: number; cvErrY: number }

export type CalibrationResult = {
  xModel: GazeModel // decides which word you're looking at
  yModel: GazeModel // only moves the gaze dot up/down
  headRef: HeadPose
  candidates: Candidate[]
  score: Score // word test result for the x model
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
      // 2. Choose recipes with cross-validation.
      candidates = FEATURE_SETS.map((set) => {
        const cv = crossValidate(calibration, set)
        return { set, cvErrX: cv.errX, cvErrY: cv.errY }
      })
      xSet = simplestGoodEnough(candidates, (c) => c.cvErrX)
      score = scoreModel(GazeModel.fit(toSamples(calibration), xSet), test, board.nearestWord)

      // 4. Quality gate.
      const weak = WORDS.filter((w) => (score.hitByWord[w.id] ?? 0) < GATE)
      if (weak.length === 0 || round === MAX_REDOS) break
      const names = weak.map((w) => `${w.icon} ${w.label}`).join(', ')
      const choice = await ask(
        layer,
        `<p>${names} ${weak.length === 1 ? "wasn't" : "weren't"} detected well.</p>
         <p class="muted">Redoing them adds a few more practice looks at just those pictures.</p>`,
        ['Redo those words', 'Use anyway'],
      )
      if (choice === 1) break

      // Extra practice on the weak words only (two heights each), then re-test them.
      const weakCols = cols.filter((c) => weak.some((w) => w.id === c.id))
      await countdown(layer, 'A few more looks. Follow the star.')
      calibration.push(...(await recordAtTargets(layer, stream, weakCols.flatMap((c) => [wordTarget(c, 0.3), wordTarget(c, 0.7)]))))
      const retest = await recordAtTargets(layer, stream, weakCols.map((c) => wordTarget(c, 0.5)))
      test = test.map((r) => retest.find((n) => n.target.id === r.target.id) ?? r)
    }

    // 5. Final models on all the data. The test has done its job (choosing and checking),
    //    so its recordings now become extra training examples.
    const all: Recording[] = [...calibration, ...test]
    const ySet = simplestGoodEnough(candidates, (c) => c.cvErrY)
    return {
      xModel: GazeModel.fit(toSamples(all), xSet),
      yModel: GazeModel.fit(toSamples(all), ySet),
      headRef: averagePose(poses),
      candidates,
      score,
    }
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
function simplestGoodEnough(candidates: Candidate[], error: (c: Candidate) => number): FeatureSet {
  const best = Math.min(...candidates.map(error))
  const good = candidates.filter((c) => error(c) <= best + SIMPLER_IS_BETTER)
  return good.reduce((a, b) => (weightCount(b.set) < weightCount(a.set) ? b : a)).set
}
