export const TOKEN_KEY = 'tds_auth_token'
export const USER_KEY = 'tds_auth_user'

export function decodeTokenPayload(token) {
  try {
    const base64 = token.split('.')[1]
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)
  } catch {
    return null
  }
}

export function isTokenExpired(token) {
  const payload = decodeTokenPayload(token)
  if (!payload || !payload.exp) return true
  return payload.exp * 1000 < Date.now()
}

export function tokenTtlMs(token) {
  const payload = decodeTokenPayload(token)
  if (!payload || !payload.exp) return -1
  return payload.exp * 1000 - Date.now()
}

export function persistSession(token, user, rememberMe) {
  const storage = rememberMe ? localStorage : sessionStorage
  storage.setItem(TOKEN_KEY, token)
  storage.setItem(USER_KEY, JSON.stringify(user))
  if (!rememberMe) {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  } else {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(USER_KEY)
  }
}

export function readStoredSession() {
  try {
    const token = localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY)
    const userJson = localStorage.getItem(USER_KEY) ?? sessionStorage.getItem(USER_KEY)
    if (!token || !userJson) return null
    if (isTokenExpired(token)) {
      clearSession()
      return null
    }
    return { token, user: JSON.parse(userJson) }
  } catch {
    return null
  }
}

export function clearSession() {
  ;[localStorage, sessionStorage].forEach((s) => {
    s.removeItem(TOKEN_KEY)
    s.removeItem(USER_KEY)
  })
}
