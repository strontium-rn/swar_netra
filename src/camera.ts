// Pipeline box 1: Camera.
// Job: ask for webcam permission and stream the video into a <video> element.

export async function startCamera(video: HTMLVideoElement): Promise<void> {
  // getUserMedia shows the browser's "Allow camera?" popup.
  // It returns a "stream": a live feed of frames from the webcam.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, facingMode: 'user' }, // 'user' = front camera
    audio: false,
  })

  video.srcObject = stream // plug the live feed into the <video> element
  await video.play() // wait until frames are actually flowing
}
