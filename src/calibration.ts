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

// Timing for each spot. People react at different speeds (a child, a grandparent), so
// instead of guessing when the eyes have arrived, we record a longer stretch and then
// KEEP the steadiest part of it: that's where the eyes were resting on the star.
const SETTLE_MS = 400 // the eyes are certainly still jumping during this part: skip it
const LOOK_MS = 1600 // then record for this long...
export const COLLECT_MS = 800 // ...and keep the steadiest stretch of this length

// A spot whose data is much shakier than the others (or mostly blinks) is redone once
// automatically, at the end of the run, so one bad moment doesn't spoil the calibration.
const SHAKY = 2.5 // "much shakier" = this many times the typical spot's shake

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

// A card with a message and some buttons; resolves with the index of the button clicked.
// Used for the quality gate ("Hungry wasn't detected well. Redo it?").
export function ask(layer: HTMLElement, html: string, choices: string[]): Promise<number> {
  layer.hidden = false
  const card = document.createElement('div')
  card.className = 'calib-card'
  card.innerHTML = `<div>${html}</div><div class="choices"></div>`
  layer.append(card)
  return new Promise((resolve) => {
    choices.forEach((label, i) => {
      const button = document.createElement('button')
      button.textContent = label
      button.addEventListener('click', () => {
        card.remove()
        resolve(i)
      })
      card.querySelector('.choices')!.append(button)
    })
  })
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

  try {
    const recordings: Recording[] = []
    for (const target of targets) recordings.push(await recordSpot(star, stream, target))

    // Quality check: redo spots that came out much worse than the rest.
    const typical = median(recordings.map(shake))
    const typicalCount = median(recordings.map((r) => r.frames.length))
    for (let i = 0; i < recordings.length; i++) {
      const r = recordings[i]
      if (shake(r) <= typical * SHAKY && r.frames.length >= typicalCount / 2) continue
      const again = await recordSpot(star, stream, r.target)
      if (again.frames.length >= r.frames.length / 2 && shake(again) < shake(r)) recordings[i] = again
    }

    const total = recordings.reduce((sum, r) => sum + r.frames.length, 0)
    if (total < targets.length * 10) {
      throw new Error("Couldn't see your eyes well enough. Check lighting and face the camera.")
    }
    return recordings
  } finally {
    // `finally` runs even if something above throws, so the screen is always cleaned up.
    star.remove()
    layer.hidden = true
  }
}

// Show the star at one spot and record the eyes looking at it.
async function recordSpot(star: HTMLElement, stream: FrameStream, target: Target): Promise<Recording> {
  star.style.left = `${target.x * 100}%`
  star.style.top = `${target.y * 100}%`
  star.classList.remove('collecting')
  await wait(SETTLE_MS)

  // Shrinking the star while recording pulls the eye to its exact center.
  star.classList.add('collecting')
  const frames: Timed[] = []
  const unsubscribe = stream.subscribe((info) => frames.push({ t: performance.now(), f: info.features }))
  await wait(LOOK_MS)
  unsubscribe()

  const steady = steadiest(dropBlinks(frames))
  return { target, frames: dropOutliers(steady.map((x) => x.f)) }
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
function dropBlinks(fs: Timed[]): Timed[] {
  if (fs.length === 0) return fs
  const m = median(fs.map((x) => x.f.open))
  return fs.filter((x) => x.f.open > m * 0.7)
}

// A frame plus the time it arrived (ms).
type Timed = { t: number; f: EyeFeatures }

// Slide a COLLECT_MS-long window over the recording and keep the window where the iris
// moved least. Before the eyes arrive (or during a glance away) the iris is moving, so
// those parts are shaky and get skipped. A slow looker's data is kept from later on;
// a fast looker's from earlier. No timing guess needed.
function steadiest(fs: Timed[]): Timed[] {
  if (fs.length < 5) return fs
  let best = fs
  let bestShake = Infinity
  for (let i = 0; i < fs.length; i++) {
    const end = fs[i].t + COLLECT_MS
    if (end > fs[fs.length - 1].t + 1) break // window would run past the end of the recording
    const window = fs.filter((x) => x.t >= fs[i].t && x.t < end)
    if (window.length < 5) continue
    const s = spread(window.map((x) => x.f))
    if (s < bestShake) {
      bestShake = s
      best = window
    }
  }
  return best
}

// How much the iris wandered while looking at one spot (standard deviation, both directions).
function spread(fs: EyeFeatures[]): number {
  const sd = (vs: number[]) => {
    const m = vs.reduce((a, b) => a + b, 0) / vs.length
    return Math.sqrt(vs.reduce((a, v) => a + (v - m) ** 2, 0) / vs.length)
  }
  return Math.hypot(sd(fs.map((f) => f.irisX)), sd(fs.map((f) => f.irisY)))
}

const shake = (r: Recording) => (r.frames.length < 5 ? Infinity : spread(r.frames))

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
