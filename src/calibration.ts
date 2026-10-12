// Calibration: show a dot at 9 known spots and record the eye features at each one.
// The result is a list of examples that the gaze model learns from.

import type { EyeFeatures } from './eyeFeatures.ts'
import type { Sample } from './gazeModel.ts'

// `subscribe` lets calibration "listen" to the stream of eye features from the main loop.
// It returns a function that stops listening (unsubscribe).
export type Subscribe = (listener: (f: EyeFeatures) => void) => () => void

// 3×3 grid of spots, as fractions of the screen. Not at the very edge (0 or 1),
// because the dot must be fully visible.
const TARGETS = [0.08, 0.5, 0.92].flatMap((y) => [0.08, 0.5, 0.92].map((x) => ({ x, y })))

const SETTLE_MS = 900 // eyes need time to jump to the new dot and settle; ignore this part
const COLLECT_MS = 1100 // then record for this long

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function runCalibration(layer: HTMLElement, subscribe: Subscribe): Promise<Sample[]> {
  layer.hidden = false
  const dot = document.createElement('div')
  dot.className = 'calib-dot'
  layer.append(dot)

  const samples: Sample[] = []
  try {
    for (const target of TARGETS) {
      dot.style.left = `${target.x * 100}%`
      dot.style.top = `${target.y * 100}%`
      dot.classList.remove('collecting')
      await wait(SETTLE_MS)

      // Shrinking the dot while recording pulls the eye to its exact center.
      dot.classList.add('collecting')
      const collected: EyeFeatures[] = []
      const unsubscribe = subscribe((f) => collected.push(f))
      await wait(COLLECT_MS)
      unsubscribe()

      for (const features of dropBlinks(collected)) samples.push({ features, target })
    }
  } finally {
    // `finally` runs even if something above throws, so the screen is always cleaned up.
    dot.remove()
    layer.hidden = true
  }

  if (samples.length < 9 * 10) {
    throw new Error("Couldn't see your eyes well enough. Check lighting and face the camera.")
  }
  return samples
}

// A blink makes the eye features jump around, which would teach the model wrong examples.
// Blinks show up as eyelids much more closed than usual, so we drop those frames.
function dropBlinks(fs: EyeFeatures[]): EyeFeatures[] {
  if (fs.length === 0) return fs
  const sorted = fs.map((f) => f.open).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return fs.filter((f) => f.open > median * 0.7)
}
