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
const CORRECTION_REGISTER_STORAGE_KEY = 'tds_correction_register'
const LAST_UPLOAD_SCHEMA_VERSION = 5


function correctionActor(user) {
  if (!user) return { name: 'Unknown user', email: '', role: '' }
  return {
    name: user.name || user.full_name || user.email || 'Unknown user',
    email: user.email || '',
    role: user.role || '',
  }
}

function nextCorrectionGroupId(existingGroups = []) {
  const max = existingGroups.reduce((highest, group) => {
    const match = String(group.groupId || '').match(/^CG-(\d+)$/i)
    return match ? Math.max(highest, Number(match[1])) : highest
  }, 0)
  return `CG-${String(max + 1).padStart(4, '0')}`
}


function readCorrectionGroups() {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CORRECTION_REGISTER_STORAGE_KEY) || 'null')
    return Array.isArray(parsed?.correctionGroups) ? parsed.correctionGroups : []
  } catch {
    return []
  }
}

function saveCorrectionGroups(correctionGroups = []) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CORRECTION_REGISTER_STORAGE_KEY, JSON.stringify({ correctionGroups }))
  } catch {
    // The correction register is convenience persistence until a backend table exists.
  }
}

function applyCorrectionRegisterToIssues(issues = [], correctionGroups = []) {
  const groupsByOriginalDoc = new Map()
  const groupsByCorrectionDoc = new Map()
  for (const group of correctionGroups) {
    const originalDocNo = String(group.originalDocumentNumber || '')
    if (originalDocNo) groupsByOriginalDoc.set(originalDocNo, group)
    for (const entry of group.entries || []) {
      const correctionDocNo = String(entry.correctionDocumentNumber || entry.docNo || '')
      if (correctionDocNo) groupsByCorrectionDoc.set(correctionDocNo, group)
    }
  }
  return issues.map((issue) => {
    const docNo = String(issue.docNo || '')
    const originalGroup = groupsByOriginalDoc.get(docNo)
    if (originalGroup) {
      return {
        ...issue,
        status: 'resolved',
        correctionGroupId: originalGroup.groupId,
        correctionMethod: originalGroup.method,
        correctionStatus: originalGroup.status,
      }
    }

    const correctionGroup = groupsByCorrectionDoc.get(docNo)
    if (!correctionGroup) return issue
    return {
      ...issue,
      status: 'resolved',
      correctionGroupId: correctionGroup.groupId,
      correctionMethod: correctionGroup.method,
      correctionStatus: correctionGroup.status,
      isMatchedSapCorrection: true,
    }
  })
}

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
    saveCorrectionGroups(state.correctionGroups || [])
  } catch {
    // LDC utilization is a small convenience cache; upload analysis remains the source of truth.
  }
  const payload = {
    schemaVersion: LAST_UPLOAD_SCHEMA_VERSION,
    uploadedIssues: state.uploadedIssues,
    uploadMeta: state.uploadMeta,
    correctionGroups: state.correctionGroups,
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
const storedCorrectionGroups = readCorrectionGroups()
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
  dashboardVendorNameFilter: 'all',
  dashboardSectionFilter:    'all',
  dashboardIssueTypeFilter:  'all',
  selectedIssueId: null,
  drawerOpen:      false,

  dataSource: lastUpload ? 'upload' : 'empty',
  uploadedIssues: applyCorrectionRegisterToIssues(lastUpload?.uploadedIssues || [], storedCorrectionGroups.length ? storedCorrectionGroups : lastUpload?.correctionGroups || []),
  uploadMeta: lastUpload?.uploadMeta || null,
  correctionGroups: storedCorrectionGroups.length ? storedCorrectionGroups : lastUpload?.correctionGroups || [],
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
    setDashboardVendorNameFilter: (state, action) => { state.dashboardVendorNameFilter = action.payload },
    setDashboardSectionFilter:    (state, action) => { state.dashboardSectionFilter    = action.payload },
    setDashboardIssueTypeFilter:  (state, action) => { state.dashboardIssueTypeFilter  = action.payload },
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
      state.dashboardVendorNameFilter = 'all'
      state.dashboardSectionFilter = 'all'
      state.dashboardIssueTypeFilter = 'all'
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
      state.uploadedIssues = applyCorrectionRegisterToIssues(payload.issues || [], state.correctionGroups || [])
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
      state.dashboardVendorNameFilter = 'all'
      state.dashboardSectionFilter = 'all'
      state.dashboardIssueTypeFilter = 'all'
      saveLastUpload(state)
    },
    createManualCorrection: (state, action) => {
      const {
        issueId,
        method,
        remarks,
        additionalAmount,
        reversalAmount,
        freshDeductionAmount,
        actor,
      } = action.payload || {}
      const issue = state.uploadedIssues.find((row) => row.id === issueId)
      if (!issue) return

      const groupId = nextCorrectionGroupId(state.correctionGroups)
      const originalDocNo = String(issue.docNo || 'UNKNOWN')
      const cleanDocNo = originalDocNo.replace(/[^a-z0-9-]/gi, '')
      const createdAt = new Date().toISOString()
      const createdBy = correctionActor(actor)
      const appliedTdsAmount = Math.abs(Number(issue.tdsAmount) || 0)
      const expectedTdsAmount = issue.expectedRate == null || issue.baseAmount == null
        ? Math.abs(Number(issue.tdsAmount) || 0) + Math.abs(Number(issue.taxImpact) || 0)
        : Number((Number(issue.baseAmount) * Number(issue.expectedRate) / 100).toFixed(2))
      const baseEntry = {
        originalDocumentNumber: originalDocNo,
        vendor: issue.vendor,
        vendorId: issue.vendorId,
        vendorPan: issue.vendorPan,
        section: issue.section,
        baseAmount: Number(issue.baseAmount) || 0,
        appliedRate: issue.appliedRate,
        appliedTdsAmount,
        expectedRate: issue.expectedRate,
        expectedTdsAmount,
        taxImpact: Math.abs(Number(issue.taxImpact) || expectedTdsAmount - appliedTdsAmount),
        postingDate: issue.postingDate || issue.date,
        createdAt,
      }

      const entries = method === 'FULL_REVERSAL'
        ? [
          {
            ...baseEntry,
            correctionDocumentNumber: `CORR-${cleanDocNo}-R`,
            role: 'REVERSAL',
            amount: -Math.abs(Number(reversalAmount) || appliedTdsAmount || 0),
            displayAmount: Math.abs(Number(reversalAmount) || appliedTdsAmount || 0),
          },
          {
            ...baseEntry,
            correctionDocumentNumber: `CORR-${cleanDocNo}-F`,
            role: 'FRESH_DEDUCTION',
            amount: Math.abs(Number(freshDeductionAmount) || expectedTdsAmount || 0),
            displayAmount: Math.abs(Number(freshDeductionAmount) || expectedTdsAmount || 0),
          },
        ]
        : [
          {
            ...baseEntry,
            correctionDocumentNumber: `CORR-${cleanDocNo}-01`,
            role: 'ADDITIONAL_DEDUCTION',
            amount: Math.abs(Number(additionalAmount) || 0),
            displayAmount: Math.abs(Number(additionalAmount) || 0),
          },
        ]

      state.correctionGroups.push({
        groupId,
        issueId,
        originalDocumentNumber: originalDocNo,
        method,
        appliedRate: issue.appliedRate,
        appliedTdsAmount,
        expectedRate: issue.expectedRate,
        expectedTdsAmount,
        taxImpact: Math.abs(Number(issue.taxImpact) || expectedTdsAmount - appliedTdsAmount),
        status: 'draft',
        createdBy,
        actionBy: createdBy,
        actionLabel: 'Created draft correction',
        remarks: String(remarks || '').trim(),
        createdAt,
        entries,
      })

      issue.status = 'resolved'
      issue.correctionGroupId = groupId
      issue.correctionMethod = method
      issue.correctionStatus = 'draft'
      saveCorrectionGroups(state.correctionGroups)
      saveLastUpload(state)
    },
    createMatchedSapCorrection: (state, action) => {
      const {
        issueId,
        method,
        remarks,
        rows,
        actor,
      } = action.payload || {}
      const issue = state.uploadedIssues.find((row) => row.id === issueId)
      if (!issue || !Array.isArray(rows) || rows.length === 0) return

      const groupId = nextCorrectionGroupId(state.correctionGroups)
      const originalDocNo = String(issue.docNo || 'UNKNOWN')
      const createdAt = new Date().toISOString()
      const matchedBy = correctionActor(actor)
      const entries = rows.map((row, index) => ({
        correctionDocumentNumber: String(row.docNo || row.documentNumber || `SAP-${index + 1}`),
        docNo: String(row.docNo || row.documentNumber || `SAP-${index + 1}`),
        role: row.matchRole || (method === 'FULL_REVERSAL' && index === 0 ? 'REVERSAL' : method === 'FULL_REVERSAL' ? 'FRESH_DEDUCTION' : 'ADDITIONAL_DEDUCTION'),
        amount: Number(row.tdsAmount ?? row.amount ?? 0),
        displayAmount: Math.abs(Number(row.tdsAmount ?? row.amount ?? 0)),
        originalDocumentNumber: originalDocNo,
        vendor: row.vendor || issue.vendor,
        vendorId: row.vendorId || issue.vendorId,
        vendorPan: row.vendorPan || issue.vendorPan,
        section: row.section || issue.section,
        baseAmount: Number(row.baseAmount ?? issue.baseAmount ?? 0),
        appliedRate: row.appliedRate ?? issue.appliedRate,
        appliedTdsAmount: Math.abs(Number(row.tdsAmount ?? 0)),
        expectedRate: issue.expectedRate,
        expectedTdsAmount: issue.expectedRate == null || issue.baseAmount == null
          ? Math.abs(Number(issue.tdsAmount) || 0) + Math.abs(Number(issue.taxImpact) || 0)
          : Number((Number(issue.baseAmount) * Number(issue.expectedRate) / 100).toFixed(2)),
        postingDate: row.postingDate || row.date || issue.postingDate || issue.date,
        docType: row.docType,
        source: 'SAP_MATCHED_ROW',
        createdAt,
      }))

      state.correctionGroups.push({
        groupId,
        issueId,
        originalDocumentNumber: originalDocNo,
        method,
        source: 'SAP_MATCHED_ROWS',
        status: 'matched_in_sap',
        createdBy: matchedBy,
        matchedBy,
        actionBy: matchedBy,
        actionLabel: 'Matched SAP rows',
        remarks: String(remarks || '').trim(),
        createdAt,
        entries,
      })

      issue.status = 'resolved'
      issue.correctionGroupId = groupId
      issue.correctionMethod = method
      issue.correctionStatus = 'matched_in_sap'
      saveCorrectionGroups(state.correctionGroups)
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
  setDashboardVendorNameFilter, setDashboardSectionFilter, setDashboardIssueTypeFilter,
  openDrawer, closeDrawer, resetFilters, resetDashboardFilters,
  uploadStarted, uploadProgress, uploadSucceeded, uploadFailed, clearUpload,
  createManualCorrection, createMatchedSapCorrection,
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
    || state.issues.dashboardVendorNameFilter !== 'all'
    || state.issues.dashboardSectionFilter !== 'all'
    || state.issues.dashboardIssueTypeFilter !== 'all'
  )
}

export function selectDashboardIssues(state) {
  const {
    dashboardDateFromFilter,
    dashboardDateToFilter,
    dashboardMonthFilter,
    dashboardVendorCodeFilter,
    dashboardVendorNameFilter,
    dashboardSectionFilter,
    dashboardIssueTypeFilter,
  } = state.issues

  return selectActiveIssues(state).filter((issue) => {
    const dateKey = issueDateKey(issue)
    if (dashboardDateFromFilter && (!dateKey || dateKey < dashboardDateFromFilter)) return false
    if (dashboardDateToFilter && (!dateKey || dateKey > dashboardDateToFilter)) return false
    if (dashboardMonthFilter && dateKey.slice(0, 7) !== dashboardMonthFilter) return false
    if (dashboardVendorCodeFilter !== 'all' && issue.vendorId !== dashboardVendorCodeFilter) return false
    if (dashboardVendorNameFilter !== 'all' && issue.vendor !== dashboardVendorNameFilter) return false
    if (dashboardSectionFilter !== 'all' && issue.section !== dashboardSectionFilter) return false
    if (dashboardIssueTypeFilter !== 'all') {
      const rowTypes = [issue.issueTypeLabel, issue.category, issue.issueType].filter(Boolean)
      if (!rowTypes.includes(dashboardIssueTypeFilter)) return false
    }
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

export function selectCorrectionGroups(state) {
  return state.issues.correctionGroups || []
}

export default issuesSlice.reducer
