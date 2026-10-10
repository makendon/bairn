const DB_NAME = 'bairn-photos'
const DB_VERSION = 1
const STORE = 'photos'
const META = 'meta'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('aborted'))
  })
}

export async function countPhotos() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function listPhotos() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

/**
 * Store bytes + type, not the Blob/File itself: iOS Safari can fail to put Blobs into
 * IndexedDB. Read every file before opening the transaction, since awaiting inside it
 * would let it auto-commit.
 */
export async function addPhotos(files) {
  const rows = await Promise.all(
    [...files].map(async (file) => ({
      data: await file.arrayBuffer(),
      type: file.type || 'image/jpeg',
      name: file.name,
    })),
  )
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const now = Date.now()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const id = `photo-${now}-${i}-${Math.random().toString(36).slice(2, 8)}`
    store.put({
      id,
      data: row.data,
      type: row.type,
      name: row.name || id,
      addedAt: now + i,
      usedCount: 0,
      lastUsedAt: 0,
    })
  }
  await txDone(tx)
  return rows.length
}

export async function markUsed(id) {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const getReq = store.get(id)
  await new Promise((resolve, reject) => {
    getReq.onsuccess = () => {
      const row = getReq.result
      if (row) {
        row.usedCount = (row.usedCount || 0) + 1
        row.lastUsedAt = Date.now()
        store.put(row)
      }
      resolve()
    }
    getReq.onerror = () => reject(getReq.error)
  })
  await txDone(tx)
}

export async function getMeta(key, fallback = null) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(META, 'readonly').objectStore(META).get(key)
    req.onsuccess = () => resolve(req.result ? req.result.value : fallback)
    req.onerror = () => reject(req.error)
  })
}

export async function setMeta(key, value) {
  const db = await openDb()
  const tx = db.transaction(META, 'readwrite')
  tx.objectStore(META).put({ key, value })
  await txDone(tx)
}

/** Pick next photo: prefer unused / least-used, shuffle among ties. */
export async function pickNextPhoto(excludeId = null) {
  const photos = await listPhotos()
  if (!photos.length) return null
  const pool = excludeId ? photos.filter((p) => p.id !== excludeId) : photos
  const candidates = pool.length ? pool : photos
  const minUsed = Math.min(...candidates.map((p) => p.usedCount || 0))
  const least = candidates.filter((p) => (p.usedCount || 0) === minUsed)
  const pick = least[Math.floor(Math.random() * least.length)]
  return pick
}

export function blobUrl(photo) {
  // Older rows (desktop) stored the Blob directly; new rows store bytes + type.
  const blob = photo.blob || new Blob([photo.data], { type: photo.type || 'image/jpeg' })
  return URL.createObjectURL(blob)
}

export const DEMO_PATHS = [
  '/demo/sun-hill.svg',
  '/demo/balloons.svg',
  '/demo/ocean.svg',
  '/demo/garden.svg',
]

export async function ensureDemoPhotos() {
  const existing = await countPhotos()
  if (existing > 0) return existing

  const blobs = []
  for (const path of DEMO_PATHS) {
    const res = await fetch(path)
    if (!res.ok) throw new Error(`demo ${path}: ${res.status}`)
    const blob = await res.blob()
    const file = new File([blob], path.split('/').pop(), { type: blob.type || 'image/svg+xml' })
    blobs.push(file)
  }
  await addPhotos(blobs)
  await setMeta('source', 'demo')
  return blobs.length
}
