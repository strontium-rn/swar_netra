// Entry point: wires the pipeline modules together and runs the main loop.
// It does no real work itself. Each module does one job; main.ts connects them.

import './style.css'
import { startCamera } from './camera.ts'
import { LandmarkDetector } from './landmarks.ts'
import { drawPoints } from './debugView.ts'
import { computeEyeFeatures, type EyeFeatures } from './eyeFeatures.ts'
import { runCalibration, type Subscribe } from './calibration.ts'
import { GazeModel } from './gazeModel.ts'

const video = document.querySelector<HTMLVideoElement>('#video')!
const overlay = document.querySelector<HTMLCanvasElement>('#overlay')!
const status = document.querySelector<HTMLDivElement>('#status')!
const calibrateBtn = document.querySelector<HTMLButtonElement>('#calibrate')!
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

  // The main loop. requestAnimationFrame calls `loop` right before each screen
  // refresh (60–120 times a second on a Mac).
  function loop() {
    // Skip the work if the camera hasn't produced a new frame yet.
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime
      const points = detector.detect(video, performance.now())
      drawPoints(overlay, points)

      if (points) {
        const features = computeEyeFeatures(points, aspect)
        for (const listener of listeners) listener(features)

        if (gazeModel) {
          const gaze = gazeModel.predict(features)
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
  try {
    // Full screen, so the 9 dots cover the whole display. The browser only allows this
    // right after a click, which is why calibration starts from a button.
    await document.documentElement.requestFullscreen().catch(() => {})
    const samples = await runCalibration(calibLayer, subscribe)
    gazeModel = GazeModel.fit(samples)
    gazeDot.hidden = false
    status.textContent = `Calibrated with ${samples.length} samples. Look around: the red dot follows your gaze.`
  } catch (err) {
    status.textContent = `Calibration failed: ${(err as Error).message}`
  } finally {
    calibrateBtn.disabled = false
  }
})

main().catch((err) => {
  // If anything fails (e.g. camera permission denied), show it on screen instead of failing silently.
  status.textContent = `Error: ${err.message ?? err}`
  console.error(err)
})
