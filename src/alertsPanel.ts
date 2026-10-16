// The "Phone alerts" panel on the laptop (for caregivers, used with the mouse).
// Shows a QR code to pair a parent's phone, the phones already paired, and a test button.

import { renderSVG } from 'uqr'
import type { PhoneAlerts } from './alerts.ts'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}
const button = (text: string, onclick: () => void, className = '') => el('button', { textContent: text, onclick, className, type: 'button' })

export function openAlertsPanel(root: HTMLElement, alerts: PhoneAlerts): Promise<void> {
  return new Promise((resolve) => {
    const close = () => {
      alerts.onChange = previous
      root.hidden = true
      root.replaceChildren()
      resolve()
    }
    const busy = async (work: () => Promise<unknown>) => {
      try {
        await work()
      } catch (err) {
        alert(`Couldn't reach the Swar Netra server: ${(err as Error).message}`)
      }
      render()
    }

    function render() {
      const card = el('div', { className: 'card alerts-card' }, el('h2', { textContent: '📱 Phone alerts' }))

      if (!alerts.enabled) {
        card.append(
          el('p', { textContent: 'When the child chooses a word, the parents’ phones get a notification, even when nobody is in the room. Parents can reply “Coming”, and the laptop tells the child.' }),
          el('p', { className: 'muted', textContent: 'Messages are encrypted: only this laptop and your phones can read them. This needs an internet connection.' }),
          el('div', { className: 'row' }, button('Set up phone alerts', () => busy(() => alerts.setUp())), button('Close', close, 'secondary')),
        )
      } else {
        const link = alerts.link()
        const qr = el('div', { className: 'qr' })
        // The QR code is drawn as an SVG image (sharp at any size). The link inside carries the
        // secret key, so treat this screen like a password: only show it to your own family.
        qr.innerHTML = renderSVG(link, { border: 2, whiteColor: '#fff', blackColor: '#000' })
        const phones = alerts.phones.length
          ? el('ul', {}, ...alerts.phones.map((p) => el('li', { textContent: `✓ ${p.name}` })))
          : el('p', { className: 'muted', textContent: 'No phones yet.' })
        card.append(
          el(
            'div',
            { className: 'alerts-pair' },
            qr,
            el(
              'div',
              {},
              el('p', { innerHTML: '<b>Add a phone:</b> open the camera on the parent’s Android phone, scan this code, and follow the steps.' }),
              el('p', { className: 'muted', textContent: 'Keep this code private: anyone who scans it receives the child’s messages.' }),
              el('p', { textContent: `Server: ${alerts.online ? '🟢 connected' : '🔴 not connected (check the internet)'}` }),
              el('p', { innerHTML: '<b>Paired phones:</b>' }),
              phones,
            ),
          ),
          el(
            'div',
            { className: 'row' },
            button('Send a test alert', () =>
              busy(async () => {
                const result = await alerts.send({ label: 'Test', icon: '🔔', speak: 'This is a test' }, false)
                alert(result === 'sent' ? 'Test sent. Check the phone.' : result === 'no-phones' ? 'No phone is paired yet.' : 'Not sent: no connection to the server.')
              }),
            ),
            button('Turn off (removes all phones)', () => {
              if (confirm('Turn off phone alerts? All paired phones are removed, and they need to scan a new code to come back.')) busy(() => alerts.turnOff())
            }, 'danger'),
            button('Close', close, 'secondary'),
          ),
        )
      }
      root.replaceChildren(card)
    }

    // Redraw live when a phone joins or the connection changes.
    const previous = alerts.onChange
    alerts.onChange = () => {
      previous()
      render()
    }
    root.hidden = false
    render()
  })
}
