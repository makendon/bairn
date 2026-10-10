import './style.css'
import {
  addPhotos,
  blobUrl,
  countPhotos,
  ensureDemoPhotos,
  markUsed,
  pickNextPhoto,
  setMeta,
} from './db.js'
import { createOutingTimer, DEFAULT_MINUTES } from './timer.js'
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
  if (!files.length) return
  try {
    await addPhotos(files)
    await setMeta('source', 'library')
  } catch (err) {
    console.error(err)
    showToast(withErrName('Could not save those photos.', err), 8000) // long enough to screenshot
    return
  }
  if (state.screen === 'splash' || state.screen === 'boot') {
    goTimerConfirm()
  } else {
    showToast('Photos added')
  }
})

/** Error text with the DOMException name, so a phone screenshot is a usable diagnostic. */
function withErrName(msg, err) {
  const name = err && (err.name || err.constructor?.name)
  return name ? `${msg} (${name})` : msg
}

boot()

async function boot() {
  renderSplash({ loading: true })
  try {
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
  const photo = await pickNextPhoto(state.currentPhotoId)
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
  await markUsed(photo.id)
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
  loadNextPuzzle().catch((err) => {
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
  offerMorePhotosIfAllPlayed()

  clearHold()
  state.holdTimerId = setTimeout(() => {
    state.holdTimerId = null
    advanceAfterHold()
  }, HOLD_MS)
}

/** Once every photo has been shown this outing, offer more next to Next (plain tap, no hold). */
async function offerMorePhotosIfAllPlayed() {
  try {
    const count = await countPhotos() // count only; don't read every photo's bytes
    const allPlayed = count > 0 && state.played.size >= count
    const more = document.getElementById('btn-more')
    if (more && allPlayed) more.hidden = false
  } catch (err) {
    console.error(err)
  }
}

function teardownPuzzle(clearUrl = true) {
  clearHold()
  closeParentSheet()
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
      await ensureDemoPhotos()
      goTimerConfirm({ demo: true })
    } catch (err) {
      console.error(err)
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
  const pills = Object.values(DIFFICULTY)
    .map(
      (d) => `
        <button type="button" class="diff-pill${d.id === state.difficulty ? ' is-selected' : ''}" data-diff="${d.id}" aria-pressed="${d.id === state.difficulty}">
          <span class="diff-label">${escapeHtml(d.label)}</span>
          <span class="diff-meta">${d.tiles} tiles</span>
        </button>`,
    )
    .join('')
  app.innerHTML = `
    <main class="screen timer-confirm safe">
      <p class="eyebrow">Outing</p>
      <h1 class="title sm">About ${DEFAULT_MINUTES} minutes</h1>
      <p class="lede">${escapeHtml(note)} Set once, then walk away.</p>
      <p class="field-label">Difficulty</p>
      <div class="diff-row" role="group" aria-label="Difficulty">${pills}</div>
      <div class="actions">
        <button class="btn primary" id="btn-start">Start</button>
        <button class="btn ghost" id="btn-add" title="Parent">Add more photos</button>
      </div>
    </main>
  `
  document.querySelectorAll('.diff-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.difficulty = btn.dataset.diff || DEFAULT_DIFFICULTY
      document.querySelectorAll('.diff-pill').forEach((b) => {
        const on = b.dataset.diff === state.difficulty
        b.classList.toggle('is-selected', on)
        b.setAttribute('aria-pressed', String(on))
      })
    })
  })
  document.getElementById('btn-start')?.addEventListener('click', () => {
    state.timerMinutes = DEFAULT_MINUTES
    startSession()
  })
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
        <div class="parent-gate">
          <button type="button" class="parent-link" id="btn-parent" aria-label="Grown-ups: add photos" aria-haspopup="dialog">···</button>
          <span class="parent-hold-hint" aria-hidden="true">add photos</span>
        </div>
      </header>
      <div class="board-slot">
        <div id="board" class="board" role="application" aria-label="Photo puzzle"></div>
      </div>
      <p class="coach" id="coach">Drag or tap two tiles to swap</p>
      <div id="reveal-footer" class="reveal-footer" hidden>
        <p class="reveal-caption">Have a look</p>
        <div class="reveal-actions">
          <button type="button" class="btn ghost btn-more" id="btn-more" hidden>Add more photos?</button>
          <button type="button" class="btn primary btn-next" id="btn-next">Next</button>
        </div>
      </div>
    </main>
  `
  document.getElementById('btn-parent')?.addEventListener('click', () => openParentSheet())
  document.getElementById('btn-next')?.addEventListener('click', () => advanceAfterHold())
  document.getElementById('btn-more')?.addEventListener('click', () => {
    clearHold() // don't auto-advance under the photo picker
    fileInput.click() // synchronous inside the click: iOS allows the picker
  })
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
      <button class="parent-link bottom" id="btn-parent">Add more photos</button>
    </main>
  `
  document.getElementById('btn-again')?.addEventListener('click', () => goTimerConfirm({ returning: true }))
  document.getElementById('btn-parent')?.addEventListener('click', () => fileInput.click())
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


/**
 * Mid-puzzle "for grown-ups" sheet: a plain tap on ··· opens it; Add photos opens the
 * library straight from its click (the one gesture iOS reliably allows). Closes itself
 * after PARENT_SHEET_MS untouched. Worst case a toddler opens the library and backs out.
 */
const PARENT_SHEET_MS = 6000

function closeParentSheet() {
  const sheet = document.getElementById('parent-sheet')
  if (!sheet) return
  clearTimeout(closeParentSheet._id)
  sheet.remove()
}

function openParentSheet() {
  closeParentSheet()
  const sheet = document.createElement('div')
  sheet.id = 'parent-sheet'
  sheet.className = 'parent-sheet'
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-label', 'For grown-ups')
  sheet.innerHTML = `
    <div class="parent-sheet-scrim" data-close></div>
    <div class="parent-sheet-panel">
      <p class="parent-sheet-title">For grown-ups</p>
      <button type="button" class="btn primary" id="sheet-add">Add photos</button>
      <button type="button" class="btn ghost" id="sheet-back" data-close>Back to puzzle</button>
    </div>
  `
  document.body.appendChild(sheet)
  const restart = () => {
    clearTimeout(closeParentSheet._id)
    closeParentSheet._id = setTimeout(closeParentSheet, PARENT_SHEET_MS)
  }
  sheet.addEventListener('pointerdown', restart)
  sheet.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeParentSheet))
  sheet.querySelector('#sheet-add').addEventListener('click', () => {
    closeParentSheet()
    clearHold() // don't auto-advance under the photo picker
    fileInput.click() // synchronous inside the click: iOS allows the picker
  })
  restart()
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
