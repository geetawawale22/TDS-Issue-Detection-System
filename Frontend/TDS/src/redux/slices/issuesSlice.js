import { createSlice } from '@reduxjs/toolkit'
import {
  issues as mockIssues,
  sections as mockSections,
  vendorNames as mockVendors,
  glCorrections as mockGlCorrections,
  issuesBySection as mockIssuesBySection,
  topVendorsWithIssues as mockTopVendors,
  complianceHealth as mockComplianceHealth,
  monthlyTrend as mockMonthlyTrend,
  vendors as mockThresholdVendors,
  thresholdSectionBreakdown as mockThresholdBreakdown,
  thresholdConsumptionTrend as mockThresholdTrend,
} from '@/data/mockData'
import {
  deriveIssuesBySection,
  deriveTopVendors,
  deriveComplianceHealth,
  deriveDashboardKpis,
  deriveThresholdVendors,
  deriveThresholdSectionBreakdown,
  deriveGlCorrections,
  deriveMonthlyTrend,
  deriveThresholdConsumptionTrend,
} from '@/utils/liveAnalytics'

const initialState = {
  searchQuery:     '',
  vendorFilter:    'all',
  sectionFilter:   'all',
  severityFilter:  'all',
  statusFilter:    'all',
  issueTypeFilter: 'all',
  selectedIssueId: null,
  drawerOpen:      false,

  dataSource: 'sample',
  uploadedIssues: [],
  uploadMeta: null,
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
    },
    uploadFailed: (state, action) => {
      state.uploadStatus = 'error'
      state.uploadError = action.payload || 'Upload failed'
      state.uploadProgress = 0
    },
    clearUpload: (state) => {
      state.dataSource = 'sample'
      state.uploadedIssues = []
      state.uploadMeta = null
      state.uploadStatus = 'idle'
      state.uploadProgress = 0
      state.uploadError = null
      state.selectedIssueId = null
      state.drawerOpen = false
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

export function selectActiveIssues(state) {
  return state.issues.dataSource === 'upload'
    ? state.issues.uploadedIssues
    : mockIssues
}

export function selectActiveVendors(state) {
  if (state.issues.dataSource === 'upload' && state.issues.uploadMeta?.vendors?.length) {
    return state.issues.uploadMeta.vendors
  }
  return mockVendors
}

export function selectActiveSections(state) {
  if (state.issues.dataSource === 'upload' && state.issues.uploadMeta?.sections?.length) {
    return state.issues.uploadMeta.sections
  }
  return mockSections
}

export function selectDashboardKpis(state) {
  const issues = selectActiveIssues(state)
  const stats = state.issues.dataSource === 'upload' ? state.issues.uploadMeta?.stats : null
  return deriveDashboardKpis(issues, stats)
}

export function selectIssuesBySection(state) {
  if (state.issues.dataSource !== 'upload') return mockIssuesBySection
  return deriveIssuesBySection(state.issues.uploadedIssues)
}

export function selectTopVendors(state) {
  if (state.issues.dataSource !== 'upload') return mockTopVendors
  return deriveTopVendors(state.issues.uploadedIssues)
}

export function selectComplianceHealth(state) {
  if (state.issues.dataSource !== 'upload') return mockComplianceHealth
  return deriveComplianceHealth(
    state.issues.uploadedIssues,
    state.issues.uploadMeta?.stats?.transactionsBuilt,
  )
}

export function selectMonthlyTrend(state) {
  if (state.issues.dataSource !== 'upload') return mockMonthlyTrend
  return deriveMonthlyTrend(state.issues.uploadedIssues)
}

export function selectThresholdVendors(state) {
  if (state.issues.dataSource !== 'upload') return mockThresholdVendors
  return deriveThresholdVendors(state.issues.uploadedIssues)
}

export function selectThresholdSectionBreakdown(state) {
  if (state.issues.dataSource !== 'upload') return mockThresholdBreakdown
  return deriveThresholdSectionBreakdown(deriveThresholdVendors(state.issues.uploadedIssues))
}

export function selectThresholdConsumptionTrend(state) {
  if (state.issues.dataSource !== 'upload') return mockThresholdTrend
  return deriveThresholdConsumptionTrend(state.issues.uploadedIssues)
}

export function selectGlCorrections(state) {
  if (state.issues.dataSource !== 'upload') return mockGlCorrections
  return deriveGlCorrections(state.issues.uploadedIssues)
}

export default issuesSlice.reducer
