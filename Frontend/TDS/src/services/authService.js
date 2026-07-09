import api from './api'
import adminService from './adminService'
import { decodeTokenPayload } from './sessionStorage'
export {
  TOKEN_KEY, USER_KEY,
  decodeTokenPayload, isTokenExpired, tokenTtlMs,
  persistSession, readStoredSession, clearSession,
} from './sessionStorage'


const authService = {
  /**
   * POST /auth/login -> { access_token, token_type, role, full_name }
   * There is no GET /auth/me on the backend, so the rest of the profile
   * (id, email) is read straight out of the JWT payload, which already
   * carries { user_id, email, role } (see backend/core/security.py).
   * company_codes has no self-service endpoint for non-admins yet — admins
   * implicitly have access to every code (mirrors backend/core/dependencies.py
   * get_user_company_codes), accountants get an empty list until the
   * backend exposes one.
   */
  async login({ email, password }) {
    const { data } = await api.post('/auth/login', { email, password })
    const token = data.access_token
    const payload = decodeTokenPayload(token)

    const user = {
      id: payload?.user_id ?? null,
      name: data.full_name,
      email: payload?.email ?? email,
      role: data.role,
      isActive: true,
      companyCodes: data.role === 'admin' ? adminService.VALID_COMPANY_CODES : [],
    }

    return { token, user }
  },

  /**
   * There is no open self-registration endpoint on the backend — only an
   * admin, via POST /admin/users, can create accounts. This is kept only so
   * the UI layer has something to call if that ever changes; today it
   * always rejects.
   */
  async signup() {
    throw new Error('Self-service signup is not available. Ask an administrator to create your account.')
  },

  /**
   * POST /auth/forgot-password -> { message }
   * The backend doesn't implement this route yet (services/email_service.py
   * is an empty stub), so this currently 404s. It's wired to the contract
   * the backend is expected to expose, so once that lands this starts
   * working with no frontend changes. Until then, a 404 is translated into
   * a clear "not available yet" message instead of a raw "Not Found".
   */
  async forgotPassword({ email }) {
    try {
      const { data } = await api.post('/auth/forgot-password', { email })
      return { message: data?.message }
    } catch (err) {
      if (err.status === 404) {
        throw new Error('Password reset isn\u2019t available yet. Please contact an administrator.')
      }
      throw err
    }
  },

  /**
   * POST /auth/reset-password -> { message }
   * Same situation as forgotPassword above \u2014 not implemented server-side yet.
   */
  async resetPassword({ token, password }) {
    try {
      const { data } = await api.post('/auth/reset-password', { token, password })
      return { message: data?.message }
    } catch (err) {
      if (err.status === 404) {
        throw new Error('Password reset isn\u2019t available yet. Please contact an administrator.')
      }
      throw err
    }
  },

  async logout() {
    // Stateless JWT — nothing to invalidate server-side yet.
    return Promise.resolve()
  },
}

export default authService
