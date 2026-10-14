// Head guard: the gaze model only works well with the head where it was during calibration.
// We remember that position and warn when the head drifts too far.
// While the head is off, the app pauses selection (fail-safe: better to say nothing
// than to say the wrong word).

import type { FaceFrame } from './landmarks.ts'

export type HeadPose = {
  x: number // nose tip position in the camera image (0..1)
  y: number
  size: number // distance between the outer eye corners: bigger = closer to the screen
  yaw: number
  pitch: number
}

const NOSE_TIP = 1
const OUTER_EYE_CORNERS = [33, 263]

// How much drift is allowed. The board is relaxed (the user should be comfortable), while
// calibration is strict: the model learns "eyes like this = that spot" for ONE head
// position, so the data must come from (nearly) the same position.
export type Limits = { move: number; size: number; yaw: number; pitch: number }
export const BOARD_LIMITS: Limits = {
  move: 0.06, // nose movement, as a fraction of the image height
  size: 0.12, // 12% closer or farther
  yaw: 0.15, // head rotation in radians (about 9°)
  pitch: 0.15,
}
// In good calibrations the head turned under 4° in total; in a bad one it followed the
// star by 6°, so the eyes moved less and the model mixed up head and eye movement.
export const CALIBRATION_LIMITS: Limits = { move: 0.036, size: 0.07, yaw: 0.07, pitch: 0.08 } // yaw 0.07 rad = 4°
export const MOVE_LIMIT = BOARD_LIMITS.move // size of the circle on the camera preview

export type HeadProblem = 'close' | 'far' | 'moved' | 'turned'

export function headPose(frame: FaceFrame, aspect: number): HeadPose {
  const nose = frame.points[NOSE_TIP]
  const [a, b] = OUTER_EYE_CORNERS.map((i) => frame.points[i])
  return {
    x: nose.x,
    y: nose.y,
    size: Math.hypot((a.x - b.x) * aspect, a.y - b.y),
    yaw: frame.head.yaw,
    pitch: frame.head.pitch,
  }
}

export function averagePose(poses: HeadPose[]): HeadPose {
  const avg = (k: keyof HeadPose) => poses.reduce((s, p) => s + p[k], 0) / poses.length
  return { x: avg('x'), y: avg('y'), size: avg('size'), yaw: avg('yaw'), pitch: avg('pitch') }
}

// What's wrong with the head position compared to `ref`, or null if it's fine.
export function headProblem(ref: HeadPose, now: HeadPose, aspect: number, limits: Limits): HeadProblem | null {
  if (now.size > ref.size * (1 + limits.size)) return 'close'
  if (now.size < ref.size * (1 - limits.size)) return 'far'
  // x is multiplied by the aspect ratio so x and y distances use the same unit.
  if (Math.hypot((now.x - ref.x) * aspect, now.y - ref.y) > limits.move) return 'moved'
  if (Math.abs(now.yaw - ref.yaw) > limits.yaw || Math.abs(now.pitch - ref.pitch) > limits.pitch) return 'turned'
  return null
}

// On the board: a message telling the user how to fix their position, or null if it's fine.
const BOARD_MESSAGES: Record<HeadProblem, string> = {
  close: 'Too close: lean back a little',
  far: 'Too far: come a little closer',
  moved: 'Head moved: bring your nose back into the circle',
  turned: 'Head turned: face the screen like during calibration',
}
export function driftMessage(ref: HeadPose, now: HeadPose, aspect: number): string | null {
  const problem = headProblem(ref, now, aspect, BOARD_LIMITS)
  return problem && BOARD_MESSAGES[problem]
}
