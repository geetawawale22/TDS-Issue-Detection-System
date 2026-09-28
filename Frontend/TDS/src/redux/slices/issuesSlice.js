import { createSlice } from '@reduxjs/toolkit'
import {
  deriveIssuesByType,
  deriveIssuesBySection,
  deriveTopVendors,
  deriveComplianceHealth,
  deriveDashboardKpis,
  deriveThresholdVendorsFromUpload,
  deriveThresholdSectionBreakdown,
  deriveGlCorrections,
  deriveMonthlyTrend,
  deriveThresholdConsumptionTrend,
  deriveMonthlyComparison,
  deriveVendorMonthlyTrend,
} from '@/utils/liveAnalytics'
import { getFinancialYear } from '@/utils/utils'

const LAST_UPLOAD_STORAGE_KEY = 'tds_last_upload_results'
const LDC_UTILIZATION_STORAGE_KEY = 'tds_ldc_utilization_results'
const LAST_UPLOAD_SCHEMA_VERSION = 4

function readLastUpload() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LAST_UPLOAD_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.uploadedIssues)) return null
    if (parsed.schemaVersion !== LAST_UPLOAD_SCHEMA_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

function saveLastUpload(state) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LDC_UTILIZATION_STORAGE_KEY, JSON.stringify({
      ldcUtilization: state.uploadMeta?.ldcUtilization || [],
    }))
  } catch {
    // LDC utilization is a small convenience cache; upload analysis remains the source of truth.
  }
  const payload = {
    schemaVersion: LAST_UPLOAD_SCHEMA_VERSION,
    uploadedIssues: state.uploadedIssues,
    uploadMeta: state.uploadMeta,
  }
  try {
    window.localStorage.setItem(LAST_UPLOAD_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    window.localStorage.removeItem(LAST_UPLOAD_STORAGE_KEY)
  }
}

function clearLastUpload() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(LAST_UPLOAD_STORAGE_KEY)
  window.localStorage.removeItem(LDC_UTILIZATION_STORAGE_KEY)
}

function readLastLdcUtilization() {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LDC_UTILIZATION_STORAGE_KEY) || 'null')
    return Array.isArray(parsed?.ldcUtilization) ? parsed.ldcUtilization : []
  } catch {
    return []
  }
}

const lastUpload = readLastUpload()
const initialState = {
  searchQuery:     '',
  vendorFilter:    'all',
  sectionFilter:   'all',
  severityFilter:  'all',
  statusFilter:    'all',
  issueTypeFilter: 'all',
  dashboardDateFromFilter:   '',
  dashboardDateToFilter:     '',
  dashboardMonthFilter:      '',
  dashboardVendorCodeFilter: 'all',
  dashboardSectionFilter:    'all',
  selectedIssueId: null,
  drawerOpen:      false,

  dataSource: lastUpload ? 'upload' : 'empty',
  uploadedIssues: lastUpload?.uploadedIssues || [],
  uploadMeta: lastUpload?.uploadMeta || null,
  uploadStatus: 'idle',
  uploadProgress: 0,
  uploadError: null,
}

const issuesSlice = createSlice({
  name: 'issues',
  initialState,
  reducers: {
    setSearchQuery:    (state, action) => { state.searchQuery     = action.payload },
    setVendorFilter:   (state, action) => { state.vendorFilter    = action.payload },
    setSectionFilter:  (state, action) => { state.sectionFilter   = action.payload },
    setSeverityFilter: (state, action) => { state.severityFilter  = action.payload },
    setStatusFilter:   (state, action) => { state.statusFilter    = action.payload },
    setIssueTypeFilter:(state, action) => { state.issueTypeFilter = action.payload },
    setDashboardDateFromFilter:   (state, action) => { state.dashboardDateFromFilter   = action.payload },
    setDashboardDateToFilter:     (state, action) => { state.dashboardDateToFilter     = action.payload },
    setDashboardMonthFilter:      (state, action) => { state.dashboardMonthFilter      = action.payload },
    setDashboardVendorCodeFilter: (state, action) => { state.dashboardVendorCodeFilter = action.payload },
    setDashboardSectionFilter:    (state, action) => { state.dashboardSectionFilter    = action.payload },
    openDrawer:       (state, action) => { state.selectedIssueId = action.payload; state.drawerOpen = true },
    closeDrawer:      (state)         => { state.drawerOpen      = false },
    resetFilters:     (state)         => {
      state.searchQuery = ''; state.vendorFilter = 'all'; state.sectionFilter = 'all';
      state.severityFilter = 'all'; state.statusFilter = 'all';
      state.issueTypeFilter = 'all';
    },
    resetDashboardFilters: (state) => {
      state.dashboardDateFromFilter = ''
      state.dashboardDateToFilter = ''
      state.dashboardMonthFilter = ''
      state.dashboardVendorCodeFilter = 'all'
      state.dashboardSectionFilter = 'all'
    },

    uploadStarted: (state) => {
      state.uploadStatus = 'uploading'
      state.uploadProgress = 0
      state.uploadError = null
    },
    uploadProgress: (state, action) => {
      state.uploadProgress = action.payload
      if (action.payload >= 100) state.uploadStatus = 'processing'
    },
    uploadSucceeded: (state, action) => {
      const payload = action.payload
      state.dataSource = 'upload'
      state.uploadedIssues = payload.issues || []
      state.uploadMeta = {
        uploadId: payload.uploadId,
        fileName: payload.fileName,
        companyCode: payload.companyCode,
        stats: payload.stats,
        vendors: payload.vendors || [],
        sections: payload.sections || [],
        thresholdVendors: payload.thresholdVendors || [],
        ldcUtilization: payload.ldcUtilization || [],
        tdsCases: payload.tdsCases || [],
        caseStats: payload.caseStats || {},
        caseLedger: payload.caseLedger || [],
        validationRows: payload.validationRows || [],
        unrecognizedColumns: payload.unrecognizedColumns || [],
        errors: payload.errors || [],
      }
      state.uploadStatus = 'ready'
      state.uploadProgress = 100
      state.uploadError = null
      state.selectedIssueId = null
      state.drawerOpen = false
      state.searchQuery = ''
      state.vendorFilter = 'all'
      state.sectionFilter = 'all'
      state.severityFilter = 'all'
      state.statusFilter = 'all'
      state.issueTypeFilter = 'all'
      state.dashboardDateFromFilter = ''
      state.dashboardDateToFilter = ''
      state.dashboardMonthFilter = ''
      state.dashboardVendorCodeFilter = 'all'
      state.dashboardSectionFilter = 'all'
      saveLastUpload(state)
    },
    uploadFailed: (state, action) => {
      state.uploadStatus = 'error'
      state.uploadError = action.payload || 'Upload failed'
      state.uploadProgress = 0
    },
    clearUpload: (state) => {
      state.dataSource = 'empty'
      state.uploadedIssues = []
      state.uploadMeta = null
      state.uploadStatus = 'idle'
      state.uploadProgress = 0
      state.uploadError = null
      state.selectedIssueId = null
      state.drawerOpen = false
      clearLastUpload()
    },
  },
})

export const {
  setSearchQuery, setVendorFilter, setSectionFilter, setSeverityFilter,
  setStatusFilter, setIssueTypeFilter, setDashboardDateFromFilter,
  setDashboardDateToFilter, setDashboardMonthFilter, setDashboardVendorCodeFilter,
  setDashboardSectionFilter,
  openDrawer, closeDrawer, resetFilters, resetDashboardFilters,
  uploadStarted, uploadProgress, uploadSucceeded, uploadFailed, clearUpload,
} = issuesSlice.actions

export function selectIsLive(state) {
  return state.issues.dataSource === 'upload'
}

/**
 * Company scoping for real uploaded data (the Navbar's Company switcher —
 * see appSlice.js). The Issues upload table is not hidden by the Navbar FY
 * selection; SAP extracts can contain mixed posting dates while still being
 * analysed as one uploaded file.
 *
 * A row with no `companyCode` (older cached uploads from before this field
 * existed, or a row SAP genuinely didn't tag) is never excluded by the
 * company filter — treating "unknown" as "doesn't match" would silently
 * hide data instead of just not being able to scope it.
 */
function scopeToCompany(rows, state) {
  if (state.issues.dataSource !== 'upload') return rows
  const { selectedCompanyCode } = state.app
  return rows.filter((row) => {
    if (selectedCompanyCode && row.companyCode && row.companyCode !== selectedCompanyCode) return false
    return true
  })
}

function scopeToCompanyAndFY(rows, state) {
  if (state.issues.dataSource !== 'upload') return rows
  const { financialYear } = state.app
  return scopeToCompany(rows, state).filter((row) => {
    if (financialYear && row.date && getFinancialYear(row.date) !== financialYear) return false
    return true
  })
}

export function selectActiveIssues(state) {
  return scopeToCompany(state.issues.uploadedIssues, state)
}

export function selectActiveValidationRows(state) {
  return scopeToCompany(state.issues.uploadMeta?.validationRows || [], state)
}

export function selectActiveVendors(state) {
  return [...new Set(selectActiveIssues(state).map((i) => i.vendor).filter(Boolean))].sort()
}

export function selectActiveSections(state) {
  return [...new Set(selectActiveIssues(state).map((i) => i.section).filter(Boolean))].sort()
}

export function selectActiveVendorCodes(state) {
  return [...new Set(selectActiveIssues(state).map((i) => i.vendorId).filter(Boolean))].sort()
}

export function selectActiveVendorCodeOptions(state) {
  const byCode = new Map()
  for (const issue of selectActiveIssues(state)) {
    if (!issue.vendorId) continue
    if (!byCode.has(issue.vendorId)) byCode.set(issue.vendorId, new Set())
    if (issue.vendor) byCode.get(issue.vendorId).add(issue.vendor)
  }

  return [...byCode.entries()]
    .map(([vendorCode, supplierNames]) => {
      const names = [...supplierNames].filter(Boolean).sort()
      const supplierName = names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] || ''
      return { vendorCode, supplierName }
    })
    .sort((a, b) => a.vendorCode.localeCompare(b.vendorCode))
}

function issueDateKey(issue) {
  if (!issue?.date) return ''
  const d = new Date(issue.date)
  if (Number.isNaN(d.getTime())) return String(issue.date).slice(0, 10)
  return d.toISOString().slice(0, 10)
}

function hasDashboardFilters(state) {
  return Boolean(
    state.issues.dashboardDateFromFilter
    || state.issues.dashboardDateToFilter
    || state.issues.dashboardMonthFilter
    || state.issues.dashboardVendorCodeFilter !== 'all'
    || state.issues.dashboardSectionFilter !== 'all'
  )
}

export function selectDashboardIssues(state) {
  const {
    dashboardDateFromFilter,
    dashboardDateToFilter,
    dashboardMonthFilter,
    dashboardVendorCodeFilter,
    dashboardSectionFilter,
  } = state.issues

  return selectActiveIssues(state).filter((issue) => {
    const dateKey = issueDateKey(issue)
    if (dashboardDateFromFilter && (!dateKey || dateKey < dashboardDateFromFilter)) return false
    if (dashboardDateToFilter && (!dateKey || dateKey > dashboardDateToFilter)) return false
    if (dashboardMonthFilter && dateKey.slice(0, 7) !== dashboardMonthFilter) return false
    if (dashboardVendorCodeFilter !== 'all' && issue.vendorId !== dashboardVendorCodeFilter) return false
    if (dashboardSectionFilter !== 'all' && issue.section !== dashboardSectionFilter) return false
    return true
  })
}

export function selectDashboardKpis(state) {
  const issues = selectDashboardIssues(state)
  // The upload's transactionsBuilt total covers the WHOLE file — only a
  // valid denominator for compliance-style math when Company/FY scoping
  // or dashboard filters haven't narrowed the issue set down from that total.
  const stats = !hasDashboardFilters(state) && issues.length === state.issues.uploadedIssues.length
    ? state.issues.uploadMeta?.stats || null
    : null
  return deriveDashboardKpis(issues, stats)
}

export function selectIssuesBySection(state) {
  return deriveIssuesBySection(selectDashboardIssues(state))
}

export function selectIssuesByType(state) {
  return deriveIssuesByType(selectDashboardIssues(state))
}

export function selectTopVendors(state) {
  return deriveTopVendors(selectDashboardIssues(state))
}

export function selectComplianceHealth(state) {
  const issues = selectDashboardIssues(state)
  const transactionsBuilt = !hasDashboardFilters(state) && issues.length === state.issues.uploadedIssues.length
    ? state.issues.uploadMeta?.stats?.transactionsBuilt
    : null
  return deriveComplianceHealth(issues, transactionsBuilt)
}

export function selectMonthlyTrend(state) {
  return deriveMonthlyTrend(selectDashboardIssues(state))
}

export function selectMonthlyComparison(state) {
  return deriveMonthlyComparison(selectDashboardIssues(state))
}

export function selectVendorMonthlyTrend(state) {
  return deriveVendorMonthlyTrend(selectDashboardIssues(state))
}

export function selectThresholdVendors(state) {
  const thresholdVendors = scopeToCompanyAndFY(state.issues.uploadMeta?.thresholdVendors || [], state)
  return deriveThresholdVendorsFromUpload(thresholdVendors, selectActiveIssues(state))
}

export function selectThresholdSectionBreakdown(state) {
  return deriveThresholdSectionBreakdown(selectThresholdVendors(state))
}

export function selectThresholdConsumptionTrend(state) {
  return deriveThresholdConsumptionTrend(selectActiveIssues(state))
}

export function selectLdcUtilization(state) {
  return scopeToCompanyAndFY(state.issues.uploadMeta?.ldcUtilization || readLastLdcUtilization(), state)
}

export function selectGlCorrections(state) {
  return deriveGlCorrections(selectActiveIssues(state))
}

export default issuesSlice.reducer
