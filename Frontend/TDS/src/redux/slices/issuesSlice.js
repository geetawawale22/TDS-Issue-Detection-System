import { createSlice } from '@reduxjs/toolkit'
import {
  deriveIssuesBySection,
  deriveTopVendors,
  deriveComplianceHealth,
  deriveDashboardKpis,
  deriveThresholdVendorsFromUpload,
  deriveThresholdSectionBreakdown,
  deriveGlCorrections,
  deriveMonthlyTrend,
  deriveThresholdConsumptionTrend,
} from '@/utils/liveAnalytics'
import { getFinancialYear } from '@/utils/utils'

const LAST_UPLOAD_STORAGE_KEY = 'tds_last_upload_results'

function readLastUpload() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LAST_UPLOAD_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.uploadedIssues)) return null
    return parsed
  } catch {
    return null
  }
}

function saveLastUpload(state) {
  if (typeof window === 'undefined') return
  const payload = {
    uploadedIssues: state.uploadedIssues,
    uploadMeta: state.uploadMeta,
  }
  window.localStorage.setItem(LAST_UPLOAD_STORAGE_KEY, JSON.stringify(payload))
}

function clearLastUpload() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(LAST_UPLOAD_STORAGE_KEY)
}

const lastUpload = readLastUpload()
const initialState = {
  searchQuery:     '',
  vendorFilter:    'all',
  sectionFilter:   'all',
  severityFilter:  'all',
  statusFilter:    'all',
  issueTypeFilter: 'all',
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
    openDrawer:       (state, action) => { state.selectedIssueId = action.payload; state.drawerOpen = true },
    closeDrawer:      (state)         => { state.drawerOpen      = false },
    resetFilters:     (state)         => {
      state.searchQuery = ''; state.vendorFilter = 'all'; state.sectionFilter = 'all';
      state.severityFilter = 'all'; state.statusFilter = 'all';
      state.issueTypeFilter = 'all';
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
  setStatusFilter, setIssueTypeFilter, openDrawer, closeDrawer, resetFilters,
  uploadStarted, uploadProgress, uploadSucceeded, uploadFailed, clearUpload,
} = issuesSlice.actions

export function selectIsLive(state) {
  return state.issues.dataSource === 'upload'
}

/**
 * Company + Financial Year scoping for real uploaded data (the Navbar's
 * Company/FY switchers — see appSlice.js). Not applied to sample/demo data:
 * mock issues carry synthetic dates that only ever fall in FY 2025-26/26-27
 * and have no company concept at all, so filtering them would just make
 * most FY choices show "0 issues" for a demo that isn't actually broken.
 *
 * A row with no `companyCode` (older cached uploads from before this field
 * existed, or a row SAP genuinely didn't tag) is never excluded by the
 * company filter — treating "unknown" as "doesn't match" would silently
 * hide data instead of just not being able to scope it.
 */
function scopeToCompanyAndFY(rows, state) {
  if (state.issues.dataSource !== 'upload') return rows
  const { selectedCompanyCode, financialYear } = state.app
  return rows.filter((row) => {
    if (selectedCompanyCode && row.companyCode && row.companyCode !== selectedCompanyCode) return false
    if (financialYear && row.date && getFinancialYear(row.date) !== financialYear) return false
    return true
  })
}

export function selectActiveIssues(state) {
  return scopeToCompanyAndFY(state.issues.uploadedIssues, state)
}

export function selectActiveValidationRows(state) {
  return scopeToCompanyAndFY(state.issues.uploadMeta?.validationRows || [], state)
}

export function selectActiveVendors(state) {
  return [...new Set(selectActiveIssues(state).map((i) => i.vendor).filter(Boolean))].sort()
}

export function selectActiveSections(state) {
  return [...new Set(selectActiveIssues(state).map((i) => i.section).filter(Boolean))].sort()
}

export function selectDashboardKpis(state) {
  const issues = selectActiveIssues(state)
  // The upload's transactionsBuilt total covers the WHOLE file — only a
  // valid denominator for compliance-style math when Company/FY scoping
  // hasn't narrowed the issue set down from that total.
  const stats = issues.length === state.issues.uploadedIssues.length
    ? state.issues.uploadMeta?.stats || null
    : null
  return deriveDashboardKpis(issues, stats)
}

export function selectIssuesBySection(state) {
  return deriveIssuesBySection(selectActiveIssues(state))
}

export function selectTopVendors(state) {
  return deriveTopVendors(selectActiveIssues(state))
}

export function selectComplianceHealth(state) {
  const issues = selectActiveIssues(state)
  const transactionsBuilt = issues.length === state.issues.uploadedIssues.length
    ? state.issues.uploadMeta?.stats?.transactionsBuilt
    : null
  return deriveComplianceHealth(issues, transactionsBuilt)
}

export function selectMonthlyTrend(state) {
  return deriveMonthlyTrend(selectActiveIssues(state))
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

export function selectGlCorrections(state) {
  return deriveGlCorrections(selectActiveIssues(state))
}

export default issuesSlice.reducer
