import './style.css'
import {
  addPhotos,
  blobUrl,
  clearAllPhotos,
  countPhotos,
  getMeta,
  loadDemoPhotos,
  markUsed,
  pickNextPhoto,
  setMeta,
} from './db.js'
import { createOutingTimer, DEFAULT_MINUTES, OUTING_MINUTES } from './timer.js'
import { createPuzzle } from './puzzle.js'

/** Hold the completed photo so the child can look — Next skips. */
const HOLD_MS = 10_000

/** Set once with the outing timer — does not change mid-session. */
const DIFFICULTY = {
  easy: { id: 'easy', label: 'Easy', grid: 2, tiles: 4 },
  medium: { id: 'medium', label: 'Medium', grid: 3, tiles: 9 },
  hard: { id: 'hard', label: 'Hard', grid: 4, tiles: 16 },
}
const DEFAULT_DIFFICULTY = 'easy'

const app = document.getElementById('app')

const state = {
  screen: 'boot',
  timer: null,
  timerMinutes: DEFAULT_MINUTES,
  difficulty: DEFAULT_DIFFICULTY,
  currentPhotoId: null,
  currentUrl: null,
  puzzle: null,
  celebrating: false,
  holdTimerId: null,
  /** Photo ids shown this outing, so the reveal can offer more once all are played. */
  played: new Set(),
  /** Demo sandbox: in-memory only for this outing. Never written to IndexedDB. */
  demo: false,
  demoPhotos: [],
  /** After confirm, next file-input change leaves demo and saves her photos. */
  leavingDemo: false,
}

const fileInput = document.createElement('input')
fileInput.type = 'file'
fileInput.accept = 'image/*'
fileInput.multiple = true
fileInput.hidden = true
document.body.appendChild(fileInput)

fileInput.addEventListener('change', async () => {
  const files = [...(fileInput.files || [])].filter((f) => f.type.startsWith('image/'))
  fileInput.value = ''
  if (!files.length) {
    state.leavingDemo = false
    return
  }
  const fromDemo = state.demo || state.leavingDemo
  try {
    await addPhotos(files)
    await setMeta('source', 'library')
  } catch (err) {
    console.error(err)
    showToast(withErrName('Could not save those photos.', err), 8000) // long enough to screenshot
    state.leavingDemo = false
    return
  }
  dropDemo()
  if (state.screen === 'splash' || state.screen === 'boot') {
    goTimerConfirm()
  } else if (fromDemo) {
    // Left the demo sandbox: continue this outing on her photos.
    showToast('Photos added')
    state.played = new Set()
    state.currentPhotoId = null
    loadNextPuzzle().catch((err) => {
      console.error(err)
      showToast(withErrName('Could not load the next photo.', err), 8000)
    })
  } else {
    showToast('Photos added')
    const card = document.getElementById('end-card')
    if (card && !card.hidden) advanceAfterHold() // new photos are unplayed, so they come next
  }
})

/** Error text with the DOMException name, so a phone screenshot is a usable diagnostic. */
function withErrName(msg, err) {
  const name = err && (err.name || err.constructor?.name)
  return name ? `${msg} (${name})` : msg
}

function dropDemo() {
  state.demo = false
  state.demoPhotos = []
  state.leavingDemo = false
}

/** Next photo from the demo sandbox or the library pool. */
async function nextPhoto(excludeId = null) {
  if (state.demo) {
    const photos = state.demoPhotos
    if (!photos.length) return null
    const pool = excludeId ? photos.filter((p) => p.id !== excludeId) : photos
    const candidates = pool.length ? pool : photos
    const minUsed = Math.min(...candidates.map((p) => p.usedCount || 0))
    const least = candidates.filter((p) => (p.usedCount || 0) === minUsed)
    return least[Math.floor(Math.random() * least.length)]
  }
  return pickNextPhoto(excludeId)
}

async function noteUsed(id) {
  if (state.demo) {
    const row = state.demoPhotos.find((p) => p.id === id)
    if (row) {
      row.usedCount = (row.usedCount || 0) + 1
      row.lastUsedAt = Date.now()
    }
    return
  }
  await markUsed(id)
}

async function photoCount() {
  if (state.demo) return state.demoPhotos.length
  return countPhotos()
}


boot()

async function boot() {
  renderSplash({ loading: true })
  try {
    // Older builds wrote demos into IndexedDB. Wipe those so splash comes back.
    if ((await getMeta('source')) === 'demo') {
      await clearAllPhotos()
      await setMeta('source', null)
    }
    const n = await countPhotos()
    if (n > 0) {
      goTimerConfirm({ returning: true, count: n })
    } else {
      renderSplash()
    }
  } catch (err) {
    console.error(err)
    renderSplash({ error: withErrName('Could not open photo storage.', err) })
  }
}

function goTimerConfirm(opts = {}) {
  clearHold()
  state.screen = 'timer'
  renderTimerConfirm(opts)
}

function startSession() {
  clearHold()
  if (state.timer) state.timer.stop()
  state.timer = createOutingTimer({
    minutes: state.timerMinutes,
    onTick: updateTimerHud,
    onExpire: () => {
      clearHold()
      teardownPuzzle()
      renderTimesUp()
    },
  })
  state.timer.start()
  state.played = new Set()
  loadNextPuzzle()
}

/** Monotonic gen so a late hold-auto cannot clobber a fresher Next. */
let loadGen = 0

/**
 * Decode before paint — blob URLs can still race; never show empty tiles.
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const done = () => resolve(img)
      if (typeof img.decode === 'function') {
        img.decode().then(done).catch(done)
      } else {
        done()
      }
    }
    img.onerror = () => reject(new DOMException('image load failed', 'EncodingError'))
    setTimeout(() => reject(new DOMException('image load timed out', 'TimeoutError')), 8000)
    img.src = url
  })
}

async function loadNextPuzzle() {
  if (state.timer?.expired) {
    renderTimesUp()
    return
  }
  clearHold()
  state.screen = 'puzzle'
  state.celebrating = false

  const gen = ++loadGen
  // Keep prior board painted until the next photo is decoded (Ash: no blank tiles).
  const photo = await nextPhoto(state.currentPhotoId)
  if (gen !== loadGen) return
  if (!photo) {
    teardownPuzzle()
    renderSplash({ error: 'No photos yet. Add some or try the demo.' })
    return
  }

  const nextUrl = blobUrl(photo)
  try {
    await loadImage(nextUrl)
  } catch (err) {
    console.error(err)
    try {
      URL.revokeObjectURL(nextUrl)
    } catch (_) {}
    if (gen !== loadGen) return
    if (!state.puzzle) {
      renderSplash({ error: withErrName('Could not load photo.', err) })
    } else {
      // Keep the solved board, but never fail silently: say so, and let Next retry.
      showToast(withErrName('Could not load the next photo.', err), 8000)
    }
    return
  }
  if (gen !== loadGen) {
    try {
      URL.revokeObjectURL(nextUrl)
    } catch (_) {}
    return
  }

  const prevUrl = state.currentUrl
  state.played.add(photo.id)
  state.currentPhotoId = photo.id
  state.currentUrl = nextUrl
  await noteUsed(photo.id)
  if (gen !== loadGen) {
    // A fresher load superseded this one; still free the url we replaced.
    if (prevUrl && prevUrl !== nextUrl) {
      try {
        URL.revokeObjectURL(prevUrl)
      } catch (_) {}
    }
    return
  }

  // Swap only after image is ready. Replace shell in one turn (no mid-frame empty board),
  // sync-paint tiles, then revoke the previous object URL.
  state.puzzle = null
  renderPuzzleShell()
  const board = document.getElementById('board')
  const diff = DIFFICULTY[state.difficulty] || DIFFICULTY.easy
  state.puzzle = createPuzzle(board, state.currentUrl, {
    grid: diff.grid,
    onSolved: handleSolved,
  })

  if (prevUrl && prevUrl !== nextUrl) {
    requestAnimationFrame(() => {
      try {
        URL.revokeObjectURL(prevUrl)
      } catch (_) {}
    })
  }
}

function clearHold() {
  if (state.holdTimerId != null) {
    clearTimeout(state.holdTimerId)
    state.holdTimerId = null
  }
}

function advanceAfterHold() {
  clearHold()
  if (state.timer?.expired) {
    renderTimesUp()
    return
  }
  allPhotosPlayed().then((all) => {
    if (all) state.played = new Set() // same as Play them again
    return loadNextPuzzle()
  }).catch((err) => {
    console.error(err)
    showToast(withErrName('Could not load the next photo.', err), 8000)
  })
}

function handleSolved() {
  if (state.celebrating) return
  state.celebrating = true

  const screen = document.querySelector('.puzzle-screen')
  screen?.classList.add('is-revealing')

  const board = document.getElementById('board')
  board?.classList.add('has-sparkle')

  const coach = document.getElementById('coach')
  if (coach) coach.hidden = true

  const footer = document.getElementById('reveal-footer')
  if (footer) footer.hidden = false
  showEndCardIfAllPlayed()

  clearHold()
  state.holdTimerId = setTimeout(() => {
    state.holdTimerId = null
    advanceAfterHold()
  }, HOLD_MS)
}

/** Every photo shown this outing? Count only; never read photo bytes. */
async function allPhotosPlayed() {
  try {
    const count = await photoCount()
    return count > 0 && state.played.size >= count
  } catch (err) {
    console.error(err)
    return false
  }
}

/** Swap Next for the end card once every photo has been played. */
async function showEndCardIfAllPlayed() {
  if (!(await allPhotosPlayed())) return
  if (!state.celebrating) return // already moved on
  const footer = document.getElementById('reveal-footer')
  const card = document.getElementById('end-card')
  const bar = document.getElementById('puzzle-bar')
  if (footer) footer.hidden = true
  if (bar) bar.hidden = true
  if (card) card.hidden = false
}

/** Reset the played set and give a fresh scrambled board. */
function playThemAgain() {
  clearHold()
  state.played = new Set()
  loadNextPuzzle().catch((err) => {
    console.error(err)
    showToast(withErrName('Could not load the next photo.', err), 8000)
  })
}

function teardownPuzzle(clearUrl = true) {
  clearHold()
  closeConfirm()
  if (state.puzzle) {
    state.puzzle.destroy()
    state.puzzle = null
  }
  if (clearUrl && state.currentUrl) {
    try {
      URL.revokeObjectURL(state.currentUrl)
    } catch (_) {}
    state.currentUrl = null
  }
}

function updateTimerHud({ label, remainingMs }) {
  const el = document.getElementById('timer-label')
  if (el) el.textContent = label
  const bar = document.getElementById('timer-bar')
  if (bar) {
    const pct = Math.max(0, Math.min(100, (remainingMs / (state.timerMinutes * 60 * 1000)) * 100))
    bar.style.width = `${pct}%`
  }
}

/* ---------- screens ---------- */

function renderSplash({ loading = false, error = null } = {}) {
  state.screen = 'splash'
  app.innerHTML = `
    <main class="screen splash safe">
      <div class="splash-mark" aria-hidden="true">✦</div>
      <h1 class="title">Bairn</h1>
      <p class="lede">A calm photo puzzle for a short parent break.</p>
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
      <div class="actions">
        <button class="btn primary" id="btn-photos" ${loading ? 'disabled' : ''}>
          Use photos
        </button>
        <button class="btn ghost" id="btn-demo" ${loading ? 'disabled' : ''}>
          Try demo
        </button>
      </div>
      <p class="hint">Photos stay on this device. No account.</p>
    </main>
  `
  document.getElementById('btn-photos')?.addEventListener('click', () => fileInput.click())
  document.getElementById('btn-demo')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-demo')
    if (btn) btn.disabled = true
    try {
      state.demoPhotos = await loadDemoPhotos()
      state.demo = true
      goTimerConfirm({ demo: true })
    } catch (err) {
      console.error(err)
      dropDemo()
      renderSplash({ error: withErrName('Could not load demo photos.', err) })
    }
  })
}

function renderTimerConfirm({ returning = false, demo = false, count = 0 } = {}) {
  const note = returning
    ? `Ready with ${count} photo${count === 1 ? '' : 's'}.`
    : demo
      ? 'Demo photos loaded.'
      : 'Photos ready.'
  if (!DIFFICULTY[state.difficulty]) state.difficulty = DEFAULT_DIFFICULTY
  if (!OUTING_MINUTES.includes(state.timerMinutes)) state.timerMinutes = DEFAULT_MINUTES
  const pills = Object.values(DIFFICULTY)
    .map(
      (d) => `
        <button type="button" class="diff-pill${d.id === state.difficulty ? ' is-selected' : ''}" data-diff="${d.id}" aria-pressed="${d.id === state.difficulty}">
          <span class="diff-label">${escapeHtml(d.label)}</span>
          <span class="diff-meta">${d.tiles} tiles</span>
        </button>`,
    )
    .join('')
  const timePills = OUTING_MINUTES.map(
    (m) => `
        <button type="button" class="diff-pill${m === state.timerMinutes ? ' is-selected' : ''}" data-mins="${m}" aria-pressed="${m === state.timerMinutes}">
          <span class="diff-label">${m} min</span>
        </button>`,
  ).join('')
  app.innerHTML = `
    <main class="screen timer-confirm safe">
      <p class="eyebrow">Outing</p>
      <h1 class="title sm" id="outing-title">About ${state.timerMinutes} minutes</h1>
      <p class="lede">${escapeHtml(note)} Set once, then walk away.</p>
      <p class="field-label">Length</p>
      <div class="diff-row" role="group" aria-label="Outing length">${timePills}</div>
      <p class="field-label">Difficulty</p>
      <div class="diff-row" role="group" aria-label="Difficulty">${pills}</div>
      <div class="actions">
        <button class="btn primary" id="btn-start">Start</button>
        ${demo ? '' : '<button class="btn ghost" id="btn-add" title="Parent">Add more photos</button>'}
      </div>
    </main>
  `
  document.querySelectorAll('.diff-pill[data-mins]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.timerMinutes = Number(btn.dataset.mins) || DEFAULT_MINUTES
      const title = document.getElementById('outing-title')
      if (title) title.textContent = `About ${state.timerMinutes} minutes`
      document.querySelectorAll('.diff-pill[data-mins]').forEach((b) => {
        const on = Number(b.dataset.mins) === state.timerMinutes
        b.classList.toggle('is-selected', on)
        b.setAttribute('aria-pressed', String(on))
      })
    })
  })
  document.querySelectorAll('.diff-pill[data-diff]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.difficulty = btn.dataset.diff || DEFAULT_DIFFICULTY
      document.querySelectorAll('.diff-pill[data-diff]').forEach((b) => {
        const on = b.dataset.diff === state.difficulty
        b.classList.toggle('is-selected', on)
        b.setAttribute('aria-pressed', String(on))
      })
    })
  })
  document.getElementById('btn-start')?.addEventListener('click', () => startSession())
  document.getElementById('btn-add')?.addEventListener('click', () => fileInput.click())
}

function renderPuzzleShell() {
  const label = state.timer ? state.timer.format() : `${state.timerMinutes}:00`
  app.innerHTML = `
    <main class="screen puzzle-screen safe">
      <header class="hud">
        <div class="timer" aria-live="polite" aria-atomic="true">
          <span class="timer-dot" aria-hidden="true"></span>
          <span id="timer-label">${escapeHtml(label)}</span>
        </div>
        <div class="timer-track" aria-hidden="true"><div id="timer-bar" class="timer-bar"></div></div>
      </header>
      <div class="board-slot">
        <div id="board" class="board" role="application" aria-label="Photo puzzle"></div>
      </div>
      <p class="coach" id="coach">Drag or tap two tiles to swap</p>
      <div id="reveal-footer" class="reveal-footer" hidden>
        <p class="reveal-caption">Have a look</p>
        <button type="button" class="btn primary btn-next" id="btn-next">Next</button>
      </div>
      <div id="end-card" class="end-card" hidden>
        <p class="end-title">${state.demo ? 'That’s the demo 🎉' : 'That’s all your photos 🎉'}</p>
        <button type="button" class="btn primary" id="btn-again-photos">Play them again</button>
        <div class="end-row">
          <button type="button" class="btn ghost" id="end-add">${state.demo ? 'Use her photos' : '+ Add photos'}</button>
          <button type="button" class="btn ghost" id="end-start">Back to start</button>
        </div>
      </div>
      <nav class="puzzle-bar" id="puzzle-bar" aria-label="Grown-ups">
        <button type="button" class="bar-btn" id="bar-add">${state.demo ? 'use her photos' : '+ add photos'}</button>
        <button type="button" class="bar-btn" id="bar-start">⌂ start</button>
      </nav>
    </main>
  `
  document.getElementById('btn-next')?.addEventListener('click', () => advanceAfterHold())
  document.getElementById('btn-again-photos')?.addEventListener('click', () => playThemAgain())
  for (const id of ['bar-add', 'end-add']) {
    document.getElementById(id)?.addEventListener('click', () => {
      if (state.demo) {
        confirmLeaveDemo()
        return
      }
      clearHold() // don't auto-advance under the photo picker
      fileInput.click() // synchronous inside the click: iOS allows the picker
    })
  }
  document.getElementById('bar-start')?.addEventListener('click', () => confirmBackToStart())
  document.getElementById('end-start')?.addEventListener('click', () => confirmBackToStart())
  if (state.timer) {
    updateTimerHud({
      label: state.timer.format(),
      remainingMs: state.timer.remaining(),
    })
  }
}

function renderTimesUp() {
  state.screen = 'timesup'
  clearHold()
  teardownPuzzle()
  if (state.timer) {
    state.timer.stop()
  }
  app.innerHTML = `
    <main class="screen times-up safe">
      <p class="eyebrow">Time’s up</p>
      <h1 class="title sm">That was a lovely outing.</h1>
      <p class="lede">Come back when you’re ready for another short break.</p>
      <div class="actions">
        <button class="btn primary" id="btn-again">Start again</button>
      </div>
      <button class="parent-link bottom" id="btn-parent">${state.demo ? 'Use her photos' : 'Add more photos'}</button>
    </main>
  `
  document.getElementById('btn-again')?.addEventListener('click', () => backToStart())
  document.getElementById('btn-parent')?.addEventListener('click', () => {
    if (state.demo) confirmLeaveDemo()
    else fileInput.click()
  })
}

function showToast(msg, ms = 1800) {
  let t = document.getElementById('toast')
  if (!t) {
    t = document.createElement('div')
    t.id = 'toast'
    t.className = 'toast'
    document.body.appendChild(t)
  }
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(showToast._id)
  showToast._id = setTimeout(() => t.classList.remove('show'), ms)
}


/** "back to start?" confirm: losing the timer mid-outing costs more than a tap, so ask once. */
function closeConfirm() {
  document.getElementById('confirm-sheet')?.remove()
}

function confirmBackToStart() {
  closeConfirm()
  const sheet = document.createElement('div')
  sheet.id = 'confirm-sheet'
  sheet.className = 'sheet'
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-label', 'Back to start?')
  sheet.innerHTML = `
    <div class="sheet-scrim" data-close></div>
    <div class="sheet-panel">
      <p class="sheet-title">Back to start? This ends the outing.</p>
      <button type="button" class="btn primary" id="confirm-keep" data-close>Keep playing</button>
      <button type="button" class="btn ghost" id="confirm-start">Back to start</button>
    </div>
  `
  document.body.appendChild(sheet)
  sheet.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeConfirm))
  sheet.querySelector('#confirm-start').addEventListener('click', () => backToStart())
}

/** End the outing and return to the start screen (difficulty lives there). */
/** Leave the demo sandbox for her real photos. */
function confirmLeaveDemo() {
  closeConfirm()
  clearHold() // don't auto-advance under the confirm / picker
  const sheet = document.createElement('div')
  sheet.id = 'confirm-sheet'
  sheet.className = 'sheet'
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-label', 'Leave the demo?')
  sheet.innerHTML = `
    <div class="sheet-scrim" data-close></div>
    <div class="sheet-panel">
      <p class="sheet-title">Leave the demo? Her photos replace these.</p>
      <button type="button" class="btn primary" id="confirm-leave">Use her photos</button>
      <button type="button" class="btn ghost" data-close>Keep the demo</button>
    </div>
  `
  document.body.appendChild(sheet)
  sheet.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeConfirm))
  sheet.querySelector('#confirm-leave').addEventListener('click', () => {
    closeConfirm()
    state.leavingDemo = true
    fileInput.click() // synchronous inside the click: iOS allows the picker
  })
}

async function backToStart() {
  closeConfirm()
  clearHold()
  loadGen++ // drop any in-flight load
  if (state.timer) {
    state.timer.stop()
    state.timer = null
  }
  teardownPuzzle()
  dropDemo() // demo never persists; splash comes back when the store is empty
  let count = 0
  try {
    count = await countPhotos()
  } catch (err) {
    console.error(err)
  }
  if (!count) {
    renderSplash()
    return
  }
  goTimerConfirm({ returning: true, count })
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
