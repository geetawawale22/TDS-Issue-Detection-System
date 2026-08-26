import { createContext, useCallback, useContext, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useDispatch, useSelector } from 'react-redux'
import { setCredentials, clearCredentials, setAuthLoading, setAuthError } from '@/redux/slices/authSlice'
import { setAvailableCompanyCodes, clearCompanyCodes } from '@/redux/slices/appSlice'
import authService, { persistSession, clearSession, tokenTtlMs } from '@/services/authService'
import { MESSAGES } from '@/utils/messages'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const dispatch  = useDispatch()
  const navigate  = useNavigate()
  const authState = useSelector((s) => s.auth)
  const logoutTimerRef = useRef(null)

  const scheduleAutoLogout = useCallback((token) => {
    if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current)
    const ttl = tokenTtlMs(token)
    if (ttl <= 0) { handleAutoLogout(); return }
    logoutTimerRef.current = setTimeout(handleAutoLogout, ttl)
  }, []) // eslint-disable-line

  function handleAutoLogout() {
    clearSession()
    dispatch(clearCredentials())
    dispatch(clearCompanyCodes())
    toast.error(MESSAGES.SESSION_EXPIRED, { duration: 5000 })
    navigate('/login?reason=session_expired', { replace: true })
  }

  useEffect(() => {
    if (authState.token) scheduleAutoLogout(authState.token)
    return () => { if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current) }
  }, [authState.token, scheduleAutoLogout])

  const login = useCallback(async (payload) => {
    dispatch(setAuthLoading(true))
    try {
      const { token, user } = await authService.login(payload)
      persistSession(token, user, payload.rememberMe ?? false)
      dispatch(setCredentials({ token, user }))
      dispatch(setAvailableCompanyCodes(user.companyCodes ?? []))
      scheduleAutoLogout(token)
      toast.success(MESSAGES.LOGIN_SUCCESS(user.name), { duration: 3000 })
      navigate('/dashboard', { replace: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed.'
      dispatch(setAuthError(message))
      toast.error(message)
    }
  }, [dispatch, navigate, scheduleAutoLogout])

  const signup = useCallback(async (payload) => {
    dispatch(setAuthLoading(true))
    try {
      const { message } = await authService.signup(payload)
      dispatch(setAuthLoading(false))
      toast.success(message || 'Account created! Please sign in.')
      navigate('/login', { replace: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Signup failed.'
      dispatch(setAuthError(message))
      toast.error(message)
    }
  }, [dispatch, navigate])

  const forgotPassword = useCallback(async (payload) => {
    dispatch(setAuthLoading(true))
    try {
      const { message } = await authService.forgotPassword(payload)
      dispatch(setAuthLoading(false))
      toast.success(message || MESSAGES.EMAIL_SENT)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Request failed.'
      dispatch(setAuthError(message))
      toast.error(message)
      return false
    }
  }, [dispatch])

  const resetPassword = useCallback(async (payload) => {
    dispatch(setAuthLoading(true))
    try {
      const { message } = await authService.resetPassword(payload)
      dispatch(setAuthLoading(false))
      toast.success(message || MESSAGES.PASSWORD_CHANGED)
      navigate('/login', { replace: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Reset failed.'
      dispatch(setAuthError(message))
      toast.error(message)
    }
  }, [dispatch, navigate])

  const setPassword = useCallback(async (payload) => {
    dispatch(setAuthLoading(true))
    try {
      const { message } = await authService.setPassword(payload)
      dispatch(setAuthLoading(false))
      toast.success(message || MESSAGES.PASSWORD_SET)
      navigate('/login', { replace: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not set password.'
      dispatch(setAuthError(message))
      toast.error(message)
    }
  }, [dispatch, navigate])

  const logout = useCallback(async () => {
    if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current)
    await authService.logout()
    clearSession()
    dispatch(clearCredentials())
    dispatch(clearCompanyCodes())
    toast.success(MESSAGES.LOGOUT_SUCCESS)
    navigate('/login', { replace: true })
  }, [dispatch, navigate])

  return (
    <AuthContext.Provider value={{
      user: authState.user, token: authState.token,
      isAuthenticated: authState.isAuthenticated, isLoading: authState.isLoading,
      error: authState.error, permissions: authState.permissions,
      login, signup, forgotPassword, resetPassword, setPassword, logout,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export default AuthContext
