import { createSlice } from '@reduxjs/toolkit'
import { readStoredSession } from '@/services/sessionStorage'

// Company code the user was last working in, kept in sessionStorage so a
// page refresh doesn't reset it mid-session. Only meaningful once we know
// which codes the logged-in user is actually allowed to see.
const COMPANY_CODE_KEY = 'tds_selected_company_code'
// Sentinel for "don't scope to one company" — matches the blank-value
// convention SapUploadPanel already used for its own "All company codes"
// option. Always a valid selection regardless of availableCompanyCodes.
export const ALL_COMPANIES = ''
const FINANCIAL_YEAR_KEY = 'tds_selected_financial_year'
const LAST_UPLOAD_STORAGE_KEY = 'tds_last_upload_results'

// Indian FY runs April–March. 2025-26 is "current"; a couple of years each
// side covers reviewing prior filings or preparing for the next one.
export const FINANCIAL_YEAR_OPTIONS = ['FY 2023-24', 'FY 2024-25', 'FY 2025-26', 'FY 2026-27']

function readLastUploadMeta() {
  if (typeof window === 'undefined') return null
  try {
    return JSON.parse(window.localStorage.getItem(LAST_UPLOAD_STORAGE_KEY) || 'null')?.uploadMeta || null
  } catch {
    return null
  }
}
const lastUploadMeta = readLastUploadMeta()
const storedSession = readStoredSession()
const initialCompanyCodes = storedSession?.user?.companyCodes ?? []
const storedCompanyCode = sessionStorage.getItem(COMPANY_CODE_KEY)
const initialSelectedCode =
  storedCompanyCode === ALL_COMPANIES || initialCompanyCodes.includes(storedCompanyCode)
    ? storedCompanyCode
    : initialCompanyCodes[0] ?? null

const storedFinancialYear = typeof window !== 'undefined' ? sessionStorage.getItem(FINANCIAL_YEAR_KEY) : null
const initialFinancialYear = FINANCIAL_YEAR_OPTIONS.includes(storedFinancialYear)
  ? storedFinancialYear
  : 'FY 2025-26'

// Start collapsed on phone-sized viewports so the off-canvas sidebar
// (see AppLayout.css's <=768px rule) doesn't cover the page on first load.
const initialSidebarCollapsed = typeof window !== 'undefined' && window.innerWidth <= 768

const initialState = {
  sidebarCollapsed: initialSidebarCollapsed,
  syncStatus:       lastUploadMeta ? 'synced' : 'idle',
  lastSyncTime:     lastUploadMeta ? 'Last upload' : 'Not synced',
  workspaceName:    'Meridian Holdings Pvt Ltd',
  financialYear:    initialFinancialYear,
  dataSource:       lastUploadMeta?.fileName ? `SAP upload - ${lastUploadMeta.fileName}` : 'No SAP upload loaded',

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
    setDataSourceLabel(state, action) {
      state.dataSource = action.payload
    },
    setAvailableCompanyCodes(state, action) {
      state.availableCompanyCodes = action.payload
      if (state.selectedCompanyCode !== ALL_COMPANIES && !action.payload.includes(state.selectedCompanyCode)) {
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
    setFinancialYear(state, action) {
      state.financialYear = action.payload
      sessionStorage.setItem(FINANCIAL_YEAR_KEY, action.payload)
    },
    clearCompanyCodes(state) {
      state.availableCompanyCodes = []
      state.selectedCompanyCode = null
      sessionStorage.removeItem(COMPANY_CODE_KEY)
    },
  },
})

export const {
  toggleSidebar, setSidebarCollapsed, setSyncStatus, setLastSyncTime, setDataSourceLabel,
  setAvailableCompanyCodes, setSelectedCompanyCode, clearCompanyCodes, setFinancialYear,
} = appSlice.actions
export default appSlice.reducer

