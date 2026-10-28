// IndexedDB copy of the last SAP upload. localStorage caps out around 5 MB,
// which a full-year extract easily passes, so large uploads are kept here
// instead and survive reloads (including the session-expired redirect).
// Every call resolves rather than throws: the cache is a convenience, and
// a private window or blocked storage just means nothing is restored.

const DB_NAME = 'tds_upload_cache'
const STORE_NAME = 'uploads'
const LAST_UPLOAD_KEY = 'last_upload'

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore(mode, run) {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode)
      const request = run(tx.objectStore(STORE_NAME))
      tx.oncomplete = () => resolve(request?.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export async function readCachedUpload() {
  try {
    return (await withStore('readonly', (store) => store.get(LAST_UPLOAD_KEY))) || null
  } catch {
    return null
  }
}

export async function writeCachedUpload(payload) {
  try {
    await withStore('readwrite', (store) => store.put(payload, LAST_UPLOAD_KEY))
  } catch {
    // Storage full or blocked: the upload stays in memory for this session.
  }
}

export async function clearCachedUpload() {
  try {
    await withStore('readwrite', (store) => store.delete(LAST_UPLOAD_KEY))
  } catch {
    // Nothing to clear.
  }
}
