import { configureStore } from '@reduxjs/toolkit'
import authReducer from './slices/authSlice'
import appReducer, { setDataSourceLabel, setFinancialYear, setLastSyncTime, setSyncStatus } from './slices/appSlice'
import issuesReducer, { readCachedLastUpload, restoreLastUpload } from './slices/issuesSlice'
import dashboardReducer from './slices/dashboardSlice'
import panReducer from './slices/panSlice'
import { dominantFinancialYear } from '@/utils/utils'

export const store = configureStore({
  reducer: {
    auth: authReducer,
    app: appReducer,
    issues: issuesReducer,
    dashboard: dashboardReducer,
    pan: panReducer,
  },
})

// Uploads too large for localStorage are kept in IndexedDB, which can only be
// read asynchronously, so bring the last one back once the store exists.
if (typeof window !== 'undefined' && !store.getState().issues.uploadMeta) {
  readCachedLastUpload().then((cached) => {
    if (!cached || store.getState().issues.uploadMeta) return
    store.dispatch(restoreLastUpload(cached))
    store.dispatch(setDataSourceLabel(cached.uploadMeta?.fileName ? `SAP upload - ${cached.uploadMeta.fileName}` : 'SAP upload'))
    store.dispatch(setLastSyncTime('Last upload'))
    store.dispatch(setSyncStatus('synced'))
    // Same as a small saved upload: with no FY picked this session, follow
    // the upload's FY so its rows aren't hidden.
    if (!sessionStorage.getItem('tds_selected_financial_year')) {
      const financialYear = dominantFinancialYear(cached.uploadMeta?.validationRows || [])
      if (financialYear) store.dispatch(setFinancialYear(financialYear))
    }
  })
}
