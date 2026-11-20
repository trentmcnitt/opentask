/**
 * A considered row's ghost (2026-11-20, the /reminders page).
 *
 * A consider takes its row out of the list at once, so the next row is under
 * the finger before the next tap: a fast run of taps at one spot considers
 * one row per tap (`completeIds` in `src/hooks/useReminders.ts` has the why).
 * What used to show the tap had been taken, the row struck through and
 * collapsing in place, is now a GHOST: a copy of the row drawn over the spot
 * it left, struck through, fading out over 180 ms — its words first, on the
 * card's own colour, then that colour (`.animate-row-ghost` in globals.css).
 *
 * The ghost is out of the page's flow and takes no pointer events, so it never
 * holds a row's place and every tap passes through it to the row now
 * underneath. It is a static copy (`cloneNode`), made before React removes the
 * row, hidden from assistive tech, appended to <body> at the row's page
 * position, and removed when its animation ends (at once under reduced
 * motion, where the animation runs for 0 s and still ends).
 */

const GHOST_ATTR = 'data-row-ghost'

/** Ghosts the on-screen rows of these reminders and quota prompts. */
export function ghostRows(ids: readonly number[], keys: readonly string[]): void {
  if (typeof document === 'undefined') return
  const selectors = [
    ...ids.map((id) => `li[data-reminder-id="${id}"]`),
    ...keys.map((key) => `li[data-prompt-key="${CSS.escape(key)}"]`),
  ]
  if (selectors.length === 0) return
  for (const row of document.querySelectorAll<HTMLElement>(selectors.join(','))) {
    if (row.closest(`[${GHOST_ATTR}]`)) continue
    ghost(row)
  }
}

function ghost(row: HTMLElement): void {
  const rect = row.getBoundingClientRect()
  // Not on screen (a folded slot, a hidden narrow-width row): nothing to fade.
  if (rect.width === 0 || rect.height === 0) return
  const copy = row.cloneNode(true) as HTMLElement
  // The copy keeps the row's look but none of its identity: no id a query or
  // a test could mistake for the row, no focus, nothing to read out.
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
    el.removeAttribute('id')
    for (const name of [...el.getAttributeNames()]) {
      if (name.startsWith('data-') && name !== 'data-row-title') el.removeAttribute(name)
    }
    if (el.tabIndex >= 0) el.tabIndex = -1
  }
  // The colour it sits on — the card's, not the page's — so it covers the
  // row now beneath it until its words have faded (`.animate-row-ghost`).
  copy.style.setProperty('--row-ghost-bg', surfaceColor(row))
  copy.setAttribute(GHOST_ATTR, '')
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true
  copy.classList.add('animate-row-ghost')
  Object.assign(copy.style, {
    position: 'absolute',
    top: `${rect.top + window.scrollY}px`,
    left: `${rect.left + window.scrollX}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    pointerEvents: 'none',
    zIndex: '30',
    listStyle: 'none',
  })
  // Its own animation, not its words' (theirs end first and bubble here).
  const done = (e: AnimationEvent) => {
    if (e.target === copy) copy.remove()
  }
  copy.addEventListener('animationend', done)
  copy.addEventListener('animationcancel', done)
  document.body.appendChild(copy)
}

/**
 * The colour the row is drawn on, as one opaque colour: every background from
 * the page down to the row, painted in order onto one pixel — a card's is
 * often translucent over the page's, and a translucent cover would let the
 * row beneath show through. Any CSS colour works (`oklch()` included), since
 * the canvas parses it.
 */
function surfaceColor(el: HTMLElement): string {
  const layers: string[] = []
  for (let node: Element | null = el; node; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor)
  }
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return getComputedStyle(document.body).backgroundColor
  ctx.canvas.width = 1
  ctx.canvas.height = 1
  for (const color of layers) {
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `rgb(${r}, ${g}, ${b})`
}
