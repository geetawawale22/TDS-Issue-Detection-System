import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  Download, FileSearch, SlidersHorizontal, RotateCcw,
  Activity, AlertOctagon, AlertTriangle, CheckCircle2, CheckCheck, IdCard, Loader2, CircleSlash, X,
  BadgeCheck, BadgeX, ChevronLeft, ChevronRight,
} from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge, { severityToTone, issueStatusToTone } from '@/components/Common/StatusBadge'
import IssueDrawer from '@/components/Common/IssueDrawer'
import LinkedCorrectionDocs from '@/components/Common/LinkedCorrectionDocs'
import correctionsService from '@/services/correctionsService'
import { groupMatchesIssue } from '@/utils/correctionMatching'
import {
  CORRECTION_ROLE_LABELS, CORRECTION_ROLES_BY_METHOD, RECONCILE_TOLERANCE, correctionEffect, expectedTdsForIssue,
} from '@/utils/correctionLabels'
import SapUploadPanel from '@/components/Common/SapUploadPanel'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import {
  setSearchQuery, setVendorFilter, setSectionFilter, setSeverityFilter,
  setStatusFilter, setIssueTypeFilter, openDrawer, closeDrawer, resetFilters, correctionGroupUpdated,
  selectActiveIssues, selectActiveVendors, selectActiveSections, selectActiveValidationRows,
  issueDateKey,
} from '@/redux/slices/issuesSlice'
import { startVerifyPan, finishVerifyPan } from '@/redux/slices/panSlice'
import { issueTypeFilterOptionsFor, getDisplayIssueType, simulatePanVerification, MULTI_CATEGORY_DELIMITER, RULE_SCENARIOS } from '@/data/issueTypes'
import { filterIncludes, filterMatchesAny, selectedValues } from '@/utils/multiFilter'
import { formatCurrency, formatDate, formatStatusLabel } from '@/utils/utils'
import { sectionMatches } from '@/utils/sectionAliases'
import { downloadCsv, ISSUE_CSV_COLUMNS, VALIDATION_CSV_COLUMNS } from '@/utils/csvExport'
import uploadRowsService, { uploadRowParams } from '@/services/uploadRowsService'
import SearchInput from '@/components/Common/SearchInput'
import '@/components/Common/Common.css'
import './Issues.css'

const SEVERITY_OPTIONS = [['all','All Severity'],['high','High'],['medium','Medium'],['low','Low']]
const STATUS_OPTIONS   = [['all','All Status'],['open','Open'],['in_review','In Review'],['resolved','Resolved'],['rejected','Rejected']]

const SEVERITY_ICON = { high: AlertOctagon, medium: AlertTriangle, low: CheckCircle2 }
const DEFAULT_SECTION_RATES = {
  '194C': 1,
  '194H': 5,
  '194Q': 0.1,
}
const VIEW_LABELS = {
  all: 'All Transactions',
  issue: 'Issues Found',
  passed: 'Passed',
  insufficient: 'Insufficient Data',
  skipped: 'TDS Not Applicable',
  // Issue resolved by a correction / reversal found in this or an earlier run.
  corrected: 'Corrected',
  tds_deducted: 'TDS Deducted',
  tds_not_deducted: 'TDS Not Deducted',
  passed_deducted: 'TDS Properly Deducted',
  issue_deducted: 'Issues - TDS Deducted',
  passed_not_deducted: 'TDS Not Applicable',
  issue_not_deducted: 'Issues - TDS Not Deducted',
}

function isRowTdsDeducted(row) {
  return Math.abs(Number(row?.tdsAmount || 0)) > 0
}

// Second-row cards split each TDS Deducted / Not Deducted bucket into Passed
// (passed or not-applicable) and Issues (issue rows only). Insufficient Data
// keeps its own card, so a bucket = Passed + Issues + its Insufficient rows.
const BUCKET_VIEWS = {
  passed_deducted: { deducted: true, statuses: ['passed', 'skipped'] },
  issue_deducted: { deducted: true, statuses: ['issue'] },
  passed_not_deducted: { deducted: false, statuses: ['passed', 'skipped'] },
  issue_not_deducted: { deducted: false, statuses: ['issue'] },
}

const LINKABLE_VIEWS = ['all', 'issue', 'passed', 'insufficient', 'skipped', 'corrected', 'tds_deducted', 'tds_not_deducted', ...Object.keys(BUCKET_VIEWS)]

// issueKeys: rows with status 'issue' only count when they still have an issue
// after the Severity/Status/Issue Type filters, same as the Issues Found card.
function rowInBucketView(row, view, issueKeys) {
  const bucket = BUCKET_VIEWS[view]
  if (!bucket || isRowTdsDeducted(row) !== bucket.deducted || !bucket.statuses.includes(row.status)) return false
  return row.status !== 'issue' || issueKeys.has(issueRowKey(row))
}

// Tabs under the cards: the issues split by business category (the scenario
// workbook's sheets, read as problems). Correct rows are in the cards, so only
// open issues go in these tabs — every open issue row in exactly one of them,
// adding up to "Issues · This Upload" — plus the issues already resolved.
// `categories` are reportCategory ids (services/report_category.py).
const OPEN_ISSUE_TABS = [
  { id: 'short', label: 'Short TDS Deducted', categories: ['short'] },
  { id: 'excess', label: 'Excess TDS Deducted', categories: ['excess'] },
  { id: 'not_deducted', label: 'TDS Not Deducted', categories: ['not_deducted'] },
  { id: 'ldc', label: 'TDS Not Deducted as per LDC', categories: ['ldc'] },
  { id: 'advance', label: 'TDS on Advance', categories: ['advance_full', 'advance_partial'] },
  { id: 'not_applicable', label: 'TDS Deducted though Not Applicable', categories: ['not_applicable'] },
]
const ISSUE_TAB_BY_CATEGORY = new Map(OPEN_ISSUE_TABS.flatMap((tab) => tab.categories.map((c) => [c, tab.id])))
const ISSUE_TABS = [
  ...OPEN_ISSUE_TABS,
  // Open issues no tab above takes (e.g. TDS Section Missing).
  { id: 'other', label: 'Other Issues' },
  { id: 'resolved', label: 'Resolved Issues' },
]
const ISSUE_TAB_LABELS = new Map(ISSUE_TABS.map((tab) => [tab.id, tab.label]))

// The issue tab a row belongs to, or null for a correct / unvalidated row.
function issueTabOf(row) {
  if (row.status === 'corrected') return 'resolved'
  if (row.status !== 'issue') return null
  return ISSUE_TAB_BY_CATEGORY.get(row.reportCategory) || 'other'
}

function inferRateFromAmount(baseAmount, tdsAmount) {
  // Invoices are on the credit side, so SAP gives their base as a negative amount.
  const base = Math.abs(Number(baseAmount) || 0)
  const tds = Math.abs(Number(tdsAmount) || 0)
  if (base <= 0 || tds <= 0) return null
  return Number(((tds / base) * 100).toFixed(4))
}

function normaliseRateForDisplay(rate) {
  if (rate == null) return null
  const rounded = Number(Number(rate).toFixed(4))
  return Math.abs(rounded - 2) <= 0.05 ? 2
    : Math.abs(rounded - 10) <= 0.05 ? 10
    : Math.abs(rounded - 1) <= 0.05 ? 1
    : Math.abs(rounded - 0.1) <= 0.01 ? 0.1
    : rounded
}

function SectionCell({ issue }) {
  const oldSection = issue.legacySection || issue.ruleSection
  const newSection = issue.newSection
  const hasOldAndNew = oldSection && newSection && oldSection !== newSection

  if (!hasOldAndNew) {
    return <span className="font-mono issues-section-single">{issue.section}</span>
  }

  return (
    <span className="font-mono issues-section-stack" title={`${oldSection} /${newSection}`}>
      <span>{oldSection} /</span>
      <span>{newSection}</span>
    </span>
  )
}


/**
 * Rows that reference another document (SAP Reference_Document_Number) name it.
 * With no TDS of their own they are credit notes against that document; with
 * TDS they are TDS corrections (top-up / reversal).
 */
function correctionRowLabel(row) {
  const original = String(row?.correctionOf ?? '').trim()
  const hasTds = Math.abs(Number(row?.tdsAmount) || 0) > 0
  if (!hasTds) return original ? `Credit note for doc ${original}` : 'Credit Note'
  return original ? `Correction to doc ${original}` : 'Correction Entry'
}

// Where the original document stands now (backend correctionOriginalStatus,
// read from the issue history after the run): the headline for the entry.
const CORRECTION_ORIGINAL_STATUS = {
  resolved: { suffix: 'Original resolved', tone: 'success' },
  partial: { suffix: 'Partly corrected', tone: 'warning' },
  open: { suffix: 'Original still open', tone: 'danger' },
}

/** { label, tone } for a correction / credit-note row. */
function correctionRowBadge(row) {
  const label = correctionRowLabel(row)
  const original = CORRECTION_ORIGINAL_STATUS[row?.correctionOriginalStatus]
  if (original) return { label: `${label} · ${original.suffix}`, tone: original.tone }
  // The original has no issue: the entry's own TDS check is all there is.
  return row?.status === 'passed' ? { label: `${label} · Passed`, tone: 'success' } : { label, tone: 'default' }
}

/** Review-drawer text for a correction row: the original first, then the entry's own TDS check. */
function correctionRowAction(row) {
  const original = row.correctionOf
  const hasTds = Math.abs(Number(row.tdsAmount) || 0) > 0
  const ownCheck = !hasTds
    ? ''
    : row.status === 'passed'
      ? ' This entry\'s own TDS matches the expected rate.'
      : ' This entry\'s own TDS rate was not checked: SAP gives no section or rate on it.'
  if (row.correctionOriginalStatus === 'resolved') {
    return `No action needed. Original ${original}: resolved — every issue on it is now resolved (see Correction Center).${ownCheck}`
  }
  if (row.correctionOriginalStatus === 'partial') {
    return `Original ${original} is partly corrected: a shortfall remains on it (see Open Issues · All Runs). Post a further correction for the rest.${ownCheck}`
  }
  if (row.correctionOriginalStatus === 'open') {
    return `Original ${original} still has an open issue; this entry did not resolve it. Check this entry's amount and section against ${original}.${ownCheck}`
  }
  if (row.correctionOriginalFlagged) {
    return `No separate action. This entry corrects document ${original}; its effect is applied to that document's issue (see Open Issues · All Runs and Correction Center).`
  }
  return row.status === 'passed'
    ? `No action needed. The TDS on this entry matches the expected rate. No TDS issue is recorded for document ${original}.`
    : `No TDS issue is recorded for document ${original}. If this entry cancels it, check whether the TDS deducted on ${original} should be reversed or adjusted.`
}

function signedAmount(value) {
  const number = Number(value) || 0
  if (Math.abs(number) < 0.005) return formatCurrency(0)
  return `${number < 0 ? '−' : '+'}${formatCurrency(Math.abs(number))}`
}

function numberOrNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

// The match list shows at most this many search hits (selected rows always stay).
const MATCH_ROW_LIMIT = 80

function stripLeadingZeros(value) {
  return String(value || '').replace(/^0+(?=\d)/, '')
}

function MatchSapRowsModal({ issue, rows, matchCount = rows.length, saving = false, selectedIds, roles = {}, method, remarks, search, onSearch, onToggle, onRoleChange, onMethodChange, onRemarksChange, onClose, onSave }) {
  if (!issue) return null
  const selectedCount = selectedIds.size
  const selectedRows = rows.filter((row) => selectedIds.has(row.id))
  // Live check: TDS applied + what the ticked rows do (by role) against the expected TDS.
  const appliedTds = Math.abs(Number(issue.tdsAmount) || 0)
  const expectedTds = expectedTdsForIssue(issue)
  const selectedEffect = selectedRows.reduce((sum, row) => sum + correctionEffect(roles[row.id], row.tdsAmount), 0)
  const difference = Number((expectedTds - (appliedTds + selectedEffect)).toFixed(2))
  const reconciled = Math.abs(difference) <= RECONCILE_TOLERANCE
  const needsRemark = selectedCount > 0 && !reconciled && !remarks.trim()
  const roleOptions = CORRECTION_ROLES_BY_METHOD[method] || CORRECTION_ROLES_BY_METHOD.DIFFERENCE_ONLY

  return (
    <div className="correction-modal-overlay" onClick={onClose}>
      <div className="correction-modal correction-modal--wide" onClick={(event) => event.stopPropagation()}>
        <div className="correction-modal-header">
          <div>
            <div className="correction-modal-kicker">Match Existing SAP Rows</div>
            <h2>Resolve issue from uploaded SAP entries</h2>
            <div className="font-mono correction-modal-doc">Original doc {issue.docNo}</div>
          </div>
          <button className="issue-drawer-close" type="button" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="match-toolbar">
          <SearchInput
            wrapperClassName="search-input--fill"
            value={search}
            onChange={onSearch}
            placeholder="Search SAP doc no. / vendor name / vendor no. / PAN / section"
            aria-label="Search SAP rows by document number or vendor"
          />
          <select className="filter-select" value={method} onChange={(event) => onMethodChange(event.target.value)}>
            <option value="DIFFERENCE_ONLY">Difference only</option>
            <option value="FULL_REVERSAL">Full reversal and fresh deduction</option>
          </select>
        </div>

        <div className="match-summary-strip match-summary-strip--five">
          <div><span>TDS applied</span><strong>{formatCurrency(appliedTds)}</strong></div>
          <div><span>Expected TDS</span><strong>{formatCurrency(expectedTds)}</strong></div>
          <div><span>Needed correction</span><strong>{signedAmount(expectedTds - appliedTds)}</strong></div>
          <div><span>Selected rows ({selectedCount})</span><strong>{signedAmount(selectedEffect)}</strong></div>
          <div className={selectedCount === 0 ? '' : reconciled ? 'match-summary--ok' : 'match-summary--diff'}>
            <span>Difference</span>
            <strong>{selectedCount === 0 ? '—' : reconciled ? 'Reconciled ✓' : `${difference > 0 ? 'Short' : 'Excess'} ${formatCurrency(Math.abs(difference))}`}</strong>
          </div>
        </div>

        <div className="match-row-list">
          <div className="match-row match-row--head">
            <span></span>
            <span>Doc No.</span>
            <span>Vendor</span>
            <span>Section</span>
            <span>Base</span>
            <span>TDS</span>
            <span>Date</span>
            <span>Role</span>
          </div>
          {rows.length === 0 ? (
            <div className="match-empty">No uploaded rows match the search.</div>
          ) : rows.map((row) => (
            <label className="match-row" key={row.id}>
              <input type="checkbox" checked={selectedIds.has(row.id)} onChange={() => onToggle(row.id)} />
              <span className="font-mono">{row.docNo}</span>
              <span>{row.vendor || '—'}</span>
              <span className="font-mono">{row.section || '—'}</span>
              <span className="font-mono">{formatCurrency(row.baseAmount)}</span>
              <span className="font-mono">{formatCurrency(row.tdsAmount)}</span>
              <span>{formatDate(row.postingDate || row.date)}</span>
              {selectedIds.has(row.id) ? (
                <select className="filter-select match-role-select" value={roles[row.id] || roleOptions[0]}
                  aria-label={`Role of SAP row ${row.docNo}`}
                  onChange={(event) => onRoleChange(row.id, event.target.value)}>
                  {roleOptions.map((role) => <option key={role} value={role}>{CORRECTION_ROLE_LABELS[role]}</option>)}
                </select>
              ) : <span className="match-role-empty">—</span>}
            </label>
          ))}
        </div>
        {matchCount > MATCH_ROW_LIMIT && (
          <div className="match-limit-note">
            Showing the first {MATCH_ROW_LIMIT} of {matchCount.toLocaleString()} matching rows. Narrow the search to find others.
          </div>
        )}

        <label className="correction-field">
          <span>Remarks</span>
          <textarea value={remarks} onChange={(event) => onRemarksChange(event.target.value)} placeholder="Why these SAP rows resolve the issue" />
        </label>
        {needsRemark && (
          <div className="match-remark-hint">
            The selected rows leave a difference of {formatCurrency(Math.abs(difference))}. Explain it in Remarks to save, or change the rows / roles.
          </div>
        )}

        <div className="correction-modal-actions">
          <button className="btn btn-outline" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="button" disabled={selectedCount === 0 || saving || needsRemark} onClick={onSave}>{saving ? 'Saving…' : 'Save matched group'}</button>
        </div>
      </div>
    </div>
  )
}

function issueRowKey(row) {
  // Do not include section here. Wrong-section issues intentionally display the
  // expected/rule section, while the validation row may display the applied
  // section, so section-sensitive keys hide those issue rows from the table.
  // Line item, assignment and withholding type/code tell apart SAP rows that
  // share a document number and amounts (one row per withholding type, or the
  // same line exported against two clearing items), so each row only shows
  // its own issue.
  // Uploads analysed now give each issue its validation row's rowIndex: an
  // exact pairing, needed because an issue's amounts can differ from its
  // row's ("Possible Missed TDS Deduction" estimates a base the row lacks).
  // Older cached uploads have none and fall back to the field key below.
  if (row.rowIndex != null) return `ROW|${row.rowIndex}`
  return [
    row.docNo,
    row.lineItem,
    row.assignmentNumber,
    row.withholdingTaxType,
    row.withholdingTaxCode,
    row.vendorId,
    row.vendorPan,
    row.docType,
    row.baseAmount,
    row.tdsAmount,
  ].map((value) => String(value ?? '').trim().toUpperCase()).join('|')
}

// SAP exports can repeat an identical line (same doc, line item, vendor and
// amounts). Such rows share an issueRowKey, so each one picks up every copy's
// issues; list each issue type once per row so a row never shows doubles.
function uniqueIssueTypes(rowIssues) {
  const byLabel = new Map()
  rowIssues.forEach((issue) => {
    const label = getDisplayIssueType(issue)
    if (!byLabel.has(label)) byLabel.set(label, { id: issue.id, label, severity: issue.severity })
  })
  return [...byLabel.values()]
}

// Table page size; a large SAP pull's table is paged by the server at this size.
const TABLE_PAGE_SIZE = 1000

/**
 * A large SAP pull's saved row (backend/api/upload_rows.py: the validation row
 * plus its own `issues`) as the table shows it, built exactly like
 * viewTableRows / buildIssueValidationRows do for a small upload.
 */
function serverTableRow(row, view, rowNumber) {
  const rowIssues = row.issues || []
  if (view === 'issue') {
    const primaryIssue = rowIssues[0]
    const issueTypes = uniqueIssueTypes(rowIssues)
    return {
      ...row,
      _rowNumber: rowNumber,
      id: `issue-${row.rowIndex}`,
      issueId: primaryIssue?.id,
      category: primaryIssue?.category,
      issueType: primaryIssue?.issueType,
      issueTypeLabel: issueTypes.map((issue) => issue.label).join(' | '),
      issueTypes,
      severity: primaryIssue?.severity,
      legacySection: primaryIssue?.legacySection,
      ruleSection: primaryIssue?.ruleSection,
      newSection: primaryIssue?.newSection,
      plainEnglish: primaryIssue?.plainEnglish,
      recommendedAction: primaryIssue?.recommendedAction,
      status: 'issue',
      issueStatus: primaryIssue?.status,
      correctionGroupId: primaryIssue?.correctionGroupId,
    }
  }
  // Same issue the small-upload table pairs with the row (the last one on it).
  const matchingIssue = rowIssues[rowIssues.length - 1]
  return {
    ...row,
    _rowNumber: rowNumber,
    id: `${view}-${row.rowIndex}`,
    issueId: matchingIssue?.id,
    severity: matchingIssue?.severity,
    issueTypeLabel: matchingIssue ? getDisplayIssueType(matchingIssue) : null,
    ...(BUCKET_VIEWS[view] && row.status === 'issue' && rowIssues.length ? { issueTypes: uniqueIssueTypes(rowIssues) } : {}),
  }
}

// Posting-date window from a Dashboard click (a month or the Dashboard's dates).
export function rowInDateRange(row, from, to) {
  if (!from && !to) return true
  const dateKey = issueDateKey(row)
  if (from && (!dateKey || dateKey < from)) return false
  if (to && (!dateKey || dateKey > to)) return false
  return true
}

// Severity, Status and Issue Type only exist on issues, so while one is active
// the matching rows are issue rows only and every card narrows to them.
export function hasIssueLevelFilters({ severityFilter, statusFilter, issueTypeFilter }) {
  return Boolean(selectedValues(severityFilter) || selectedValues(statusFilter) || selectedValues(issueTypeFilter))
}

// Filter predicates shared with TDS Analysis (TDSCaseBuilder), so its tab and
// card counts are computed exactly like this page's summary cards.
// `filters` = { searchQuery, vendorFilter, sectionFilter, docTypeFilter,
//               severityFilter, statusFilter, issueTypeFilter }
export function issueMatchesFilters(issue, filters) {
  const { searchQuery, vendorFilter, sectionFilter, docTypeFilter, severityFilter, statusFilter, issueTypeFilter, profitCenterFilter, dateFrom, dateTo } = filters
  if (!rowInDateRange(issue, dateFrom, dateTo)) return false
  if (!filterIncludes(profitCenterFilter, issue.profitCenter)) return false
  if (searchQuery) {
    const q = searchQuery.toLowerCase()
    if (
      !issue.vendor?.toLowerCase().includes(q) &&
      !issue.id?.toLowerCase().includes(q) &&
      !String(issue.docNo ?? '').toLowerCase().includes(q) &&
      !String(issue.docType ?? '').toLowerCase().includes(q) &&
      !String(issue.vendorId ?? '').toLowerCase().includes(q) &&
      !String(issue.section ?? '').toLowerCase().includes(q) &&
      !String(issue.vendorPan ?? '').toLowerCase().includes(q)
    ) return false
  }
  if (!filterIncludes(vendorFilter, issue.vendor)) return false
  if (!filterMatchesAny(sectionFilter, (section) => sectionMatches(section, [issue.section, issue.legacySection, issue.ruleSection, issue.newSection]))) return false
  if (!filterIncludes(docTypeFilter, String(issue.docType ?? '').toUpperCase())) return false
  if (!filterIncludes(severityFilter, issue.severity)) return false
  if (!filterIncludes(statusFilter, issue.status)) return false
  const allowedTypes = allowedIssueTypes(issueTypeFilter)
  if (allowedTypes) {
    const rowTypes = [getDisplayIssueType(issue), issue.category, issue.issueTypeLabel, issue.issueType].filter(Boolean)
    if (!rowTypes.some((type) => allowedTypes.includes(type))) return false
  }
  return true
}

// Each issue-type option value can itself cover several backend categories.
function allowedIssueTypes(issueTypeFilter) {
  const values = selectedValues(issueTypeFilter)
  return values ? values.flatMap((value) => value.split(MULTI_CATEGORY_DELIMITER)) : null
}

export function validationRowMatchesFilters(row, filters) {
  const { searchQuery, vendorFilter, sectionFilter, docTypeFilter, profitCenterFilter, dateFrom, dateTo } = filters
  if (!rowInDateRange(row, dateFrom, dateTo)) return false
  if (!filterIncludes(profitCenterFilter, row.profitCenter)) return false
  const q = searchQuery.trim().toLowerCase()
  if (q) {
    const searchable = [
      row.vendor,
      row.docNo,
      row.docType,
      row.vendorId,
      row.section,
      row.vendorPan,
    ].filter(Boolean).join(' ').toLowerCase()
    if (!searchable.includes(q)) return false
  }
  if (!filterIncludes(vendorFilter, row.vendor)) return false
  if (!filterMatchesAny(sectionFilter, (section) => sectionMatches(section, [row.section, row.legacySection, row.ruleSection, row.newSection]))) return false
  if (!filterIncludes(docTypeFilter, String(row.docType ?? '').toUpperCase())) return false
  return true
}

// Issue-status validation rows that still have at least one issue after the
// issue-level filters (severity/status/type) — a row failing two rules counts once.
export function issueRowsMatchingIssues(validationRows, filteredIssues) {
  const issueKeys = new Set(filteredIssues.map(issueRowKey))
  return validationRows.filter((row) => row.status === 'issue' && issueKeys.has(issueRowKey(row)))
}

// Rows behind the cards: everything matching the filter bar, narrowed to rows
// with a matching issue while an issue-level filter is active.
export function validationRowsMatchingFilters(validationRows, filteredIssues, filters) {
  const rows = validationRows.filter((row) => validationRowMatchesFilters(row, filters))
  return hasIssueLevelFilters(filters) ? issueRowsMatchingIssues(rows, filteredIssues) : rows
}

// serverRunId: a large SAP pull's run. Its rows are not in the browser; the same
// cards, tabs and table are worked out and paged by the server (api/upload_rows.py).
export default function Issues({ embedded = false, initialView = 'all', filtersFirst = false, beforeSummary = null, hideFilters = false, externalDocTypeFilter = null, onExternalDocTypeFilterChange = null, reviewOnly = false, serverRunId = null } = {}) {
  const serverMode = serverRunId != null && !reviewOnly
  const dispatch = useDispatch()
  const [searchParams] = useSearchParams()
  const [validationView, setValidationView] = useState('all')
  // Business category tab under the cards (same categories as Reports →
  // TDS Category Report); narrows the table within the selected card.
  // null = no tab; picking another card clears it.
  const [categoryTab, setCategoryTab] = useState(null)
  useEffect(() => { setCategoryTab(null) }, [validationView])
  const [reviewValidationRow, setReviewValidationRow] = useState(null)
  const [docTypeFilter, setDocTypeFilter] = useState('all')
  const [matchIssue, setMatchIssue] = useState(null)
  const [matchMethod, setMatchMethod] = useState('DIFFERENCE_ONLY')
  const [matchRemarks, setMatchRemarks] = useState('')
  const [matchSearch, setMatchSearch] = useState('')
  const [selectedMatchIds, setSelectedMatchIds] = useState(() => new Set())
  const [matchSaving, setMatchSaving] = useState(false)
  // Role of each ticked row (Reversal / Fresh Deduction / Additional Deduction), chosen by the user.
  const [matchRoles, setMatchRoles] = useState({})
  const activeDocTypeFilter = externalDocTypeFilter ?? docTypeFilter
  const setActiveDocTypeFilter = onExternalDocTypeFilterChange ?? setDocTypeFilter
  const {
    searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter,
    issueTypeFilter, profitCenterFilter, issueDateFromFilter, issueDateToFilter, selectedIssueId, drawerOpen, dataSource, uploadMeta, correctionGroups,
  } = useSelector((s) => s.issues)

  const issues = useSelector(selectActiveIssues)
  const issueTypeOptions = useMemo(
    () => issueTypeFilterOptionsFor(issues, issueTypeFilter),
    [issues, issueTypeFilter],
  )
  const activeValidationRows = useSelector(selectActiveValidationRows)
  const vendorNames = useSelector(selectActiveVendors)
  const sections = useSelector(selectActiveSections)
  useEffect(() => {
    if (embedded) {
      setValidationView(LINKABLE_VIEWS.includes(initialView) ? initialView : 'all')
      return
    }

    dispatch(resetFilters())
    setActiveDocTypeFilter('all')

    const view = searchParams.get('view')
    const severity = searchParams.get('severity')
    const status = searchParams.get('status')
    const issueType = searchParams.get('type')
    const section = searchParams.get('section')
    const vendor = searchParams.get('vendor')

    if (['all', 'issue', 'passed', 'insufficient', 'skipped'].includes(view)) {
      setValidationView(view)
    } else {
      setValidationView('all')
    }
    if (severity) dispatch(setSeverityFilter(severity))
    if (status) dispatch(setStatusFilter(status))
    if (issueType) dispatch(setIssueTypeFilter(issueType))
    if (section) dispatch(setSectionFilter(section))
    if (vendor) dispatch(setVendorFilter(vendor))
  }, [dispatch, embedded, initialView, searchParams])

  // PAN is verified for every vendor in the loaded issue set at once, not
  // per-issue (see IssueDrawer, which just displays the result) — this
  // mirrors how a real bulk PAN-verification API call would work: one
  // request per vendor, not one per issue row.
  const [bulkVerifying, setBulkVerifying] = useState(false)

  function handleVerifyAllPans() {
    if (bulkVerifying) return
    const vendorPanMap = new Map()
    for (const issue of issues) {
      if (issue.vendorId && issue.vendorId !== '—' && !vendorPanMap.has(issue.vendorId)) {
        vendorPanMap.set(issue.vendorId, issue.vendorPan)
      }
    }
    const vendorIds = [...vendorPanMap.keys()]
    if (vendorIds.length === 0) {
      toast('No vendors to verify')
      return
    }
    setBulkVerifying(true)
    vendorIds.forEach((id) => dispatch(startVerifyPan(id)))
    // Simulate the latency of a real bulk government PAN API round-trip.
    setTimeout(() => {
      let active = 0, inactive = 0, invalid = 0
      vendorIds.forEach((vendorId) => {
        const result = simulatePanVerification(vendorPanMap.get(vendorId))
        dispatch(finishVerifyPan({ vendorId, result: { ...result, checkedAt: new Date().toISOString() } }))
        if (result.status === 'Active') active++
        else if (result.status === 'Inactive') inactive++
        else invalid++
      })
      setBulkVerifying(false)
      toast.success(
        `Verified ${vendorIds.length} vendor PAN${vendorIds.length === 1 ? '' : 's'} — ${active} active`
        + (inactive ? `, ${inactive} inactive` : '')
        + (invalid ? `, ${invalid} invalid format` : ''),
      )
    }, 900)
  }

  const filterValues = useMemo(() => ({
    searchQuery, vendorFilter, sectionFilter, docTypeFilter: activeDocTypeFilter,
    severityFilter, statusFilter, issueTypeFilter,
    profitCenterFilter, dateFrom: issueDateFromFilter, dateTo: issueDateToFilter,
  }), [searchQuery, vendorFilter, sectionFilter, activeDocTypeFilter, severityFilter, statusFilter, issueTypeFilter, profitCenterFilter, issueDateFromFilter, issueDateToFilter])
  const filtered = useMemo(() => issues.filter((issue) => issueMatchesFilters(issue, filterValues)), [issues, filterValues])

  // ── Large SAP pull (serverMode): cards and table pages come from the server. ──
  const selectedCompanyCode = useSelector((s) => s.app.selectedCompanyCode)
  const selectedFinancialYear = useSelector((s) => s.app.financialYear)
  const [serverSearch, setServerSearch] = useState(searchQuery)
  useEffect(() => {
    const timer = setTimeout(() => setServerSearch(searchQuery.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])
  const serverParams = useMemo(() => (serverMode ? uploadRowParams({
    runId: serverRunId,
    companyCode: selectedCompanyCode,
    financialYear: selectedFinancialYear,
    filters: { ...filterValues, searchQuery: serverSearch },
  }) : null), [serverMode, serverRunId, selectedCompanyCode, selectedFinancialYear, filterValues, serverSearch])
  const serverParamsKey = JSON.stringify(serverParams)
  const [serverSummary, setServerSummary] = useState(null)
  const [serverPage, setServerPage] = useState({ items: [], total: 0, tabCounts: {}, hasReportCategories: false })
  const [serverPageNo, setServerPageNo] = useState(1)
  const [serverLoading, setServerLoading] = useState(false)
  const [serverError, setServerError] = useState('')
  useEffect(() => { setServerPageNo(1) }, [serverParamsKey, validationView, categoryTab])
  useEffect(() => {
    if (!serverMode) return undefined
    let cancelled = false
    uploadRowsService.getSummary(JSON.parse(serverParamsKey))
      .then((data) => { if (!cancelled) setServerSummary(data) })
      .catch((err) => { if (!cancelled) setServerError(err.message || 'Could not load this upload') })
    return () => { cancelled = true }
  }, [serverMode, serverParamsKey])
  useEffect(() => {
    if (!serverMode) return undefined
    let cancelled = false
    setServerLoading(true)
    setServerError('')
    uploadRowsService.getPage(JSON.parse(serverParamsKey), { view: validationView, tab: categoryTab, page: serverPageNo, pageSize: TABLE_PAGE_SIZE })
      .then((data) => { if (!cancelled) setServerPage(data) })
      .catch((err) => { if (!cancelled) setServerError(err.message || 'Could not load this upload') })
      .finally(() => { if (!cancelled) setServerLoading(false) })
    return () => { cancelled = true }
  }, [serverMode, serverParamsKey, validationView, categoryTab, serverPageNo])
  // Issues on the rows shown, so Review opens the same drawer as for a small upload.
  const serverIssuesById = useMemo(() => new Map(
    serverPage.items.flatMap((row) => (row.issues || []).map((issue) => [issue.id, issue])),
  ), [serverPage])

  const selectedIssue = issues.find((i) => i.id === selectedIssueId) ?? serverIssuesById.get(selectedIssueId) ?? null

  // Company/FY-scoped validation rows (see selectActiveValidationRows), with
  // one extra reclassification: a row with a zero base amount can't actually
  // be rate-checked, so it reads as "insufficient data" rather than a false
  // "passed". Rows covered by a 100%-exemption (nil) LDC certificate stay
  // passed: zero TDS is correct by certificate, whatever the base amount.
  const adjustedValidationRows = useMemo(() => (
    activeValidationRows.map((row) => (
      row.status !== 'skipped' && row.status !== 'issue' && Number(row.baseAmount) === 0
        && !(row.ldcCertificate && Number(row.ldcExemptionPercent) >= 100)
        ? {
          ...row,
          status: 'insufficient',
          reason: 'Base amount is zero, so TDS cannot be validated for this row.',
        }
        : row
    ))
  ), [activeValidationRows])
  const displayValidationRows = adjustedValidationRows
  const ldcValidityByCertificate = useMemo(() => {
    const pairs = (uploadMeta?.ldcUtilization || [])
      .filter((row) => row.certificateNumber)
      .map((row) => [row.certificateNumber, {
        validFrom: row.validFrom,
        validTo: row.validTo,
      }])
    return new Map(pairs)
  }, [uploadMeta])
  const drawerIssue = useMemo(() => {
    const issue = reviewValidationRow || selectedIssue
    if (!issue?.ldcCertificate) return issue
    const ldcValidity = ldcValidityByCertificate.get(issue.ldcCertificate)
    return {
      ...issue,
      ldcValidFrom: issue.ldcValidFrom ?? ldcValidity?.validFrom,
      ldcValidTo: issue.ldcValidTo ?? ldcValidity?.validTo,
    }
  }, [reviewValidationRow, selectedIssue, ldcValidityByCertificate])
  const drawerIsOpen = Boolean(reviewValidationRow) || drawerOpen
  const drawerCorrectionGroups = useMemo(() => {
    if (!drawerIssue || reviewValidationRow) return []
    // Same issue key, or same company + fiscal year + document + line item.
    return correctionGroups.filter((group) => groupMatchesIssue(group, drawerIssue))
  }, [correctionGroups, drawerIssue, reviewValidationRow])

  // Every row the issue could be matched to. Ids are fixed here, before any
  // search, so a selection still points at the same row after the search changes.
  // Large pull: the server searches the rows; ticked rows are kept across searches.
  const [serverMatch, setServerMatch] = useState({ items: [], total: 0 })
  const [serverMatchPicked, setServerMatchPicked] = useState({})
  useEffect(() => {
    if (!serverMode || !matchIssue) return undefined
    let cancelled = false
    const timer = setTimeout(() => {
      uploadRowsService.search({ runId: serverRunId, q: matchSearch.trim(), excludeDoc: String(matchIssue.docNo || '') })
        .then((data) => { if (!cancelled) setServerMatch(data) })
        .catch(() => { if (!cancelled) setServerMatch({ items: [], total: 0 }) })
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [serverMode, serverRunId, matchIssue, matchSearch])
  const matchPoolRows = useMemo(() => {
    if (!matchIssue) return []
    if (serverMode) {
      const shown = new Set(serverMatch.items.map((row) => row.id))
      return [...Object.values(serverMatchPicked).filter((row) => !shown.has(row.id)), ...serverMatch.items]
    }
    return displayValidationRows
      .filter((row) => String(row.docNo || '') !== String(matchIssue.docNo || ''))
      .map((row, index) => ({
        ...row,
        id: row.id || `match-${index}-${row.docNo}`,
      }))
  }, [displayValidationRows, matchIssue, serverMode, serverMatch, serverMatchPicked])

  // Search hits (first MATCH_ROW_LIMIT) plus every selected row, in upload order,
  // so rows picked under an earlier search stay visible and counted.
  const { rows: matchCandidateRows, matchCount: matchSearchCount } = useMemo(() => {
    const query = matchSearch.trim().toLowerCase()
    const docQuery = stripLeadingZeros(query)
    const matchesQuery = (row) => !query
      || [row.docNo, row.vendor, row.vendorId, row.vendorPan, row.section, row.docType]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query)
      || stripLeadingZeros(row.docNo).includes(docQuery)
    const rows = []
    let matchCount = 0
    matchPoolRows.forEach((row) => {
      const isSelected = selectedMatchIds.has(row.id)
      const isMatch = matchesQuery(row)
      if (isMatch) matchCount += 1
      if (isSelected || (isMatch && matchCount <= MATCH_ROW_LIMIT)) rows.push(row)
    })
    // Large pull: the server already searched; its total counts every hit.
    if (serverMode) return { rows: matchPoolRows, matchCount: Math.max(serverMatch.total, matchPoolRows.length) }
    return { rows, matchCount }
  }, [matchPoolRows, matchSearch, selectedMatchIds, serverMode, serverMatch])

  function handleOpenSapMatch(issue) {
    setMatchIssue(issue)
    setMatchMethod('DIFFERENCE_ONLY')
    setMatchRemarks('')
    setMatchSearch(String(issue.vendorId || issue.vendor || issue.docNo || ''))
    setSelectedMatchIds(new Set())
    setMatchRoles({})
    setServerMatchPicked({})
  }

  // Starting role for a newly ticked row; the user can change it in the Role column.
  function defaultMatchRole(method, roles, selectedIds) {
    if (method !== 'FULL_REVERSAL') return 'ADDITIONAL_DEDUCTION'
    const hasReversal = [...selectedIds].some((id) => roles[id] === 'REVERSAL')
    return hasReversal ? 'FRESH_DEDUCTION' : 'REVERSAL'
  }

  function handleToggleMatchRow(rowId) {
    const next = new Set(selectedMatchIds)
    const roles = { ...matchRoles }
    if (serverMode) {
      setServerMatchPicked((picked) => {
        const copy = { ...picked }
        if (next.has(rowId)) delete copy[rowId]
        else {
          const row = matchPoolRows.find((candidate) => candidate.id === rowId)
          if (row) copy[rowId] = row
        }
        return copy
      })
    }
    if (next.has(rowId)) {
      next.delete(rowId)
      delete roles[rowId]
    } else {
      roles[rowId] = defaultMatchRole(matchMethod, roles, next)
      next.add(rowId)
    }
    setSelectedMatchIds(next)
    setMatchRoles(roles)
  }

  function handleMatchRoleChange(rowId, role) {
    setMatchRoles((prev) => ({ ...prev, [rowId]: role }))
  }

  // A new method offers different roles: re-assign ticked rows (first one reverses for Full Reversal).
  function handleMatchMethodChange(method) {
    setMatchMethod(method)
    const roles = {}
    matchPoolRows.filter((row) => selectedMatchIds.has(row.id)).forEach((row) => {
      roles[row.id] = defaultMatchRole(method, roles, new Set(Object.keys(roles)))
    })
    setMatchRoles(roles)
  }

  // Saved in the backend, which also resolves the issue in the issue history.
  async function handleSaveSapMatch() {
    if (!matchIssue || selectedMatchIds.size === 0 || matchSaving) return
    const rows = matchPoolRows.filter((row) => selectedMatchIds.has(row.id))
    const issue = matchIssue
    setMatchSaving(true)
    try {
      const group = await correctionsService.create({
        issue: {
          issueKey: issue.issueKey || null,
          companyCode: issue.companyCode || null,
          fiscalYear: issue.fiscalYear || null,
          docNo: String(issue.docNo || ''),
          lineItem: issue.lineItem || null,
          category: issue.category || null,
          vendor: issue.vendor || null,
          vendorId: issue.vendorId || null,
          vendorPan: issue.vendorPan || null,
          section: issue.section || null,
          baseAmount: numberOrNull(issue.baseAmount),
          appliedRate: numberOrNull(issue.appliedRate),
          expectedRate: numberOrNull(issue.expectedRate),
          tdsAmount: numberOrNull(issue.tdsAmount),
          taxImpact: numberOrNull(issue.taxImpact),
        },
        method: matchMethod,
        remarks: matchRemarks,
        entries: rows.map((row) => ({
          role: matchRoles[row.id] || defaultMatchRole(matchMethod, {}, new Set()),
          docNo: String(row.docNo || ''),
          companyCode: row.companyCode || null,
          fiscalYear: row.fiscalYear || null,
          lineItem: row.lineItem || null,
          docType: row.docType || null,
          postingDate: row.postingDate || row.date || null,
          vendor: row.vendor || null,
          vendorId: row.vendorId || null,
          section: row.section || null,
          baseAmount: numberOrNull(row.baseAmount),
          appliedRate: numberOrNull(row.appliedRate),
          tdsAmount: numberOrNull(row.tdsAmount),
        })),
      })
      dispatch(correctionGroupUpdated(group))
      toast.success(`SAP rows matched · ${group.groupId}`)
      if (issue.issueKey && !group.issueTracked) {
        toast('Saved, but this issue is not in the issue history yet. Re-analyse the file to track it.')
      }
      setMatchIssue(null)
      setSelectedMatchIds(new Set())
    } catch (error) {
      toast.error(error.message || 'Could not save the matched rows')
    } finally {
      setMatchSaving(false)
    }
  }

  function buildValidationReviewIssue(row) {
    const isInsufficient = row.status === 'insufficient'
    const isSkipped = row.status === 'skipped'
    const inferredRate = normaliseRateForDisplay(inferRateFromAmount(row.baseAmount, row.tdsAmount))
    const statedRate = normaliseRateForDisplay(row.appliedRate)
    const expectedRate = normaliseRateForDisplay(
      row.expectedRate
      ?? (row.section === '194J' && [2, 10].includes(statedRate) ? statedRate : null)
      ?? inferredRate
      ?? DEFAULT_SECTION_RATES[row.section]
      ?? null
    )
    const appliedRate = inferredRate != null && expectedRate != null && Math.abs(inferredRate - expectedRate) <= 0.05
      ? inferredRate
      : statedRate ?? inferredRate
    const isCorrection = row.rowKind === 'correction'
    const isCorrected = row.status === 'corrected'
    // A corrected row is a resolved issue: show the issue it had, not 'Corrected'.
    const issueLabel = isCorrected ? (row.originalReason || 'Corrected') : isCorrection ? correctionRowBadge(row).label : isSkipped ? 'TDS Not Applicable' : isInsufficient ? 'Insufficient Data' : 'Passed Validation'
    const ldcValidity = ldcValidityByCertificate.get(row.ldcCertificate)

    return {
      ...row,
      ldcValidFrom: row.ldcValidFrom ?? ldcValidity?.validFrom,
      ldcValidTo: row.ldcValidTo ?? ldcValidity?.validTo,
      id: row.id || `${isSkipped ? 'SKIPPED' : isInsufficient ? 'INSUFFICIENT' : 'PASSED'}-${row.docNo}`,
      category: issueLabel,
      issueTypeLabel: issueLabel,
      issueType: isSkipped ? 'SKIPPED_ROW' : isInsufficient ? 'INSUFFICIENT_DATA' : 'PASSED_VALIDATION',
      severity: isCorrected
        ? (row.originalSeverity || RULE_SCENARIOS.find((scenario) => scenario.category === row.originalReason)?.severity || 'high')
        : isInsufficient ? 'medium' : 'low',
      status: isCorrected ? 'resolved' : 'open',
      rowStatus: row.status,
      plainEnglish: isCorrected
        ? `Flagged as ${row.originalReason || 'an issue'}. Now resolved, so no TDS action is pending on this row.`
        : row.reason || (
        isSkipped
          ? 'TDS is not applicable to this row, so it was excluded from TDS validation.'
          : isInsufficient
          ? 'This row does not have enough usable data to complete the TDS validation.'
          : 'Validated with no issue found.'
      ),
      recommendedAction: isCorrected
        ? `No action needed — ${row.reason}${row.originalReason ? ` (was: ${row.originalReason})` : ''} It is listed in Correction Center.`
        : isCorrection
        ? correctionRowAction(row)
        : isSkipped
        ? 'No TDS issue is raised for this row. Keep it as TDS Not Applicable unless the source row should actually carry TDS section/rate details.'
        : isInsufficient
        ? 'Review the source row and complete the missing or unusable transaction data, then analyse the file again.'
        : 'No correction required — this row passed the current validation rules.',
      expectedRate,
      appliedRate,
      taxImpact: 0,
    }
  }

  const filteredValidationRowsForSummary = useMemo(() => (
    validationRowsMatchingFilters(displayValidationRows, filtered, filterValues)
  ), [displayValidationRows, filtered, filterValues])

  // Derived from the same filter bar inputs as the table, so the cards and
  // visible rows stay aligned when Vendor/Section/Doc Type/Search changes.
  const summary = useMemo(() => {
    if (serverMode) {
      const data = serverSummary || {}
      return {
        totalRows: data.totalRows || 0,
        passedRows: data.passedRows || 0,
        issueRows: data.issueRows || 0,
        insufficientDataRows: data.insufficientDataRows || 0,
        skippedRows: data.skippedRows || 0,
        correctedRows: data.correctedRows || 0,
        correctedDeducted: data.correctedDeducted || 0,
      }
    }
    const filteredIssueRows = issueRowsMatchingIssues(filteredValidationRowsForSummary, filtered)

    if (!uploadMeta) {
      return {
        totalRows: filtered.length,
        passedRows: 0,
        issueRows: filtered.length,
        insufficientDataRows: 0,
        skippedRows: 0,
        correctedRows: 0,
        correctedDeducted: 0,
      }
    }
    const correctedRows = filteredValidationRowsForSummary.filter((row) => row.status === 'corrected')

    return {
      totalRows: filteredValidationRowsForSummary.length,
      passedRows: filteredValidationRowsForSummary.filter((row) => row.status === 'passed').length,
      issueRows: filteredIssueRows.length,
      insufficientDataRows: filteredValidationRowsForSummary.filter((row) => row.status === 'insufficient').length,
      skippedRows: filteredValidationRowsForSummary.filter((row) => row.status === 'skipped').length,
      correctedRows: correctedRows.length,
      correctedDeducted: correctedRows.filter(isRowTdsDeducted).length,
    }
  }, [filtered, uploadMeta, filteredValidationRowsForSummary, serverMode, serverSummary])

  // Count-only cards: rows with a non-zero TDS amount vs. rows without one,
  // from the same filtered row set as the other summary cards.
  const tdsDeductionSummary = useMemo(() => {
    if (serverMode) {
      const data = serverSummary || {}
      return {
        deducted: data.deducted || 0,
        notDeducted: data.notDeducted || 0,
        insufficientDeducted: data.insufficientDeducted || 0,
        insufficientNotDeducted: data.insufficientNotDeducted || 0,
      }
    }
    const deducted = filteredValidationRowsForSummary.filter(isRowTdsDeducted).length
    const insufficientRows = filteredValidationRowsForSummary.filter((row) => row.status === 'insufficient')
    const insufficientDeducted = insufficientRows.filter(isRowTdsDeducted).length
    return {
      deducted,
      notDeducted: filteredValidationRowsForSummary.length - deducted,
      insufficientDeducted,
      insufficientNotDeducted: insufficientRows.length - insufficientDeducted,
    }
  }, [filteredValidationRowsForSummary, serverMode, serverSummary])

  const filteredIssueKeys = useMemo(() => new Set(filtered.map(issueRowKey)), [filtered])

  const bucketRows = useMemo(() => Object.fromEntries(
    Object.keys(BUCKET_VIEWS).map((view) => [
      view,
      filteredValidationRowsForSummary.filter((row) => rowInBucketView(row, view, filteredIssueKeys)),
    ]),
  ), [filteredValidationRowsForSummary, filteredIssueKeys])
  // Card counts of the four buckets (a large pull's come from the server).
  const bucketCounts = useMemo(() => (
    serverMode
      ? Object.fromEntries(Object.keys(BUCKET_VIEWS).map((view) => [view, serverSummary?.buckets?.[view] || 0]))
      : Object.fromEntries(Object.entries(bucketRows).map(([view, rows]) => [view, rows.length]))
  ), [serverMode, serverSummary, bucketRows])


  const docTypes = useMemo(() => {
    const values = [
      ...displayValidationRows.map((row) => row.docType),
      ...issues.map((issue) => issue.docType),
    ]
      .map((value) => String(value || '').trim().toUpperCase())
      .filter((value) => value && value !== '—')
    return [...new Set(values)].sort()
  }, [displayValidationRows, issues])

  const issuesByRow = useMemo(() => {
    const grouped = new Map()
    issues.forEach((issue) => {
      const key = issueRowKey(issue)
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key).push(issue)
    })
    return grouped
  }, [issues])

  const filteredIssuesByRow = useMemo(() => {
    const grouped = new Map()
    filtered.forEach((issue) => {
      const key = issueRowKey(issue)
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key).push(issue)
    })
    return grouped
  }, [filtered])

  const buildIssueValidationRows = (issueGroupsByRow) => (
    displayValidationRows
      .filter((row) => row.status === 'issue')
      .map((row, index) => {
        const rowIssues = issueGroupsByRow.get(issueRowKey(row)) || []
        const primaryIssue = rowIssues[0]
        if (!primaryIssue) return null
        const issueTypes = uniqueIssueTypes(rowIssues)
        return {
          ...row,
          id: `issue-${index}-${row.id || row.docNo || 'row'}`,
          issueId: primaryIssue.id,
          category: primaryIssue.category,
          issueType: primaryIssue.issueType,
          issueTypeLabel: issueTypes.map((issue) => issue.label).join(' | '),
          issueTypes,
          severity: primaryIssue.severity,
          legacySection: primaryIssue.legacySection,
          ruleSection: primaryIssue.ruleSection,
          newSection: primaryIssue.newSection,
          plainEnglish: primaryIssue.plainEnglish,
          recommendedAction: primaryIssue.recommendedAction,
          status: 'issue',
          issueStatus: primaryIssue.status,
          correctionGroupId: primaryIssue.correctionGroupId,
        }
      })
      .filter(Boolean)
  )

  const allIssueValidationRows = useMemo(
    () => buildIssueValidationRows(issuesByRow),
    [displayValidationRows, issuesByRow],
  )
  const issueValidationRows = useMemo(
    () => buildIssueValidationRows(filteredIssuesByRow),
    [displayValidationRows, filteredIssuesByRow],
  )

  // Each KPI card's download exports exactly the rows behind that card's own
  // number (Company/FY-scoped, like the count itself) — not whatever happens
  // to be showing on the currently active tab, and not further narrowed by
  // the filter-bar's Vendor/Section/etc, which only apply to what's on
  // screen right now, not to "all Passed rows" as a concept.
  // Large pull: the card's rows are fetched from the server, then downloaded the same way.
  async function exportServerKpi(kind, fileBase) {
    const spec = {
      all: ['all', 'all-transactions'],
      tds_deducted: ['tds_deducted', 'tds-deducted'],
      tds_not_deducted: ['tds_not_deducted', 'tds-not-deducted'],
      passed: ['passed', 'passed'],
      issue: ['issue', 'issues-found'],
      insufficient: ['insufficient', 'insufficient-data'],
      skipped: ['skipped', 'skipped'],
      passed_deducted: ['passed_deducted', 'tds-properly-deducted'],
      issue_deducted: ['issue_deducted', 'issues-tds-deducted'],
      passed_not_deducted: ['passed_not_deducted', 'tds-not-applicable'],
      issue_not_deducted: ['issue_not_deducted', 'issues-tds-not-deducted'],
    }[kind]
    if (!spec) return
    const [view, suffix] = spec
    const toastId = toast.loading('Preparing download…')
    try {
      const rows = await uploadRowsService.getAll(serverParams, view)
      toast.dismiss(toastId)
      if (rows.length === 0) {
        toast('No rows to export')
        return
      }
      const exportRows = view === 'issue' ? rows.map((row, index) => serverTableRow(row, 'issue', index + 1)) : rows
      downloadCsv(`${fileBase}-${suffix}.csv`, view === 'issue' ? ISSUE_CSV_COLUMNS : VALIDATION_CSV_COLUMNS, exportRows)
    } catch (err) {
      toast.dismiss(toastId)
      toast.error(err.message || 'Could not prepare the download')
    }
  }

  function handleExportKpi(kind) {
    const fileBase = (uploadMeta?.fileName || 'issues').replace(/\.[^.]+$/, '')
    if (serverMode) {
      exportServerKpi(kind, fileBase)
      return
    }
    const exportSpec = {
      all: { rows: filteredValidationRowsForSummary, columns: VALIDATION_CSV_COLUMNS, suffix: 'all-transactions' },
      tds_deducted: { rows: filteredValidationRowsForSummary.filter(isRowTdsDeducted), columns: VALIDATION_CSV_COLUMNS, suffix: 'tds-deducted' },
      tds_not_deducted: { rows: filteredValidationRowsForSummary.filter((row) => !isRowTdsDeducted(row)), columns: VALIDATION_CSV_COLUMNS, suffix: 'tds-not-deducted' },
      passed: { rows: filteredValidationRowsForSummary.filter((r) => r.status === 'passed'), columns: VALIDATION_CSV_COLUMNS, suffix: 'passed' },
      issue: { rows: issueValidationRows, columns: ISSUE_CSV_COLUMNS, suffix: 'issues-found' },
      insufficient: { rows: filteredValidationRowsForSummary.filter((r) => r.status === 'insufficient'), columns: VALIDATION_CSV_COLUMNS, suffix: 'insufficient-data' },
      skipped: { rows: filteredValidationRowsForSummary.filter((r) => r.status === 'skipped'), columns: VALIDATION_CSV_COLUMNS, suffix: 'skipped' },
      passed_deducted: { rows: bucketRows.passed_deducted, columns: VALIDATION_CSV_COLUMNS, suffix: 'tds-properly-deducted' },
      issue_deducted: { rows: bucketRows.issue_deducted, columns: VALIDATION_CSV_COLUMNS, suffix: 'issues-tds-deducted' },
      passed_not_deducted: { rows: bucketRows.passed_not_deducted, columns: VALIDATION_CSV_COLUMNS, suffix: 'tds-not-applicable' },
      issue_not_deducted: { rows: bucketRows.issue_not_deducted, columns: VALIDATION_CSV_COLUMNS, suffix: 'issues-tds-not-deducted' },
    }[kind]
    if (!exportSpec || exportSpec.rows.length === 0) {
      toast('No rows to export')
      return
    }
    downloadCsv(`${fileBase}-${exportSpec.suffix}.csv`, exportSpec.columns, exportSpec.rows)
  }

  const columns = [
    { header: '#', render: (r, i) => <span className="font-mono" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{r._rowNumber ?? i + 1}</span> },
    { key: 'vendor', header: 'Vendor Name', render: (r) => (
      <span style={{ fontSize: 12.5, fontWeight: 500 }}>{r.vendor}</span>
    )},
    { key: 'vendorId', header: 'Vendor No.', render: (r) => (
      <span className="font-mono" style={{ fontSize: 11.5 }}>{r.vendorId || '—'}</span>
    )},
    { key: 'vendorPan', header: 'PAN', render: (r) => (
      <span className="font-mono" style={{ fontSize: 11.5 }}>{r.vendorPan || r.vendorId || '—'}</span>
    )},
    { key: 'docNo',   header: 'Doc No.',  render: (r) => (
      <div>
        <span className="font-mono" style={{ fontSize: 11.5 }}>{r.docNo}</span>
        {(r.issueStatus || r.status) === 'resolved' ? (
          <div className="corrected-badge"><CheckCheck size={11} />Corrected</div>
        ) : r.status !== 'open' && (
          <div style={{ marginTop: 3 }}>
            <StatusBadge label={formatStatusLabel(r.status)} tone={issueStatusToTone(r.status)} />
          </div>
        )}
      </div>
    )},
    { key: 'docType', header: 'Doc Type', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.docType || '—'}</span> },
    { key: 'section',      header: 'Section',  render: (r) => <SectionCell issue={r} /> },
    { key: 'baseAmount',   header: 'Base Amt', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.baseAmount)}</span> },
    { key: 'tdsAmount',    header: 'TDS (₹)',  render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.tdsAmount)}</span> },
    { key: 'category', header: 'Issue Type', render: (r) => {
      const Icon = SEVERITY_ICON[r.severity] ?? AlertTriangle
      const displayType = getDisplayIssueType(r)
      return (
        <div className={`issue-type-cell issue-type-cell--${r.severity}`} title={displayType}>
          <Icon size={13} />
          <span className="issue-type-text">{displayType}</span>
        </div>
      )
    }},
    { key: 'severity', header: 'Severity', render: (r) => <StatusBadge label={formatStatusLabel(r.severity)} tone={severityToTone(r.severity)} /> },
    { header: '', render: (r) => (
      <button className="issues-review-btn" onClick={() => dispatch(openDrawer(r.id))}>Review</button>
    )},
  ]

  const transactionColumns = [
    { header: '#', render: (r, i) => <span className="font-mono" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{r._rowNumber ?? i + 1}</span> },
    { key: 'vendor', header: 'Vendor Name', render: (r) => (
      <span style={{ fontSize: 12.5, fontWeight: 500 }}>{r.vendor}</span>
    )},
    { key: 'vendorId', header: 'Vendor No.', render: (r) => (
      <span className="font-mono" style={{ fontSize: 11.5 }}>{r.vendorId || '—'}</span>
    )},
    { key: 'vendorPan', header: 'PAN', render: (r) => (
      <span className="font-mono" style={{ fontSize: 11.5 }}>{r.vendorPan || r.vendorId || '—'}</span>
    )},
    { key: 'docNo', header: 'Doc No.', render: (r) => (
      <div>
        <span className="font-mono" style={{ fontSize: 11.5 }}>{r.docNo}</span>
        {r.issueStatus === 'resolved' && <div className="corrected-badge"><CheckCheck size={11} />Corrected</div>}
      </div>
    )},
    { key: 'docType', header: 'Doc Type', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.docType || '—'}</span> },
    // Temporarily hidden from the Issues UI. Keep this column definition for future restore.
    // { key: 'poNo', header: 'PO No.', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.poNo || r.poNumber || '-'}</span> },
    { key: 'section', header: 'Section', render: (r) => <span className="font-mono issues-section-single">{r.section}</span> },
    { key: 'profitCenter', header: 'Profit Center', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.profitCenter || '—'}</span> },
    { key: 'baseAmount', header: 'Base Amt', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.baseAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS (₹)', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.tdsAmount)}</span> },
    // TDS Note is shown only in the "TDS Not Deducted" and
    // "Passed - TDS Not Applicable" views.
    ...(['tds_not_deducted', 'skipped', 'passed_not_deducted', 'issue_not_deducted'].includes(validationView) ? [
      { key: 'tdsNote', header: 'TDS Note', render: (r) => (
        r.tdsNote
          ? <span className="issues-tds-note" title={r.tdsNote}>{r.tdsNote}</span>
          : <span style={{ color: 'var(--color-text-muted)' }}>—</span>
      )},
    ] : []),
    { key: 'status', header: validationView === 'issue' ? 'Issue Type' : 'Validation Result', sortValue: (r) => (
      r.status === 'issue' ? (r.issueTypeLabel || 'Issue Found') : formatStatusLabel(r.status)
    ), render: (r) => {
      if (r.status === 'issue' && r.issueTypes?.length) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
            {r.issueTypes.map((issue) => (
              <StatusBadge
                key={`${r.id}-${issue.id || issue.label}`}
                label={issue.label}
                tone="danger"
              />
            ))}
          </div>
        )
      }
      if (r.status === 'corrected') {
        return (
          <span title={r.reason || undefined}>
            <StatusBadge label="Corrected" tone="success" />
          </span>
        )
      }
      // Credit memo / reversal / TDS top-up referencing another document.
      if (r.rowKind === 'correction' && r.status !== 'issue') {
        const badge = correctionRowBadge(r)
        return (
          <span title={r.reason || undefined}>
            <StatusBadge label={badge.label} tone={badge.tone} />
          </span>
        )
      }
      return (
        <StatusBadge
          label={r.status === 'issue' ? (r.issueTypeLabel || 'Issue Found') : formatStatusLabel(r.status)}
          tone={r.status === 'passed' ? 'success' : r.status === 'insufficient' ? 'warning' : r.status === 'issue' ? 'danger' : 'default'}
        />
      )
    }},
    { header: '', render: (r) => (
      r.status === 'passed' || r.status === 'insufficient' || r.status === 'skipped' || r.status === 'corrected'
        ? (
          <button
            className="issues-review-btn"
            type="button"
            onClick={() => setReviewValidationRow(buildValidationReviewIssue(r))}
          >
            Review
          </button>
        )
        : r.status === 'issue' && r.issueId
          ? (
            <button className="issues-review-btn" type="button" onClick={() => dispatch(openDrawer(r.issueId))}>
              Review
            </button>
          )
        : null
    )},
  ]

  // Search/Vendor/Section/period apply to every row. Severity/Issue Type/Status
  // keep only rows with a matching issue, so the table matches the card counts.
  const viewTableRows = useMemo(() => {
    if (validationView === 'issue') {
      return issueValidationRows
    }

    const issueByRow = new Map(issues.map((issue) => [issueRowKey(issue), issue]))
    return displayValidationRows
      .filter((row) => {
        const matchingIssue = issueByRow.get(issueRowKey(row))
        if (BUCKET_VIEWS[validationView]) {
          if (!rowInBucketView(row, validationView, filteredIssueKeys)) return false
        } else if (validationView === 'tds_deducted') {
          if (!isRowTdsDeducted(row)) return false
        } else if (validationView === 'tds_not_deducted') {
          if (isRowTdsDeducted(row)) return false
        } else if (validationView !== 'all' && row.status !== validationView) return false
        if (searchQuery) {
          const q = searchQuery.toLowerCase()
          if (
            !row.vendor?.toLowerCase().includes(q) &&
            !String(row.docNo ?? '').toLowerCase().includes(q) &&
            !String(row.docType ?? '').toLowerCase().includes(q) &&
            !String(row.vendorId ?? '').toLowerCase().includes(q) &&
            !String(row.section ?? '').toLowerCase().includes(q) &&
            !String(row.vendorPan ?? '').toLowerCase().includes(q)
          ) return false
        }
        if (!filterIncludes(vendorFilter, row.vendor)) return false
        if (!filterMatchesAny(sectionFilter, (section) => sectionMatches(section, [row.section, row.legacySection, row.ruleSection, row.newSection]))) return false
        if (!filterIncludes(activeDocTypeFilter, String(row.docType ?? '').toUpperCase())) return false
        if (!rowInDateRange(row, issueDateFromFilter, issueDateToFilter)) return false
        if (!filterIncludes(profitCenterFilter, row.profitCenter)) return false
        if (hasIssueLevelFilters(filterValues) && (row.status !== 'issue' || !filteredIssueKeys.has(issueRowKey(row)))) return false
        return true
      })
      .map((row, index) => {
        const matchingIssue = issueByRow.get(issueRowKey(row))
        const rowIssues = BUCKET_VIEWS[validationView] && row.status === 'issue'
          ? filteredIssuesByRow.get(issueRowKey(row)) || []
          : []
        return {
          ...row,
          id: `${validationView}-${index}-${row.id || row.docNo || 'row'}`,
          issueId: matchingIssue?.id,
          severity: matchingIssue?.severity,
          issueTypeLabel: matchingIssue ? getDisplayIssueType(matchingIssue) : null,
          ...(rowIssues.length ? {
            issueTypes: uniqueIssueTypes(rowIssues),
          } : {}),
        }
      })
  }, [displayValidationRows, issues, issueValidationRows, filteredIssueKeys, filteredIssuesByRow, validationView, searchQuery, vendorFilter, sectionFilter, activeDocTypeFilter, filterValues, profitCenterFilter, issueDateFromFilter, issueDateToFilter])

  // Issue counts per tab for the rows the card view and filters leave, so a
  // tab's count is exactly what clicking it shows. Needs report categories
  // (uploads analysed since they were added).
  const hasReportCategories = useMemo(() => (
    serverMode ? Boolean(serverPage.hasReportCategories) : viewTableRows.some((row) => row.reportCategory)
  ), [serverMode, serverPage, viewTableRows])
  const issueTabCounts = useMemo(() => {
    if (serverMode) return new Map(ISSUE_TABS.map((tab) => [tab.id, serverPage.tabCounts?.[tab.id] || 0]))
    const counts = new Map(ISSUE_TABS.map((tab) => [tab.id, 0]))
    for (const row of viewTableRows) {
      const tab = issueTabOf(row)
      if (tab) counts.set(tab, counts.get(tab) + 1)
    }
    return counts
  }, [viewTableRows, serverMode, serverPage])

  const validationTableRows = useMemo(() => {
    if (serverMode) {
      const first = (serverPage.page ? (serverPage.page - 1) * serverPage.pageSize : 0) + 1
      return serverPage.items.map((row, index) => serverTableRow(row, validationView, first + index))
    }
    if (!categoryTab || !hasReportCategories) return viewTableRows
    return viewTableRows.filter((row) => issueTabOf(row) === categoryTab)
  }, [viewTableRows, categoryTab, hasReportCategories, serverMode, serverPage, validationView])
  const tableRowTotal = serverMode ? serverPage.total : validationTableRows.length
  const serverPageCount = Math.max(1, Math.ceil((serverPage.total || 0) / TABLE_PAGE_SIZE))

  function handleResetFilters() {
    setActiveDocTypeFilter('all')
    dispatch(resetFilters())
  }

  const filterBar = (
    <>
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
          <select className="filter-select" value={vendorFilter} onChange={(e) => dispatch(setVendorFilter(e.target.value))}>
            <option value="all">All Vendors</option>
            {vendorNames.slice(0, 40).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select className="filter-select" value={sectionFilter} onChange={(e) => dispatch(setSectionFilter(e.target.value))}>
            <option value="all">All Sections</option>
            {sections.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            className="filter-select"
            value={severityFilter}
            disabled={validationView !== 'issue'}
            title={validationView !== 'issue' ? 'Only applies to the Issues Found view' : undefined}
            onChange={(e) => dispatch(setSeverityFilter(e.target.value))}
          >
            {SEVERITY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select
            className="filter-select"
            value={issueTypeFilter}
            disabled={validationView !== 'issue'}
            title={validationView !== 'issue' ? 'Only applies to the Issues Found view' : undefined}
            onChange={(e) => dispatch(setIssueTypeFilter(e.target.value))}
          >
            <option value="all">All Issue Types</option>
            {issueTypeOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select
            className="filter-select"
            value={statusFilter}
            disabled={validationView !== 'issue'}
            title={validationView !== 'issue' ? 'Only applies to the Issues Found view' : undefined}
            onChange={(e) => dispatch(setStatusFilter(e.target.value))}
          >
            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select
            className="filter-select"
            value={activeDocTypeFilter}
            onChange={(e) => setActiveDocTypeFilter(e.target.value)}
          >
            <option value="all">All Doc Types</option>
            {docTypes.map((docType) => <option key={docType} value={docType}>{docType}</option>)}
          </select>
          <button className="filter-reset-btn" onClick={handleResetFilters}>
            <RotateCcw size={12} />Reset
          </button>
        </div>
      </div>
    </>
  )


  // Review drawer plus its correction / SAP-match modals. With `reviewOnly`
  // only these render, so another page (the GL Ledger issues pop-up) can open
  // the same Review drawer by dispatching openDrawer(issue.id).
  const reviewOverlays = (
    <>
        <IssueDrawer
          issue={drawerIssue}
          open={drawerIsOpen}
          correctionGroups={drawerCorrectionGroups}
          onMatchSapRows={reviewValidationRow ? null : handleOpenSapMatch}
          resolvedNote={drawerIssue?.rowStatus === 'corrected' ? drawerIssue.reason : null}
          onClose={() => {
            setReviewValidationRow(null)
            dispatch(closeDrawer())
          }}
        >
          {drawerIssue?.rowStatus === 'corrected' && <LinkedCorrectionDocs docs={drawerIssue.correctionDocs || []} emptyText="No SAP document is linked to this resolution." />}
        </IssueDrawer>

        <MatchSapRowsModal
          issue={matchIssue}
          rows={matchCandidateRows}
          matchCount={matchSearchCount}
          saving={matchSaving}
          selectedIds={selectedMatchIds}
          roles={matchRoles}
          method={matchMethod}
          remarks={matchRemarks}
          search={matchSearch}
          onSearch={setMatchSearch}
          onToggle={handleToggleMatchRow}
          onRoleChange={handleMatchRoleChange}
          onMethodChange={handleMatchMethodChange}
          onRemarksChange={setMatchRemarks}
          onClose={() => setMatchIssue(null)}
          onSave={handleSaveSapMatch}
        />
    </>
  )

  if (reviewOnly) return reviewOverlays

  if (serverMode && serverSummary && !serverSummary.available) {
    return (
      <div className={embedded ? 'issues-embedded' : undefined}>
        {beforeSummary}
        <div className="case-empty-source">
          This SAP pull was analysed before its rows were saved for this page. Pull it again to see its cards and rows here;
          its issues are already in Open Issues · All Runs.
        </div>
      </div>
    )
  }

  return (
    <div className={embedded ? 'issues-embedded' : undefined}>
      {!embedded && (
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">Issues</span>
          </div>
          <h1 className="page-title">Issues</h1>
        </div>
        <div className="issues-header-actions">
          <LiveDataBadge />
          <button className="btn btn-outline" type="button" onClick={handleVerifyAllPans} disabled={bulkVerifying}>
            {bulkVerifying ? <Loader2 size={14} className="spin" /> : <IdCard size={14} />}
            {bulkVerifying ? 'Verifying PANs…' : 'Verify All PANs'}
          </button>
          <button className="btn btn-outline" type="button">
            <Download size={14} />Export
          </button>
        </div>
      </div>
      )}

      {!embedded && <SapUploadPanel />}

      {!hideFilters && filtersFirst && filterBar}
      {beforeSummary}

      <div className="issues-summary-grid issues-summary-grid--top">
        <div className={`issues-summary-card issues-summary-card--info ${validationView === 'all' ? 'issues-summary-card--active' : ''}`}>
          <button className="issues-summary-card-clickarea" type="button" onClick={() => setValidationView('all')}>
            <Activity size={16} />
            <div>
              <div className="issues-summary-value">{summary.totalRows.toLocaleString()}</div>
              <div className="issues-summary-label">Transactions</div>
            </div>
          </button>
          {summary.totalRows > 0 && (
            <button
              className="issues-summary-card-download"
              type="button"
              title="Download CSV of all transaction rows"
              onClick={(e) => { e.stopPropagation(); handleExportKpi('all') }}
            >
              <Download size={12} />
            </button>
          )}
        </div>
        <div className={`issues-summary-card issues-summary-card--success ${validationView === 'tds_deducted' ? 'issues-summary-card--active' : ''}`}>
          <button className="issues-summary-card-clickarea" type="button" onClick={() => setValidationView('tds_deducted')}>
            <BadgeCheck size={16} />
            <div>
              <div className="issues-summary-value">{tdsDeductionSummary.deducted.toLocaleString()}</div>
              <div className="issues-summary-label">TDS Deducted</div>
              <div className="issues-summary-breakdown">
                Properly Deducted {bucketCounts.passed_deducted.toLocaleString()} · Issues {bucketCounts.issue_deducted.toLocaleString()}
                {summary.correctedDeducted > 0 && ` · Corrected ${summary.correctedDeducted.toLocaleString()}`}
                {tdsDeductionSummary.insufficientDeducted > 0 && ` · Insufficient Data ${tdsDeductionSummary.insufficientDeducted.toLocaleString()}`}
              </div>
            </div>
          </button>
          {tdsDeductionSummary.deducted > 0 && (
            <button className="issues-summary-card-download" type="button" title="Download CSV of TDS Deducted rows" aria-label="Download TDS Deducted CSV" onClick={(e) => { e.stopPropagation(); handleExportKpi('tds_deducted') }}>
              <Download size={12} />
            </button>
          )}
        </div>
        <div className={`issues-summary-card issues-summary-card--danger ${validationView === 'tds_not_deducted' ? 'issues-summary-card--active' : ''}`}>
          <button className="issues-summary-card-clickarea" type="button" onClick={() => setValidationView('tds_not_deducted')}>
            <BadgeX size={16} />
            <div>
              <div className="issues-summary-value">{tdsDeductionSummary.notDeducted.toLocaleString()}</div>
              <div className="issues-summary-label">TDS Not Deducted</div>
              <div className="issues-summary-breakdown">
                Not Applicable {bucketCounts.passed_not_deducted.toLocaleString()} · Issues {bucketCounts.issue_not_deducted.toLocaleString()}
                {summary.correctedRows - summary.correctedDeducted > 0 && ` · Corrected ${(summary.correctedRows - summary.correctedDeducted).toLocaleString()}`}
                {tdsDeductionSummary.insufficientNotDeducted > 0 && ` · Insufficient Data ${tdsDeductionSummary.insufficientNotDeducted.toLocaleString()}`}
              </div>
            </div>
          </button>
          {tdsDeductionSummary.notDeducted > 0 && (
            <button className="issues-summary-card-download" type="button" title="Download CSV of TDS Not Deducted rows" aria-label="Download TDS Not Deducted CSV" onClick={(e) => { e.stopPropagation(); handleExportKpi('tds_not_deducted') }}>
              <Download size={12} />
            </button>
          )}
        </div>
      </div>

      <div className={`issues-summary-grid issues-summary-grid--five ${summary.correctedRows > 0 ? '' : 'issues-summary-grid--split'}`}>
        <div className={`issues-summary-card issues-summary-card--success ${validationView === 'passed_deducted' ? 'issues-summary-card--active' : ''}`}>
          <button className="issues-summary-card-clickarea" type="button" onClick={() => setValidationView('passed_deducted')}>
            <CheckCircle2 size={16} />
            <div>
              <div className="issues-summary-value">{bucketCounts.passed_deducted.toLocaleString()}</div>
              <div className="issues-summary-label">TDS Properly Deducted</div>
            </div>
          </button>
          {bucketCounts.passed_deducted > 0 && (
            <button className="issues-summary-card-download" type="button" title="Download CSV of TDS Properly Deducted rows" aria-label="Download TDS Properly Deducted CSV" onClick={(e) => { e.stopPropagation(); handleExportKpi('passed_deducted') }}>
              <Download size={12} />
            </button>
          )}
        </div>
        <div className={`issues-summary-card issues-summary-card--danger ${validationView === 'issue_deducted' ? 'issues-summary-card--active' : ''}`}>
          <button className="issues-summary-card-clickarea" type="button" onClick={() => setValidationView('issue_deducted')}>
            <AlertOctagon size={16} />
            <div>
              <div className="issues-summary-value">{bucketCounts.issue_deducted.toLocaleString()}</div>
              <div className="issues-summary-label">Issues - TDS Deducted</div>
            </div>
          </button>
          {bucketCounts.issue_deducted > 0 && (
            <button className="issues-summary-card-download" type="button" title="Download CSV of Issues - TDS Deducted rows" aria-label="Download Issues - TDS Deducted CSV" onClick={(e) => { e.stopPropagation(); handleExportKpi('issue_deducted') }}>
              <Download size={12} />
            </button>
          )}
        </div>
        <div className={`issues-summary-card issues-summary-card--neutral ${validationView === 'passed_not_deducted' ? 'issues-summary-card--active' : ''}`}>
          <button className="issues-summary-card-clickarea" type="button" onClick={() => setValidationView('passed_not_deducted')}>
            <CircleSlash size={16} />
            <div>
              <div className="issues-summary-value">{bucketCounts.passed_not_deducted.toLocaleString()}</div>
              <div className="issues-summary-label">TDS Not Applicable</div>
            </div>
          </button>
          {bucketCounts.passed_not_deducted > 0 && (
            <button className="issues-summary-card-download" type="button" title="Download CSV of TDS Not Applicable rows" aria-label="Download TDS Not Applicable CSV" onClick={(e) => { e.stopPropagation(); handleExportKpi('passed_not_deducted') }}>
              <Download size={12} />
            </button>
          )}
        </div>
        <div className={`issues-summary-card issues-summary-card--danger ${validationView === 'issue_not_deducted' ? 'issues-summary-card--active' : ''}`}>
          <button className="issues-summary-card-clickarea" type="button" onClick={() => setValidationView('issue_not_deducted')}>
            <AlertOctagon size={16} />
            <div>
              <div className="issues-summary-value">{bucketCounts.issue_not_deducted.toLocaleString()}</div>
              <div className="issues-summary-label">Issues - TDS Not Deducted</div>
            </div>
          </button>
          {bucketCounts.issue_not_deducted > 0 && (
            <button className="issues-summary-card-download" type="button" title="Download CSV of Issues - TDS Not Deducted rows" aria-label="Download Issues - TDS Not Deducted CSV" onClick={(e) => { e.stopPropagation(); handleExportKpi('issue_not_deducted') }}>
              <Download size={12} />
            </button>
          )}
        </div>
        <div className={`issues-summary-card issues-summary-card--warning ${validationView === 'insufficient' ? 'issues-summary-card--active' : ''}`}>
          <button className="issues-summary-card-clickarea" type="button" onClick={() => setValidationView('insufficient')}>
            <AlertTriangle size={16} />
            <div>
              <div className="issues-summary-value">{summary.insufficientDataRows.toLocaleString()}</div>
              <div className="issues-summary-label">Insufficient Data</div>
            </div>
          </button>
          {summary.insufficientDataRows > 0 && (
            <button
              className="issues-summary-card-download"
              type="button"
              title="Download CSV of all Insufficient Data rows"
              onClick={(e) => { e.stopPropagation(); handleExportKpi('insufficient') }}
            >
              <Download size={12} />
            </button>
          )}
        </div>
        {summary.correctedRows > 0 && (
          <div className={`issues-summary-card issues-summary-card--success ${validationView === 'corrected' ? 'issues-summary-card--active' : ''}`}>
            <button
              className="issues-summary-card-clickarea"
              type="button"
              title="Rows whose issue was resolved by a correction or reversal (this upload or an earlier one). See Correction Center."
              onClick={() => setValidationView('corrected')}
            >
              <CheckCheck size={16} />
              <div>
                <div className="issues-summary-value">{summary.correctedRows.toLocaleString()}</div>
                <div className="issues-summary-label">Corrected</div>
              </div>
            </button>
          </div>
        )}
      </div>

      {!hideFilters && !filtersFirst && filterBar}

      {hasReportCategories && (
        <div className="issues-category-tabs" role="tablist" aria-label="Issues by category">
          {ISSUE_TABS.map((c) => {
            const count = issueTabCounts.get(c.id) || 0
            return (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={categoryTab === c.id}
                className={`issues-category-tab ${c.id === 'resolved' ? 'issues-category-tab--resolved' : ''} ${categoryTab === c.id ? 'active' : ''} ${count === 0 ? 'is-empty' : ''}`}
                onClick={() => setCategoryTab((current) => (current === c.id ? null : c.id))}
                title={categoryTab === c.id ? 'Click again to show every row of the selected card' : undefined}
              >
                {c.label}
                <span className="issues-category-tab-count">{count.toLocaleString()}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="table-card">
        <div className="issues-count-label">
          {serverMode && serverLoading ? 'Loading… ' : ''}
          {serverMode && serverError ? `${serverError} · ` : ''}
          {`Showing ${tableRowTotal.toLocaleString()} ${VIEW_LABELS[validationView] || 'rows'} row${tableRowTotal === 1 ? '' : 's'}`}
          {hasReportCategories && categoryTab ? ` · ${ISSUE_TAB_LABELS.get(categoryTab)}` : ''}
          {dataSource === 'upload' ? ' from SAP upload' : ' awaiting SAP upload'}
        </div>
        <DataTable
          key={`validation-table-${validationView}-${categoryTab}`}
          columns={transactionColumns}
          data={validationTableRows}
          pageSize={TABLE_PAGE_SIZE}
          emptyState={
            <div className="empty-state">
              <div className="empty-state-icon"><FileSearch size={20} /></div>
              <div className="empty-state-title">No rows match your filters</div>
              <div className="empty-state-desc">Try adjusting your search or filter criteria.</div>
              <button className="btn btn-outline btn-sm" onClick={handleResetFilters}>Reset Filters</button>
            </div>
          }
        />
        {serverMode && serverPageCount > 1 && (
          <div className="case-stored-pager">
            <span>{`Rows ${((serverPageNo - 1) * TABLE_PAGE_SIZE + 1).toLocaleString()}–${Math.min(serverPageNo * TABLE_PAGE_SIZE, serverPage.total).toLocaleString()} of ${serverPage.total.toLocaleString()}`}</span>
            <div>
              <button className="table-page-btn" type="button" disabled={serverPageNo <= 1 || serverLoading} onClick={() => setServerPageNo((page) => page - 1)}><ChevronLeft size={13} /></button>
              <span>Page {serverPageNo.toLocaleString()} of {serverPageCount.toLocaleString()}</span>
              <button className="table-page-btn" type="button" disabled={serverPageNo >= serverPageCount || serverLoading} onClick={() => setServerPageNo((page) => page + 1)}><ChevronRight size={13} /></button>
            </div>
          </div>
        )}
      </div>

      {reviewOverlays}
    </div>
  )
}
