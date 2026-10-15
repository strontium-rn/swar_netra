// Pipeline box 8: Speech.
// Job: say a word out loud. If a caregiver recorded their own voice for it, play that
// (a familiar voice, in the family's own accent and language); otherwise use the browser's
// built-in voice (Web Speech API), which works offline and needs no server or account.

let playing: HTMLAudioElement | null = null

export function speak(text: string, recordingUrl?: string): void {
  // Stop anything still being said, so the newest word plays right away.
  speechSynthesis.cancel()
  playing?.pause()
  playing = null

  if (recordingUrl) {
    playing = new Audio(recordingUrl)
    // If the recording can't play (e.g. a broken file), fall back to the computer voice:
    // the child's message must always come out.
    playing.play().catch(() => speakText(text))
    return
  }
  speakText(text)
}

function speakText(text: string): void {
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'en-US'
  utterance.rate = 0.9 // a little slower than normal, clearer to listen to
  // Prefer a voice installed on this Mac (works offline) over an online one.
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith('en') && v.localService)
  if (voice) utterance.voice = voice
  speechSynthesis.speak(utterance)
}
