// Entry point: wires the pipeline modules together and runs the main loop.
// It does no real work itself. Each module does one job; main.ts connects them.

import './style.css'
import { startCamera } from './camera.ts'
import { LandmarkDetector } from './landmarks.ts'
import { drawPoints } from './debugView.ts'
import { computeEyeFeatures, type EyeFeatures } from './eyeFeatures.ts'
import {
  CALIBRATION_TARGETS,
  VALIDATION_TARGETS,
  recordAtTargets,
  toSamples,
  type Subscribe,
} from './calibration.ts'
import { GazeModel, IRIS_LOOK_HEAD, IRIS_ONLY } from './gazeModel.ts'
import { GazeSmoother } from './smoothing.ts'
import { scoreModel, type Score } from './evaluate.ts'

const video = document.querySelector<HTMLVideoElement>('#video')!
const overlay = document.querySelector<HTMLCanvasElement>('#overlay')!
const status = document.querySelector<HTMLDivElement>('#status')!
const calibrateBtn = document.querySelector<HTMLButtonElement>('#calibrate')!
const smoothToggle = document.querySelector<HTMLInputElement>('#smooth')!
const report = document.querySelector<HTMLDivElement>('#report')!
const calibLayer = document.querySelector<HTMLDivElement>('#calib-layer')!
const gazeDot = document.querySelector<HTMLDivElement>('#gaze-dot')!

// Observer pattern: the loop announces each new eye reading to every listener.
// Modules subscribe when they need readings and unsubscribe when done.
const listeners = new Set<(f: EyeFeatures) => void>()
const subscribe: Subscribe = (listener) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let gazeModel: GazeModel | null = null // null until calibration is done
const smoother = new GazeSmoother()

async function main() {
  status.textContent = 'Starting camera…'
  await startCamera(video)

  // Make the canvas the same pixel size as the video so points line up.
  overlay.width = video.videoWidth
  overlay.height = video.videoHeight
  const aspect = video.videoWidth / video.videoHeight

  status.textContent = 'Loading face model…'
  const detector = await LandmarkDetector.create()
  status.textContent = 'Ready. Sit comfortably, keep your head still, then press Calibrate.'
  calibrateBtn.disabled = false

  let lastVideoTime = -1
  let lastFrameMs = performance.now()

  // The main loop. requestAnimationFrame calls `loop` right before each screen
  // refresh (60–120 times a second on a Mac).
  function loop() {
    // Skip the work if the camera hasn't produced a new frame yet.
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime
      const now = performance.now()
      const dt = (now - lastFrameMs) / 1000 // seconds since the previous frame
      lastFrameMs = now

      const frame = detector.detect(video, now)
      drawPoints(overlay, frame?.points ?? null)

      if (frame) {
        const features = computeEyeFeatures(frame, aspect)
        for (const listener of listeners) listener(features)

        if (gazeModel) {
          let gaze = gazeModel.predict(features)
          if (smoothToggle.checked) gaze = smoother.smooth(gaze, dt)
          // Clamp to 0..1 so the dot never leaves the screen.
          const x = Math.min(1, Math.max(0, gaze.x)) * window.innerWidth
          const y = Math.min(1, Math.max(0, gaze.y)) * window.innerHeight
          gazeDot.style.transform = `translate(${x}px, ${y}px)`
        }
      }
    }
    requestAnimationFrame(loop)
  }
  loop()
}

calibrateBtn.addEventListener('click', async () => {
  calibrateBtn.disabled = true
  gazeDot.hidden = true
  report.hidden = true
  try {
    // Full screen, so the dots cover the whole display. The browser only allows this
    // right after a click, which is why calibration starts from a button.
    await document.documentElement.requestFullscreen().catch(() => {})

    // 1. Learn: record at 16 spots, then train both recipes on the SAME data (a fair comparison).
    const calibration = await recordAtTargets(calibLayer, subscribe, CALIBRATION_TARGETS)
    const samples = toSamples(calibration)
    const models = [IRIS_ONLY, IRIS_LOOK_HEAD].map((set) => GazeModel.fit(samples, set))

    // 2. Test: 5 new spots the models have never seen.
    const validation = await recordAtTargets(calibLayer, subscribe, VALIDATION_TARGETS)
    const scores = models.map((m) => scoreModel(m, validation))

    // 3. Use whichever model scored best (smallest total aim error).
    const total = (s: Score) => s.errX + s.errY
    const best = scores.indexOf(scores.reduce((a, b) => (total(b) < total(a) ? b : a)))
    gazeModel = models[best]

    showReport(scores, best)
    gazeDot.hidden = false
    status.textContent = `Using "${models[best].set.name}". Look around: the red dot follows your gaze.`
  } catch (err) {
    status.textContent = `Calibration failed: ${(err as Error).message}`
  } finally {
    calibrateBtn.disabled = false
  }
})

function showReport(scores: Score[], best: number) {
  // Convert % of screen to pixels too, since button sizes will be in pixels.
  const fmt = (pct: number, screenPx: number) => `${pct.toFixed(1)}% (${Math.round((pct / 100) * screenPx)}px)`
  const rows = scores
    .map(
      (s, i) => `<tr class="${i === best ? 'best' : ''}">
        <td>${s.name}</td>
        <td>${fmt(s.errX, window.innerWidth)}</td>
        <td>${fmt(s.errY, window.innerHeight)}</td>
        <td>${s.jitter.toFixed(1)}%</td>
        <td>${s.jitterSmoothed.toFixed(1)}%</td>
      </tr>`,
    )
    .join('')
  report.innerHTML = `<table>
    <tr><th>Model</th><th>Aim error ↔</th><th>Aim error ↕</th><th>Jitter</th><th>Jitter (smoothed)</th></tr>
    ${rows}
  </table>`
  report.hidden = false
}

main().catch((err) => {
  // If anything fails (e.g. camera permission denied), show it on screen instead of failing silently.
  status.textContent = `Error: ${err.message ?? err}`
  console.error(err)
})
