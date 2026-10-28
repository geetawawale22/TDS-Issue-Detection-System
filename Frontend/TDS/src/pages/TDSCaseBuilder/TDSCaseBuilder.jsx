import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { AlertTriangle, ChevronDown, Download, FileSpreadsheet, GitBranch, ListTree, RotateCcw, ShieldAlert, SlidersHorizontal, X } from 'lucide-react'
import Issues, { issueMatchesFilters, issueRowsMatchingIssues, validationRowMatchesFilters } from '@/pages/Issues/Issues'
import DataTable from '@/components/Common/DataTable'
import SapUploadPanel from '@/components/Common/SapUploadPanel'
import StatusBadge, { severityToTone } from '@/components/Common/StatusBadge'
import {
  resetFilters, setIssueTypeFilter, setSearchQuery, setSectionFilter, setSeverityFilter,
  setStatusFilter, setVendorFilter, selectActiveIssues, selectActiveValidationRows,
  selectActiveCaseLedger, openDrawer,
} from '@/redux/slices/issuesSlice'
import { formatCurrency, formatDate } from '@/utils/utils'
import { sectionMatches } from '@/utils/sectionAliases'
import { filterIncludes, filterMatchesAny, selectedValues } from '@/utils/multiFilter'
import { getDisplayIssueType, issueTypeFilterOptionsFor } from '@/data/issueTypes'
import { downloadCsv, ISSUE_CSV_COLUMNS } from '@/utils/csvExport'
import '@/components/Common/Common.css'
import './TDSCaseBuilder.css'

const CASE_BUILDER_VIEW_STORAGE_KEY = 'tds_case_builder_view'
const DEFAULT_CASE_BUILDER_VIEW = { activeTab: 'ledger', quickFilter: 'ledger-all' }
const VALID_TABS = new Set(['ledger', 'issues', 'gl'])
const TDS_ANALYSIS_ISSUE_TYPE_LABELS = new Set([
  'Wrong Section Applied',
  'TDS Rate Mismatch',
  'Amount Mismatch (Short/Excess)',
  '194J Rate Mismatch (Not 2% or 10%)',
  'TDS Exceeds Full Invoice Amount',
  'Possible Missed TDS Deduction',
  'Missed TDS (Advance)',
  'Missed TDS (Provision)',
  'Missed TDS (Threshold Crossed)',
  'Threshold Crossed — Short Deducted',
  'PAN Missing (206AA)',
  'Non-Filer Higher Rate (206AB)',
  'Form 197 Rate Mismatch',
  'LDC Not Yet Valid',
  'LDC Expired',
  'Premature 194Q Deduction',
  'Wrongful TDS (Form 15G/15H)',
  'Unnecessary TDS (Transporter)',
  'Wrong Section (Non-Resident)',
  'Wrong Section (Resident Misclassified)',
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

function sumEventAmount(events) {
  return events.reduce((total, event) => total + Number(event.amount || 0), 0)
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

function rowCalculatedRate(events) {
  const rateLines = events.filter((event) => !isRateCheckSkipped(event))
  const baseAmount = rateLines.reduce((total, event) => total + Math.abs(Number(event.baseAmount || 0)), 0)
  const tdsAmount = rateLines.reduce((total, event) => total + Math.abs(Number(event.tdsAmount || 0)), 0)
  return baseAmount > 0 ? (tdsAmount / baseAmount) * 100 : null
}

// A GL row is red if any of its lines is, green only when every checkable line matches.
function rowRateStatus(events) {
  const statuses = events.map(eventRateStatus)
  if (statuses.includes('mismatched')) return 'mismatched'
  return statuses.includes('matched') ? 'matched' : null
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

function isEventTdsDeducted(event) {
  return Math.abs(Number(event.tdsAmount || 0)) > 0
}

// Flattens every transaction line from the document ledger and regroups the
// lines by company code + GL account number.
// "Old section / new section", e.g. "194C / 393(1)6(i)".
function sectionPairLabel(legacySection, newSection) {
  const oldSection = presentValue(legacySection)
  const nextSection = presentValue(newSection)
  if (oldSection && nextSection && oldSection !== nextSection) return `${oldSection} / ${nextSection}`
  return oldSection || nextSection || 'No Section'
}

function eventSectionLabel(event) {
  // Older cached uploads have no legacy/new split on events; fall back to tdsSection.
  if (event.legacySection === undefined && event.newSection === undefined) {
    return presentValue(event.tdsSection) || 'No Section'
  }
  return sectionPairLabel(event.legacySection, event.newSection)
}

function glSectionKey(companyCode, glAccount, sectionLabel) {
  return `${presentValue(companyCode) || '—'}||${presentValue(glAccount) || 'No GL'}||${sectionLabel}`
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

// One GL Ledger row per company + GL account + section + SAP rate + LDC
// certificate/rate, so e.g. 194C lines at 1% and at 2%, or under two
// different LDC certificates, on the same GL appear as separate rows.
function buildGlLedgerRows(ledgerRows, issues = []) {
  const groups = new Map()
  // Issues carry no SAP rate, so each one joins the row holding its document.
  const groupKeyByDocument = new Map()
  const firstGroupKeyBySection = new Map()
  ledgerRows.forEach((ledgerRow) => {
    (ledgerRow.events || []).forEach((event) => {
      const companyCode = presentValue(ledgerRow.companyCode) || '—'
      const glAccount = presentValue(event.glAccount) || 'No GL'
      const section = eventSectionLabel(event)
      const rate = eventSapRate(event)
      const ldc = eventLdc(event)
      const sectionKey = glSectionKey(companyCode, glAccount, section)
      const ldcKey = ldc ? `${ldc.certificate}|${ldc.exemptionRate}|${ldc.expectedRate ?? ''}` : 'no-ldc'
      const key = `${sectionKey}||${rate ?? 'none'}||${ldcKey}`
      if (!groups.has(key)) {
        groups.set(key, { id: `GL-${key}`, glKey: key, companyCode, glAccount, section, rate, ldc, events: [] })
      }
      const documentKey = `${sectionKey}||${presentValue(event.docNo) || ''}`
      if (!groupKeyByDocument.has(documentKey)) groupKeyByDocument.set(documentKey, key)
      if (!firstGroupKeyBySection.has(sectionKey)) firstGroupKeyBySection.set(sectionKey, key)
      groups.get(key).events.push({
        ...event,
        id: `${key}-${groups.get(key).events.length}`,
        vendor: ledgerRow.vendor,
        vendorId: ledgerRow.vendorId,
        pan: ledgerRow.pan,
      })
    })
  })

  const issuesByGlKey = new Map()
  issues.forEach((issue) => {
    const sectionKey = glSectionKey(issue.companyCode, issue.glAccount, sectionPairLabel(issue.legacySection, issue.newSection))
    const key = groupKeyByDocument.get(`${sectionKey}||${presentValue(issue.docNo) || ''}`)
      || firstGroupKeyBySection.get(sectionKey)
    if (!key) return
    if (!issuesByGlKey.has(key)) issuesByGlKey.set(key, [])
    issuesByGlKey.get(key).push(issue)
  })

  return [...groups.values()]
    .map((group) => {
      const deductedRows = group.events.filter(isEventTdsDeducted).length
      const baseAmount = group.events.reduce((total, event) => total + Math.abs(Number(event.baseAmount || 0)), 0)
      const tdsAmount = group.events.reduce((total, event) => total + Math.abs(Number(event.tdsAmount || 0)), 0)
      return {
        ...group,
        rowCount: group.events.length,
        baseAmount,
        tdsAmount,
        // Effective rate actually deducted across the row: TDS ÷ base over the
        // same lines the popup checks, so ₹0 adjustment lines don't dilute it.
        calculatedRate: rowCalculatedRate(group.events),
        rateStatus: rowRateStatus(group.events),
        deductedRows,
        notDeductedRows: group.events.length - deductedRows,
        issues: issuesByGlKey.get(group.glKey) || [],
        issueRows: (issuesByGlKey.get(group.glKey) || []).length,
      }
    })
    .sort((a, b) => (
      a.companyCode.localeCompare(b.companyCode)
      || a.glAccount.localeCompare(b.glAccount)
      || (a.section === 'No Section') - (b.section === 'No Section')
      || a.section.localeCompare(b.section)
      || (a.rate == null) - (b.rate == null)
      || (a.rate ?? 0) - (b.rate ?? 0)
      || (a.ldc != null) - (b.ldc != null)
      || (a.ldc?.certificate || '').localeCompare(b.ldc?.certificate || '')
      || (a.ldc?.exemptionRate ?? 0) - (b.ldc?.exemptionRate ?? 0)
    ))
}

// Checkbox dropdown used by every TDS Analysis filter. `value` is 'all' or an
// array of option values; ticking nothing (or "All") goes back to 'all'.
function MultiSelectFilter({ allLabel, options, value, disabled = false, disabledTitle, onChange }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef(null)
  const selected = selectedValues(value) || []
  const selectedSet = new Set(selected)
  const labelFor = (optionValue) => options.find(([candidate]) => candidate === optionValue)?.[1] || optionValue
  const buttonLabel = selected.length === 0
    ? allLabel
    : selected.length === 1 ? labelFor(selected[0]) : `${selected.length} selected`

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return undefined
    function handleOutsideClick(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  function toggle(optionValue) {
    const next = selectedSet.has(optionValue)
      ? selected.filter((item) => item !== optionValue)
      : [...selected, optionValue]
    onChange(next.length ? next : 'all')
  }

  return (
    <div className="case-filter-menu" ref={menuRef}>
      <button
        className={`filter-select case-filter-menu-button ${selected.length ? 'has-selection' : ''}`}
        type="button"
        disabled={disabled}
        title={disabled ? disabledTitle : selected.map(labelFor).join(', ') || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
      >
        <span>{buttonLabel}</span>
        <ChevronDown size={14} />
      </button>
      {open && !disabled && (
        <div className="case-filter-menu-list" role="listbox" aria-multiselectable="true">
          <button
            className={`case-filter-menu-option ${selected.length === 0 ? 'is-active' : ''}`}
            type="button"
            role="option"
            aria-selected={selected.length === 0}
            onClick={() => onChange('all')}
          >
            <input type="checkbox" readOnly tabIndex={-1} checked={selected.length === 0} />
            {allLabel}
          </button>
          {options.map(([optionValue, label]) => (
            <button
              className={`case-filter-menu-option ${selectedSet.has(optionValue) ? 'is-active' : ''}`}
              type="button"
              key={optionValue}
              role="option"
              aria-selected={selectedSet.has(optionValue)}
              onClick={() => toggle(optionValue)}
            >
              <input type="checkbox" readOnly tabIndex={-1} checked={selectedSet.has(optionValue)} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const SEVERITY_OPTIONS = [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]
const STATUS_OPTIONS = [['open', 'Open'], ['in_review', 'In Review'], ['resolved', 'Resolved'], ['rejected', 'Rejected']]
const ISSUES_TAB_ONLY = 'Only applies to the Issues tab'

export default function TDSCaseBuilder() {
  const dispatch = useDispatch()
  const savedView = useMemo(readSavedCaseBuilderView, [])
  const [activeTab, setActiveTab] = useState(savedView.activeTab)
  const [quickFilter, setQuickFilter] = useState(savedView.quickFilter)
  const [caseSearch, setCaseSearch] = useState('')
  const [docTypeFilter, setDocTypeFilter] = useState('all')
  const [expandedLedgerKey, setExpandedLedgerKey] = useState(null)
  const [glModal, setGlModal] = useState(null)
  const uploadMeta = useSelector((state) => state.issues.uploadMeta)
  const { searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter, issueTypeFilter } = useSelector((state) => state.issues)

  const filteredCaseLedger = useSelector(selectActiveCaseLedger)
  const issueRows = useSelector(selectActiveIssues)
  const validationRows = useSelector(selectActiveValidationRows)
  const ledgerRows = useMemo(() => (
    filteredCaseLedger.map((row) => ({ ...row, id: row.caseId }))
  ), [filteredCaseLedger])
  const hasUpload = Boolean(uploadMeta)
  // Counts follow the shared filter bar, using the Issues page's own
  // predicates so tab/card numbers match the cards inside the Issues tab.
  const filterValues = useMemo(() => ({
    searchQuery, vendorFilter, sectionFilter, docTypeFilter,
    severityFilter, statusFilter, issueTypeFilter,
  }), [searchQuery, vendorFilter, sectionFilter, docTypeFilter, severityFilter, statusFilter, issueTypeFilter])
  const filteredValidationRows = useMemo(() => (
    validationRows.filter((row) => validationRowMatchesFilters(row, filterValues))
  ), [validationRows, filterValues])
  // Rows with at least one issue — a row failing two rules counts once, so this
  // matches the "Issues Found" card inside the Issues tab.
  const issueRowCount = useMemo(() => {
    const filteredIssues = issueRows.filter((issue) => issueMatchesFilters(issue, filterValues))
    return issueRowsMatchingIssues(filteredValidationRows, filteredIssues).length
  }, [issueRows, filteredValidationRows, filterValues])
  const issueTypeOptions = useMemo(
    () => issueTypeFilterOptionsFor(issueRows, issueTypeFilter)
      .filter(([, label]) => TDS_ANALYSIS_ISSUE_TYPE_LABELS.has(label)),
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
  const sectionOptions = useMemo(() => {
    const values = [
      ...ledgerRows.flatMap((row) => [row.section, row.legacySection, row.newSection, ...(row.events || []).map((event) => event.tdsSection)]),
      ...issueRows.map((row) => row.section),
      ...validationRows.map((row) => row.section),
    ].map(presentValue).filter(Boolean)
    return [...new Set(values)].sort()
  }, [ledgerRows, issueRows, validationRows])
  const docTypeOptions = useMemo(() => {
    const values = [
      ...ledgerRows.flatMap((row) => (row.events || []).map((event) => event.docType)),
      ...issueRows.map((row) => row.docType),
      ...validationRows.map((row) => row.docType),
    ].map((value) => String(value || '').trim().toUpperCase()).filter((value) => value && value !== '—')
    return [...new Set(values)].sort()
  }, [ledgerRows, issueRows, validationRows])

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
    { key: 'assignmentNumber', header: 'Assignment No.', render: (row) => <span className="font-mono case-strong">{row.assignmentNumber || '—'}</span> },
    { key: 'invoiceAmount', header: 'Invoice', render: (row) => <span className="font-mono">{formatCurrency(row.invoiceAmount)}</span> },
    { key: 'baseAmount', header: 'Base Amount', render: (row) => <span className="font-mono">{formatCurrency(ledgerBaseAmount(row))}</span> },
    { key: 'advanceAmount', header: 'Advance', render: (row) => <span className="font-mono">{formatCurrency(row.advanceAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (row) => <span className="font-mono">{formatCurrency(row.tdsAmount)}</span> },
    { key: 'issueCount', header: 'Issues', render: (row) => <span className="font-mono">{row.issueCount}</span> },
    { key: 'status', header: 'Status', sortValue: (row) => row.status, render: (row) => <StatusBadge label={row.status} tone={row.status === 'ISSUE' ? 'danger' : row.status === 'BALANCED' ? 'success' : 'warning'} /> },
  ]

  // Ledger groups matching the filter bar; drives the tab count, the ledger
  // summary cards and (after the quick filter) the table.
  const filteredLedgerRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return ledgerRows.filter((row) => {
      const events = row.events || []
      const eventText = events.map((event) => [
        event.docNo,
        event.docType,
        event.assignmentNumber,
        event.eventType,
        event.glAccount,
        event.tdsSection,
        event.referenceDoc,
      ].join(' ')).join(' ')
      const rowSections = [row.section, row.legacySection, row.newSection, ...events.map((event) => event.tdsSection)]
        .map(presentValue)
        .filter(Boolean)
      const rowDocTypes = events.map((event) => String(event.docType || '').trim().toUpperCase()).filter(Boolean)

      if (!filterIncludes(vendorFilter, row.vendor)) return false
      if (!filterMatchesAny(sectionFilter, (section) => sectionMatches(section, rowSections))) return false
      if (!filterMatchesAny(docTypeFilter, (docType) => rowDocTypes.includes(docType))) return false

      if (!query) return true
      const searchable = [
        row.anchorDocNo,
        row.groupType,
        row.vendor,
        row.vendorId,
        row.pan,
        row.section,
        row.assignmentNumber,
        row.clearingDocument,
        row.status,
        row.docNo,
        row.category,
        row.issueTypeLabel,
        row.description,
        row.plainEnglish,
        row.severity,
        eventText,
      ].filter(Boolean).join(' ').toLowerCase()
      return searchable.includes(query)
    })
  }, [ledgerRows, searchQuery, vendorFilter, sectionFilter, docTypeFilter])
  const visibleRows = useMemo(() => {
    if (quickFilter === 'ledger-balanced') return filteredLedgerRows.filter((row) => row.status === 'BALANCED')
    if (quickFilter === 'ledger-open') return filteredLedgerRows.filter((row) => row.openItem || row.status === 'OPEN')
    if (quickFilter === 'ledger-issue') return filteredLedgerRows.filter((row) => row.status === 'ISSUE')
    return filteredLedgerRows
  }, [quickFilter, filteredLedgerRows])

  const summaryCards = useMemo(() => [
    { label: 'Transactions', value: filteredValidationRows.length, icon: FileSpreadsheet, tone: 'info', tab: 'ledger', filter: 'ledger-all', description: 'Transactions in the selected Company/FY scope and filters' },
    { label: 'Document Groups', value: filteredLedgerRows.length, icon: ListTree, tone: 'success', tab: 'ledger', filter: 'ledger-all', description: 'Grouped by clearing / reference' },
    { label: 'Balanced Groups', value: filteredLedgerRows.filter((row) => row.status === 'BALANCED').length, icon: GitBranch, tone: 'success', tab: 'ledger', filter: 'ledger-balanced', description: 'Net amount is zero' },
    { label: 'Open Items', value: filteredLedgerRows.filter((row) => row.openItem || row.status === 'OPEN').length, icon: AlertTriangle, tone: 'warning', tab: 'ledger', filter: 'ledger-open', description: 'No clearing document found' },
    { label: 'Issue Groups', value: filteredLedgerRows.filter((row) => row.status === 'ISSUE').length, icon: ShieldAlert, tone: 'danger', tab: 'ledger', filter: 'ledger-issue', description: 'Ledger groups with issue' },
    { label: 'Issues', value: issueRowCount, icon: ShieldAlert, tone: 'danger', tab: 'issues', filter: 'issues-all', description: 'Rows failing TDS rules' },
  ], [filteredValidationRows, filteredLedgerRows, issueRowCount])
  const canExpand = activeTab === 'ledger'

  // GL tab: vendor/section/doc type filters apply per transaction line before
  // grouping, so group totals reflect only the matching lines.
  const glRows = useMemo(() => {
    const lineFilteredLedgerRows = ledgerRows
      .filter((row) => filterIncludes(vendorFilter, row.vendor))
      .map((row) => ({
        ...row,
        events: (row.events || []).filter((event) => {
          if (!filterMatchesAny(sectionFilter, (section) => sectionMatches(section, [event.tdsSection].map(presentValue).filter(Boolean)))) return false
          if (!filterIncludes(docTypeFilter, String(event.docType || '').trim().toUpperCase())) return false
          return true
        }),
      }))
    const lineFilteredIssues = issueRows.filter((issue) => (
      filterIncludes(vendorFilter, issue.vendor)
      && filterMatchesAny(sectionFilter, (section) => sectionMatches(section, [issue.section, issue.legacySection, issue.ruleSection, issue.newSection].map(presentValue).filter(Boolean)))
      && filterIncludes(docTypeFilter, String(issue.docType || '').trim().toUpperCase())
    ))
    const query = searchQuery.trim().toLowerCase()
    return buildGlLedgerRows(lineFilteredLedgerRows, lineFilteredIssues).filter((group) => {
      if (!query) return true
      const searchable = [
        group.companyCode,
        group.glAccount,
        group.section,
        ...group.events.map((event) => [
          event.docNo,
          event.docType,
          event.vendor,
          event.vendorId,
          event.pan,
          event.tdsSection,
          event.eventType,
          event.referenceDoc,
          ...(event.issues || []),
        ].join(' ')),
      ].filter(Boolean).join(' ').toLowerCase()
      return searchable.includes(query)
    })
  }, [ledgerRows, issueRows, vendorFilter, sectionFilter, docTypeFilter, searchQuery])

  // Totals across the GL rows in view, shown above their columns.
  const glTotals = useMemo(() => glRows.reduce((totals, row) => ({
    baseAmount: totals.baseAmount + (Number(row.baseAmount) || 0),
    tdsAmount: totals.tdsAmount + (Number(row.tdsAmount) || 0),
  }), { baseAmount: 0, tdsAmount: 0 }), [glRows])

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
    { key: 'eventType', header: 'Event', render: (event) => event.eventType },
    { key: 'debitCredit', header: 'D/C', render: (event) => <span className="font-mono">{event.debitCredit}</span> },
    { key: 'amount', header: 'Document Amount', render: (event) => <span className="font-mono">{formatCurrency(event.amount)}</span> },
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
    { key: 'baseAmount', header: 'Base Amount', render: (issue) => <span className="font-mono">{formatCurrency(issue.baseAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (issue) => <span className="font-mono">{formatCurrency(issue.tdsAmount)}</span> },
    { key: 'category', header: 'Issue Type', sortValue: (issue) => getDisplayIssueType(issue), render: (issue) => getDisplayIssueType(issue) },
    { key: 'severity', header: 'Severity', render: (issue) => <StatusBadge label={issue.severity} tone={severityToTone(issue.severity)} /> },
    { key: 'description', header: 'Details', render: (issue) => <span className="case-tds-note case-gl-modal-note" title={issue.description || ''}>{issue.description || '—'}</span> },
    { header: '', render: (issue) => (
      <button
        type="button"
        className="issues-review-btn"
        onClick={(event) => { event.stopPropagation(); dispatch(openDrawer(issue.id)) }}
      >
        Review
      </button>
    )},
  ]

  function downloadGlIssues(row) {
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

  const activeGlModalRow = glModal ? glRows.find((row) => row.glKey === glModal.key) : null

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
        <span className="font-mono">{event.debitCredit}</span>
        <span className="font-mono">{formatCurrency(event.amount)}</span>
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
          Document Ledger ({filteredLedgerRows.length.toLocaleString()})
        </button>
        <button type="button" className={`case-tab ${activeTab === 'issues' ? 'active' : ''}`} onClick={() => applyQuickFilter('issues', 'issues-all')}>
          Issues ({issueRowCount.toLocaleString()})
        </button>
        <button type="button" className={`case-tab ${activeTab === 'gl' ? 'active' : ''}`} onClick={() => applyQuickFilter('gl', 'gl-all')}>
          GL Ledger ({glRows.length.toLocaleString()})
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
        <input
          className="filter-input"
          value={searchQuery}
          onChange={(event) => dispatch(setSearchQuery(event.target.value))}
          placeholder="Search vendor / doc / ID / section / PAN…"
        />
      </div>
      <div className="filter-bar-controls">
        <MultiSelectFilter
          allLabel="All Vendors"
          options={vendorOptions.map((vendor) => [vendor, vendor])}
          value={vendorFilter}
          onChange={(next) => dispatch(setVendorFilter(next))}
        />
        <MultiSelectFilter
          allLabel="All Sections"
          options={sectionOptions.map((section) => [section, section])}
          value={sectionFilter}
          onChange={(next) => dispatch(setSectionFilter(next))}
        />
        <MultiSelectFilter
          allLabel="All Severity"
          options={SEVERITY_OPTIONS}
          value={severityFilter}
          disabled={activeTab !== 'issues'}
          disabledTitle={ISSUES_TAB_ONLY}
          onChange={(next) => dispatch(setSeverityFilter(next))}
        />
        <MultiSelectFilter
          allLabel="All Issue Types"
          options={issueTypeOptions}
          value={issueTypeFilter}
          disabled={activeTab !== 'issues'}
          disabledTitle={ISSUES_TAB_ONLY}
          onChange={(next) => dispatch(setIssueTypeFilter(next))}
        />
        <MultiSelectFilter
          allLabel="All Status"
          options={STATUS_OPTIONS}
          value={statusFilter}
          disabled={activeTab !== 'issues'}
          disabledTitle={ISSUES_TAB_ONLY}
          onChange={(next) => dispatch(setStatusFilter(next))}
        />
        <MultiSelectFilter
          allLabel="All Doc Types"
          options={docTypeOptions.map((docType) => [docType, docType])}
          value={docTypeFilter}
          onChange={setDocTypeFilter}
        />
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
        </div>
      </div>

      <SapUploadPanel compact showResults={false} defaultCompanyCode="" followSelectedCompany={false} forceAllCompanyOption />

      {!hasUpload && (
        <div className="case-empty-source">
          Upload a combined SAP extract here to build the document ledger and issues.
        </div>
      )}

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


      {sharedFilters}

      {activeTab === 'issues' ? (
        <Issues embedded initialView="all" hideFilters beforeSummary={resultsTabsPanel} externalDocTypeFilter={docTypeFilter} onExternalDocTypeFilterChange={setDocTypeFilter} />
      ) : activeTab === 'gl' ? (
        <>
          {resultsTabsPanel}
          {/* Review drawer for the GL issues pop-up, shared with the Issues tab. */}
          <Issues embedded reviewOnly />
          <div className="table-card">
          <DataTable
            columns={glColumns}
            data={glRows}
            pageSize={200}
            renderPreHeaderCell={(col) => (
              col.key === 'baseAmount' || col.key === 'tdsAmount' ? (
                <span className="font-mono case-strong" title={`Total ${col.header} across ${glRows.length.toLocaleString()} GL rows`}>
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
                  {glModal.type === 'issues' ? (
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
          <div className="table-card">
          <DataTable
            columns={ledgerColumns}
            data={visibleRows}
            pageSize={200}
            expandedRowKey={canExpand ? expandedLedgerKey : null}
            onRowClick={canExpand ? (row) => setExpandedLedgerKey((key) => key === row.id ? null : row.id) : undefined}
            renderExpandedRow={canExpand ? renderLedgerLines : undefined}
            emptyState={<div className="data-table-empty">No rows found for this view</div>}
          />
          </div>
        </>
      )}
    </div>
  )
}
