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

// How much drift is allowed. These are first guesses, tune them by testing.
export const MOVE_LIMIT = 0.06 // nose movement, as a fraction of the image height
const SIZE_LIMIT = 0.12 // 12% closer or farther
const TURN_LIMIT = 0.15 // head rotation in radians (about 9°)

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

// Returns a message telling the user how to fix their position, or null if it's fine.
export function driftMessage(ref: HeadPose, now: HeadPose, aspect: number): string | null {
  if (now.size > ref.size * (1 + SIZE_LIMIT)) return 'Too close: lean back a little'
  if (now.size < ref.size * (1 - SIZE_LIMIT)) return 'Too far: come a little closer'
  // x is multiplied by the aspect ratio so x and y distances use the same unit.
  if (Math.hypot((now.x - ref.x) * aspect, now.y - ref.y) > MOVE_LIMIT) {
    return 'Head moved: bring your nose back into the circle'
  }
  if (Math.abs(now.yaw - ref.yaw) > TURN_LIMIT || Math.abs(now.pitch - ref.pitch) > TURN_LIMIT) {
    return 'Head turned: face the screen like during calibration'
  }
  return null
}
