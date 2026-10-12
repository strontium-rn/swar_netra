// Pipeline box 3b: Gaze model.
// Job: learn a formula that turns eye features into a screen position.
// Pure math: no camera, no screen. That makes it easy to test and to replace later.

import type { EyeFeatures } from './eyeFeatures.ts'

// A screen position as fractions: x = 0 is the left edge, 1 is the right edge.
export type ScreenPoint = { x: number; y: number }

// One calibration example: "the eyes looked like `features` while looking at `target`".
export type Sample = { features: EyeFeatures; target: ScreenPoint }

// Mean and spread of each feature, used to rescale features to similar sizes.
type Scale = { mean: EyeFeatures; std: EyeFeatures }

// The "terms" of our formula. The prediction is:
//   screenX = w0*1 + w1*x + w2*y + w3*x*y + w4*x² + w5*y² + w6*open
// The squared terms let the formula bend, because the eye is a ball, not a flat mirror,
// so iris movement and screen position aren't perfectly proportional.
function terms(f: EyeFeatures, s: Scale): number[] {
  const x = (f.x - s.mean.x) / s.std.x
  const y = (f.y - s.mean.y) / s.std.y
  const o = (f.open - s.mean.open) / s.std.open
  return [1, x, y, x * y, x * x, y * y, o]
}

export class GazeModel {
  private wx: number[] // weights for screen X
  private wy: number[] // weights for screen Y
  private scale: Scale

  private constructor(wx: number[], wy: number[], scale: Scale) {
    this.wx = wx
    this.wy = wy
    this.scale = scale
  }

  // "Training": find the weights that make predictions closest to the real targets.
  static fit(samples: Sample[]): GazeModel {
    const scale = computeScale(samples.map((s) => s.features))
    const rows = samples.map((s) => terms(s.features, scale))
    const wx = leastSquares(rows, samples.map((s) => s.target.x))
    const wy = leastSquares(rows, samples.map((s) => s.target.y))
    return new GazeModel(wx, wy, scale)
  }

  predict(f: EyeFeatures): ScreenPoint {
    const t = terms(f, this.scale)
    return { x: dot(t, this.wx), y: dot(t, this.wy) }
  }
}

// ---- Math helpers ----

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + v * b[i], 0)
}

function computeScale(fs: EyeFeatures[]): Scale {
  const keys = ['x', 'y', 'open'] as const
  const mean = { x: 0, y: 0, open: 0 }
  const std = { x: 0, y: 0, open: 0 }
  for (const k of keys) {
    mean[k] = fs.reduce((sum, f) => sum + f[k], 0) / fs.length
    const variance = fs.reduce((sum, f) => sum + (f[k] - mean[k]) ** 2, 0) / fs.length
    std[k] = Math.sqrt(variance) || 1 // avoid dividing by 0
  }
  return { mean, std }
}

// Least squares: find weights w that minimize the total squared error
// between (rows · w) and the targets. Solved with the "normal equations":
//   (Aᵀ A + λI) w = Aᵀ t
// λ (ridge) is a tiny penalty on big weights. It stops the formula from going
// wild when the data is noisy, a guard against "overfitting".
function leastSquares(rows: number[][], targets: number[], lambda = 1e-3): number[] {
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
