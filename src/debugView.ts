// Debug overlay: draws on a <canvas> that sits on top of the camera preview.
// Developer/caregiver tool so we can SEE what the system detects.

import { LEFT_IRIS, RIGHT_IRIS, type Point } from './landmarks.ts'
import { MOVE_LIMIT, type HeadPose } from './headGuard.ts'

export function drawPoints(canvas: HTMLCanvasElement, points: Point[] | null): void {
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height) // wipe the previous frame's drawing

  if (!points) return // no face found: leave the canvas empty

  // Points are 0..1, so multiply by the canvas size to get pixel positions.
  const dot = (p: Point, radius: number, color: string) => {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(p.x * canvas.width, p.y * canvas.height, radius, 0, Math.PI * 2)
    ctx.fill()
  }

  for (const p of points) dot(p, 1.2, 'rgba(255,255,255,0.5)') // all 478 face points, small
  for (const i of [...LEFT_IRIS, ...RIGHT_IRIS]) dot(points[i], 3, '#00e5ff') // iris points, big
}

// Head guide: a circle where the nose was during calibration, and a dot where it is now.
// Green = position is fine, orange = moved too far (keep the dot inside the circle).
export function drawHeadGuide(
  canvas: HTMLCanvasElement,
  ref: HeadPose | null,
  now: HeadPose | null,
  ok: boolean,
): void {
  if (!ref) return // not calibrated yet
  const ctx = canvas.getContext('2d')!
  const color = ok ? '#3ddc84' : '#ffa000'

  ctx.strokeStyle = color
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.arc(ref.x * canvas.width, ref.y * canvas.height, MOVE_LIMIT * canvas.height, 0, Math.PI * 2)
  ctx.stroke()

  if (now) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(now.x * canvas.width, now.y * canvas.height, 8, 0, Math.PI * 2)
    ctx.fill()
  }
}
