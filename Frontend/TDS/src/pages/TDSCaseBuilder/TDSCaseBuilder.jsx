import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, ChevronLeft, ChevronRight, Download, FileSpreadsheet, GitBranch, ListTree, RotateCcw, ShieldAlert, SlidersHorizontal, X } from 'lucide-react'
import Issues, { issueMatchesFilters, issueRowsMatchingIssues, validationRowsMatchingFilters } from '@/pages/Issues/Issues'
import DataTable from '@/components/Common/DataTable'
import SearchInput from '@/components/Common/SearchInput'
import MultiSelectFilter from '@/components/Common/MultiSelectFilter'
import SapUploadPanel from '@/components/Common/SapUploadPanel'
import IssueHistory from '@/pages/CorrectionCenter/IssueHistory'
import issuesService from '@/services/issuesService'
import ledgerService from '@/services/ledgerService'
import StatusBadge, { severityToTone } from '@/components/Common/StatusBadge'
import {
  resetFilters, setIssueDateRange, setIssueTypeFilter, setProfitCenterFilter, setSearchQuery, setSectionFilter, setSeverityFilter,
  setStatusFilter, setVendorFilter, selectActiveIssues, selectActiveValidationRows,
  selectActiveCaseLedger,
} from '@/redux/slices/issuesSlice'
import { formatCurrency, formatDate } from '@/utils/utils'
import { NO_SECTION, hasSection } from '@/utils/sectionAliases'
import { selectedValues } from '@/utils/multiFilter'
import { getDisplayIssueType, issueTypeFilterOptionsFor, issueTypeFilterValuesFor } from '@/data/issueTypes'
import { downloadCsv, ISSUE_CSV_COLUMNS } from '@/utils/csvExport'
import '@/components/Common/Common.css'
import './TDSCaseBuilder.css'

const CASE_BUILDER_VIEW_STORAGE_KEY = 'tds_case_builder_view'
const DEFAULT_CASE_BUILDER_VIEW = { activeTab: 'ledger', quickFilter: 'ledger-all' }
const STORED_PAGE_SIZE = 100
const STORED_STATUS_BY_FILTER = { 'ledger-balanced': 'balanced', 'ledger-open': 'open', 'ledger-issue': 'issue' }
// Group statuses as shown. CLEARING_ONLY: only the clearing entry's own lines
// are known (they always net to zero); the documents it settles are not in the data.
const GROUP_STATUS_LABELS = { CLEARING_ONLY: 'CLEARING ONLY' }
const GROUP_STATUS_TITLES = {
  CLEARING_ONLY: 'Only the clearing entry is in the data. The documents it settles were not found (posted earlier, or not sent yet), so this group is not counted as balanced.',
  BALANCED: 'The group nets to zero and includes the documents being cleared.',
}
const VALID_TABS = new Set(['ledger', 'issues', 'open-issues', 'gl'])
// Issue Type filter lists every issue type present in the upload except the
// "correctly handled" confirmations, which are not issues. An allow-list here
// hid real issue types (e.g. TDS Section Missing, LDC limit warnings).
const TDS_ANALYSIS_HIDDEN_ISSUE_TYPE_LABELS = new Set([
  'TDS Not Applicable — Correctly Handled',
  'LDC — Correctly Applied',
  'PAN Missing/Invalid — Correctly Handled',
])

function presentValue(value) {
  const text = String(value ?? '').trim()
  return text && text !== '—' ? text : null
}

function distinctValues(values, limit = 3) {
  const unique = [...new Set(values.map(presentValue).filter(Boolean))]
  if (unique.length <= limit) return unique.join(', ') || '—'
  return `${unique.slice(0, limit).join(', ')} +${unique.length - limit}`
}

// Date window from a Dashboard link: its month narrowed by any from/to dates.
function linkedDateRange(params) {
  let from = params.get('dateFrom') || ''
  let to = params.get('dateTo') || ''
  const month = params.get('month')
  if (month) {
    const [year, monthNumber] = month.split('-').map(Number)
    const start = `${month}-01`
    const end = `${month}-${String(new Date(year, monthNumber, 0).getDate()).padStart(2, '0')}`
    if (!from || start > from) from = start
    if (!to || end < to) to = end
  }
  return { from, to }
}

function readSavedCaseBuilderView() {
  if (typeof window === 'undefined') return DEFAULT_CASE_BUILDER_VIEW
  try {
    const saved = JSON.parse(window.localStorage.getItem(CASE_BUILDER_VIEW_STORAGE_KEY) || 'null')
    if (!saved || !VALID_TABS.has(saved.activeTab)) return DEFAULT_CASE_BUILDER_VIEW
    return {
      activeTab: saved.activeTab,
      quickFilter: saved.quickFilter || DEFAULT_CASE_BUILDER_VIEW.quickFilter,
    }
  } catch {
    return DEFAULT_CASE_BUILDER_VIEW
  }
}

function renderSection(row) {
  if (row.newSection && row.legacySection && row.newSection !== row.legacySection) {
    return <span className="font-mono">{row.legacySection} / {row.newSection}</span>
  }
  const section = presentValue(row.section) || distinctValues((row.events || []).map((event) => event.tdsSection))
  return <span className="font-mono">{section}</span>
}

function splitLedgerDetailEvents(row) {
  const anchorDocNo = presentValue(row.anchorDocNo)
  const events = row.events || []
  if (row.groupType !== 'CLEARING' || !anchorDocNo) {
    return { linkedEvents: events, clearingEvents: [] }
  }
  return {
    linkedEvents: events.filter((event) => presentValue(event.docNo) !== anchorDocNo),
    clearingEvents: events.filter((event) => presentValue(event.docNo) === anchorDocNo),
  }
}

// A SAP line with two withholding taxes has two rows; its amount counts once.
function sumEventAmount(events) {
  return events.reduce((total, event) => total + (event.additionalWithholding ? 0 : Number(event.amount || 0)), 0)
}

/** Amount cell: the second withholding row of a line repeats no amount (it is on the row above). */
function EventAmount({ event }) {
  if (!event.additionalWithholding) return <span className="font-mono">{formatCurrency(event.amount)}</span>
  return (
    <span className="font-mono case-ledger-same-line" title={`Same SAP line as the row above (amount ${formatCurrency(event.amount)}); this row is its second withholding tax${event.withholdingTaxType ? ` (${event.withholdingTaxType}/${event.withholdingTaxCode || ''})` : ''}.`}>
      Same line
    </span>
  )
}

function ledgerBaseAmount(row) {
  const events = row.events || []
  const tdsRelevantBase = events
    .filter((event) => Math.abs(Number(event.tdsAmount || 0)) > 0)
    .reduce((total, event) => total + Math.abs(Number(event.baseAmount || 0)), 0)
  if (tdsRelevantBase) return tdsRelevantBase

  const backendTotal = Number(row.baseAmount || 0)
  if (backendTotal) return backendTotal

  return events
    .filter((event) => ['INVOICE', 'ADVANCE_PAYMENT'].includes(event.eventType))
    .reduce((total, event) => total + Math.abs(Number(event.baseAmount || 0)), 0)
}

function appliedRateForEvent(event) {
  if (event.tdsRate != null && event.tdsRate !== '') return Number(event.tdsRate)
  const baseAmount = Math.abs(Number(event.baseAmount || 0))
  if (!baseAmount) return null
  const tdsAmount = Math.abs(Number(event.tdsAmount || 0))
  if (!tdsAmount) return null
  return Math.round((tdsAmount / baseAmount) * 10000) / 100
}

// Rate actually deducted on a line (TDS ÷ base), ignoring any SAP rate.
function calculatedRateForEvent(event) {
  const baseAmount = Math.abs(Number(event.baseAmount || 0))
  if (!baseAmount) return null
  return Math.round((Math.abs(Number(event.tdsAmount || 0)) / baseAmount) * 10000) / 100
}

// Whether a line's TDS was deducted at the rate it should have been: the LDC
// expected rate when a certificate applies, otherwise the SAP rate. TDS is
// rounded to the rupee, so up to ₹1 of difference still counts as a match.
// 'matched' | 'mismatched', or null when there is no base or rate to check.
// Lines with no rate of their own to judge: advance adjustments, clearing and
// transfer lines, and lines with no TDS deducted where the rule engine raised
// no issue (the TDS Note explains why — advance already taxed, below
// threshold, payment against invoice, …).
function isRateCheckSkipped(event) {
  if (event.rateCheckNotApplicable) return true
  return !Math.abs(Number(event.tdsAmount || 0)) && !event.issues?.length
}

function eventRateStatus(event) {
  if (isRateCheckSkipped(event)) return null
  // No TDS deducted but the rule engine flagged the document.
  if (!Math.abs(Number(event.tdsAmount || 0))) return 'mismatched'
  const baseAmount = Math.abs(Number(event.baseAmount || 0))
  const ldc = eventLdc(event)
  const targetRate = ldc ? ldc.expectedRate : eventSapRate(event)
  if (targetRate == null || !baseAmount) return null
  const expectedTds = (baseAmount * targetRate) / 100
  return Math.abs(expectedTds - Math.abs(Number(event.tdsAmount || 0))) <= 1 ? 'matched' : 'mismatched'
}

const RATE_STATUS_CLASS = { matched: 'case-rate-matched', mismatched: 'case-rate-mismatched' }

function formatRate(value) {
  if (value == null || Number.isNaN(Number(value))) return '—'
  return `${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
}

function formatGroupType(row) {
  if (row.openItem) return 'Open Item'
  return String(row.groupType || 'DOCUMENT').replace(/^OPEN_/, 'Open ').replace(/_/g, ' ')
}

// SAP-reported rate rounded to two decimals so 1 / 1.0 / 1.00 share a row;
// blank and 0% rows share the "no rate" row, as the Rate column showed before.
function eventSapRate(event) {
  if (event.sapRate == null || event.sapRate === '') return null
  const rate = Number(event.sapRate)
  if (Number.isNaN(rate) || rate === 0) return null
  return Math.round(rate * 100) / 100
}

function roundedRate(value) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return null
  return Math.round(Number(value) * 100) / 100
}

// LDC terms on a line: certificate, its exemption % and the rate the rules
// expect after that exemption. Null when no certificate covers the line.
function eventLdc(event) {
  const certificate = presentValue(event.ldcCertificate)
  const exemptionRate = roundedRate(event.ldcRate)
  if (!certificate || exemptionRate == null) return null
  return { certificate, exemptionRate, expectedRate: roundedRate(event.ldcExpectedRate) }
}

const SEVERITY_OPTIONS = [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]
const STATUS_OPTIONS = [['open', 'Open'], ['in_review', 'In Review'], ['resolved', 'Resolved'], ['rejected', 'Rejected']]

export default function TDSCaseBuilder() {
  const dispatch = useDispatch()
  const [searchParams, setSearchParams] = useSearchParams()
  const savedView = useMemo(readSavedCaseBuilderView, [])
  const [activeTab, setActiveTab] = useState(savedView.activeTab)
  const [quickFilter, setQuickFilter] = useState(savedView.quickFilter)
  const [caseSearch, setCaseSearch] = useState('')
  const [docTypeFilter, setDocTypeFilter] = useState('all')
  const [expandedLedgerKey, setExpandedLedgerKey] = useState(null)
  const [glModal, setGlModal] = useState(null)
  const uploadMeta = useSelector((state) => state.issues.uploadMeta)
  const { searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter, issueTypeFilter, profitCenterFilter, issueDateFromFilter, issueDateToFilter } = useSelector((state) => state.issues)

  const filteredCaseLedger = useSelector(selectActiveCaseLedger)
  const issueRows = useSelector(selectActiveIssues)
  const validationRows = useSelector(selectActiveValidationRows)
  const ledgerRows = useMemo(() => (
    filteredCaseLedger.map((row) => ({ ...row, id: row.caseId }))
  ), [filteredCaseLedger])
  const hasUpload = Boolean(uploadMeta)
  // Issue book across every run (daily feed / uploads): each issue counted once.
  const trackingRunId = uploadMeta?.tracking?.runId ?? null
  const selectedCompanyCode = useSelector((state) => state.app.selectedCompanyCode)
  const financialYear = useSelector((state) => state.app.financialYear)
  const [openSummary, setOpenSummary] = useState(null)
  useEffect(() => {
    let cancelled = false
    // Same company / FY as the rest of the page (and the Document / GL Ledger).
    issuesService.getTrackedIssueSummary({ companyCode: selectedCompanyCode || '', financialYear: financialYear || '' })
      .then((data) => { if (!cancelled) setOpenSummary(data) })
      .catch(() => { if (!cancelled) setOpenSummary(null) })
    return () => { cancelled = true }
  }, [trackingRunId, selectedCompanyCode, financialYear])
  // ── Document / GL Ledger: always every saved line across runs. A clearing
  // only makes sense against earlier days, so one file alone is never shown. ──
  const [storedOptions, setStoredOptions] = useState(null)
  const [storedGroups, setStoredGroups] = useState({ items: [], total: 0, counts: null })
  const [storedGl, setStoredGl] = useState([])
  const [storedGlLoading, setStoredGlLoading] = useState(true)
  const [storedPage, setStoredPage] = useState(1)
  const [storedLoading, setStoredLoading] = useState(false)
  const [storedError, setStoredError] = useState('')
  const [glModalData, setGlModalData] = useState(null)
  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])
  const storedFilters = useMemo(() => ({
    company_code: selectedCompanyCode || '',
    financial_year: financialYear || '',
    vendor: selectedValues(vendorFilter) || [],
    section: selectedValues(sectionFilter) || [],
    doc_type: selectedValues(docTypeFilter) || [],
    profit_center: selectedValues(profitCenterFilter) || [],
    severity: selectedValues(severityFilter) || [],
    issue_type: selectedValues(issueTypeFilter) || [],
    issue_status: selectedValues(statusFilter) || [],
    date_from: issueDateFromFilter || undefined,
    date_to: issueDateToFilter || undefined,
    search: debouncedSearch,
  }), [selectedCompanyCode, financialYear, vendorFilter, sectionFilter, docTypeFilter, profitCenterFilter, severityFilter, issueTypeFilter, statusFilter, issueDateFromFilter, issueDateToFilter, debouncedSearch])
  const storedStatus = STORED_STATUS_BY_FILTER[quickFilter] || 'all'
  const storedFilterKey = JSON.stringify([storedFilters, storedStatus])
  useEffect(() => { setStoredPage(1) }, [storedFilterKey])
  useEffect(() => {
    let cancelled = false
    ledgerService.getOptions({ companyCode: selectedCompanyCode || '', financialYear: financialYear || '' })
      .then((data) => { if (!cancelled) setStoredOptions(data) })
      .catch(() => { if (!cancelled) setStoredOptions(null) })
    return () => { cancelled = true }
  }, [selectedCompanyCode, financialYear, trackingRunId])
  useEffect(() => {
    let cancelled = false
    setStoredLoading(true)
    setStoredError('')
    ledgerService.getGroups({ filters: storedFilters, status: storedStatus, page: storedPage, pageSize: STORED_PAGE_SIZE })
      .then((data) => { if (!cancelled) setStoredGroups(data) })
      .catch((err) => { if (!cancelled) setStoredError(err.message || 'Could not load the saved ledger') })
      .finally(() => { if (!cancelled) setStoredLoading(false) })
    return () => { cancelled = true }
  }, [storedFilters, storedStatus, storedPage, trackingRunId])
  // Loaded on every tab (not only GL) so the GL Ledger tab label shows its count.
  useEffect(() => {
    let cancelled = false
    setStoredGlLoading(true)
    ledgerService.getGlRows({ filters: storedFilters })
      .then((data) => { if (!cancelled) setStoredGl(data.items || []) })
      .catch(() => { if (!cancelled) setStoredGl([]) })
      .finally(() => { if (!cancelled) setStoredGlLoading(false) })
    return () => { cancelled = true }
  }, [storedFilters, trackingRunId])
  // Filter bar for the Open Issues tab (that list is open-only, so no status filter).
  const openIssueBarFilters = useMemo(() => ({
    vendor: storedFilters.vendor,
    section: storedFilters.section,
    doc_type: storedFilters.doc_type,
    profit_center: storedFilters.profit_center,
    severity_in: storedFilters.severity,
    issue_type: storedFilters.issue_type,
    date_from: storedFilters.date_from,
    date_to: storedFilters.date_to,
    bar_search: storedFilters.search || undefined,
  }), [storedFilters])

  // Counts follow the shared filter bar, using the Issues page's own
  // predicates so tab/card numbers match the cards inside the Issues tab.
  const filterValues = useMemo(() => ({
    searchQuery, vendorFilter, sectionFilter, docTypeFilter,
    severityFilter, statusFilter, issueTypeFilter,
    profitCenterFilter, dateFrom: issueDateFromFilter, dateTo: issueDateToFilter,
  }), [searchQuery, vendorFilter, sectionFilter, docTypeFilter, severityFilter, statusFilter, issueTypeFilter, profitCenterFilter, issueDateFromFilter, issueDateToFilter])
  const filteredIssues = useMemo(() => issueRows.filter((issue) => issueMatchesFilters(issue, filterValues)), [issueRows, filterValues])
  const filteredValidationRows = useMemo(() => (
    validationRowsMatchingFilters(validationRows, filteredIssues, filterValues)
  ), [validationRows, filteredIssues, filterValues])
  // Rows with at least one issue — a row failing two rules counts once, so this
  // matches the "Issues Found" card inside the Issues tab.
  const issueRowCount = useMemo(() => (
    issueRowsMatchingIssues(filteredValidationRows, filteredIssues).length
  ), [filteredValidationRows, filteredIssues])
  const issueTypeOptions = useMemo(
    () => issueTypeFilterOptionsFor(issueRows, issueTypeFilter)
      .filter(([, label]) => !TDS_ANALYSIS_HIDDEN_ISSUE_TYPE_LABELS.has(label)),
    [issueRows, issueTypeFilter],
  )
  const vendorOptions = useMemo(() => {
    const values = [
      ...ledgerRows.map((row) => row.vendor),
      ...issueRows.map((row) => row.vendor),
      ...validationRows.map((row) => row.vendor),
    ].map(presentValue).filter(Boolean)
    return [...new Set(values)].sort()
  }, [ledgerRows, issueRows, validationRows])
  // Profit Center is per SAP line; uploads without the column have none, and
  // the filter is then disabled.
  const profitCenterOptions = useMemo(() => {
    const values = [
      ...ledgerRows.flatMap((row) => (row.events || []).map((event) => event.profitCenter)),
      ...validationRows.map((row) => row.profitCenter),
    ].map(presentValue).filter(Boolean)
    return [...new Set(values)].sort()
  }, [ledgerRows, validationRows])
  const sectionOptions = useMemo(() => {
    const values = [
      ...ledgerRows.flatMap((row) => [row.section, row.legacySection, row.newSection, ...(row.events || []).map((event) => event.tdsSection)]),
      ...issueRows.map((row) => row.section),
      ...validationRows.map((row) => row.section),
    ].map(presentValue).filter(Boolean)
    const options = [...new Set(values)].sort()
    // Lets the Dashboard's "No Section" bars open their issues here.
    if ([...issueRows, ...validationRows].some((row) => !hasSection(row.section))) options.push(NO_SECTION)
    return options
  }, [ledgerRows, issueRows, validationRows])
  const docTypeOptions = useMemo(() => {
    const values = [
      ...ledgerRows.flatMap((row) => (row.events || []).map((event) => event.docType)),
      ...issueRows.map((row) => row.docType),
      ...validationRows.map((row) => row.docType),
    ].map((value) => String(value || '').trim().toUpperCase()).filter((value) => value && value !== '—')
    return [...new Set(values)].sort()
  }, [ledgerRows, issueRows, validationRows])

  // A Dashboard click arrives as /issues?view=…&type=…: open the Issues tab with
  // exactly those filters. A plain /issues keeps whatever is already selected.
  useEffect(() => {
    if (!searchParams.toString()) return
    dispatch(resetFilters())
    setDocTypeFilter('all')
    const severity = searchParams.get('severity')
    const status = searchParams.get('status')
    const issueType = searchParams.get('type')
    const section = searchParams.get('section')
    const vendor = searchParams.get('vendor')
    const search = searchParams.get('search')
    if (severity) dispatch(setSeverityFilter(severity))
    if (status) dispatch(setStatusFilter(status))
    if (issueType) dispatch(setIssueTypeFilter(issueTypeFilterValuesFor(issueType)))
    if (section) dispatch(setSectionFilter(section))
    if (vendor) dispatch(setVendorFilter(vendor))
    if (search) dispatch(setSearchQuery(search))
    dispatch(setIssueDateRange(linkedDateRange(searchParams)))
    applyQuickFilter('issues', 'issues-all')
  }, [dispatch, searchParams])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(CASE_BUILDER_VIEW_STORAGE_KEY, JSON.stringify({
      activeTab,
      quickFilter,
    }))
  }, [activeTab, quickFilter])

  const ledgerColumns = [
    { key: 'vendor', header: 'Vendor', render: (row) => (
      <div>
        <div className="case-strong">{row.vendor}</div>
        <div className="font-mono case-muted">{row.vendorId || '—'}</div>
      </div>
    )},
    { key: 'pan', header: 'PAN', render: (row) => (
      <span className="font-mono case-muted">{row.pan || row.vendorId || '—'}</span>
    )},
    { key: 'anchorDocNo', header: 'Document Group', render: (row) => (
      <div>
        <div className="font-mono case-strong">{row.anchorDocNo}</div>
        <div className="case-muted">{formatGroupType(row)} · {row.eventCount} rows</div>
      </div>
    )},
    { key: 'section', header: 'Section', render: renderSection },
    { key: 'profitCenter', header: 'Profit Center', sortValue: (row) => distinctValues((row.events || []).map((event) => event.profitCenter)), render: (row) => (
      <span className="font-mono">{distinctValues((row.events || []).map((event) => event.profitCenter))}</span>
    )},
    { key: 'assignmentNumber', header: 'Assignment No.', render: (row) => <span className="font-mono case-strong">{row.assignmentNumber || '—'}</span> },
    { key: 'invoiceAmount', header: 'Invoice', render: (row) => <span className="font-mono">{formatCurrency(row.invoiceAmount)}</span> },
    { key: 'baseAmount', header: 'Base Amount', render: (row) => <span className="font-mono">{formatCurrency(ledgerBaseAmount(row))}</span> },
    { key: 'advanceAmount', header: 'Advance', render: (row) => <span className="font-mono">{formatCurrency(row.advanceAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (row) => <span className="font-mono">{formatCurrency(row.tdsAmount)}</span> },
    { key: 'issueCount', header: 'Issues', render: (row) => <span className="font-mono">{row.issueCount}</span> },
    { key: 'status', header: 'Status', sortValue: (row) => row.status, render: (row) => (
      <span title={GROUP_STATUS_TITLES[row.status]}>
        <StatusBadge label={GROUP_STATUS_LABELS[row.status] || row.status} tone={row.status === 'ISSUE' ? 'danger' : row.status === 'BALANCED' ? 'success' : 'warning'} />
      </span>
    ) },
  ]

  const storedCounts = storedGroups.counts || {}
  const ledgerGroupCount = storedCounts.groups ?? 0
  const clearingOnlyCount = storedCounts.clearingOnly ?? 0
  const balancedNote = clearingOnlyCount
    ? `Net zero, with the documents cleared · ${clearingOnlyCount.toLocaleString()} clearing-only not counted`
    : 'Net zero, with the documents cleared'
  const summaryCards = useMemo(() => [
    { label: 'Transactions', value: storedCounts.transactions ?? 0, icon: FileSpreadsheet, tone: 'info', tab: 'ledger', filter: 'ledger-all', description: 'Saved SAP lines, all runs, in the Company/FY scope and filters' },
    { label: 'Document Groups', value: storedCounts.groups ?? 0, icon: ListTree, tone: 'success', tab: 'ledger', filter: 'ledger-all', description: 'Grouped by clearing / reference across days' },
    { label: 'Balanced Groups', value: storedCounts.balanced ?? 0, icon: GitBranch, tone: 'success', tab: 'ledger', filter: 'ledger-balanced', description: balancedNote },
    { label: 'Open Items', value: storedCounts.open ?? 0, icon: AlertTriangle, tone: 'warning', tab: 'ledger', filter: 'ledger-open', description: 'No clearing document found yet' },
    { label: 'Issue Groups', value: storedCounts.issue ?? 0, icon: ShieldAlert, tone: 'danger', tab: 'ledger', filter: 'ledger-issue', description: 'Groups with an open issue' },
    openSummary
      ? { label: 'Open Issues', value: openSummary.open, icon: ShieldAlert, tone: 'danger', tab: 'open-issues', filter: 'open-issues', description: `All runs · ${issueRowCount.toLocaleString()} in this upload` }
      : { label: 'Issues', value: issueRowCount, icon: ShieldAlert, tone: 'danger', tab: 'issues', filter: 'issues-all', description: 'Rows failing TDS rules' },
  ], [storedCounts, issueRowCount, openSummary, balancedNote])
  const canExpand = activeTab === 'ledger'

  const glTableRows = storedGl
  // Totals across the GL rows in view, shown above their columns.
  const glTotals = useMemo(() => glTableRows.reduce((totals, row) => ({
    baseAmount: totals.baseAmount + (Number(row.baseAmount) || 0),
    tdsAmount: totals.tdsAmount + (Number(row.tdsAmount) || 0),
  }), { baseAmount: 0, tdsAmount: 0 }), [glTableRows])

  const glColumns = [
    { key: 'glAccount', header: 'GL Account', render: (row) => (
      <div>
        <div className="font-mono case-strong">{row.glAccount}</div>
        <div className="case-muted">{row.rowCount} rows</div>
      </div>
    )},
    { key: 'section', header: 'Section (Old / New)', render: (row) => (
      <span className={`font-mono ${row.section === 'No Section' ? 'case-muted' : ''}`}>{row.section}</span>
    )},
    { key: 'profitCenter', header: 'Profit Center', sortValue: (row) => row.profitCenterLabel ?? distinctValues(row.events.map((event) => event.profitCenter)), render: (row) => (
      <span className="font-mono">{row.profitCenterLabel ?? distinctValues(row.events.map((event) => event.profitCenter))}</span>
    )},
    { key: 'baseAmount', header: 'Base Amount', render: (row) => <span className="font-mono">{formatCurrency(row.baseAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (row) => <span className="font-mono">{formatCurrency(row.tdsAmount)}</span> },
    { key: 'rate', header: 'Rate', sortValue: (row) => row.rate ?? -1, render: (row) => (
      <div>
        <span className="font-mono" title={row.rate != null ? 'TDS rate reported by SAP' : 'No SAP TDS rate on these lines'}>
          {row.rate != null ? formatRate(row.rate) : '—'}
        </span>
      </div>
    )},
    { key: 'ldcRate', header: 'LDC Expected Rate', sortValue: (row) => row.ldc?.expectedRate ?? -1, render: (row) => (
      row.ldc ? (
        <div title={`LDC certificate ${row.ldc.certificate}`}>
          <span className="font-mono">{row.ldc.expectedRate != null ? formatRate(row.ldc.expectedRate) : '—'}</span>
          <div className="case-ldc-rate font-mono">Exemption {formatRate(row.ldc.exemptionRate)}</div>
          <div className="case-muted font-mono">{row.ldc.certificate}</div>
        </div>
      ) : <span className="case-muted case-ldc-empty">—</span>
    )},
    { key: 'calculatedRate', header: 'Calculated Rate', sortValue: (row) => row.calculatedRate ?? -1, render: (row) => (
      <span
        className={`font-mono ${RATE_STATUS_CLASS[row.rateStatus] || ''}`}
        title={{
          matched: `TDS ÷ base over the checked lines of this row (₹0-TDS lines with no issue are left out) — every line matches the ${row.ldc ? 'LDC expected' : 'SAP'} rate`,
          mismatched: `TDS ÷ base over the checked lines of this row (₹0-TDS lines with no issue are left out) — at least one line does not match the ${row.ldc ? 'LDC expected' : 'SAP'} rate`,
        }[row.rateStatus] || 'TDS ÷ base over the checked lines of this row (₹0-TDS lines with no issue are left out)'}
      >
        {row.calculatedRate != null ? formatRate(row.calculatedRate) : '—'}
      </span>
    )},
    { key: 'deductedRows', header: 'TDS Deducted / Not', render: (row) => (
      <span className="font-mono">{row.deductedRows.toLocaleString()} / {row.notDeductedRows.toLocaleString()}</span>
    )},
    { key: 'issueRows', header: 'Issue Rows', render: (row) => (
      <div className="case-gl-issue-cell">
        <button
          type="button"
          className="case-gl-issue-link font-mono"
          disabled={!row.issueRows}
          title={row.issueRows ? `View ${row.issueRows} issues on GL ${row.glAccount}, section ${row.section}, rate ${row.rate != null ? formatRate(row.rate) : '—'}` : 'No issues on these lines'}
          onClick={(event) => { event.stopPropagation(); setGlModal({ type: 'issues', key: row.glKey }) }}
        >
          {row.issueRows.toLocaleString()}
        </button>
        {row.issueRows > 0 ? (
          <button
            type="button"
            className="case-gl-download-btn"
            title={`Download ${row.issueRows} issues on GL ${row.glAccount} (CSV)`}
            aria-label={`Download issues for GL ${row.glAccount}`}
            onClick={(event) => { event.stopPropagation(); downloadGlIssues(row) }}
          >
            <Download size={13} />
          </button>
        ) : (
          <span className="case-gl-download-placeholder" aria-hidden="true" />
        )}
      </div>
    )},
  ]

  const glTransactionColumns = [
    { key: 'docType', header: 'Type', render: (event) => <span className="font-mono">{event.docType}</span> },
    { key: 'docNo', header: 'Doc No.', render: (event) => <span className="font-mono">{event.docNo}</span> },
    { key: 'vendor', header: 'Vendor', render: (event) => (
      <div>
        <div className="case-strong">{event.vendor}</div>
        <div className="font-mono case-muted">{event.vendorId || '—'}</div>
      </div>
    )},
    { key: 'postingDate', header: 'Posting Date', sortValue: (event) => event.postingDate, render: (event) => <span className="font-mono">{formatDate(event.postingDate)}</span> },
    { key: 'profitCenter', header: 'Profit Center', render: (event) => <span className="font-mono">{presentValue(event.profitCenter) || '—'}</span> },
    { key: 'eventType', header: 'Event', render: (event) => event.eventType },
    { key: 'debitCredit', header: 'D/C', render: (event) => <span className="font-mono">{event.debitCredit}</span> },
    { key: 'amount', header: 'Document Amount', render: (event) => <EventAmount event={event} /> },
    { key: 'baseAmount', header: 'Base Amount', render: (event) => <span className="font-mono">{formatCurrency(event.baseAmount)}</span> },
    { key: 'tdsSection', header: 'Section', render: (event) => <span className="font-mono">{event.tdsSection}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (event) => <span className="font-mono">{formatCurrency(event.tdsAmount)}</span> },
    // Same three rates as the GL Ledger row, per line.
    { key: 'sapRate', header: 'Rate', sortValue: (event) => eventSapRate(event) ?? -1, render: (event) => {
      const rate = eventSapRate(event)
      return (
        <span className="font-mono" title={rate != null ? 'TDS rate reported by SAP' : 'No SAP TDS rate on this line'}>
          {rate != null ? formatRate(rate) : '—'}
        </span>
      )
    }},
    { key: 'ldcExpectedRate', header: 'LDC Expected Rate', sortValue: (event) => eventLdc(event)?.expectedRate ?? -1, render: (event) => {
      const ldc = eventLdc(event)
      return ldc ? (
        <div title={`LDC certificate ${ldc.certificate}`}>
          <span className="font-mono">{ldc.expectedRate != null ? formatRate(ldc.expectedRate) : '—'}</span>
          <div className="case-ldc-rate font-mono">Exemption {formatRate(ldc.exemptionRate)}</div>
          <div className="case-muted font-mono">{ldc.certificate}</div>
        </div>
      ) : <span className="case-muted case-ldc-empty">—</span>
    }},
    { key: 'calculatedRate', header: 'Calculated Rate', sortValue: (event) => calculatedRateForEvent(event) ?? -1, render: (event) => {
      const target = eventLdc(event) ? 'LDC expected' : 'SAP'
      const status = eventRateStatus(event)
      return (
        <span
          className={`font-mono ${RATE_STATUS_CLASS[status] || ''}`}
          title={{
            matched: `TDS ÷ base amount for this line — matches the ${target} rate`,
            mismatched: `TDS ÷ base amount for this line — does not match the ${target} rate`,
          }[status] || 'TDS ÷ base amount for this line'}
        >
          {formatRate(calculatedRateForEvent(event))}
        </span>
      )
    }},
    { key: 'tdsNote', header: 'TDS Note', render: (event) => <span className="case-tds-note case-gl-modal-note" title={event.tdsNote || ''}>{event.tdsNote || '—'}</span> },
  ]

  const glIssueColumns = [
    { key: 'docNo', header: 'Doc No.', render: (issue) => <span className="font-mono">{issue.docNo}</span> },
    { key: 'docType', header: 'Type', render: (issue) => <span className="font-mono">{issue.docType}</span> },
    { key: 'vendor', header: 'Vendor', render: (issue) => (
      <div>
        <div className="case-strong">{issue.vendor}</div>
        <div className="font-mono case-muted">{issue.vendorId || '—'}</div>
      </div>
    )},
    { key: 'section', header: 'Section', render: (issue) => <span className="font-mono">{issue.section}</span> },
    { key: 'profitCenter', header: 'Profit Center', render: (issue) => <span className="font-mono">{presentValue(issue.profitCenter) || '—'}</span> },
    { key: 'baseAmount', header: 'Base Amount', render: (issue) => <span className="font-mono">{formatCurrency(issue.baseAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (issue) => <span className="font-mono">{formatCurrency(issue.tdsAmount)}</span> },
    { key: 'category', header: 'Issue Type', sortValue: (issue) => getDisplayIssueType(issue), render: (issue) => getDisplayIssueType(issue) },
    { key: 'severity', header: 'Severity', render: (issue) => <StatusBadge label={issue.severity} tone={severityToTone(issue.severity)} /> },
    { key: 'description', header: 'Details', render: (issue) => <span className="case-tds-note case-gl-modal-note" title={issue.description || ''}>{issue.description || '—'}</span> },
  ]

  async function downloadGlIssues(row) {
    if (!row.issues?.length && row.issueRows) {
      const data = await ledgerService.getGlLines({ glKey: row.glKey, filters: storedFilters })
      row = { ...row, issues: data.issues || [] }
    }
    const fileBase = (uploadMeta?.fileName || 'tds-analysis').replace(/\.[^.]+$/, '')
    downloadCsv(
      `${fileBase}-GL-${row.glAccount}-${row.section.replace(/[^A-Za-z0-9]+/g, '_')}-${row.rate != null ? `${row.rate}pct` : 'no_rate'}${row.ldc ? `-LDC_${row.ldc.certificate}` : ''}-${row.companyCode}-issues.csv`,
      [
        { label: 'Company', value: () => row.companyCode },
        { label: 'GL Account', value: () => row.glAccount },
        { label: 'GL Section (Old / New)', value: () => row.section },
        { label: 'SAP Rate', value: () => (row.rate != null ? formatRate(row.rate) : '—') },
        { label: 'LDC Certificate', value: () => row.ldc?.certificate || '—' },
        { label: 'LDC Exemption', value: () => (row.ldc ? formatRate(row.ldc.exemptionRate) : '—') },
        { label: 'LDC Expected Rate', value: () => (row.ldc?.expectedRate != null ? formatRate(row.ldc.expectedRate) : '—') },
        ...ISSUE_CSV_COLUMNS,
      ],
      row.issues,
    )
  }

  // All data: the GL pop-up loads its lines and issues from the server.
  useEffect(() => {
    if (!glModal) { setGlModalData(null); return undefined }
    let cancelled = false
    setGlModalData({ key: glModal.key, loading: true, events: [], issues: [] })
    ledgerService.getGlLines({ glKey: glModal.key, filters: storedFilters })
      .then((data) => { if (!cancelled) setGlModalData({ key: glModal.key, loading: false, ...data }) })
      // Say why instead of showing an empty table, so a failing request
      // (e.g. on the MySQL machine) isn't mistaken for "no data".
      .catch((err) => { if (!cancelled) setGlModalData({ key: glModal.key, loading: false, events: [], issues: [], error: err.message || 'Could not load the lines for this GL' }) })
    return () => { cancelled = true }
  }, [glModal?.key, storedFilters])
  const glModalBaseRow = glModal ? glTableRows.find((row) => row.glKey === glModal.key) : null
  const activeGlModalRow = glModalBaseRow
    ? { ...glModalBaseRow, events: glModalData?.events || [], issues: glModalData?.issues || [] }
    : null

  useEffect(() => {
    if (!glModal) return undefined
    const onKeyDown = (event) => { if (event.key === 'Escape') setGlModal(null) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [glModal])


  function applyQuickFilter(tab, filter) {
    setActiveTab(tab)
    setQuickFilter(filter)
    setCaseSearch('')
    setExpandedLedgerKey(null)
    setGlModal(null)
  }

  function handleSharedFilterReset() {
    setDocTypeFilter('all')
    dispatch(resetFilters())
    if (searchParams.toString()) setSearchParams({}, { replace: true })
  }

  function renderLedgerLines(row) {
    const { linkedEvents, clearingEvents } = splitLedgerDetailEvents(row)
    const linkedNet = sumEventAmount(linkedEvents)
    const clearingNet = sumEventAmount(clearingEvents)
    const groupNet = Number(row.netAmount ?? linkedNet + clearingNet)

    const renderRows = (events) => events.map((event, index) => (
      <div className="case-ledger-line" key={`${event.docNo}-${event.lineItem}-${index}`}>
        <span className="font-mono">{event.docType}</span>
        <span className="font-mono">{event.docNo}</span>
        <span className="font-mono">{event.assignmentNumber}</span>
        <span>{event.eventType}</span>
        <span className="font-mono">{event.glAccount}</span>
        <span className="font-mono">{presentValue(event.profitCenter) || '—'}</span>
        <span className="font-mono">{event.debitCredit}</span>
        <EventAmount event={event} />
        <span className="font-mono">{formatCurrency(event.baseAmount)}</span>
        <span className="font-mono">{event.tdsSection}</span>
        <span className="font-mono">{formatRate(appliedRateForEvent(event))}</span>
        <span className="font-mono">{formatCurrency(event.tdsAmount)}</span>
        <span className="case-tds-note" title={event.tdsNote || ''}>{event.tdsNote || '—'}</span>
        <span className="font-mono">{event.referenceDoc}</span>
      </div>
    ))

    return (
      <div className="case-ledger-detail">
        {clearingEvents.length > 0 && (
          <div className="case-ledger-balance-strip">
            <div>
              <span>Linked documents net</span>
              <strong>{formatCurrency(linkedNet)}</strong>
            </div>
            <div>
              <span>Clearing entries net</span>
              <strong>{formatCurrency(clearingNet)}</strong>
            </div>
            <div>
              <span>Group net</span>
              <strong>{formatCurrency(groupNet)}</strong>
            </div>
          </div>
        )}
        <div className="case-ledger-section-title">Linked documents</div>
        <div className="case-ledger-line case-ledger-line--head">
          <span>Type</span>
          <span>Doc No.</span>
          <span>Assignment</span>
          <span>Event</span>
          <span>GL</span>
          <span>Profit Center</span>
          <span>D/C</span>
          <span>Document Amount</span>
          <span>Base Amount</span>
          <span>Section</span>
          <span>Rate</span>
          <span>TDS</span>
          <span>TDS Note</span>
          <span>Reference</span>
        </div>
        {linkedEvents.length ? renderRows(linkedEvents) : (
          <div className="case-ledger-empty-line">No linked business documents in this group.</div>
        )}
        {clearingEvents.length > 0 && (
          <>
            <div className="case-ledger-section-title case-ledger-section-title--clearing">
              Clearing / balancing entries
            </div>
            <div className="case-ledger-line case-ledger-line--head">
              <span>Type</span>
              <span>Doc No.</span>
              <span>Assignment</span>
              <span>Event</span>
              <span>GL</span>
              <span>Profit Center</span>
              <span>D/C</span>
              <span>Document Amount</span>
              <span>Base Amount</span>
              <span>Section</span>
              <span>Rate</span>
              <span>TDS</span>
              <span>TDS Note</span>
              <span>Reference</span>
            </div>
            {renderRows(clearingEvents)}
          </>
        )}
      </div>
    )
  }

  const resultsTabsPanel = (
    <div className="case-tabs-panel">
      <div className="case-tabs" role="tablist" aria-label="TDS analysis results">
        <button type="button" className={`case-tab ${activeTab === 'ledger' ? 'active' : ''}`} onClick={() => applyQuickFilter('ledger', 'ledger-all')}>
          Document Ledger ({ledgerGroupCount.toLocaleString()})
        </button>
        <button type="button" className={`case-tab ${activeTab === 'issues' ? 'active' : ''}`} onClick={() => applyQuickFilter('issues', 'issues-all')}>
          Issues · This Upload ({issueRowCount.toLocaleString()})
        </button>
        <button type="button" className={`case-tab ${activeTab === 'open-issues' ? 'active' : ''}`} onClick={() => applyQuickFilter('open-issues', 'open-issues')}>
          Open Issues · All Runs ({(openSummary?.open ?? 0).toLocaleString()})
        </button>
        <button type="button" className={`case-tab ${activeTab === 'gl' ? 'active' : ''}`} onClick={() => applyQuickFilter('gl', 'gl-all')}>
          GL Ledger ({storedGlLoading ? '…' : glTableRows.length.toLocaleString()})
        </button>
      </div>
    </div>
  )

  const sharedFilters = (
    <div className="filter-bar">
      <div className="filter-bar-top">
        <div className="filter-bar-label">
          <SlidersHorizontal size={14} />Filters
        </div>
        <SearchInput
          value={searchQuery}
          onChange={(value) => dispatch(setSearchQuery(value))}
          placeholder="Search vendor / doc / ID / section / PAN…"
        />
      </div>
      <div className="filter-bar-controls">
        <MultiSelectFilter
          allLabel="All Vendors"
          options={(storedOptions ? storedOptions.vendors : vendorOptions).map((vendor) => [vendor, vendor])}
          value={vendorFilter}
          onChange={(next) => dispatch(setVendorFilter(next))}
        />
        <MultiSelectFilter
          allLabel="All Sections"
          options={(storedOptions ? [...storedOptions.sections, NO_SECTION] : sectionOptions).map((section) => [section, section])}
          value={sectionFilter}
          onChange={(next) => dispatch(setSectionFilter(next))}
        />
        <MultiSelectFilter
          allLabel="All Profit Centers"
          options={(storedOptions ? storedOptions.profitCenters : profitCenterOptions).map((profitCenter) => [profitCenter, profitCenter])}
          value={profitCenterFilter}
          disabled={!(storedOptions ? storedOptions.profitCenters : profitCenterOptions).length}
          disabledTitle="This upload has no Profit Center column"
          onChange={(next) => dispatch(setProfitCenterFilter(next))}
        />
        <MultiSelectFilter
          allLabel="All Severity"
          options={SEVERITY_OPTIONS}
          value={severityFilter}
          onChange={(next) => dispatch(setSeverityFilter(next))}
        />
        <MultiSelectFilter
          allLabel="All Issue Types"
          options={issueTypeOptions}
          value={issueTypeFilter}
          onChange={(next) => dispatch(setIssueTypeFilter(next))}
        />
        {activeTab !== 'open-issues' && (
          <MultiSelectFilter
            allLabel="All Status"
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(next) => dispatch(setStatusFilter(next))}
          />
        )}
        <MultiSelectFilter
          allLabel="All Doc Types"
          options={(storedOptions ? storedOptions.docTypes : docTypeOptions).map((docType) => [docType, docType])}
          value={docTypeFilter}
          onChange={setDocTypeFilter}
        />
        {(issueDateFromFilter || issueDateToFilter) && (
          <button
            className="case-period-chip"
            type="button"
            title="Clear period"
            onClick={() => dispatch(setIssueDateRange({ from: '', to: '' }))}
          >
            Period: {issueDateFromFilter ? formatDate(issueDateFromFilter) : '…'} – {issueDateToFilter ? formatDate(issueDateToFilter) : '…'}
            <X size={12} />
          </button>
        )}
        <button className="filter-reset-btn" type="button" onClick={handleSharedFilterReset}>
          <RotateCcw size={12} />Reset
        </button>
      </div>
    </div>
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">TDS Analysis</span>
          </div>
          <h1 className="page-title">TDS Analysis</h1>
          {hasUpload && <div className="case-source-line">Using latest Issues upload: <span className="font-mono">{uploadMeta.fileName}</span></div>}
          {openSummary?.latestRun && (
            <div className="case-run-line">
              <span>
                Latest run: {openSummary.latestRun.issuesFound.toLocaleString()} issues found ·{' '}
                <strong>{openSummary.latestRun.newIssues.toLocaleString()}</strong> new ·{' '}
                <strong>{openSummary.latestRun.resolvedIssues.toLocaleString()}</strong> resolved
                {openSummary.latestRun.reopenedIssues ? ` · ${openSummary.latestRun.reopenedIssues.toLocaleString()} reopened` : ''}
              </span>
              <span className="case-run-line-total">
                Open across all runs: <strong>{openSummary.open.toLocaleString()}</strong>
                {openSummary.partlyCorrected ? ` (${openSummary.partlyCorrected.toLocaleString()} partly corrected)` : ''}
                {' '}· tax impact {formatCurrency(openSummary.openTaxImpact)}
              </span>
            </div>
          )}
        </div>
      </div>

      <SapUploadPanel compact showResults={false} defaultCompanyCode="" followSelectedCompany={false} forceAllCompanyOption />

      {!hasUpload && (
        <div className="case-empty-source">
          Upload a combined SAP extract here to build the document ledger and issues.
        </div>
      )}

      {sharedFilters}

      {activeTab === 'open-issues' ? (
        <>
          {resultsTabsPanel}
          <IssueHistory mode="open" showCards refreshKey={trackingRunId} barFilters={openIssueBarFilters} />
        </>
      ) : activeTab === 'issues' ? (
        <Issues embedded initialView={searchParams.get('view') || 'all'} hideFilters beforeSummary={resultsTabsPanel} externalDocTypeFilter={docTypeFilter} onExternalDocTypeFilterChange={setDocTypeFilter} />
      ) : activeTab === 'gl' ? (
        <>
          {resultsTabsPanel}
          {/* Review drawer for the GL issues pop-up, shared with the Issues tab. */}
          <Issues embedded reviewOnly />
          <div className="table-card">
          <DataTable
            columns={glColumns}
            data={glTableRows}
            pageSize={200}
            renderPreHeaderCell={(col) => (
              col.key === 'baseAmount' || col.key === 'tdsAmount' ? (
                <span className="font-mono case-strong" title={`Total ${col.header} across ${glTableRows.length.toLocaleString()} GL rows`}>
                  {formatCurrency(glTotals[col.key])}
                </span>
              ) : col.key === 'glAccount' ? <span className="case-muted">Total</span> : null
            )}
            onRowClick={(row) => setGlModal({ type: 'transactions', key: row.glKey })}
            emptyState={<div className="data-table-empty">No GL accounts found for this view</div>}
          />
          </div>
          {activeGlModalRow && (
            <div className="case-gl-modal-overlay" onClick={() => setGlModal(null)}>
              <div className="case-gl-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
                <div className="case-gl-modal-header">
                  <div>
                    <div className="case-gl-modal-title">
                      {glModal.type === 'issues' ? 'Issues on' : 'Transactions on'} GL <span className="font-mono">{activeGlModalRow.glAccount}</span>
                      {' · '}Section <span className="font-mono">{activeGlModalRow.section}</span>
                      {' · '}Rate <span className="font-mono">{activeGlModalRow.rate != null ? formatRate(activeGlModalRow.rate) : '—'}</span>
                      {activeGlModalRow.ldc && <>{' · '}LDC <span className="font-mono">{activeGlModalRow.ldc.certificate}</span></>}
                    </div>
                    <div className="case-muted">
                      Company <span className="font-mono">{activeGlModalRow.companyCode}</span>
                      {' · '}{activeGlModalRow.rowCount.toLocaleString()} rows
                      {' · '}TDS deducted {activeGlModalRow.deductedRows.toLocaleString()} / not {activeGlModalRow.notDeductedRows.toLocaleString()}
                      {' · '}{activeGlModalRow.issueRows.toLocaleString()} issues
                    </div>
                  </div>
                  <div className="case-gl-modal-actions">
                    <div className="case-tabs" role="tablist">
                      <button type="button" className={`case-tab ${glModal.type === 'transactions' ? 'active' : ''}`} onClick={() => setGlModal({ ...glModal, type: 'transactions' })}>
                        Transactions ({activeGlModalRow.rowCount.toLocaleString()})
                      </button>
                      <button type="button" className={`case-tab ${glModal.type === 'issues' ? 'active' : ''}`} onClick={() => setGlModal({ ...glModal, type: 'issues' })}>
                        Issues ({activeGlModalRow.issueRows.toLocaleString()})
                      </button>
                    </div>
                    {glModal.type === 'issues' && activeGlModalRow.issueRows > 0 && (
                      <button type="button" className="btn btn-outline" onClick={() => downloadGlIssues(activeGlModalRow)}>
                        <Download size={14} />Download
                      </button>
                    )}
                    <button type="button" className="case-gl-modal-close" aria-label="Close" onClick={() => setGlModal(null)}>
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="case-gl-modal-body">
                  {glModalData?.loading ? (
                    <div className="data-table-empty">Loading…</div>
                  ) : glModalData?.error ? (
                    <div className="data-table-empty">Could not load this GL's lines: {glModalData.error}</div>
                  ) : glModal.type === 'issues' ? (
                    <DataTable
                      key={`gl-issues-${activeGlModalRow.glKey}`}
                      columns={glIssueColumns}
                      data={activeGlModalRow.issues}
                      pageSize={100}
                      emptyState={<div className="data-table-empty">No issues on this GL</div>}
                    />
                  ) : (
                    <DataTable
                      key={`gl-transactions-${activeGlModalRow.glKey}`}
                      columns={glTransactionColumns}
                      data={activeGlModalRow.events}
                      pageSize={100}
                      emptyState={<div className="data-table-empty">No transactions on this GL</div>}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {resultsTabsPanel}
          <div className="case-summary-grid">
            {summaryCards.map((card) => (
              <button
                type="button"
                className={`kpi-card case-kpi-button ${quickFilter === card.filter ? 'is-active' : ''}`}
                key={card.label}
                onClick={() => applyQuickFilter(card.tab, card.filter)}
              >
                <div className="kpi-icon-row">
                  <span className="kpi-label">{card.label}</span>
                  <div className={`kpi-icon-box ${card.tone}`}><card.icon size={14} /></div>
                </div>
                <span className="kpi-value">{Number(card.value || 0).toLocaleString()}</span>
                <span className="case-muted">{card.description}</span>
              </button>
            ))}
          </div>
          <div className="table-card">
          <DataTable
            columns={ledgerColumns}
            data={storedGroups.items}
            pageSize={STORED_PAGE_SIZE}
            expandedRowKey={canExpand ? expandedLedgerKey : null}
            onRowClick={canExpand ? (row) => setExpandedLedgerKey((key) => key === row.id ? null : row.id) : undefined}
            renderExpandedRow={canExpand ? renderLedgerLines : undefined}
            emptyState={<div className="data-table-empty">{storedLoading ? 'Loading…' : storedError || (storedOptions && !storedOptions.hasData ? 'No saved SAP lines yet for this company / FY. Analyse a file to start the saved ledger.' : 'No rows found for this view')}</div>}
          />
          <div className="case-stored-pager">
            <span>
              {storedLoading ? 'Loading…' : `${storedGroups.total.toLocaleString()} groups · all runs`}
            </span>
            <div>
              <button className="table-page-btn" type="button" disabled={storedPage <= 1 || storedLoading} onClick={() => setStoredPage((page) => page - 1)}>
                <ChevronLeft size={13} />
              </button>
              <span>Page {storedPage} of {Math.max(1, Math.ceil(storedGroups.total / STORED_PAGE_SIZE)).toLocaleString()}</span>
              <button className="table-page-btn" type="button" disabled={storedPage >= Math.ceil(storedGroups.total / STORED_PAGE_SIZE) || storedLoading} onClick={() => setStoredPage((page) => page + 1)}>
                <ChevronRight size={13} />
              </button>
            </div>
          </div>
          </div>
        </>
      )}
    </div>
  )
}
