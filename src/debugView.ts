// Debug overlay: draws face points on a <canvas> that sits on top of the video.
// A developer tool so we can SEE what the model detects. Not part of the final board.

import { LEFT_IRIS, RIGHT_IRIS, type Point } from './landmarks.ts'

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
