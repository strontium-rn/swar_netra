// Pipeline box 3b: Gaze model.
// Job: learn a formula that turns eye features into a screen position.
// Pure math: no camera, no screen. That makes it easy to test and to compare versions.

import type { EyeFeatures, FeatureName } from './eyeFeatures.ts'

// A screen position as fractions: x = 0 is the left edge, 1 is the right edge.
export type ScreenPoint = { x: number; y: number }

// One calibration example: "the eyes looked like `features` while looking at `target`".
export type Sample = { features: EyeFeatures; target: ScreenPoint }

// A "recipe" for the formula: which features it uses.
// `linear` features each get one weight. Every term is one more weight the model must learn,
// and more weights need more calibration data, or the model memorizes noise ("overfitting").
// `squared` (x²) bends the formula the SAME way on both sides, like a parabola.
// `cubed` (x³) bends it in OPPOSITE ways on each side, making an S-curve. That's the
// shape of real eye movement: the eye is a rotating ball, so toward either edge of the
// screen the iris moves a bit less per centimeter, on both sides symmetrically.
export type FeatureSet = { name: string; linear: FeatureName[]; squared: FeatureName[]; cubed: FeatureName[] }

// Candidate recipes, from simplest (2 weights) to most flexible (11 weights).
// Cross-validation picks the one that works best for this person, this time.
export const FEATURE_SETS: FeatureSet[] = [
  { name: 'Iris ↔ only', linear: ['irisX'], squared: [], cubed: [] },
  { name: 'Iris ↔ S-curve', linear: ['irisX'], squared: [], cubed: ['irisX'] },
  // MediaPipe's own "eye looking left/right" reading. It comes from the whole eye area,
  // not just the iris points, so it may hold up better when glasses glare covers the iris.
  { name: 'Eye-look ↔ S-curve', linear: ['lookH'], squared: [], cubed: ['lookH'] },
  // Both readings together: two noisy measurements of the same thing average out.
  { name: 'Iris + eye-look ↔', linear: ['irisX', 'lookH'], squared: [], cubed: ['irisX'] },
  { name: 'Iris ↔ S-curve + head turn', linear: ['irisX', 'yaw'], squared: ['irisX'], cubed: ['irisX'] },
  { name: 'Iris 2D', linear: ['irisX', 'irisY', 'open', 'pitch'], squared: ['irisY'], cubed: ['irisX'] },
  {
    name: 'Iris + eye-look + head',
    linear: ['irisX', 'irisY', 'open', 'lookH', 'lookV', 'yaw', 'pitch'],
    squared: ['irisY'],
    cubed: ['irisX'],
  },
]

// Number of weights a recipe has (the +1 is the constant term).
export const weightCount = (set: FeatureSet) => 1 + set.linear.length + set.squared.length + set.cubed.length

// Mean and spread of each feature, used to rescale all features to similar sizes.
// Without this, a feature measured in big numbers would dominate small ones.
type Scale = { mean: Record<FeatureName, number>; std: Record<FeatureName, number> }

export class GazeModel {
  readonly set: FeatureSet
  private wx: number[] // weights for screen X
  private wy: number[] // weights for screen Y
  private scale: Scale

  private constructor(set: FeatureSet, wx: number[], wy: number[], scale: Scale) {
    this.set = set
    this.wx = wx
    this.wy = wy
    this.scale = scale
  }

  // "Training": find the weights that make predictions closest to the real targets.
  static fit(samples: Sample[], set: FeatureSet): GazeModel {
    const scale = computeScale(samples.map((s) => s.features))
    const rows = samples.map((s) => terms(s.features, set, scale))
    const wx = leastSquares(rows, samples.map((s) => s.target.x))
    const wy = leastSquares(rows, samples.map((s) => s.target.y))
    return new GazeModel(set, wx, wy, scale)
  }

  predict(f: EyeFeatures): ScreenPoint {
    const t = terms(f, this.set, this.scale)
    return { x: dot(t, this.wx), y: dot(t, this.wy) }
  }

  // A copy of this model whose answers are all moved by (dx, dy). Used by "Quick fix":
  // when the head has shifted a little since calibration, every estimate is off by about
  // the same amount, so we measure that amount and subtract it. The first weight belongs
  // to the constant term (always 1), so adding to it shifts every prediction.
  shifted(dx: number, dy: number): GazeModel {
    const wx = [this.wx[0] + dx, ...this.wx.slice(1)]
    const wy = [this.wy[0] + dy, ...this.wy.slice(1)]
    return new GazeModel(this.set, wx, wy, this.scale)
  }

  // Saving and loading: a trained model is just numbers (weights + scale),
  // so it can be stored as plain JSON text and rebuilt later without recalibrating.
  toJSON(): SavedModel {
    return { set: this.set.name, wx: this.wx, wy: this.wy, scale: this.scale }
  }

  static fromJSON(saved: SavedModel): GazeModel {
    const set = FEATURE_SETS.find((s) => s.name === saved.set)
    if (!set) throw new Error(`Unknown feature set: ${saved.set}`)
    return new GazeModel(set, saved.wx, saved.wy, saved.scale)
  }
}

export type SavedModel = { set: string; wx: number[]; wy: number[]; scale: Scale }

// The formula's terms, e.g. for "Iris ↔ S-curve": [1, irisX, irisX³]
// The prediction is each term times its learned weight, all added up.
function terms(f: EyeFeatures, set: FeatureSet, s: Scale): number[] {
  const v = (k: FeatureName) => (f[k] - s.mean[k]) / s.std[k]
  return [1, ...set.linear.map(v), ...set.squared.map((k) => v(k) ** 2), ...set.cubed.map((k) => v(k) ** 3)]
}

// ---- Math helpers ----

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + v * b[i], 0)
}

function computeScale(fs: EyeFeatures[]): Scale {
  const mean = {} as Record<FeatureName, number>
  const std = {} as Record<FeatureName, number>
  for (const k of Object.keys(fs[0]) as FeatureName[]) {
    mean[k] = fs.reduce((sum, f) => sum + f[k], 0) / fs.length
    const variance = fs.reduce((sum, f) => sum + (f[k] - mean[k]) ** 2, 0) / fs.length
    std[k] = Math.sqrt(variance) || 1 // avoid dividing by 0
  }
  return { mean, std }
}

// Least squares: find weights w that minimize the total squared error
// between (rows · w) and the targets. Solved with the "normal equations":
//   (Aᵀ A + λI) w = Aᵀ t
// λ (ridge) is a small penalty on big weights. It stops the formula from going
// wild when the data is noisy, a guard against "overfitting".
function leastSquares(rows: number[][], targets: number[], lambda = 1e-2): number[] {
  const k = rows[0].length
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0))
  const b = new Array<number>(k).fill(0)
  rows.forEach((r, n) => {
    for (let i = 0; i < k; i++) {
      b[i] += r[i] * targets[n]
      for (let j = 0; j < k; j++) A[i][j] += r[i] * r[j]
    }
  })
  for (let i = 1; i < k; i++) A[i][i] += lambda * rows.length // don't penalize the constant term
  return solve(A, b)
}

// Solves A·w = b with Gaussian elimination (the method you may know from school algebra).
function solve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    // Pick the row with the biggest value in this column, for numerical stability.
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r
    ;[M[col], M[pivot]] = [M[pivot], M[col]]
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / M[col][col]
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c]
    }
  }
  const w = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n]
    for (let j = i + 1; j < n; j++) sum -= M[i][j] * w[j]
    w[i] = sum / M[i][i]
  }
  return w
}
