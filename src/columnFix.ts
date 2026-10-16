// Column fix: a small, per-button correction applied after the gaze model.
//
// The gaze model is a smooth curve (3-5 weights). Real eyes don't follow a perfectly smooth
// curve: in a given session, some buttons consistently read a few % to the left, others to
// the right (e.g. one session read the 2nd button 2% and 6% left on two separate looks).
// A smooth curve can't bend for each button, so we add a correction per button:
//   1. After calibration, check where the model puts each button's own looks.
//   2. Shift that button's area back by most of the difference (STRENGTH).
//   3. Between buttons, blend the two neighbouring corrections smoothly.
//
// Tested on 3 daylight sessions (learned from one look, checked on another the model never
// saw): average miss 3.0% → 2.4%, worst 8.2% → 5.3% (a button's edge is 8.3% away).
//
// Why only 80% of the difference? Each look also has some random error. Correcting 100%
// would also "correct" that randomness, which is noise; in testing, 70-100% worked best
// and 130%+ made things worse. Shrinking an estimate toward zero like this is called
// "shrinkage": trust the measurement, but not blindly.

import type { Recording } from './calibration.ts'
import type { GazeModel } from './gazeModel.ts'

const STRENGTH = 0.8
const MAX_FIX = 0.06 // never move any button's area by more than 6% of the screen (safety)
const SAME_SPOT = 0.005 // a recording belongs to a button if its star was this close to the center

export type ColumnFixData = { x: number; fix: number }[] // button center → correction (screen fractions)

export class ColumnFix {
  readonly points: ColumnFixData

  constructor(points: ColumnFixData) {
    this.points = points
  }

  static none(): ColumnFix {
    return new ColumnFix([])
  }

  // Learn from all calibration looks: where did the model put the looks at each button?
  static learn(model: GazeModel, recordings: Recording[], centers: number[]): ColumnFix {
    const points = centers.flatMap((x) => {
      const looks = recordings.filter((r) => Math.abs(r.target.x - x) < SAME_SPOT && r.frames.length > 0)
      if (!looks.length) return []
      // Average per look first, so a long look doesn't count more than a short one.
      const lean = mean(looks.map((r) => mean(r.frames.map((f) => model.predict(f).x)))) - x
      return [{ x, fix: clamp(-STRENGTH * lean, MAX_FIX) }]
    })
    return new ColumnFix(points)
  }

  // Apply to a gaze estimate (screen fraction). Points are in screen order, so we find the
  // two button centers around x and blend their corrections ("linear interpolation").
  // Beyond the first/last button, the nearest correction is used.
  apply(x: number): number {
    const p = this.points
    if (!p.length) return x
    if (x <= p[0].x) return x + p[0].fix
    if (x >= p[p.length - 1].x) return x + p[p.length - 1].fix
    const i = p.findIndex((q) => q.x >= x)
    const a = p[i - 1]
    const b = p[i]
    const t = (x - a.x) / (b.x - a.x)
    return x + a.fix + t * (b.fix - a.fix)
  }

  toJSON(): ColumnFixData {
    return this.points
  }
}

const mean = (vs: number[]) => vs.reduce((s, v) => s + v, 0) / vs.length
const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v))
