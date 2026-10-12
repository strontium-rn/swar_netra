// Pipeline box 8: Speech.
// Job: say text out loud using the browser's built-in voice (Web Speech API).
// It works offline and needs no server or account.

export function speak(text: string): void {
  speechSynthesis.cancel() // stop anything still being said, so the newest word plays right away
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'en-US'
  utterance.rate = 0.9 // a little slower than normal, clearer to listen to
  // Prefer a voice installed on this Mac (works offline) over an online one.
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith('en') && v.localService)
  if (voice) utterance.voice = voice
  speechSynthesis.speak(utterance)
}
