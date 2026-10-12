// Pipeline box 2: Face landmarks.
// Job: load the MediaPipe face model and find 478 face points in a video frame.
// The rest of the app only sees our simple `Point` type, never MediaPipe's types.

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// x and y are 0..1 (fractions of the video's width/height), z is depth.
export type Point = { x: number; y: number; z: number }

// Index numbers of the iris points inside the 478-point list.
// 468 and 473 are the iris centers; the other 4 of each are around the iris edge.
// Left/right means the person's OWN left/right (not the side of the image).
export const RIGHT_IRIS = [468, 469, 470, 471, 472]
export const LEFT_IRIS = [473, 474, 475, 476, 477]

// The model's code (WebAssembly) and its trained weights are downloaded once
// when the page loads. Only these files are downloaded; your video never leaves the laptop.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

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
    })
    return new LandmarkDetector(landmarker)
  }

  // Returns the 478 points of the face, or null if no face is visible.
  detect(video: HTMLVideoElement, timeMs: number): Point[] | null {
    const result = this.landmarker.detectForVideo(video, timeMs)
    return result.faceLandmarks[0] ?? null
  }
}
