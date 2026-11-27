import axios from 'axios'
import { readStoredSession, clearSession } from './sessionStorage'
import { startRequest, endRequest } from './loaderBus'

const DEFAULT_API_HOST = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1'
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? `http://${DEFAULT_API_HOST}:8000`

// ── Short-lived cache of GET responses, so switching between pages shows data
// already loaded instead of fetching it again.
// * Kept in memory only (gone on a browser refresh), per logged-in user.
// * Entries expire after CACHE_TTL_MS, so other users' changes still show up.
// * Any save (POST / PUT / PATCH / DELETE) empties the cache, and so does a SAP
//   data API analysis finishing, so your own changes always show at once.
// * The raw response text is cached; axios parses it for every caller, so each
//   page gets its own copy and cannot change what another page sees.
// * A request can skip the cache with { cache: false }.
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_ENTRIES = 60
// Never cached: live job status, auth, file downloads, "does this run still exist" checks.
const NO_CACHE_PREFIXES = ['/auth/', '/sap-data/analyse-jobs', '/issues/template']
const NO_CACHE_PATTERN = /\/exists$/
// POSTs that only read data, so they do not empty the cache.
const READ_ONLY_POSTS = ['/pan/statuses', '/sap-data/query']
const ACTIVE_JOB_STATUSES = new Set(['queued', 'fetching', 'grouping', 'analysing', 'finishing'])

const responseCache = new Map() // key -> { expires, response } or { pending }
let cacheGeneration = 0
const networkAdapter = axios.getAdapter(axios.defaults.adapter)

export function clearApiCache() {
  cacheGeneration += 1
  responseCache.clear()
}

function pathOf(config) {
  return String(config.url || '').split('?')[0]
}

function isCacheableGet(config) {
  if ((config.method || 'get').toLowerCase() !== 'get' || config.cache === false) return false
  if (config.responseType && config.responseType !== 'json') return false
  const path = pathOf(config)
  return !NO_CACHE_PREFIXES.some((prefix) => path.startsWith(prefix)) && !NO_CACHE_PATTERN.test(path)
}

function freshResponse(cached, config) {
  // dispatchRequest overwrites response.data with the parsed JSON, so every caller gets a new object.
  return { ...cached, config, request: null }
}

async function cachingAdapter(config) {
  const method = (config.method || 'get').toLowerCase()
  const path = pathOf(config)

  if (method !== 'get') {
    try {
      return await networkAdapter(config)
    } finally {
      if (!READ_ONLY_POSTS.includes(path)) clearApiCache()
    }
  }

  if (!isCacheableGet(config)) {
    const response = await networkAdapter(config)
    if (path.startsWith('/sap-data/analyse-jobs')) {
      // A finished analysis has saved new issues and ledger lines: drop old copies.
      try {
        const status = JSON.parse(response.data)?.status
        if (status && !ACTIVE_JOB_STATUSES.has(status)) clearApiCache()
      } catch {
        // Not JSON; nothing to decide.
      }
    }
    return response
  }

  const key = `${config.headers?.Authorization || ''} ${api.getUri(config)}`
  const hit = responseCache.get(key)
  if (hit?.response && hit.expires > Date.now()) return freshResponse(hit.response, config)
  if (hit?.pending) {
    // The same data is already being fetched (two parts of a page asking at once): share it.
    try {
      return freshResponse(await hit.pending, config)
    } catch {
      return networkAdapter(config)
    }
  }

  const generation = cacheGeneration
  const pending = networkAdapter(config).then((response) => ({
    data: response.data,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }))
  responseCache.set(key, { pending })
  try {
    const stored = await pending
    if (generation === cacheGeneration && typeof stored.data === 'string') {
      responseCache.delete(key)
      responseCache.set(key, { expires: Date.now() + CACHE_TTL_MS, response: stored })
      while (responseCache.size > CACHE_MAX_ENTRIES) responseCache.delete(responseCache.keys().next().value)
    } else if (responseCache.get(key)?.pending === pending) {
      responseCache.delete(key)
    }
    return freshResponse(stored, config)
  } catch (error) {
    if (responseCache.get(key)?.pending === pending) responseCache.delete(key)
    throw error
  }
}

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  adapter: cachingAdapter,
})

// Attach the JWT to every outgoing request
api.interceptors.request.use((config) => {
  const session = readStoredSession()
  if (session?.token) {
    config.headers.Authorization = `Bearer ${session.token}`
  }
  // File uploads render their own progress UI, so they skip the page loader.
  // Callers can also opt out explicitly with { skipGlobalLoader: true }.
  const isUpload = config.data instanceof FormData || Boolean(config.onUploadProgress)
  if (!config.skipGlobalLoader && !isUpload) {
    config._trackedByLoader = true
    startRequest()
  }
  return config
})

function finishTracking(config) {
  if (config?._trackedByLoader) {
    config._trackedByLoader = false
    endRequest()
  }
}

// Normalize FastAPI error shape ({ detail: "..." }) into a plain Error,
// and force a full logout if the token is rejected/expired server-side.
api.interceptors.response.use(
  (response) => {
    finishTracking(response.config)
    return response
  },
  (error) => {
    finishTracking(error.config)
    const status = error.response?.status
    const detail = error.response?.data?.detail

    if (status === 401) {
      clearSession()
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login?reason=session_expired'
      }
    }

    const message = typeof detail === 'string'
      ? detail
      : Array.isArray(detail)
        ? detail.map((d) => d.msg).join(', ')
        : error.message || 'Something went wrong. Please try again.'

    const normalizedError = new Error(message)
    normalizedError.status = status
    return Promise.reject(normalizedError)
  }
)

export default api
export { BASE_URL }
