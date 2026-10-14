// Pipeline box 2: Face landmarks.
// Job: run the MediaPipe face model on a video frame and return what it found.
// The rest of the app only sees our simple types (`FaceFrame`), never MediaPipe's types.

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// x and y are 0..1 (fractions of the video's width/height), z is depth.
export type Point = { x: number; y: number; z: number }

// Everything we get from one video frame.
export type FaceFrame = {
  points: Point[] // the 478 face points
  blendshapes: Record<string, number> // 52 expression scores (0..1), e.g. "eyeLookUpLeft"
  head: { yaw: number; pitch: number } // head rotation in radians: yaw = turn left/right, pitch = nod up/down
}

// Index numbers of the iris points inside the 478-point list.
// 468 and 473 are the iris centers; the other 4 of each are around the iris edge.
// Left/right means the person's OWN left/right (not the side of the image).
export const RIGHT_IRIS = [468, 469, 470, 471, 472]
export const LEFT_IRIS = [473, 474, 475, 476, 477]

// The model's code (WebAssembly) and its trained weights are served by our own site
// (copied there by scripts/copy-mediapipe.mjs), so the service worker can keep them
// for offline use. Your video never leaves the laptop.
// BASE_URL is where the app lives ("/" locally, or e.g. "/swar_netra/" when hosted).
const local = (path: string) => new URL(`${import.meta.env.BASE_URL}${path}`, location.href).href
const WASM_URL = local('mediapipe/wasm')
const MODEL_URL = local('mediapipe/face_landmarker.task')

export class LandmarkDetector {
  private landmarker: FaceLandmarker

  // `private constructor` + `static create` is a common pattern:
  // creating a detector needs `await` (downloading the model), and
  // constructors can't be async, so we use a static async "factory" method.
  private constructor(landmarker: FaceLandmarker) {
    this.landmarker = landmarker
  }

  static async create(): Promise<LandmarkDetector> {
    const wasm = await FilesetResolver.forVisionTasks(WASM_URL)
    const landmarker = await FaceLandmarker.createFromOptions(wasm, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' }, // run on the M1's GPU
      runningMode: 'VIDEO', // VIDEO mode reuses info between frames, so it's faster than IMAGE mode
      numFaces: 1, // we only care about the person using the board
      outputFaceBlendshapes: true, // expression scores, including where the eyes look
      outputFacialTransformationMatrixes: true, // the head's 3D position and rotation
    })
    return new LandmarkDetector(landmarker)
  }

  // Returns what was found in this frame, or null if no face is visible.
  detect(video: HTMLVideoElement, timeMs: number): FaceFrame | null {
    const result = this.landmarker.detectForVideo(video, timeMs)
    const points = result.faceLandmarks[0]
    if (!points) return null

    const blendshapes: Record<string, number> = {}
    for (const c of result.faceBlendshapes[0]?.categories ?? []) blendshapes[c.categoryName] = c.score

    const matrix = result.facialTransformationMatrixes[0]?.data
    const head = matrix ? headAngles(matrix) : { yaw: 0, pitch: 0 }

    return { points, blendshapes, head }
  }
}

// The transformation matrix is a 4×4 grid of numbers describing how the head is
// rotated and moved in 3D. We pull out just the two rotation angles we need.
// MediaPipe stores it "column by column", so row r, column c is at data[c * 4 + r].
function headAngles(data: number[]): { yaw: number; pitch: number } {
  const m = (r: number, c: number) => data[c * 4 + r]
  return {
    yaw: Math.atan2(m(0, 2), m(2, 2)),
    pitch: Math.asin(Math.max(-1, Math.min(1, -m(1, 2)))),
  }
}
