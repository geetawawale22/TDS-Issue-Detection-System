import api from './api'
import adminService from './adminService'
import { decodeTokenPayload } from './sessionStorage'
export {
  TOKEN_KEY, USER_KEY,
  decodeTokenPayload, isTokenExpired, tokenTtlMs,
  persistSession, readStoredSession, clearSession, updateStoredUser,
} from './sessionStorage'


const authService = {
  /**
   * POST /auth/login -> { access_token, token_type, role, full_name }
   * The rest of the profile (id, email) is read straight out of the JWT
   * payload, which already carries { user_id, email, role } (see
   * backend/core/security.py). company_codes has no self-service endpoint
   * for non-admins yet — admins implicitly have access to every code
   * (mirrors backend/core/dependencies.py get_user_company_codes),
   * accountants get an empty list here (the profile modal fetches the real
   * list for the logged-in user via getMe() below).
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
   * Always resolves with a generic message (whether or not the email is
   * registered) \u2014 the backend intentionally avoids confirming which emails
   * exist. Real failures (network/server errors) reject normally and are
   * surfaced via api.js's response interceptor.
   */
  async forgotPassword({ email }) {
    const { data } = await api.post('/auth/forgot-password', { email })
    return { message: data?.message }
  },

  /**
   * POST /auth/reset-password -> { message }
   */
  async resetPassword({ token, password }) {
    const { data } = await api.post('/auth/reset-password', { token, password })
    return { message: data?.message }
  },

  async logout() {
    // Stateless JWT — nothing to invalidate server-side yet.
    return Promise.resolve()
  },

  /**
   * GET /auth/me -> full UserOut (id, full_name, email, role, is_active,
   * created_at, company_codes). Works for any role, unlike /admin/users/*
   * which requires Admin — this is how the profile modal gets fields
   * (created_at, real is_active/company_codes) that aren't in the JWT.
   */
  async getMe() {
    const { data } = await api.get('/auth/me')
    return data
  },

  /** PATCH /auth/me -> UserOut. Only full_name is self-editable. */
  async updateProfile({ full_name }) {
    const { data } = await api.patch('/auth/me', { full_name })
    return data
  },
}

export default authService
