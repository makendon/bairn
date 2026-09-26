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

// Next should skip wait and load new scramble
await page.click('#btn-next')
await page.waitForSelector('.puzzle-board:not(.is-solved)')
const afterNextTiles = await page.locator('.puzzle-tile').count()
const stillSolved = await page.locator('.puzzle-board.is-solved').count()
const nextHidden = await page.locator('#reveal-footer[hidden]').count()

// Second puzzle: solve and wait for auto-advance (~10s) — use shortened hold via evaluate override isn't available;
// instead verify hold timer by waiting a bit then confirming still held, then click Next again.
await solveCurrent()
await page.waitForSelector('.puzzle-board.is-solved')
await page.waitForSelector('#btn-next')
await page.waitForTimeout(1500)
const stillHeld = await page.locator('.puzzle-board.is-solved').count()
const stillNext = await page.locator('#btn-next').count()

const ok =
  tileCount === 4 &&
  footerVisible === 1 &&
  coachHidden === 1 &&
  celebrateGone === 0 &&
  afterNextTiles === 4 &&
  stillSolved === 0 &&
  nextHidden === 1 &&
  stillHeld === 1 &&
  stillNext === 1 &&
  errors.length === 0

console.log(JSON.stringify({
  tileCount,
  gapAfterSolve: gap,
  footerVisible,
  coachHidden,
  celebrateGone,
  afterNextTiles,
  stillSolvedAfterNext: stillSolved,
  nextHiddenAfterAdvance: nextHidden,
  stillHeldAfter1_5s: stillHeld,
  stillNextAfter1_5s: stillNext,
  errors,
  ok,
}, null, 2))

await browser.close()
process.exit(ok ? 0 : 1)
