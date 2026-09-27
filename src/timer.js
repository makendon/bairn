const DEFAULT_MINUTES = 25

export function createOutingTimer({
  minutes = DEFAULT_MINUTES,
  onTick,
  onExpire,
}) {
  const durationMs = Math.max(1, minutes) * 60 * 1000
  const startedAt = Date.now()
  let expired = false
  let raf = null
  let interval = null

  function remaining() {
    return Math.max(0, durationMs - (Date.now() - startedAt))
  }

  function format(ms) {
    const totalSec = Math.ceil(ms / 1000)
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  function tick() {
    const rem = remaining()
    onTick?.({ remainingMs: rem, label: format(rem), progress: 1 - rem / durationMs })
    if (rem <= 0 && !expired) {
      expired = true
      stop()
      onExpire?.()
    }
  }

  function start() {
    tick()
    interval = setInterval(tick, 250)
    return api
  }

  function stop() {
    if (interval) clearInterval(interval)
    interval = null
    if (raf) cancelAnimationFrame(raf)
    raf = null
  }

  const api = {
    start,
    stop,
    remaining,
    format: () => format(remaining()),
    get expired() {
      return expired
    },
    get minutes() {
      return minutes
    },
  }
  return api
}

export { DEFAULT_MINUTES }
