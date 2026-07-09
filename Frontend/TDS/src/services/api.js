import axios from 'axios'
import { readStoredSession, clearSession } from './sessionStorage'

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000'

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
})

// Attach the JWT to every outgoing request
api.interceptors.request.use((config) => {
  const session = readStoredSession()
  if (session?.token) {
    config.headers.Authorization = `Bearer ${session.token}`
  }
  return config
})

// Normalize FastAPI error shape ({ detail: "..." }) into a plain Error,
// and force a full logout if the token is rejected/expired server-side.
api.interceptors.response.use(
  (response) => response,
  (error) => {
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
