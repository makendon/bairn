/**
 * Chunky tile puzzle (2×2 / 3×3 / 4×4) with tap-swap and pointer drag.
 * On solve, board gets `.is-solved` so CSS collapses gaps into one photo.
 */
export function createPuzzle(container, imageUrl, { grid = 3, onSolved } = {}) {
  const n = grid
  const total = n * n
  let order = shuffleSolvable([...Array(total).keys()])
  let selected = null
  let dragFrom = null
  let solved = false
  let objectUrl = imageUrl

  container.innerHTML = ''
  container.classList.add('puzzle-board')
  container.classList.remove('is-solved')
  container.style.setProperty('--grid', String(n))
  container.dataset.grid = String(n)

  const tiles = []
  for (let i = 0; i < total; i++) {
    const tile = document.createElement('button')
    tile.type = 'button'
    tile.className = 'puzzle-tile'
    tile.setAttribute('aria-label', `Tile ${i + 1}`)
    tile.dataset.slot = String(i)
    const piece = document.createElement('span')
    piece.className = 'puzzle-piece'
    tile.appendChild(piece)
    container.appendChild(tile)
    tiles.push(tile)

    tile.addEventListener('pointerdown', (e) => {
      if (solved) return
      if (e.button !== undefined && e.button !== 0) return
      dragFrom = i
      tile.setPointerCapture?.(e.pointerId)
      tile.classList.add('is-dragging')
    })

    tile.addEventListener('pointerup', (e) => {
      if (solved) return
      tile.classList.remove('is-dragging')
      const to = hitSlot(e.clientX, e.clientY)
      if (dragFrom !== null && to !== null && to !== dragFrom) {
        swap(dragFrom, to)
        selected = null
        clearSelection()
      } else if (dragFrom !== null && (to === null || to === dragFrom)) {
        if (selected === null) {
          selected = dragFrom
          clearSelection()
          tiles[selected].classList.add('is-selected')
        } else if (selected === dragFrom) {
          selected = null
          clearSelection()
        } else {
          swap(selected, dragFrom)
          selected = null
          clearSelection()
        }
      }
      dragFrom = null
    })

    tile.addEventListener('pointercancel', () => {
      tile.classList.remove('is-dragging')
      dragFrom = null
    })
  }

  function hitSlot(x, y) {
    for (let i = 0; i < tiles.length; i++) {
      const r = tiles[i].getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i
    }
    return null
  }

  function clearSelection() {
    tiles.forEach((t) => t.classList.remove('is-selected'))
  }

  function paint() {
    for (let slot = 0; slot < total; slot++) {
      const pieceIndex = order[slot]
      const row = Math.floor(pieceIndex / n)
      const col = pieceIndex % n
      const piece = tiles[slot].querySelector('.puzzle-piece')
      piece.style.backgroundImage = `url("${objectUrl}")`
      piece.style.backgroundSize = `${n * 100}% ${n * 100}%`
      const denom = Math.max(n - 1, 1)
      piece.style.backgroundPosition = `${(col / denom) * 100}% ${(row / denom) * 100}%`
      tiles[slot].dataset.piece = String(pieceIndex)
    }
  }

  function swap(a, b) {
    ;[order[a], order[b]] = [order[b], order[a]]
    paint()
    checkSolved()
  }

  function checkSolved() {
    if (solved) return
    const ok = order.every((v, i) => v === i)
    if (!ok) return
    solved = true
    clearSelection()
    container.classList.add('is-solved')
    tiles.forEach((t) => {
      t.classList.remove('is-selected', 'is-dragging')
      t.disabled = true
      t.setAttribute('tabindex', '-1')
    })
    // One continuous photo on top — tiles fade so no grid lines remain
    const reveal = document.createElement('div')
    reveal.className = 'puzzle-reveal'
    reveal.setAttribute('aria-hidden', 'true')
    reveal.style.backgroundImage = `url("${objectUrl}")`
    const sparkle = document.createElement('div')
    sparkle.className = 'puzzle-sparkle'
    sparkle.setAttribute('aria-hidden', 'true')
    reveal.appendChild(sparkle)
    container.appendChild(reveal)
    // Double rAF so gap/padding transition + reveal fade start together
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        reveal.classList.add('is-in')
        sparkle.classList.add('is-in')
        onSolved?.()
        // After melt, drop tile nodes so no hairlines can remain under the photo
        setTimeout(() => {
          tiles.forEach((el) => el.remove())
          tiles.length = 0
        }, 300)
      })
    })
  }

  // Caller (loadNextPuzzle) must decode the image first — paint sync so tiles
  // never mount with an empty background.
  paint()

  if (order.every((v, i) => v === i)) {
    order = shuffleSolvable([...Array(total).keys()])
    paint()
  }

  return {
    destroy() {
      container.innerHTML = ''
      container.classList.remove('puzzle-board', 'is-solved')
    },
  }
}

function shuffleSolvable(arr) {
  let out = arr.slice()
  do {
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
  } while (out.every((v, i) => v === i))
  return out
}
