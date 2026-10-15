// Word editor, for parents and therapists (used with mouse and keyboard, not the eyes).
//
// It shows each page exactly as the board lays it out (6 columns), so the caregiver sees
// WHERE a word will be, not just what it is. Click a column to change it: label, emoji or
// photo, what is said, a recorded voice, and its position.
//
// Edits happen on a DRAFT copy. Nothing changes on the board until "Save"; "Cancel" throws
// the draft away. (Like a document you edit and then save: the child's board never shows
// a half-finished change.)

import { iconElement } from './board.ts'
import { addMedia, mediaUrl } from './media.ts'
import { speak } from './speech.ts'
import { saveVocabulary } from './storage.ts'
import {
  BACK,
  BACK_COLOR,
  DEFAULT_VOCABULARY,
  HELP_COLOR,
  type Category,
  type PageId,
  type Vocabulary,
  type Word,
} from './vocabulary.ts'

const MAX_RECORD_MS = 6000 // a word or short sentence; also stops a forgotten recording
const PHOTO_SIZE = 400 // photos are shrunk to this many pixels (longest side)

type Slot = Word | Category | typeof BACK | null

// Make an element, set some of its properties, and put children inside it.
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}

const button = (text: string, onclick: () => void, className = '') => el('button', { textContent: text, onclick, className, type: 'button' })

// Keep only the first emoji/letter typed (an emoji can be several characters long, e.g. 👍🏽).
function firstSymbol(text: string): string {
  const [first] = new Intl.Segmenter().segment(text.trim())
  return first?.segment ?? ''
}

// Phone photos are often 4000 px wide and several MB. The button shows them at a few
// hundred pixels, so we shrink them first: about 50x smaller, and the board stays fast.
async function shrinkPhoto(file: File): Promise<Blob> {
  const image = await createImageBitmap(file)
  const scale = Math.min(1, PHOTO_SIZE / Math.max(image.width, image.height))
  const canvas = el('canvas', { width: Math.round(image.width * scale), height: Math.round(image.height * scale) })
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff' // JPEG has no transparency: put see-through pictures on white
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the photo'))), 'image/jpeg', 0.85),
  )
}

export function openEditor(root: HTMLElement, saved: Vocabulary): Promise<Vocabulary | null> {
  let draft: Vocabulary = structuredClone(saved)
  let page: PageId = 'home'
  let slot = 1
  let recorder: MediaRecorder | null = null
  const changed = () => JSON.stringify(draft) !== JSON.stringify(saved)

  const pagesEl = el('nav', { className: 'ed-pages' })
  const slotsEl = el('div', { className: 'ed-slots' })
  const formEl = el('div', { className: 'ed-form' })
  const category = () => draft.categories.find((c) => c.id === page)

  // What sits in a column of the current page.
  function slotAt(i: number): Slot {
    if (page === 'home') return i === 0 ? draft.help : draft.categories[i - 1]
    return i === 0 ? BACK : (category()?.words[i - 1] ?? null)
  }

  function colorOf(item: Slot): string {
    if (item === draft.help) return HELP_COLOR
    if (item?.kind === 'back') return BACK_COLOR
    if (item?.kind === 'category') return item.color
    return category()?.color ?? '#555'
  }

  // ---- Drawing ----

  function renderPages() {
    pagesEl.replaceChildren(
      ...[{ id: 'home', label: '🏠 Home page' }, ...draft.categories.map((c) => ({ id: c.id, label: `${c.icon} ${c.label}` }))].map(
        (p) =>
          button(p.label, () => {
            stopRecording()
            page = p.id
            slot = 1
            render()
          }, p.id === page ? 'selected' : ''),
      ),
    )
  }

  function renderSlots() {
    slotsEl.replaceChildren(
      ...Array.from({ length: 6 }, (_, i) => {
        const item = slotAt(i)
        const tile = el('div', { className: `ed-slot${item ? '' : ' empty'}${i === slot ? ' selected' : ''}` })
        tile.style.setProperty('--color', colorOf(item))
        if (item) {
          const picture = 'picture' in item ? mediaUrl(item.picture) : undefined
          tile.append(iconElement(item.icon, picture, 'icon'), el('span', { className: 'label', textContent: item.label }))
          if ('audio' in item && item.audio) tile.append(el('span', { className: 'ed-badge', textContent: '🎙️', title: 'Recorded voice' }))
        } else {
          tile.append(el('span', { className: 'label', textContent: '+ Empty' }))
        }
        tile.onclick = () => {
          stopRecording()
          slot = i
          renderSlots()
          renderForm()
        }
        return tile
      }),
    )
  }

  function render() {
    renderPages()
    renderSlots()
    renderForm()
  }

  // A labelled row in the form.
  const row = (label: string, ...controls: (Node | string)[]) =>
    el('div', { className: 'ed-row' }, el('span', { className: 'ed-label', textContent: label }), ...controls)

  function renderForm() {
    const item = slotAt(slot)
    formEl.replaceChildren()

    if (item?.kind === 'back') {
      formEl.append(el('p', { className: 'muted', textContent: 'Back is always in this corner on every page, so it is never hard to find. It can’t be changed.' }))
      return
    }
    if (item === null) {
      formEl.append(
        el('p', { className: 'muted', textContent: 'Empty: nothing happens when the child looks here.' }),
        button('+ Add a word here', () => {
          category()!.words[slot - 1] = { kind: 'word', id: `w-${crypto.randomUUID()}`, label: 'New word', icon: '⭐', speak: 'New word' }
          renderSlots()
          renderForm()
          formEl.querySelector('input')?.select() // ready to type the word
        }),
      )
      return
    }

    // Text shown on the button. If "what to say" was the same as the label, keep them in step.
    const label = el('input', { value: item.label, maxLength: 30 })
    label.oninput = () => {
      if (item.kind === 'word' && item.speak === item.label) {
        item.speak = label.value
        if (speakInput) speakInput.value = label.value
      }
      item.label = label.value
      renderSlots()
      if (item.kind === 'category') renderPages()
    }
    formEl.append(row('Text on button', label))

    // Picture: an emoji, or a photo (a photo of the child's own cup is easier to recognize
    // than any drawing of "a cup").
    const emoji = el('input', { value: item.icon, className: 'ed-emoji', title: 'Mac: press Ctrl + Cmd + Space to pick an emoji' })
    emoji.onchange = () => {
      item.icon = firstSymbol(emoji.value) || item.icon
      emoji.value = item.icon
      renderSlots()
      if (item.kind === 'category') renderPages()
    }
    const file = el('input', { type: 'file', accept: 'image/*', hidden: true })
    file.onchange = async () => {
      const f = file.files?.[0]
      if (!f) return
      try {
        item.picture = await addMedia(await shrinkPhoto(f))
      } catch (err) {
        alert(`Couldn't use that photo: ${(err as Error).message}`)
      }
      renderSlots()
      renderForm()
    }
    formEl.append(
      row(
        'Picture',
        emoji,
        el('span', { className: 'muted', textContent: 'emoji, or' }),
        file,
        button(item.picture ? 'Change photo…' : 'Use a photo…', () => file.click()),
        ...(item.picture
          ? [button('Remove photo', () => {
              delete item.picture
              renderSlots()
              renderForm()
            }, 'secondary')]
          : []),
      ),
    )

    let speakInput: HTMLInputElement | null = null
    if (item.kind === 'word') {
      speakInput = el('input', { value: item.speak, maxLength: 120 })
      speakInput.oninput = () => (item.speak = speakInput!.value)
      formEl.append(row('What is said', speakInput, button('▶ Listen', () => speak(item.speak, mediaUrl(item.audio)), 'secondary')))
      formEl.append(voiceRow(item))
    }

    if (item.kind === 'category') {
      const color = el('input', { type: 'color', value: item.color })
      color.oninput = () => {
        item.color = color.value
        renderSlots()
      }
      formEl.append(row('Color', color, el('span', { className: 'muted', textContent: 'all words in this group share it' })))
    }

    // Moving and removing (Help stays fixed in the first column).
    if (item !== draft.help) {
      const list: (Word | Category | null)[] = page === 'home' ? draft.categories : category()!.words
      const move = (by: number) => {
        const i = slot - 1
        ;[list[i], list[i + by]] = [list[i + by], list[i]]
        slot += by
        render()
      }
      const left = button('◀ Move left', () => move(-1), 'secondary')
      const right = button('Move right ▶', () => move(1), 'secondary')
      left.disabled = slot === 1
      right.disabled = slot === 5
      formEl.append(row('Position', left, right))
      if (item.kind === 'word') {
        formEl.append(
          row(
            '',
            button('Remove word', () => {
              category()!.words[slot - 1] = null
              renderSlots()
              renderForm()
            }, 'danger'),
          ),
        )
      }
    }
  }

  // Record the caregiver's voice for a word (the microphone is only asked for here).
  function voiceRow(word: Word): HTMLElement {
    const status = el('span', { className: 'muted', textContent: word.audio ? '✓ Your recording' : 'Computer voice' })
    if (recorder) {
      return row('Voice', el('span', { className: 'ed-recording', textContent: '● Recording… say it now' }), button('■ Stop', stopRecording))
    }
    return row(
      'Voice',
      status,
      button(word.audio ? '● Record again' : '● Record your voice', () => startRecording(word).catch((err) => alert(`Couldn't record: ${(err as Error).message}`))),
      ...(word.audio
        ? [button('Use computer voice', () => {
            delete word.audio
            renderSlots()
            renderForm()
          }, 'secondary')]
        : []),
    )
  }

  // MediaRecorder: the browser's built-in recorder. It collects the sound in chunks while
  // recording; when stopped, the chunks are joined into one audio file.
  async function startRecording(word: Word) {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    const chunks: Blob[] = []
    const r = new MediaRecorder(mic)
    r.ondataavailable = (e) => chunks.push(e.data)
    r.onstop = async () => {
      mic.getTracks().forEach((t) => t.stop()) // turn the microphone off (and its indicator)
      recorder = null
      word.audio = await addMedia(new Blob(chunks, { type: r.mimeType }))
      renderSlots()
      renderForm()
      speak(word.speak, mediaUrl(word.audio)) // play it back, so the caregiver can check it
    }
    r.start()
    recorder = r
    setTimeout(() => r.state === 'recording' && r.stop(), MAX_RECORD_MS)
    renderForm()
  }

  function stopRecording() {
    if (recorder?.state === 'recording') recorder.stop()
  }

  // ---- Open, and wait for Save or Cancel ----

  return new Promise((resolve) => {
    const close = (result: Vocabulary | null) => {
      stopRecording()
      root.hidden = true
      root.replaceChildren()
      resolve(result)
    }
    const save = () => {
      if (!saveVocabulary(draft)) return alert('Could not save: the browser storage is full or blocked.')
      close(draft)
    }
    const cancel = () => {
      if (!changed() || confirm('Throw away your changes?')) close(null)
    }
    const reset = () => {
      if (!confirm('Go back to the starting words? Your own words, photos and recordings will be removed when you save.')) return
      draft = structuredClone(DEFAULT_VOCABULARY)
      render()
    }

    root.replaceChildren(
      el(
        'div',
        { className: 'ed-top' },
        el('h2', { textContent: 'Edit words' }),
        el('div', { className: 'ed-actions' }, button('Reset to starting words', reset, 'secondary'), button('Cancel', cancel, 'secondary'), button('Save', save)),
      ),
      pagesEl,
      slotsEl,
      formEl,
      el('p', {
        className: 'muted ed-tip',
        textContent:
          'Tip: children learn WHERE each word is, so after a while their eyes go there without searching. ' +
          'Change words when needed, but move them rarely.',
      }),
    )
    root.hidden = false
    render()
  })
}
