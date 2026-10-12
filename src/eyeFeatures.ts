// Pipeline box 3a: Eye features.
// Job: turn 478 face points into 3 numbers that describe where the eyes point.
// We measure the iris RELATIVE TO THE EYE (its corners and lids), not relative to
// the camera image, so small head movements change these numbers much less.

import type { Point } from './landmarks.ts'

// x: iris left/right inside the eye, y: iris up/down, open: how open the eyelids are.
// All are divided by the eye's width, so sitting closer/farther doesn't change them.
export type EyeFeatures = { x: number; y: number; open: number }

// Landmark index numbers for each eye (from MediaPipe's face mesh map).
// "left"/"right" corner = the corner on the left/right side of the camera image.
type EyeIndices = { iris: number; left: number; right: number; top: number; bottom: number }
const RIGHT_EYE: EyeIndices = { iris: 468, left: 33, right: 133, top: 159, bottom: 145 }
const LEFT_EYE: EyeIndices = { iris: 473, left: 362, right: 263, top: 386, bottom: 374 }

function oneEye(points: Point[], eye: EyeIndices, aspect: number): EyeFeatures {
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
    // Eyelids also move when you look up/down, so they help with vertical gaze.
    open: ((bottom.x - top.x) * nx + (bottom.y - top.y) * ny) / width,
  }
}

// Average both eyes: it cancels out some of the noise from each one.
export function computeEyeFeatures(points: Point[], aspect: number): EyeFeatures {
  const r = oneEye(points, RIGHT_EYE, aspect)
  const l = oneEye(points, LEFT_EYE, aspect)
  return { x: (r.x + l.x) / 2, y: (r.y + l.y) / 2, open: (r.open + l.open) / 2 }
}
