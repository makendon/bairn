import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => new Promise((r) => { const req = indexedDB.deleteDatabase('bairn-photos'); req.onsuccess = r; req.onerror = r; req.onblocked = r }))
await page.reload({ waitUntil: 'networkidle' })
await page.click('#btn-demo')
await page.waitForSelector('#btn-start')
await page.click('#btn-start')
await page.waitForSelector('.puzzle-board')
await page.evaluate(() => {
  const tiles = [...document.querySelectorAll('.puzzle-tile')]
  const click = (i) => {
    const r = tiles[i].getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    tiles[i].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }))
    tiles[i].dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }))
  }
  for (let g = 0; g < 40; g++) {
    const order = tiles.map((t) => Number(t.dataset.piece))
    if (order.every((v, i) => v === i)) break
    const a = order.findIndex((v, i) => v !== i)
    const b = order.indexOf(a)
    if (b < 0 || a === b) break
    click(a); click(b)
  }
})
await page.waitForSelector('.puzzle-board.is-solved')
const t0 = Date.now()
await page.waitForSelector('.puzzle-board:not(.is-solved)', { timeout: 12000 })
const elapsed = Date.now() - t0
console.log(JSON.stringify({ autoAdvancedMs: elapsed, ok: elapsed >= 9000 && elapsed <= 11500 }))
await browser.close()
process.exit(elapsed >= 9000 && elapsed <= 11500 ? 0 : 1)
