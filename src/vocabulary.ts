// The words on the board. This is DATA, kept separate from the code that displays it,
// so a caregiver or therapist could change words without touching any logic.

export type Word = {
  id: string // unique name used inside the code
  label: string // text shown on the button
  icon: string // picture shown on the button (many children recognize pictures before words)
  speak: string // what the computer says out loud; could be a full sentence, e.g. "I need the toilet"
  color: string // button background
}

export const WORDS: Word[] = [
  { id: 'toilet', label: 'Toilet', icon: '🚽', speak: 'Toilet', color: '#2f6fd6' },
  { id: 'hungry', label: 'Hungry', icon: '🍽️', speak: 'Hungry', color: '#c9631a' },
  { id: 'thirsty', label: 'Thirsty', icon: '💧', speak: 'Thirsty', color: '#11899c' },
  { id: 'happy', label: 'Happy', icon: '😊', speak: 'Happy', color: '#3c9a3f' },
  { id: 'sad', label: 'Sad', icon: '😢', speak: 'Sad', color: '#7a4fc4' },
]
