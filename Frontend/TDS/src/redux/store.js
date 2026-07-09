import { configureStore } from '@reduxjs/toolkit'
import authReducer from './slices/authSlice'
import appReducer from './slices/appSlice'
import issuesReducer from './slices/issuesSlice'
import dashboardReducer from './slices/dashboardSlice'

export const store = configureStore({
  reducer: {
    auth: authReducer,
    app: appReducer,
    issues: issuesReducer,
    dashboard: dashboardReducer,
  },
})
