import { configureStore } from '@reduxjs/toolkit'
import authReducer from './slices/authSlice'
import appReducer from './slices/appSlice'
import issuesReducer from './slices/issuesSlice'
import dashboardReducer from './slices/dashboardSlice'
import panReducer from './slices/panSlice'

export const store = configureStore({
  reducer: {
    auth: authReducer,
    app: appReducer,
    issues: issuesReducer,
    dashboard: dashboardReducer,
    pan: panReducer,
  },
})
