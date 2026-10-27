// User study screens (laptop, used with the mouse):
//   openConsent()   → what is collected and what isn't; "Take part" / "No thanks"
//   openFeedback()  → the short questionnaire, plus "Leave the study and delete my data"

import type { Study } from './study.ts'

// Where testers can ask questions about the study.
const CONTACT = 'https://github.com/strontium-rn/swar_netra/issues'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}
const button = (text: string, onclick: () => void, className = '') => el('button', { textContent: text, onclick, className, type: 'button' })
const list = (...items: string[]) => el('ul', {}, ...items.map((t) => el('li', { textContent: t })))

function show(root: HTMLElement, card: HTMLElement) {
  root.replaceChildren(card)
  root.hidden = false
  root.scrollTop = 0
}
function hide(root: HTMLElement) {
  root.hidden = true
  root.replaceChildren()
}

// ---- Consent ----

export function openConsent(root: HTMLElement, study: Study): Promise<boolean> {
  return new Promise((resolve) => {
    const adult = el('input', { type: 'checkbox' })
    const agree = el('input', { type: 'checkbox' })
    const join = button('Take part', () => {
      study.join()
      hide(root)
      resolve(true)
    })
    const update = () => (join.disabled = !(adult.checked && agree.checked))
    adult.onchange = update
    agree.onchange = update
    update()

    show(
      root,
      el(
        'div',
        { className: 'card study-card' },
        el('h2', { textContent: '🔬 Help improve Swar Netra' }),
        el('p', { textContent: 'Swar Netra is a student prototype: an eye-gaze communication board for people who cannot speak. You are invited to try it and share how it went. Taking part is optional, and the app works exactly the same if you say no.' }),
        el('h3', { textContent: 'If you take part, we collect' }),
        list(
          'Calibration results: accuracy numbers, which formula fitted your eyes best, how steady the eye signal was, and your head position during calibration (as numbers).',
          'Your screen size and browser.',
          'Your answers to a short feedback form, when you choose to fill it in.',
        ),
        el('h3', { textContent: 'We never collect' }),
        list(
          'Camera video, photos or images of your face (the camera picture never leaves this computer).',
          'Your name, email or IP address.',
          'The words you choose on the board, voice recordings, or phone alert messages.',
        ),
        el('h3', { textContent: 'How it is used' }),
        list(
          'Your data is linked to a random code made in this browser, not to you.',
          'It is stored in an online database and used only by the researcher to improve this prototype. Results may appear in a student project report as summaries, never as individual details.',
          'You can leave at any time: click “Feedback”, then “Leave the study and delete my data”.',
        ),
        el('p', { className: 'muted' }, 'Questions? ', el('a', { href: CONTACT, target: '_blank', rel: 'noopener', textContent: 'Ask here' }), '.'),
        el('label', { className: 'check' }, adult, ' I am 18 or older.'),
        el('label', { className: 'check' }, agree, ' I have read this and agree to take part.'),
        el(
          'div',
          { className: 'row' },
          join,
          button('No thanks', () => {
            study.decline()
            hide(root)
            resolve(false)
          }, 'secondary'),
        ),
      ),
    )
  })
}

// ---- Feedback ----

// 1–5 agreement scale, optionally with "didn't try" for features the tester may have skipped.
function scale(name: string, question: string, canSkip = false) {
  const options = [1, 2, 3, 4, 5].map((n) => el('label', { className: 'scale-option' }, el('input', { type: 'radio', name, value: String(n) }), String(n)))
  const skip = canSkip ? [el('label', { className: 'scale-option skip' }, el('input', { type: 'radio', name, value: 'skipped' }), 'Didn’t try')] : []
  return el(
    'fieldset',
    { className: 'scale' },
    el('legend', { textContent: question }),
    el('div', { className: 'scale-row' }, el('span', { className: 'muted', textContent: 'Disagree' }), ...options, el('span', { className: 'muted', textContent: 'Agree' }), ...skip),
  )
}

function choice(name: string, question: string, options: string[]) {
  const select = el('select', { name }, el('option', { value: '', textContent: 'Choose…' }), ...options.map((o) => el('option', { value: o, textContent: o })))
  return el('label', { className: 'field' }, question, select)
}

function text(name: string, question: string) {
  return el('label', { className: 'field' }, question, el('textarea', { name, rows: 2, maxLength: 1000 }))
}

export function openFeedback(root: HTMLElement, study: Study): Promise<void> {
  return new Promise((resolve) => {
    const close = () => {
      hide(root)
      resolve()
    }

    if (!study.joined) {
      // Not in the study: nothing to send. Offer to join (consent first).
      show(
        root,
        el(
          'div',
          { className: 'card study-card' },
          el('h2', { textContent: '💬 Feedback' }),
          el('p', { textContent: 'To send feedback, please first read what is collected and agree to take part in the study.' }),
          el('div', { className: 'row' }, button('Read and decide', async () => {
            if (await openConsent(root, study)) openFeedback(root, study).then(resolve)
            else close()
          }), button('Close', close, 'secondary')),
        ),
      )
      return
    }

    const status = el('p', { className: 'muted' })
    const form = el(
      'form',
      {},
      el('h3', { textContent: 'About you and your setup' }),
      choice('role', 'Which describes you best?', ['Student', 'Parent or family member', 'Therapist or special educator', 'Teacher', 'Developer', 'Other']),
      choice('light', 'Light on your face while testing', ['Daylight from a window', 'Indoor lights', 'Dim light', 'Mixed']),
      choice('glasses', 'Glasses?', ['No', 'Glasses', 'Contact lenses']),
      el('h3', { textContent: 'How much do you agree?' }),
      scale('calibrationEasy', 'Calibration (following the star) was easy.'),
      scale('accuracy', 'It chose the button I was looking at.'),
      scale('speed', 'Choosing a word took the right amount of time.'),
      scale('comfort', 'My eyes and neck felt comfortable.'),
      scale('editorEasy', 'Changing words in “Edit words” was easy.', true),
      scale('alertsUseful', 'Phone alerts worked well.', true),
      scale('helpful', 'This could help someone who cannot speak.'),
      el('h3', { textContent: 'In your own words' }),
      text('frustrating', 'What was the most frustrating moment?'),
      text('liked', 'What did you like most?'),
      text('change', 'What would you change or add?'),
    )
    form.onsubmit = (e) => e.preventDefault()

    const send = button('Send feedback', async () => {
      const answers: Record<string, string> = {}
      for (const [k, v] of new FormData(form)) if (String(v).trim()) answers[k] = String(v).trim()
      if (Object.keys(answers).length === 0) {
        status.textContent = 'Please answer at least one question.'
        return
      }
      send.disabled = true
      status.textContent = 'Sending… (the server may take up to a minute to wake up)'
      const ok = await study.record('feedback', { answers, device: deviceInfo() })
      if (ok) {
        show(root, el('div', { className: 'card study-card' }, el('h2', { textContent: '🙏 Thank you!' }), el('p', { textContent: 'Your feedback was sent. It really helps.' }), el('div', { className: 'row' }, button('Close', close))))
      } else {
        status.textContent = 'Couldn’t reach the server. Your answers are saved on this computer and will be sent automatically next time.'
        send.disabled = false
      }
    })

    show(
      root,
      el(
        'div',
        { className: 'card study-card' },
        el('h2', { textContent: '💬 Feedback' }),
        el('p', { textContent: study.feedbackSent ? 'Thanks for your earlier feedback! You can send more anytime, e.g. after another session.' : 'A few quick questions about how it went. Every answer is optional.' }),
        form,
        status,
        el('div', { className: 'row' }, send, button('Close', close, 'secondary')),
        el('hr'),
        el('p', { className: 'muted', textContent: 'Changed your mind about the study?' }),
        button('Leave the study and delete my data', async () => {
          if (!confirm('Leave the study? Everything this browser has sent will be deleted from the server.')) return
          try {
            const deleted = await study.withdraw()
            alert(`Done. ${deleted} record${deleted === 1 ? ' was' : 's were'} deleted. Nothing more will be sent.`)
            close()
          } catch (err) {
            alert(`Couldn’t reach the server, nothing was deleted yet. Please try again later. (${(err as Error).message})`)
          }
        }, 'danger'),
      ),
    )
  })
}

// Screen and browser: helps tell "the method is bad" from "this screen or browser is odd".
export function deviceInfo() {
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string; version: string }[] } }).userAgentData?.brands
  return {
    screen: { width: screen.width, height: screen.height, window: `${innerWidth}x${innerHeight}`, pixelRatio: devicePixelRatio },
    browser: brands?.filter((b) => !/not.a.brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`).join(', ') || navigator.userAgent.slice(0, 160),
    platform: navigator.platform,
    language: navigator.language,
  }
}
