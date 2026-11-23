import { createSlice, current, isDraft } from '@reduxjs/toolkit'
import { clearCachedUpload, readCachedUpload, writeCachedUpload } from '@/utils/uploadCache'
import {
  deriveIssuesByType,
  deriveIssuesBySection,
  deriveTopVendors,
  deriveComplianceHealth,
  deriveDashboardKpis,
  deriveThresholdVendorsFromUpload,
  deriveThresholdSectionBreakdown,
  deriveMonthlyTrend,
  deriveSectionMonthlyTrend,
  deriveThresholdConsumptionTrend,
  deriveMonthlyComparison,
  deriveVendorMonthlyTrend,
} from '@/utils/liveAnalytics'
import { getFinancialYear } from '@/utils/utils'
import {
  findCorrectionForIssue,
  groupMatchesIssue,
  groupOriginalLine,
  indexCorrectionGroups,
  isActiveCorrection,
  sameDocumentLine,
} from '@/utils/correctionMatching'

const LAST_UPLOAD_STORAGE_KEY = 'tds_last_upload_results'
const LDC_UTILIZATION_STORAGE_KEY = 'tds_ldc_utilization_results'
// Old browser-only correction register; imported into the backend once, then removed.
const CORRECTION_REGISTER_STORAGE_KEY = 'tds_correction_register_v2'
const LEGACY_CORRECTION_REGISTER_KEYS = ['tds_correction_register']
const LAST_UPLOAD_SCHEMA_VERSION = 6
// localStorage holds ~5 MB per origin and an upload row serialises to 1–2 KB,
// so anything past this many rows can never be saved. Skipping the attempt
// avoids stringifying tens of MB on every upload and correction.
const LAST_UPLOAD_MAX_ROWS = 10000


// The old UI kept the correction register in this browser. It now lives in
// the backend; whatever is still here is imported once (see
// CorrectionRegisterLoader) and then removed.
export function readLegacyCorrectionGroups() {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CORRECTION_REGISTER_STORAGE_KEY) || 'null')
    return Array.isArray(parsed?.correctionGroups) ? parsed.correctionGroups : []
  } catch {
    return []
  }
}

export function clearLegacyCorrectionGroups() {
  if (typeof window === 'undefined') return
  try {
    ;[CORRECTION_REGISTER_STORAGE_KEY, ...LEGACY_CORRECTION_REGISTER_KEYS].forEach((key) => window.localStorage.removeItem(key))
  } catch {
    // Storage blocked: nothing to clear.
  }
}

// Drop correction flags the register no longer backs. A manual (MANUAL)
// resolution exists only because of a correction group, so without an active
// group the issue is open again; any other saved resolution still stands.
function stripCorrection(issue) {
  if (!issue.correctionGroupId) return issue
  const {
    correctionGroupId, correctionMethod, correctionStatus, isMatchedSapCorrection, ...rest
  } = issue
  const keptResolution = rest.resolutionType && rest.resolutionType !== 'MANUAL'
  return { ...rest, status: keptResolution ? 'resolved' : 'open' }
}

function applyCorrectionRegisterToIssues(issues = [], correctionGroups = []) {
  const index = indexCorrectionGroups(correctionGroups.filter(isActiveCorrection))
  return issues.map((cachedIssue) => {
    const issue = stripCorrection(cachedIssue)
    const match = findCorrectionForIssue(index, issue)
    if (!match) return issue
    return {
      ...issue,
      status: 'resolved',
      correctionGroupId: match.group.groupId,
      correctionMethod: match.group.method,
      correctionStatus: match.group.status,
      ...(match.isCorrectionRow ? { isMatchedSapCorrection: true } : {}),
    }
  })
}

// After a group is undone or rejected, reopen what its manual resolution
// closed in the upload on screen (issues and their SAP rows).
function reopenForCorrection(state, group) {
  state.uploadedIssues = state.uploadedIssues.map((issue) => (
    issue.status === 'resolved' && issue.resolutionType === 'MANUAL' && groupMatchesIssue(group, issue)
      ? { ...issue, status: 'open', resolutionType: null, resolutionNote: null }
      : issue
  ))
  const rows = state.uploadMeta?.validationRows
  if (!rows) return
  const original = groupOriginalLine(group)
  state.uploadMeta.validationRows = rows.map((row) => (
    row.status === 'corrected' && row.resolutionType === 'MANUAL' && sameDocumentLine(original, row)
      ? { ...row, status: 'issue', reason: row.originalReason || row.reason, resolutionType: null, correctionDocs: null }
      : row
  ))
}

function upsertCorrectionGroup(groups = [], group) {
  const others = groups.filter((existing) => existing.id !== group.id)
  return [group, ...others]
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
  } catch {
    // LDC utilization is a small convenience cache; upload analysis remains the source of truth.
  }
  // Reducers pass an Immer draft, which is revoked once the reducer returns;
  // snapshot it so the async IndexedDB write below still has the data.
  const snapshot = isDraft(state) ? current(state) : state
  const payload = {
    schemaVersion: LAST_UPLOAD_SCHEMA_VERSION,
    uploadedIssues: snapshot.uploadedIssues,
    uploadMeta: snapshot.uploadMeta,
  }
  const rowCount = (payload.uploadedIssues?.length || 0)
    + (payload.uploadMeta?.validationRows?.length || 0)
    + (payload.uploadMeta?.caseLedger?.length || 0)
  if (rowCount <= LAST_UPLOAD_MAX_ROWS) {
    try {
      window.localStorage.setItem(LAST_UPLOAD_STORAGE_KEY, JSON.stringify(payload))
      clearCachedUpload()
      return
    } catch {
      // Over the localStorage quota after all; fall through to IndexedDB.
    }
  }
  // Too large for localStorage: keep it in IndexedDB so a reload or the
  // session-expired redirect doesn't blank the page.
  window.localStorage.removeItem(LAST_UPLOAD_STORAGE_KEY)
  writeCachedUpload(payload)
}

function clearLastUpload() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(LAST_UPLOAD_STORAGE_KEY)
  window.localStorage.removeItem(LDC_UTILIZATION_STORAGE_KEY)
  clearCachedUpload()
}

/** Large uploads live in IndexedDB; read them back once the app has started. */
export async function readCachedLastUpload() {
  const cached = await readCachedUpload()
  if (!cached || !Array.isArray(cached.uploadedIssues)) return null
  if (cached.schemaVersion !== LAST_UPLOAD_SCHEMA_VERSION) return null
  return cached
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
  profitCenterFilter: 'all',
  issueDateFromFilter: '',
  issueDateToFilter:   '',
  dashboardDateFromFilter:   '',
  dashboardDateToFilter:     '',
  dashboardMonthFilter:      '',
  dashboardVendorCodeFilter: 'all',
  dashboardVendorNameFilter: 'all',
  dashboardSectionFilter:    'all',
  dashboardIssueTypeFilter:  'all',
  dashboardTdsDeductionFilter: 'all',
  // Every saved issue across runs (tracked_issues), for the Dashboard. null
  // until loaded; the Dashboard then falls back to the latest upload's issues.
  trackedIssues: null,
  selectedIssueId: null,
  drawerOpen:      false,

  dataSource: lastUpload ? 'upload' : 'empty',
  // Correction flags are re-applied once the register loads from the backend.
  uploadedIssues: lastUpload?.uploadedIssues || [],
  uploadMeta: lastUpload?.uploadMeta || null,
  correctionGroups: [],
  correctionGroupsLoaded: false,
  uploadStatus: 'idle',
  uploadProgress: 0,
  uploadError: null,
}

const issuesSlice = createSlice({
  name: 'issues',
  initialState,
  reducers: {
    setTrackedIssues: (state, action) => { state.trackedIssues = action.payload },
    setSearchQuery:    (state, action) => { state.searchQuery     = action.payload },
    setVendorFilter:   (state, action) => { state.vendorFilter    = action.payload },
    setSectionFilter:  (state, action) => { state.sectionFilter   = action.payload },
    setSeverityFilter: (state, action) => { state.severityFilter  = action.payload },
    setStatusFilter:   (state, action) => { state.statusFilter    = action.payload },
    setIssueTypeFilter:(state, action) => { state.issueTypeFilter = action.payload },
    setProfitCenterFilter: (state, action) => { state.profitCenterFilter = action.payload },
    setIssueDateRange: (state, action) => {
      state.issueDateFromFilter = action.payload.from
      state.issueDateToFilter = action.payload.to
    },
    setDashboardDateFromFilter:   (state, action) => { state.dashboardDateFromFilter   = action.payload },
    setDashboardDateToFilter:     (state, action) => { state.dashboardDateToFilter     = action.payload },
    setDashboardMonthFilter:      (state, action) => { state.dashboardMonthFilter      = action.payload },
    setDashboardVendorCodeFilter: (state, action) => { state.dashboardVendorCodeFilter = action.payload },
    setDashboardVendorNameFilter: (state, action) => { state.dashboardVendorNameFilter = action.payload },
    setDashboardSectionFilter:    (state, action) => { state.dashboardSectionFilter    = action.payload },
    setDashboardIssueTypeFilter:  (state, action) => { state.dashboardIssueTypeFilter  = action.payload },
    setDashboardTdsDeductionFilter: (state, action) => { state.dashboardTdsDeductionFilter = action.payload },
    openDrawer:       (state, action) => { state.selectedIssueId = action.payload; state.drawerOpen = true },
    closeDrawer:      (state)         => { state.drawerOpen      = false },
    resetFilters:     (state)         => {
      state.searchQuery = ''; state.vendorFilter = 'all'; state.sectionFilter = 'all';
      state.severityFilter = 'all'; state.statusFilter = 'all';
      state.issueTypeFilter = 'all';
      state.issueDateFromFilter = ''; state.issueDateToFilter = '';
      state.profitCenterFilter = 'all';
    },
    resetDashboardFilters: (state) => {
      state.dashboardDateFromFilter = ''
      state.dashboardDateToFilter = ''
      state.dashboardMonthFilter = ''
      state.dashboardVendorCodeFilter = 'all'
      state.dashboardVendorNameFilter = 'all'
      state.dashboardSectionFilter = 'all'
      state.dashboardIssueTypeFilter = 'all'
      state.dashboardTdsDeductionFilter = 'all'
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
      // The API sends the issue message once as `description`; the UI also reads it as `plainEnglish`.
      const issues = (payload.issues || []).map((issue) => (
        issue.plainEnglish === undefined ? { ...issue, plainEnglish: issue.description } : issue
      ))
      state.uploadedIssues = applyCorrectionRegisterToIssues(issues, state.correctionGroups || [])
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
        // Comparison with earlier runs (new / resolved since last run), see tracked_issues.
        tracking: payload.tracking || null,
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
      state.issueDateFromFilter = ''
      state.issueDateToFilter = ''
      state.profitCenterFilter = 'all'
      state.dashboardDateFromFilter = ''
      state.dashboardDateToFilter = ''
      state.dashboardMonthFilter = ''
      state.dashboardVendorCodeFilter = 'all'
      state.dashboardVendorNameFilter = 'all'
      state.dashboardSectionFilter = 'all'
      state.dashboardIssueTypeFilter = 'all'
      state.dashboardTdsDeductionFilter = 'all'
      saveLastUpload(state)
    },
    // Register loaded from the backend: re-apply it to the upload on screen.
    setCorrectionGroups: (state, action) => {
      state.correctionGroups = action.payload || []
      state.correctionGroupsLoaded = true
      state.uploadedIssues = applyCorrectionRegisterToIssues(state.uploadedIssues, state.correctionGroups)
    },
    // A group was saved, undone, approved or rejected (server response).
    correctionGroupUpdated: (state, action) => {
      const group = action.payload
      if (!group?.id) return
      state.correctionGroups = upsertCorrectionGroup(state.correctionGroups, group)
      if (!isActiveCorrection(group)) reopenForCorrection(state, group)
      state.uploadedIssues = applyCorrectionRegisterToIssues(state.uploadedIssues, state.correctionGroups)
    },
    uploadFailed: (state, action) => {
      state.uploadStatus = 'error'
      state.uploadError = action.payload || 'Upload failed'
      state.uploadProgress = 0
    },
    // Upload read back from IndexedDB after start-up. Ignored if a new upload
    // already landed while the cache was being read.
    restoreLastUpload: (state, action) => {
      if (state.uploadMeta) return
      const cached = action.payload
      state.dataSource = 'upload'
      state.uploadMeta = cached.uploadMeta
      // Until the register has loaded, keep the cached flags; setCorrectionGroups re-applies them.
      state.uploadedIssues = state.correctionGroupsLoaded
        ? applyCorrectionRegisterToIssues(cached.uploadedIssues || [], state.correctionGroups)
        : cached.uploadedIssues || []
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
  setTrackedIssues,
  setSearchQuery, setVendorFilter, setSectionFilter, setSeverityFilter,
  setStatusFilter, setIssueTypeFilter, setIssueDateRange, setProfitCenterFilter, setDashboardDateFromFilter,
  setDashboardDateToFilter, setDashboardMonthFilter, setDashboardVendorCodeFilter,
  setDashboardVendorNameFilter, setDashboardSectionFilter, setDashboardIssueTypeFilter,
  setDashboardTdsDeductionFilter,
  openDrawer, closeDrawer, resetFilters, resetDashboardFilters,
  uploadStarted, uploadProgress, uploadSucceeded, uploadFailed, restoreLastUpload, clearUpload,
  setCorrectionGroups, correctionGroupUpdated,
} = issuesSlice.actions

export function selectIsLive(state) {
  return state.issues.dataSource === 'upload'
}

/** Scope uploaded rows to the global company. */
function scopeToCompany(rows, state) {
  if (state.issues.dataSource !== 'upload') return rows
  const { selectedCompanyCode } = state.app
  return selectedCompanyCode
    ? rows.filter((row) => row.companyCode === selectedCompanyCode)
    : rows
}

/** Scope rows to the company and Indian financial year picked in the app header. */
function scopeRowsToCompanyAndFY(rows, state) {
  const { selectedCompanyCode, financialYear } = state.app
  const companyRows = selectedCompanyCode
    ? rows.filter((row) => row.companyCode === selectedCompanyCode)
    : rows
  return companyRows.filter((row) => {
    if (!financialYear) return true
    const rowDate = row.date || row.postingDate
    if (!rowDate && !row.financialYear) return true
    const rowFinancialYear = rowDate
      ? getFinancialYear(rowDate)
      : row.financialYear
        ? String(row.financialYear).startsWith('FY ') ? String(row.financialYear) : `FY ${row.financialYear}`
        : null
    return rowFinancialYear === financialYear
  })
}

/** Upload rows are scoped only once a file is loaded (sample data is not). */
function scopeToCompanyAndFY(rows, state) {
  if (state.issues.dataSource !== 'upload') return rows
  return scopeRowsToCompanyAndFY(rows, state)
}

/** Upload issues in the header's financial year, every company (Reports filters companies itself). */
export function selectFyScopedIssues(state) {
  const rows = state.issues.uploadedIssues
  if (state.issues.dataSource !== 'upload') return rows
  return scopeRowsToCompanyAndFY(rows, { ...state, app: { ...state.app, selectedCompanyCode: '' } })
}

export function selectActiveIssues(state) {
  return scopeToCompanyAndFY(state.issues.uploadedIssues, state)
}

export function selectActiveValidationRows(state) {
  return scopeToCompanyAndFY(state.issues.uploadMeta?.validationRows || [], state)
}

export function selectActiveUploadMetaRows(state, key) {
  return scopeToCompanyAndFY(state.issues.uploadMeta?.[key] || [], state)
}

export function selectActiveCaseLedger(state) {
  const { dataSource } = state.issues
  const { selectedCompanyCode, financialYear } = state.app
  const rows = state.issues.uploadMeta?.caseLedger || []
  if (dataSource !== 'upload') return rows

  return rows.flatMap((row) => {
    if (selectedCompanyCode && row.companyCode !== selectedCompanyCode) return []
    const events = (row.events || []).filter((event) => {
      if (!financialYear) return true
      const eventYear = event.postingDate && event.postingDate !== '—'
        ? getFinancialYear(event.postingDate)
        : row.financialYear
          ? String(row.financialYear).startsWith('FY ') ? String(row.financialYear) : `FY ${row.financialYear}`
          : null
      return eventYear === financialYear
    })
    if (!events.length) return []
    const sumAmount = (types) => events.reduce((sum, event) =>
      sum + (types.includes(event.eventType) ? Math.abs(Number(event.amount) || 0) : 0), 0)
    const netAmount = events.reduce((sum, event) => sum + (Number(event.amount) || 0), 0)
    const invoiceAmount = sumAmount(['INVOICE'])
    const advanceAmount = sumAmount(['ADVANCE_PAYMENT'])
    const paymentAmount = sumAmount(['PAYMENT'])
    const creditAmount = sumAmount(['CREDIT_MEMO'])
    const reversalAmount = sumAmount(['REVERSAL'])
    const adjustmentAmount = sumAmount(['DEBIT_NOTE', 'TRANSFER_POSTING', 'TDS_PAYMENT', 'JOURNAL', 'PROVISION', 'SUPPORTING', 'UNKNOWN'])
    const openAmount = Math.max(0, invoiceAmount + advanceAmount - paymentAmount - creditAmount - reversalAmount - adjustmentAmount)
    const openItem = Boolean(row.openItem)
    const issueCount = events.reduce((sum, event) => sum + (event.issues?.length || 0), 0)
    const status = issueCount ? 'ISSUE' : openItem ? 'OPEN' : Math.abs(netAmount) <= 1 ? 'BALANCED' : 'OPEN'
    return [{
      ...row,
      events,
      eventCount: events.length,
      issueCount,
      invoiceAmount,
      advanceAmount,
      paymentAmount,
      creditAmount,
      reversalAmount,
      baseAmount: events.reduce((sum, event) => sum + (['INVOICE', 'ADVANCE_PAYMENT'].includes(event.eventType) ? Math.abs(Number(event.baseAmount) || 0) : 0), 0),
      adjustmentAmount,
      debitAmount: events.reduce((sum, event) => sum + (Number(event.amount) > 0 ? Number(event.amount) : 0), 0),
      netAmount,
      tdsAmount: events.reduce((sum, event) => sum + (Number(event.tdsAmount) || 0), 0),
      openAmount,
      openItem,
      status,
    }]
  })
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
  return vendorCodeOptionsFrom(selectActiveIssues(state))
}

function vendorCodeOptionsFrom(issues) {
  const byCode = new Map()
  for (const issue of issues) {
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

export function issueDateKey(issue) {
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
    || state.issues.dashboardTdsDeductionFilter !== 'all'
  )
}

function isTdsDeducted(row) {
  return Math.abs(Number(row?.tdsAmount || 0)) > 0
}

function matchesTdsDeductionFilter(row, filter) {
  if (filter === 'deducted') return isTdsDeducted(row)
  if (filter === 'not_deducted') return !isTdsDeducted(row)
  return true
}

/**
 * Issues the Dashboard counts: every saved issue across runs (each once, open
 * and resolved) once loaded, so yesterday's and today's issues add up; until
 * then, the latest upload's issues.
 */
export function selectDashboardSourceIssues(state) {
  const tracked = state.issues.trackedIssues
  // Saved issues are real data even before a file is uploaded in this browser,
  // so they always follow the selected company and financial year.
  return tracked ? scopeRowsToCompanyAndFY(tracked, state) : selectActiveIssues(state)
}

export function selectUsesTrackedIssues(state) {
  return Boolean(state.issues.trackedIssues)
}

export function selectDashboardSections(state) {
  return [...new Set(selectDashboardSourceIssues(state).map((i) => i.section).filter(Boolean))].sort()
}

export function selectDashboardVendorCodeOptions(state) {
  return vendorCodeOptionsFrom(selectDashboardSourceIssues(state))
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
    dashboardTdsDeductionFilter,
  } = state.issues

  return selectDashboardSourceIssues(state).filter((issue) => {
    if (!matchesTdsDeductionFilter(issue, dashboardTdsDeductionFilter)) return false
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

/**
 * Deducted / not-deducted row counts from the upload's validation rows,
 * scoped by company and the dashboard date/vendor/section filters. The TDS
 * deduction filter itself is not applied so both counts stay visible.
 */
export function selectDashboardTdsDeductionCounts(state) {
  const {
    dashboardDateFromFilter,
    dashboardDateToFilter,
    dashboardMonthFilter,
    dashboardVendorCodeFilter,
    dashboardVendorNameFilter,
    dashboardSectionFilter,
  } = state.issues

  const rows = selectActiveValidationRows(state).filter((row) => {
    const dateKey = issueDateKey(row)
    if (dashboardDateFromFilter && (!dateKey || dateKey < dashboardDateFromFilter)) return false
    if (dashboardDateToFilter && (!dateKey || dateKey > dashboardDateToFilter)) return false
    if (dashboardMonthFilter && dateKey.slice(0, 7) !== dashboardMonthFilter) return false
    if (dashboardVendorCodeFilter !== 'all' && row.vendorId !== dashboardVendorCodeFilter) return false
    if (dashboardVendorNameFilter !== 'all' && row.vendor !== dashboardVendorNameFilter) return false
    if (dashboardSectionFilter !== 'all' && row.section !== dashboardSectionFilter) return false
    return true
  })

  const deducted = rows.filter(isTdsDeducted).length
  return { deducted, notDeducted: rows.length - deducted }
}

export function selectDashboardKpis(state) {
  const issues = selectDashboardIssues(state)
  if (state.issues.trackedIssues) {
    // Issue counts cover every run; transactions are only known for the latest file.
    const kpis = deriveDashboardKpis(issues, null)
    return {
      ...kpis,
      transactions: state.issues.uploadMeta?.stats?.transactionsBuilt ?? state.issues.uploadMeta?.stats?.rowsRead ?? 0,
      partlyCorrected: issues.filter((i) => i.partlyCorrected).length,
      isLive: true,
    }
  }
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

export function selectSectionMonthlyTrend(state) {
  return deriveSectionMonthlyTrend(selectDashboardIssues(state))
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
  const rows = scopeToCompany(state.issues.uploadMeta?.ldcUtilization || readLastLdcUtilization(), state)
  if (state.issues.dataSource !== 'upload' || !state.app.financialYear) return rows

  return rows.map((row) => {
    if (!Array.isArray(row.monthlyUsage) || row.monthlyUsage.length === 0) {
      return row.financialYear
        ? (scopeToCompanyAndFY([row], state)[0] || null)
        : row // Older saved uploads did not include monthly usage by year.
    }
    const monthlyUsage = row.monthlyUsage.filter((month) =>
      getFinancialYear(`${month.monthKey}-01`) === state.app.financialYear,
    )
    const used = monthlyUsage.reduce((sum, month) => sum + Number(month.used || 0), 0)
    const limit = Number(row.limit)
    const utilization = Number.isFinite(limit) && limit > 0 ? Math.round((used / limit) * 10000) / 100 : null
    const status = utilization == null ? 'safe'
      : utilization > 100 ? 'over_utilized'
        : utilization >= 100 ? 'exhausted'
          : utilization >= 90 ? 'high_warning'
            : utilization >= 80 ? 'warning' : 'safe'
    const statusLabel = status === 'over_utilized' ? 'LDC Over-utilized'
      : status === 'exhausted' ? 'LDC Limit Exhausted'
        : status === 'high_warning' ? 'LDC Limit 90% Utilized — High Warning'
          : status === 'warning' ? 'LDC Limit 80% Utilized — Warning' : 'Within LDC Limit'
    return {
      ...row,
      used,
      transactions: monthlyUsage.reduce((sum, month) => sum + Number(month.transactions || 0), 0),
      monthlyUsage,
      available: Number.isFinite(limit) && limit > 0 ? limit - used : null,
      utilization,
      status,
      statusLabel,
    }
  }).filter(Boolean)
}

export function selectActiveTdsCases(state) {
  return selectActiveUploadMetaRows(state, 'tdsCases')
}

export function selectCorrectionGroups(state) {
  return state.issues.correctionGroups || []
}

export default issuesSlice.reducer
