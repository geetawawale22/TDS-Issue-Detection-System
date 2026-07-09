import { createSlice } from '@reduxjs/toolkit'
import { readStoredSession } from '@/services/sessionStorage'

const storedSession = readStoredSession()

const initialState = {
  user:            storedSession?.user  ?? null,
  token:           storedSession?.token ?? null,
  isAuthenticated: storedSession !== null,
  isLoading:       false,
  error:           null,
  permissions:     storedSession?.user?.role ? [storedSession.user.role] : [],
}

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setAuthLoading(state, action) {
      state.isLoading = action.payload
      state.error     = null
    },
    setCredentials(state, action) {
      state.user            = action.payload.user
      state.token           = action.payload.token
      state.isAuthenticated = true
      state.isLoading       = false
      state.error           = null
      state.permissions     = [action.payload.user.role]
    },
    clearCredentials(state) {
      state.user            = null
      state.token           = null
      state.isAuthenticated = false
      state.isLoading       = false
      state.error           = null
      state.permissions     = []
    },
    setAuthError(state, action) {
      state.error     = action.payload
      state.isLoading = false
    },
    updateUser(state, action) {
      if (state.user) {
        state.user = { ...state.user, ...action.payload }
      }
    },
  },
})

export const { setAuthLoading, setCredentials, clearCredentials, setAuthError, updateUser } = authSlice.actions
export default authSlice.reducer
