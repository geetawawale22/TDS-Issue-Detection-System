import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { AlertTriangle, ChevronDown, Download, FileSpreadsheet, GitBranch, ListTree, RotateCcw, ShieldAlert, SlidersHorizontal, X } from 'lucide-react'
import Issues from '@/pages/Issues/Issues'
import DataTable from '@/components/Common/DataTable'
import SapUploadPanel from '@/components/Common/SapUploadPanel'
import StatusBadge, { severityToTone } from '@/components/Common/StatusBadge'
import {
  resetFilters, setIssueTypeFilter, setSearchQuery, setSectionFilter, setSeverityFilter,
  setStatusFilter, setVendorFilter, selectActiveIssues, selectActiveValidationRows,
  selectActiveCaseLedger,
} from '@/redux/slices/issuesSlice'
import { formatCurrency, formatDate } from '@/utils/utils'
import { sectionMatches } from '@/utils/sectionAliases'
import { getDisplayIssueType, issueTypeFilterOptions } from '@/data/issueTypes'
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
const TDS_ANALYSIS_ISSUE_TYPE_OPTIONS = issueTypeFilterOptions()
  .filter(([, label]) => TDS_ANALYSIS_ISSUE_TYPE_LABELS.has(label))

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

function glGroupKey(companyCode, glAccount, sectionLabel) {
  return `${presentValue(companyCode) || '—'}||${presentValue(glAccount) || 'No GL'}||${sectionLabel}`
}

function buildGlLedgerRows(ledgerRows, issuesByGlKey = new Map()) {
  const groups = new Map()
  ledgerRows.forEach((ledgerRow) => {
    (ledgerRow.events || []).forEach((event) => {
      const companyCode = presentValue(ledgerRow.companyCode) || '—'
      const glAccount = presentValue(event.glAccount) || 'No GL'
      const section = eventSectionLabel(event)
      const key = glGroupKey(companyCode, glAccount, section)
      if (!groups.has(key)) {
        groups.set(key, { id: `GL-${key}`, glKey: key, companyCode, glAccount, section, events: [] })
      }
      groups.get(key).events.push({
        ...event,
        id: `${key}-${groups.get(key).events.length}`,
        vendor: ledgerRow.vendor,
        vendorId: ledgerRow.vendorId,
        pan: ledgerRow.pan,
      })
    })
  })

  return [...groups.values()]
    .map((group) => {
      const deductedRows = group.events.filter(isEventTdsDeducted).length
      // Unique SAP-reported rates only (no TDS ÷ base derivation), matched at
      // two decimals so 1 / 1.0 / 1.00 collapse into one value.
      const rates = [...new Set(group.events
        .map((event) => (event.sapRate == null || event.sapRate === '' ? NaN : Number(event.sapRate)))
        .filter((rate) => !Number.isNaN(rate) && rate !== 0)
        .map((rate) => Math.round(rate * 100) / 100))]
        .sort((x, y) => x - y)
      const ldcRates = [...new Set(group.events
        .filter((event) => event.ldcRate != null && event.ldcRate !== '' && !Number.isNaN(Number(event.ldcRate)))
        .map((event) => Math.round(Number(event.ldcRate) * 100) / 100))]
        .sort((x, y) => x - y)
      const ldcCertificates = [...new Set(group.events.map((event) => presentValue(event.ldcCertificate) && event.ldcRate != null ? event.ldcCertificate : null).filter(Boolean))]
      return {
        ...group,
        rowCount: group.events.length,
        vendorCount: new Set(group.events.map((event) => presentValue(event.vendorId) || presentValue(event.vendor)).filter(Boolean)).size,
        documentAmount: group.events.reduce((total, event) => total + Number(event.amount || 0), 0),
        baseAmount: group.events.reduce((total, event) => total + Math.abs(Number(event.baseAmount || 0)), 0),
        tdsAmount: group.events.reduce((total, event) => total + Math.abs(Number(event.tdsAmount || 0)), 0),
        deductedRows,
        notDeductedRows: group.events.length - deductedRows,
        rates,
        ldcRates,
        ldcCertificates,
        issues: issuesByGlKey.get(group.glKey) || [],
        issueRows: (issuesByGlKey.get(group.glKey) || []).length,
      }
    })
    .sort((a, b) => (
      a.companyCode.localeCompare(b.companyCode)
      || a.glAccount.localeCompare(b.glAccount)
      || (a.section === 'No Section') - (b.section === 'No Section')
      || a.section.localeCompare(b.section)
    ))
}

function IssueTypeDropdown({ value, disabled, onChange }) {
  const [open, setOpen] = useState(false)
  const selectedLabel = value === 'all'
    ? 'All Issue Types'
    : TDS_ANALYSIS_ISSUE_TYPE_OPTIONS.find(([optionValue]) => optionValue === value)?.[1] || value

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <div className="case-filter-menu">
      <button
        className="filter-select case-filter-menu-button"
        type="button"
        disabled={disabled}
        title={disabled ? 'Only applies to the Issues tab' : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
      >
        <span>{selectedLabel}</span>
        <ChevronDown size={14} />
      </button>
      {open && !disabled && (
        <div className="case-filter-menu-list" role="listbox">
          <button
            className={`case-filter-menu-option ${value === 'all' ? 'is-active' : ''}`}
            type="button"
            role="option"
            aria-selected={value === 'all'}
            onClick={() => { onChange('all'); setOpen(false) }}
          >
            All Issue Types
          </button>
          {TDS_ANALYSIS_ISSUE_TYPE_OPTIONS.map(([optionValue, label]) => (
            <button
              className={`case-filter-menu-option ${value === optionValue ? 'is-active' : ''}`}
              type="button"
              key={optionValue}
              role="option"
              aria-selected={value === optionValue}
              onClick={() => { onChange(optionValue); setOpen(false) }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

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

  const summaryCards = useMemo(() => [
    { label: 'Transactions', value: validationRows.length, icon: FileSpreadsheet, tone: 'info', tab: 'ledger', filter: 'ledger-all', description: 'Transactions in the selected Company/FY scope' },
    { label: 'Document Groups', value: ledgerRows.length, icon: ListTree, tone: 'success', tab: 'ledger', filter: 'ledger-all', description: 'Grouped by clearing / reference' },
    { label: 'Balanced Groups', value: ledgerRows.filter((row) => row.status === 'BALANCED').length, icon: GitBranch, tone: 'success', tab: 'ledger', filter: 'ledger-balanced', description: 'Net amount is zero' },
    { label: 'Open Items', value: ledgerRows.filter((row) => row.openItem || row.status === 'OPEN').length, icon: AlertTriangle, tone: 'warning', tab: 'ledger', filter: 'ledger-open', description: 'No clearing document found' },
    { label: 'Issue Groups', value: ledgerRows.filter((row) => row.status === 'ISSUE').length, icon: ShieldAlert, tone: 'danger', tab: 'ledger', filter: 'ledger-issue', description: 'Ledger groups with issue' },
    { label: 'Issues', value: issueRows.length, icon: ShieldAlert, tone: 'danger', tab: 'issues', filter: 'issues-all', description: 'Rows failing TDS rules' },
  ], [validationRows, ledgerRows, issueRows])

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

  const activeRows = useMemo(() => {
    if (quickFilter === 'ledger-balanced') return ledgerRows.filter((row) => row.status === 'BALANCED')
    if (quickFilter === 'ledger-open') return ledgerRows.filter((row) => row.openItem || row.status === 'OPEN')
    if (quickFilter === 'ledger-issue') return ledgerRows.filter((row) => row.status === 'ISSUE')
    return ledgerRows
  }, [quickFilter, ledgerRows])
  const visibleRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return activeRows.filter((row) => {
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

      if (vendorFilter !== 'all' && row.vendor !== vendorFilter) return false
      if (sectionFilter !== 'all' && !sectionMatches(sectionFilter, rowSections)) return false
      if (docTypeFilter !== 'all' && !rowDocTypes.includes(docTypeFilter)) return false

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
  }, [activeRows, searchQuery, vendorFilter, sectionFilter, docTypeFilter])
  const canExpand = activeTab === 'ledger'

  // GL tab: vendor/section/doc type filters apply per transaction line before
  // grouping, so group totals reflect only the matching lines.
  const glRows = useMemo(() => {
    const filteredLedgerRows = ledgerRows
      .filter((row) => vendorFilter === 'all' || row.vendor === vendorFilter)
      .map((row) => ({
        ...row,
        events: (row.events || []).filter((event) => {
          if (sectionFilter !== 'all' && !sectionMatches(sectionFilter, [event.tdsSection].map(presentValue).filter(Boolean))) return false
          if (docTypeFilter !== 'all' && String(event.docType || '').trim().toUpperCase() !== docTypeFilter) return false
          return true
        }),
      }))
    const issuesByGlKey = new Map()
    issueRows.forEach((issue) => {
      if (vendorFilter !== 'all' && issue.vendor !== vendorFilter) return
      if (sectionFilter !== 'all' && !sectionMatches(sectionFilter, [issue.section, issue.legacySection, issue.ruleSection, issue.newSection].map(presentValue).filter(Boolean))) return
      if (docTypeFilter !== 'all' && String(issue.docType || '').trim().toUpperCase() !== docTypeFilter) return
      const key = glGroupKey(issue.companyCode, issue.glAccount, sectionPairLabel(issue.legacySection, issue.newSection))
      if (!issuesByGlKey.has(key)) issuesByGlKey.set(key, [])
      issuesByGlKey.get(key).push(issue)
    })
    const query = searchQuery.trim().toLowerCase()
    return buildGlLedgerRows(filteredLedgerRows, issuesByGlKey).filter((group) => {
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

  const glColumns = [
    { key: 'companyCode', header: 'Company', render: (row) => <span className="font-mono">{row.companyCode}</span> },
    { key: 'glAccount', header: 'GL Account', render: (row) => (
      <div>
        <div className="font-mono case-strong">{row.glAccount}</div>
        <div className="case-muted">{row.rowCount} rows</div>
      </div>
    )},
    { key: 'vendorCount', header: 'Vendors', render: (row) => <span className="font-mono">{row.vendorCount}</span> },
    { key: 'section', header: 'Section (Old / New)', render: (row) => (
      <span className={`font-mono ${row.section === 'No Section' ? 'case-muted' : ''}`}>{row.section}</span>
    )},
    { key: 'documentAmount', header: 'Document Amount', render: (row) => <span className="font-mono">{formatCurrency(row.documentAmount)}</span> },
    { key: 'baseAmount', header: 'Base Amount', render: (row) => <span className="font-mono">{formatCurrency(row.baseAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (row) => <span className="font-mono">{formatCurrency(row.tdsAmount)}</span> },
    { key: 'rate', header: 'Rate', sortValue: (row) => row.rates[0] ?? -1, render: (row) => (
      <div>
        <span className="font-mono" title={row.rates.length ? 'Unique TDS rates reported by SAP' : 'No SAP TDS rate on this GL section'}>
          {row.rates.length ? row.rates.map(formatRate).join(', ') : '—'}
        </span>
        {row.ldcRates.length > 0 && (
          <div className="case-ldc-rate font-mono" title={`LDC certificate${row.ldcCertificates.length === 1 ? '' : 's'}: ${row.ldcCertificates.join(', ')}`}>
            LDC {row.ldcRates.map(formatRate).join(', ')}
          </div>
        )}
      </div>
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
          title={row.issueRows ? `View ${row.issueRows} issues on GL ${row.glAccount}, section ${row.section}` : 'No issues on this GL section'}
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
    { key: 'tdsRate', header: 'Rate', sortValue: (event) => appliedRateForEvent(event), render: (event) => (
      <div>
        <span className="font-mono">{formatRate(appliedRateForEvent(event))}</span>
        {event.ldcRate != null && event.ldcRate !== '' && (
          <div className="case-ldc-rate font-mono" title={event.ldcCertificate ? `LDC certificate ${event.ldcCertificate}` : 'LDC rate'}>
            LDC {formatRate(event.ldcRate)}
          </div>
        )}
      </div>
    ) },
    { key: 'tdsAmount', header: 'TDS', render: (event) => <span className="font-mono">{formatCurrency(event.tdsAmount)}</span> },
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
  ]

  function downloadGlIssues(row) {
    const fileBase = (uploadMeta?.fileName || 'tds-analysis').replace(/\.[^.]+$/, '')
    downloadCsv(
      `${fileBase}-GL-${row.glAccount}-${row.section.replace(/[^A-Za-z0-9]+/g, '_')}-${row.companyCode}-issues.csv`,
      [
        { label: 'Company', value: () => row.companyCode },
        { label: 'GL Account', value: () => row.glAccount },
        { label: 'GL Section (Old / New)', value: () => row.section },
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
          Document Ledger ({ledgerRows.length.toLocaleString()})
        </button>
        <button type="button" className={`case-tab ${activeTab === 'issues' ? 'active' : ''}`} onClick={() => applyQuickFilter('issues', 'issues-all')}>
          Issues ({issueRows.length.toLocaleString()})
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
        <select className="filter-select" value={vendorFilter} onChange={(event) => dispatch(setVendorFilter(event.target.value))}>
          <option value="all">All Vendors</option>
          {vendorOptions.slice(0, 80).map((vendor) => <option key={vendor} value={vendor}>{vendor}</option>)}
        </select>
        <select className="filter-select" value={sectionFilter} onChange={(event) => dispatch(setSectionFilter(event.target.value))}>
          <option value="all">All Sections</option>
          {sectionOptions.map((section) => <option key={section} value={section}>{section}</option>)}
        </select>
        <select
          className="filter-select"
          value={severityFilter}
          disabled={activeTab !== 'issues'}
          title={activeTab !== 'issues' ? 'Only applies to the Issues tab' : undefined}
          onChange={(event) => dispatch(setSeverityFilter(event.target.value))}
        >
          <option value="all">All Severity</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <IssueTypeDropdown
          value={issueTypeFilter}
          disabled={activeTab !== 'issues'}
          onChange={(nextValue) => dispatch(setIssueTypeFilter(nextValue))}
        />
        <select
          className="filter-select"
          value={statusFilter}
          disabled={activeTab !== 'issues'}
          title={activeTab !== 'issues' ? 'Only applies to the Issues tab' : undefined}
          onChange={(event) => dispatch(setStatusFilter(event.target.value))}
        >
          <option value="all">All Status</option>
          <option value="open">Open</option>
          <option value="in_review">In Review</option>
          <option value="resolved">Resolved</option>
          <option value="rejected">Rejected</option>
        </select>
        <select className="filter-select" value={docTypeFilter} onChange={(event) => setDocTypeFilter(event.target.value)}>
          <option value="all">All Doc Types</option>
          {docTypeOptions.map((docType) => <option key={docType} value={docType}>{docType}</option>)}
        </select>
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
          <div className="table-card">
          <DataTable
            columns={glColumns}
            data={glRows}
            pageSize={200}
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
