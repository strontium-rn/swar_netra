// Entry point: wires the pipeline modules together and runs the main loop.
// It does no real work itself. Each module does one job; main.ts connects them.
//
//   camera → landmarks → eye features → gaze model → smoothing → board hit-test → dwell → speech

import './style.css'
import { startCamera } from './camera.ts'
import { LandmarkDetector, type FaceFrame } from './landmarks.ts'
import { drawHeadGuide, drawPoints } from './debugView.ts'
import { computeEyeFeatures } from './eyeFeatures.ts'
import { countdown, recordAtTargets, toSamples, type Target } from './calibration.ts'
import { FEATURE_SETS, GazeModel } from './gazeModel.ts'
import { GazeSmoother } from './smoothing.ts'
import { scoreModel, type Score } from './evaluate.ts'
import { FrameStream } from './frameStream.ts'
import { averagePose, driftMessage, headPose, type HeadPose } from './headGuard.ts'
import { Board } from './board.ts'
import { DwellSelector } from './dwell.ts'
import { speak } from './speech.ts'
import { WORDS } from './vocabulary.ts'
import { loadCalibration, saveCalibration } from './storage.ts'

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const video = $<HTMLVideoElement>('#video')
const overlay = $<HTMLCanvasElement>('#overlay')
const welcome = $<HTMLDivElement>('#welcome')
const status = $<HTMLParagraphElement>('#status')
const calibrateBtn = $<HTMLButtonElement>('#calibrate')
const recalibrateBtn = $<HTMLButtonElement>('#recalibrate')
const fullscreenBtn = $<HTMLButtonElement>('#fullscreen')
const smoothToggle = $<HTMLInputElement>('#smooth')
const showDotToggle = $<HTMLInputElement>('#show-dot')
const accuracy = $<HTMLElement>('#accuracy')
const report = $<HTMLDivElement>('#report')
const headWarning = $<HTMLDivElement>('#head-warning')
const messageIcon = $<HTMLSpanElement>('#message-icon')
const messageText = $<HTMLSpanElement>('#message-text')
const calibLayer = $<HTMLDivElement>('#calib-layer')
const gazeDot = $<HTMLDivElement>('#gaze-dot')

// ---- App state ----
// The app is always in exactly one mode. Writing it down explicitly (a "state machine")
// avoids bugs like the board reacting to your eyes while you're calibrating.
//   setup → calibrating → board  (and board → calibrating again on "Recalibrate")
let mode: 'setup' | 'calibrating' | 'board' = 'setup'
let xModel: GazeModel | null = null // predicts left/right (chosen by word hit rate)
let yModel: GazeModel | null = null // predicts up/down (only used for the gaze dot)
let headRef: HeadPose | null = null // head position during calibration
let lastFaceMs = -Infinity // when a face was last seen

const stream = new FrameStream()
const smoother = new GazeSmoother()
const dwell = new DwellSelector()
const board = new Board($<HTMLElement>('#words'), WORDS)

async function main() {
  status.textContent = 'Starting camera…'
  await startCamera(video)

  // Make the canvas the same pixel size as the video so points line up.
  overlay.width = video.videoWidth
  overlay.height = video.videoHeight
  const aspect = video.videoWidth / video.videoHeight

  status.textContent = 'Loading face model…'
  const detector = await LandmarkDetector.create()

  // A saved calibration means we can skip straight to the board.
  const saved = loadCalibration()
  if (saved) {
    xModel = GazeModel.fromJSON(saved.xModel)
    yModel = GazeModel.fromJSON(saved.yModel)
    headRef = saved.headRef
    accuracy.textContent = `Saved calibration · ${Math.round(saved.hitRate)}% hit rate`
    report.innerHTML = `<p>Calibrated ${new Date(saved.savedAt).toLocaleString()}.<br>Recalibrate to see the full report.</p>`
    enterBoard()
  }

  let lastVideoTime = -1
  let lastFrameMs = performance.now()

  // The main loop. requestAnimationFrame calls `loop` right before each screen refresh.
  function loop() {
    // Skip the work if the camera hasn't produced a new frame yet.
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime
      const now = performance.now()
      const dt = (now - lastFrameMs) / 1000 // seconds since the previous frame
      lastFrameMs = now
      onFrame(detector.detect(video, now), now, dt, aspect)
    }
    requestAnimationFrame(loop)
  }
  loop()
}

// Everything that happens for one camera frame.
function onFrame(frame: FaceFrame | null, now: number, dt: number, aspect: number) {
  if (frame) lastFaceMs = now
  if (mode === 'setup') updateFaceCheck(now)

  if (!frame) {
    drawPoints(overlay, null)
    drawHeadGuide(overlay, headRef, null, false)
    if (mode === 'board') {
      showWarning("Can't see your face")
      updateBoard(null, now)
    }
    return
  }

  const features = computeEyeFeatures(frame, aspect)
  const pose = headPose(frame, aspect)
  stream.publish({ features, pose })

  const drift = headRef ? driftMessage(headRef, pose, aspect) : null
  drawPoints(overlay, frame.points)
  drawHeadGuide(overlay, headRef, pose, drift === null)

  if (mode !== 'board' || !xModel || !yModel) return

  // Gaze → smoothing → position on screen (as fractions, clamped to 0..1).
  let gaze = { x: xModel.predict(features).x, y: yModel.predict(features).y }
  if (smoothToggle.checked) gaze = smoother.smooth(gaze, dt)
  const x = Math.min(1, Math.max(0, gaze.x))
  const y = Math.min(1, Math.max(0, gaze.y))
  gazeDot.style.transform = `translate(${x * window.innerWidth}px, ${y * window.innerHeight}px)`
  gazeDot.hidden = !showDotToggle.checked
  gazeDot.classList.toggle('paused', drift !== null)

  showWarning(drift)
  // Fail-safe: if the head is out of position, the gaze can't be trusted, so select nothing.
  updateBoard(drift ? null : board.wordAt(x), now)
}

// Before calibrating, make sure the camera can see the face. Starting without a face
// would only produce a bad calibration, so the button stays disabled until then.
function updateFaceCheck(now: number) {
  const faceOk = now - lastFaceMs < 500
  calibrateBtn.disabled = !faceOk
  status.textContent = faceOk
    ? '✓ Face found. Sit comfortably about an arm’s length from the screen.'
    : 'Looking for your face… Make sure it is well lit and in the middle of the camera.'
  status.classList.toggle('ok', faceOk)
}

// Dwell → fill animation → (when complete) speak.
function updateBoard(target: string | null, now: number) {
  const chosen = dwell.update(target, now)
  const progress = dwell.progress()
  board.show(target, progress?.id ?? null, progress?.fraction ?? 0)

  if (chosen) {
    const word = WORDS.find((w) => w.id === chosen)!
    board.flash(chosen)
    messageIcon.textContent = word.icon
    messageText.textContent = word.label
    speak(word.speak)
  }
}

function showWarning(message: string | null) {
  headWarning.hidden = message === null
  if (message) headWarning.textContent = message
}

function enterBoard() {
  welcome.hidden = true
  mode = 'board'
}

// ---- Calibration ----

async function calibrate() {
  mode = 'calibrating'
  welcome.hidden = true
  gazeDot.hidden = true
  headWarning.hidden = true
  dwell.reset()
  board.show(null, null, 0)
  try {
    // Full screen, so the board looks exactly as it will be used. The browser only
    // allows this right after a click, which is why calibration starts from a button.
    await document.documentElement.requestFullscreen().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 300)) // let the layout resize

    // Spots on the word buttons: the center of each button at two heights.
    // Snake order (left→right on top, right→left below) so the star never jumps far.
    const cols = board.centers()
    const at = (frac: number) => cols.map((c): Target => ({ id: c.id, x: c.x, y: c.top + frac * (c.bottom - c.top) }))
    const calibrationTargets = [...at(0.25), ...at(0.75).reverse()]
    const testTargets = at(0.5)

    // Also record where the head is during calibration, for the head guard.
    const poses: HeadPose[] = []
    const stopPoses = stream.subscribe((info) => poses.push(info.pose))

    // 1. Learn: train every recipe on the SAME data (a fair comparison).
    await countdown(calibLayer, 'Follow the star with your eyes.<br>Keep your head still.')
    const calibration = await recordAtTargets(calibLayer, stream, calibrationTargets)
    const models = FEATURE_SETS.map((set) => GazeModel.fit(toSamples(calibration), set))

    // 2. Test: one more look at each word.
    await countdown(calibLayer, 'Quick test: follow the star once more.')
    const test = await recordAtTargets(calibLayer, stream, testTargets)
    stopPoses()
    const scores = models.map((m) => scoreModel(m, test, board.nearestWord))

    // 3. Left/right decides the word, so pick that model by HIT RATE.
    //    Up/down only moves the gaze dot, so pick that one by aim error.
    const bestX = argmax(scores.map((s) => s.hitRate - s.errX / 100)) // error breaks ties
    const bestY = argmax(scores.map((s) => -s.errY))
    xModel = models[bestX]
    yModel = models[bestY]
    headRef = averagePose(poses)

    saveCalibration({
      xModel: xModel.toJSON(),
      yModel: yModel.toJSON(),
      headRef,
      hitRate: scores[bestX].hitRate,
      savedAt: new Date().toISOString(),
    })
    showReport(scores, bestX, bestY)
    messageIcon.textContent = ''
    messageText.textContent =
      scores[bestX].hitRate >= 75
        ? 'Look at a word to say it'
        : 'Accuracy is low. Try more light on your face, then Recalibrate.'
    enterBoard()
  } catch (err) {
    mode = 'setup'
    welcome.hidden = false
    status.textContent = `Calibration failed: ${(err as Error).message}`
  }
}

calibrateBtn.addEventListener('click', calibrate)
recalibrateBtn.addEventListener('click', calibrate)
fullscreenBtn.addEventListener('click', () => document.documentElement.requestFullscreen().catch(() => {}))

function argmax(values: number[]): number {
  return values.indexOf(Math.max(...values))
}

function showReport(scores: Score[], bestX: number, bestY: number) {
  const best = scores[bestX]
  accuracy.textContent = `Words hit ${Math.round(best.hitRate)}% of the time`

  const pct = (v: number) => `${Math.round(v)}%`
  const used = (yes: boolean) => (yes ? ' class="used"' : '')
  const rows = scores
    .map(
      (s, i) => `<tr>
        <td>${s.name}</td>
        <td${used(i === bestX)}>${pct(s.hitRate)}</td>
        <td${used(i === bestX)}>${s.errX.toFixed(1)}%</td>
        <td${used(i === bestY)}>${s.errY.toFixed(1)}%</td>
        <td>${s.jitter.toFixed(1)}%</td>
      </tr>`,
    )
    .join('')
  const perWord = WORDS.map((w) => `${w.icon} ${pct(best.hitByWord[w.id] ?? 0)}`).join(' &nbsp; ')
  report.innerHTML = `<table>
    <tr><th>Model</th><th>Word hit rate</th><th>Aim error ↔</th><th>Aim error ↕</th><th>Jitter</th></tr>
    ${rows}
  </table>
  <p>Per word: ${perWord}</p>
  <p class="muted">Highlighted = used. Hit rate = % of time the right word was under your gaze.</p>`
}

main().catch((err) => {
  // If anything fails (e.g. camera permission denied), show it on screen instead of failing silently.
  status.textContent = `Error: ${err.message ?? err}`
  console.error(err)
})
