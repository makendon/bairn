import { chromium } from 'playwright-core'

const BASE = process.env.BAIRN_URL || 'http://127.0.0.1:5173'
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome'

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
})

await page.goto(BASE, { waitUntil: 'networkidle' })

// Clear IDB so we get a clean splash → demo path
await page.evaluate(async () => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('bairn-photos')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
})
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('#btn-demo')
await page.click('#btn-demo')
await page.waitForSelector('#btn-start')
await page.click('#btn-start')
await page.waitForSelector('.puzzle-board')

// Parent ··· discoverability: always-visible “hold to add photos” hint; tap no-op; long-press opens add-photos
await page.waitForSelector('.parent-hold-hint')
const parentAffordance = await page.evaluate(() => {
  const hint = document.querySelector('.parent-hold-hint')
  const btn = document.getElementById('btn-parent')
  const style = hint ? getComputedStyle(hint) : null
  return {
    hintText: (hint?.textContent || '').trim().toLowerCase(),
    hintVisible: !!(hint && style && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0),
    btnPresent: !!btn,
  }
})

await page.evaluate(() => {
  window.__fileClicks = 0
  const input = document.querySelector('input[type="file"]')
  if (!input) return
  input.click = () => { window.__fileClicks += 1 }
})

// Pointer helper at the centre of ··· (release outside the button must not open)
async function parentPointer(type, pointerId, { off = false } = {}) {
  await page.evaluate(({ type, pointerId, off }) => {
    const btn = document.getElementById('btn-parent')
    const r = btn.getBoundingClientRect()
    const x = off ? r.left - 60 : r.left + r.width / 2
    const y = off ? r.bottom + 60 : r.top + r.height / 2
    btn.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, pointerType: 'touch', button: 0, clientX: x, clientY: y }))
    if (type === 'pointerup') btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  }, { type, pointerId, off })
}

// Quick tap — must not open add-photos
await parentPointer('pointerdown', 1)
await parentPointer('pointerup', 1)
await page.waitForTimeout(100)
const fileClicksAfterTap = await page.evaluate(() => window.__fileClicks)

// Hold well past 700ms — arms, stays armed, but must NOT open while the finger is still down
await parentPointer('pointerdown', 2)
await page.waitForTimeout(1500)
const armedBeforeRelease = await page.evaluate(() => document.getElementById('btn-parent').classList.contains('is-armed'))
const fileClicksWhileHeld = await page.evaluate(() => window.__fileClicks)
// Release on the button — opens add-photos exactly once
await parentPointer('pointerup', 2)
const fileClicksAfterHold = await page.evaluate(() => window.__fileClicks)

// Hold past 700ms, slide off, release — disarms, nothing opens
await parentPointer('pointerdown', 3)
await page.waitForTimeout(780)
await parentPointer('pointermove', 3, { off: true })
await parentPointer('pointerup', 3, { off: true })
const fileClicksAfterSlideOff = await page.evaluate(() => window.__fileClicks)

// Long-press system menu is suppressed on ···
const parentCallout = await page.evaluate(() => {
  const btn = document.getElementById('btn-parent')
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  btn.dispatchEvent(ev)
  const cs = getComputedStyle(btn)
  return {
    contextmenuPrevented: ev.defaultPrevented,
    touchCallout: cs.webkitTouchCallout ?? cs.getPropertyValue('-webkit-touch-callout'),
    userSelect: cs.userSelect || cs.webkitUserSelect,
    touchAction: cs.touchAction,
  }
})

const tileCount = await page.locator('.puzzle-tile').count()

async function solveCurrent() {
  await page.evaluate(() => {
    const board = document.querySelector('.puzzle-board')
    const tiles = [...board.querySelectorAll('.puzzle-tile')]
    function clickTile(i) {
      const r = tiles[i].getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      tiles[i].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }))
      tiles[i].dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }))
    }
    for (let guard = 0; guard < 40; guard++) {
      const order = tiles.map((t) => Number(t.dataset.piece))
      if (order.every((v, i) => v === i)) break
      const a = order.findIndex((v, i) => v !== i)
      const b = order.indexOf(a)
      if (b < 0 || a === b) break
      clickTile(a)
      clickTile(b)
    }
  })
}

await solveCurrent()
await page.waitForSelector('.puzzle-board.is-solved')
await page.waitForSelector('#btn-next')
await page.waitForTimeout(700) // join animation

const gap = await page.evaluate(() => {
  const board = document.querySelector('.puzzle-board')
  return getComputedStyle(board).gap
})
const footerVisible = await page.locator('#reveal-footer:not([hidden])').count()
const coachHidden = await page.locator('#coach[hidden]').count()
const celebrateGone = await page.locator('.celebrate').count()

await page.screenshot({ path: '/workspace/bairn/smoke-held-complete.png', fullPage: true })

// Next should skip wait and load new scramble with visible photo tiles (not blank/black)
const nextClickedAt = Date.now()
await page.click('#btn-next')
await page.waitForSelector('.puzzle-board:not(.is-solved)')
const afterNextMs = Date.now() - nextClickedAt
const afterNextTiles = await page.locator('.puzzle-tile').count()
const stillSolved = await page.locator('.puzzle-board.is-solved').count()
const nextHidden = await page.locator('#reveal-footer[hidden]').count()

const tileVisibility = await page.evaluate(() => {
  const pieces = [...document.querySelectorAll('.puzzle-tile .puzzle-piece')]
  const tiles = [...document.querySelectorAll('.puzzle-tile')]
  const board = document.querySelector('.puzzle-board')
  const slot = document.querySelector('.board-slot')
  const br = board.getBoundingClientRect()
  const sr = slot.getBoundingClientRect()
  const tr = tiles[0]?.getBoundingClientRect()
  const bgs = pieces.map((p) => p.style.backgroundImage || '')
  const emptyBg = bgs.filter((b) => !b || b === 'none' || !b.includes('url(')).length
  const square = Math.abs(br.width - br.height) <= 2
  const centred =
    Math.abs((br.left + br.width / 2) - (sr.left + sr.width / 2)) <= 2 &&
    Math.abs((br.top + br.height / 2) - (sr.top + sr.height / 2)) <= 3
  const fullBleed = br.width >= sr.width * 0.92 || br.height >= sr.height * 0.92
  return {
    emptyBg,
    bgSample: bgs[0]?.slice(0, 48) || '',
    tileW: tr?.width ?? 0,
    tileH: tr?.height ?? 0,
    boardW: br.width,
    boardH: br.height,
    slotW: sr.width,
    slotH: sr.height,
    square,
    centred,
    fullBleed,
  }
})

// Second puzzle: solve and wait for auto-advance (~10s) — use shortened hold via evaluate override isn't available;
// instead verify hold timer by waiting a bit then confirming still held, then click Next again.
await solveCurrent()
await page.waitForSelector('.puzzle-board.is-solved')
await page.waitForSelector('#btn-next')
await page.waitForTimeout(1500)
const stillHeld = await page.locator('.puzzle-board.is-solved').count()
const stillNext = await page.locator('#btn-next').count()

// Resume/restart with stored pool → outing-start, one Start tap
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('#btn-start')
const resumeScreen = await page.evaluate(() => ({
  hasStart: !!document.getElementById('btn-start'),
  hasDemo: !!document.getElementById('btn-demo'),
  isOuting: !!document.querySelector('.timer-confirm'),
}))
await page.click('#btn-start')
await page.waitForSelector('.puzzle-board')
const resumeTiles = await page.locator('.puzzle-tile').count()

const ok =
  tileCount === 4 &&
  parentAffordance.hintText === 'hold to add photos' &&
  parentAffordance.hintVisible &&
  parentAffordance.btnPresent &&
  fileClicksAfterTap === 0 &&
  armedBeforeRelease &&
  fileClicksWhileHeld === 0 &&
  fileClicksAfterHold === 1 &&
  fileClicksAfterSlideOff === 1 &&
  parentCallout.contextmenuPrevented &&
  parentCallout.userSelect === 'none' &&
  parentCallout.touchAction === 'manipulation' &&
  footerVisible === 1 &&
  coachHidden === 1 &&
  celebrateGone === 0 &&
  afterNextTiles === 4 &&
  stillSolved === 0 &&
  nextHidden === 1 &&
  stillHeld === 1 &&
  stillNext === 1 &&
  tileVisibility.emptyBg === 0 &&
  afterNextMs <= 500 &&
  tileVisibility.tileW >= 44 &&
  tileVisibility.tileH >= 44 &&
  tileVisibility.square &&
  tileVisibility.centred &&
  tileVisibility.fullBleed &&
  resumeScreen.hasStart &&
  !resumeScreen.hasDemo &&
  resumeScreen.isOuting &&
  resumeTiles === 4 &&
  errors.length === 0

console.log(JSON.stringify({
  tileCount,
  parentAffordance,
  fileClicksAfterTap,
  armedBeforeRelease,
  fileClicksWhileHeld,
  fileClicksAfterHold,
  fileClicksAfterSlideOff,
  parentCallout,
  gapAfterSolve: gap,
  footerVisible,
  coachHidden,
  celebrateGone,
  afterNextTiles,
  stillSolvedAfterNext: stillSolved,
  nextHiddenAfterAdvance: nextHidden,
  stillHeldAfter1_5s: stillHeld,
  stillNextAfter1_5s: stillNext,
  afterNextMs,
  tileVisibility,
  resumeScreen,
  resumeTiles,
  errors,
  ok,
}, null, 2))

await browser.close()
process.exit(ok ? 0 : 1)
