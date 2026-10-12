// Pipeline box 3a: Eye features.
// Job: turn one face frame into a handful of numbers that describe where the person is looking.

import type { FaceFrame, Point } from './landmarks.ts'

export type EyeFeatures = {
  // From the iris position inside the eye (measured relative to eye corners and lids,
  // so small head movements change these much less). Divided by the eye's width,
  // so sitting closer/farther doesn't change them.
  irisX: number // iris left/right inside the eye
  irisY: number // iris up/down inside the eye
  open: number // how open the eyelids are (lids move when you look up/down)
  // From MediaPipe's blendshapes: a second model's opinion on eye direction.
  lookH: number // looking right (+) vs left (-)
  lookV: number // looking up (+) vs down (-)
  // Head rotation: people turn their head a little toward what they look at.
  yaw: number
  pitch: number
}

export type FeatureName = keyof EyeFeatures

// Landmark index numbers for each eye (from MediaPipe's face mesh map).
// "left"/"right" corner = the corner on the left/right side of the camera image.
type EyeIndices = { iris: number; left: number; right: number; top: number; bottom: number }
const RIGHT_EYE: EyeIndices = { iris: 468, left: 33, right: 133, top: 159, bottom: 145 }
const LEFT_EYE: EyeIndices = { iris: 473, left: 362, right: 263, top: 386, bottom: 374 }

function oneEye(points: Point[], eye: EyeIndices, aspect: number) {
  // Points are 0..1 of the image width and height, but the image isn't square (16:9).
  // Multiplying x by the aspect ratio makes x and y use the same unit.
  const get = (i: number) => ({ x: points[i].x * aspect, y: points[i].y })
  const a = get(eye.left)
  const b = get(eye.right)
  const iris = get(eye.iris)
  const top = get(eye.top)
  const bottom = get(eye.bottom)

  // Build a small coordinate system attached to the eye:
  // `u` runs along the eye (corner to corner), `n` is perpendicular to it (down).
  // If you tilt your head, this system tilts with it.
  const width = Math.hypot(b.x - a.x, b.y - a.y)
  const ux = (b.x - a.x) / width
  const uy = (b.y - a.y) / width
  const nx = -uy
  const ny = ux

  // Iris position measured from the middle of the eye, along u and n.
  const ix = iris.x - (a.x + b.x) / 2
  const iy = iris.y - (a.y + b.y) / 2

  return {
    x: (ix * ux + iy * uy) / width,
    y: (ix * nx + iy * ny) / width,
    open: ((bottom.x - top.x) * nx + (bottom.y - top.y) * ny) / width,
  }
}

export function computeEyeFeatures(frame: FaceFrame, aspect: number): EyeFeatures {
  const r = oneEye(frame.points, RIGHT_EYE, aspect)
  const l = oneEye(frame.points, LEFT_EYE, aspect)
  const bs = (name: string) => frame.blendshapes[name] ?? 0

  // Blendshapes are per eye and use "In" (toward the nose) / "Out" (toward the ear).
  // Looking to the person's right = right eye looks Out + left eye looks In.
  const lookRight = (bs('eyeLookOutRight') + bs('eyeLookInLeft')) / 2
  const lookLeft = (bs('eyeLookOutLeft') + bs('eyeLookInRight')) / 2
  const lookUp = (bs('eyeLookUpLeft') + bs('eyeLookUpRight')) / 2
  const lookDown = (bs('eyeLookDownLeft') + bs('eyeLookDownRight')) / 2

  return {
    // Average both eyes: it cancels out some of the noise from each one.
    irisX: (r.x + l.x) / 2,
    irisY: (r.y + l.y) / 2,
    open: (r.open + l.open) / 2,
    lookH: lookRight - lookLeft,
    lookV: lookUp - lookDown,
    yaw: frame.head.yaw,
    pitch: frame.head.pitch,
  }
}
