// Calibration and testing: show a star at known spots and record the eye features at each one.
// The same routine serves both purposes:
//   calibration = spots the model LEARNS from
//   validation  = spots used to TEST it afterwards
// Spots are placed on the word buttons themselves, so we calibrate for exactly the task
// the board needs ("task-specific calibration").

import type { EyeFeatures } from './eyeFeatures.ts'
import type { FrameStream } from './frameStream.ts'
import type { Sample, ScreenPoint } from './gazeModel.ts'

// A spot to look at. `id` is the word button it sits on.
export type Target = ScreenPoint & { id: string }

// Everything recorded while looking at one spot.
export type Recording = { target: Target; frames: EyeFeatures[] }

export const SETTLE_MS = 800 // eyes need time to jump to the new spot and settle; ignore this part
export const COLLECT_MS = 1000 // then record for this long

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// A short instruction card with a 3-2-1 countdown, so the user is ready before the star moves.
export async function countdown(layer: HTMLElement, message: string): Promise<void> {
  layer.hidden = false
  const card = document.createElement('div')
  card.className = 'calib-card'
  layer.append(card)
  try {
    for (const n of [3, 2, 1]) {
      card.innerHTML = `<p>${message}</p><div class="count">${n}</div>`
      await wait(800)
    }
  } finally {
    card.remove()
  }
}

export async function recordAtTargets(
  layer: HTMLElement,
  stream: FrameStream,
  targets: Target[],
): Promise<Recording[]> {
  layer.hidden = false
  const star = document.createElement('div')
  star.className = 'calib-star'
  star.textContent = '⭐'
  layer.append(star)

  const recordings: Recording[] = []
  try {
    for (const target of targets) {
      star.style.left = `${target.x * 100}%`
      star.style.top = `${target.y * 100}%`
      star.classList.remove('collecting')
      await wait(SETTLE_MS)

      // Shrinking the star while recording pulls the eye to its exact center.
      star.classList.add('collecting')
      const frames: EyeFeatures[] = []
      const unsubscribe = stream.subscribe((info) => frames.push(info.features))
      await wait(COLLECT_MS)
      unsubscribe()

      recordings.push({ target, frames: dropOutliers(dropBlinks(frames)) })
    }
  } finally {
    // `finally` runs even if something above throws, so the screen is always cleaned up.
    star.remove()
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

// ---- Data cleaning ----

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// A blink makes the eye features jump around, which would teach the model wrong examples.
// Blinks show up as eyelids much more closed than usual, so we drop those frames.
function dropBlinks(fs: EyeFeatures[]): EyeFeatures[] {
  if (fs.length === 0) return fs
  const m = median(fs.map((f) => f.open))
  return fs.filter((f) => f.open > m * 0.7)
}

// While looking at ONE spot, most frames should look alike. Frames that are far from
// the typical one are probably a glance away or a tracking glitch, so we drop them.
// "Far" is measured with the MAD (median absolute deviation), a spread measure that,
// unlike the average, isn't thrown off by the very outliers we're trying to find.
function dropOutliers(fs: EyeFeatures[]): EyeFeatures[] {
  if (fs.length < 5) return fs
  const keys = ['irisX', 'irisY'] as const
  const limits = keys.map((k) => {
    const values = fs.map((f) => f[k])
    const m = median(values)
    const mad = median(values.map((v) => Math.abs(v - m))) || 1e-6
    return { k, m, max: 3 * mad }
  })
  return fs.filter((f) => limits.every(({ k, m, max }) => Math.abs(f[k] - m) <= max))
}
