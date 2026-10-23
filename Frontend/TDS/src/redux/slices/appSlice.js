import { createSlice } from '@reduxjs/toolkit'
import { readStoredSession } from '@/services/sessionStorage'
import { dominantFinancialYear } from '@/utils/utils'

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

// Indian FY runs April–March. Keep two prior years and the next year available.
const today = new Date()
const currentFinancialYearStart = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1
const financialYearLabel = (year) => `FY ${year}-${String(year + 1).slice(-2)}`
export const FINANCIAL_YEAR_OPTIONS = Array.from({ length: 4 }, (_, index) =>
  financialYearLabel(currentFinancialYearStart - 2 + index),
)

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
// Any "FY 2026-27" style value is accepted, since an upload can switch to an
// FY outside FINANCIAL_YEAR_OPTIONS. With nothing chosen this session, follow
// the saved upload's FY so its rows aren't hidden.
const initialFinancialYear = /^FY \d{4}-\d{2}$/.test(storedFinancialYear || '')
  ? storedFinancialYear
  : dominantFinancialYear(lastUploadMeta?.validationRows || []) || financialYearLabel(currentFinancialYearStart)

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

