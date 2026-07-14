import { createSlice } from '@reduxjs/toolkit'
import { readStoredSession } from '@/services/sessionStorage'

// Company code the user was last working in, kept in sessionStorage so a
// page refresh doesn't reset it mid-session. Only meaningful once we know
// which codes the logged-in user is actually allowed to see.
const COMPANY_CODE_KEY = 'tds_selected_company_code'

const storedSession = readStoredSession()
const initialCompanyCodes = storedSession?.user?.companyCodes ?? []
const storedCompanyCode = sessionStorage.getItem(COMPANY_CODE_KEY)
const initialSelectedCode = initialCompanyCodes.includes(storedCompanyCode)
  ? storedCompanyCode
  : initialCompanyCodes[0] ?? null

// Start collapsed on phone-sized viewports so the off-canvas sidebar
// (see AppLayout.css's <=768px rule) doesn't cover the page on first load.
const initialSidebarCollapsed = typeof window !== 'undefined' && window.innerWidth <= 768

const initialState = {
  sidebarCollapsed: initialSidebarCollapsed,
  syncStatus:       'synced',
  lastSyncTime:     '8 minutes ago',
  workspaceName:    'Meridian Holdings Pvt Ltd',
  financialYear:    'FY 2025-26',
  dataSource:       'GCP BigQuery — finance-prod',

  // Company codes the logged-in user has access to (admins: all of them),
  // and which one is currently selected for dashboard/issues/reports views.
  availableCompanyCodes: initialCompanyCodes,
  selectedCompanyCode:   initialSelectedCode,
}

const appSlice = createSlice({
  name: 'app',
  initialState,
  reducers: {
    toggleSidebar(state) {
      state.sidebarCollapsed = !state.sidebarCollapsed
    },
    setSidebarCollapsed(state, action) {
      state.sidebarCollapsed = action.payload
    },
    setSyncStatus(state, action) {
      state.syncStatus = action.payload
    },
    setLastSyncTime(state, action) {
      state.lastSyncTime = action.payload
    },
    setAvailableCompanyCodes(state, action) {
      state.availableCompanyCodes = action.payload
      if (!action.payload.includes(state.selectedCompanyCode)) {
        state.selectedCompanyCode = action.payload[0] ?? null
        if (state.selectedCompanyCode) {
          sessionStorage.setItem(COMPANY_CODE_KEY, state.selectedCompanyCode)
        }
      }
    },
    setSelectedCompanyCode(state, action) {
      state.selectedCompanyCode = action.payload
      sessionStorage.setItem(COMPANY_CODE_KEY, action.payload)
    },
    clearCompanyCodes(state) {
      state.availableCompanyCodes = []
      state.selectedCompanyCode = null
      sessionStorage.removeItem(COMPANY_CODE_KEY)
    },
  },
})

export const {
  toggleSidebar, setSidebarCollapsed, setSyncStatus, setLastSyncTime,
  setAvailableCompanyCodes, setSelectedCompanyCode, clearCompanyCodes,
} = appSlice.actions
export default appSlice.reducer
