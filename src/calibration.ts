// Calibration and testing: show a dot at known spots and record the eye features at each one.
// The same routine serves both purposes:
//   calibration = dots the model LEARNS from
//   validation  = new dots the model has NEVER seen, used to measure how good it is

import type { EyeFeatures } from './eyeFeatures.ts'
import type { FrameStream } from './frameStream.ts'
import type { Sample, ScreenPoint } from './gazeModel.ts'

// Everything recorded while looking at one dot.
export type Recording = { target: ScreenPoint; frames: EyeFeatures[] }

// Spots are fractions of the screen. Not at the very edge (0 or 1), so the dot is fully visible.
const grid = (xs: number[], ys: number[]) => ys.flatMap((y) => xs.map((x) => ({ x, y })))

// 4×4 = 16 spots, reaching close to the edges and corners so the model doesn't have to guess there.
export const CALIBRATION_TARGETS = grid([0.06, 0.35, 0.65, 0.94], [0.06, 0.35, 0.65, 0.94])

// Test spots placed BETWEEN the calibration spots, so the model is tested on new positions.
export const VALIDATION_TARGETS = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.5, y: 0.5 },
  { x: 0.2, y: 0.8 },
  { x: 0.8, y: 0.8 },
]

export const SETTLE_MS = 800 // eyes need time to jump to the new dot and settle; ignore this part
export const COLLECT_MS = 1000 // then record for this long

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function recordAtTargets(
  layer: HTMLElement,
  stream: FrameStream,
  targets: ScreenPoint[],
): Promise<Recording[]> {
  layer.hidden = false
  const dot = document.createElement('div')
  dot.className = 'calib-dot'
  layer.append(dot)

  const recordings: Recording[] = []
  try {
    for (const target of targets) {
      dot.style.left = `${target.x * 100}%`
      dot.style.top = `${target.y * 100}%`
      dot.classList.remove('collecting')
      await wait(SETTLE_MS)

      // Shrinking the dot while recording pulls the eye to its exact center.
      dot.classList.add('collecting')
      const frames: EyeFeatures[] = []
      const unsubscribe = stream.subscribe((info) => frames.push(info.features))
      await wait(COLLECT_MS)
      unsubscribe()

      recordings.push({ target, frames: dropBlinks(frames) })
    }
  } finally {
    // `finally` runs even if something above throws, so the screen is always cleaned up.
    dot.remove()
    layer.hidden = true
  }

  const total = recordings.reduce((sum, r) => sum + r.frames.length, 0)
  if (total < targets.length * 10) {
    throw new Error("Couldn't see your eyes well enough. Check lighting and face the camera.")
  }
  return recordings
}

// Flatten recordings into the (features, target) pairs the model trains on.
export function toSamples(recordings: Recording[]): Sample[] {
  return recordings.flatMap((r) => r.frames.map((features) => ({ features, target: r.target })))
}

// A blink makes the eye features jump around, which would teach the model wrong examples.
// Blinks show up as eyelids much more closed than usual, so we drop those frames.
function dropBlinks(fs: EyeFeatures[]): EyeFeatures[] {
  if (fs.length === 0) return fs
  const sorted = fs.map((f) => f.open).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return fs.filter((f) => f.open > median * 0.7)
}
