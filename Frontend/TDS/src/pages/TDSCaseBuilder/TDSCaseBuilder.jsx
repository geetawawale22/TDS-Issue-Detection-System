import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { AlertTriangle, FileSpreadsheet, GitBranch, ListTree, RotateCcw, ShieldAlert, SlidersHorizontal } from 'lucide-react'
import Issues from '@/pages/Issues/Issues'
import DataTable from '@/components/Common/DataTable'
import SapUploadPanel from '@/components/Common/SapUploadPanel'
import StatusBadge from '@/components/Common/StatusBadge'
import { resetFilters, setIssueTypeFilter, setSearchQuery, setSectionFilter, setSeverityFilter, setStatusFilter, setVendorFilter } from '@/redux/slices/issuesSlice'
import { formatCurrency } from '@/utils/utils'
import { sectionMatches } from '@/utils/sectionAliases'
import '@/components/Common/Common.css'
import './TDSCaseBuilder.css'

const CASE_BUILDER_VIEW_STORAGE_KEY = 'tds_case_builder_view'
const DEFAULT_CASE_BUILDER_VIEW = { activeTab: 'ledger', quickFilter: 'ledger-all' }
const VALID_TABS = new Set(['ledger', 'issues'])

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

export default function TDSCaseBuilder() {
  const dispatch = useDispatch()
  const savedView = useMemo(readSavedCaseBuilderView, [])
  const [activeTab, setActiveTab] = useState(savedView.activeTab)
  const [quickFilter, setQuickFilter] = useState(savedView.quickFilter)
  const [caseSearch, setCaseSearch] = useState('')
  const [docTypeFilter, setDocTypeFilter] = useState('all')
  const [expandedLedgerKey, setExpandedLedgerKey] = useState(null)
  const uploadMeta = useSelector((state) => state.issues.uploadMeta)
  const uploadedIssues = useSelector((state) => state.issues.uploadedIssues)
  const { searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter, issueTypeFilter } = useSelector((state) => state.issues)

  const stats = uploadMeta?.stats || {}
  const ledgerRows = useMemo(() => (
    (uploadMeta?.caseLedger || []).map((row) => ({ ...row, id: row.caseId }))
  ), [uploadMeta])
  const issueRows = uploadedIssues || []
  const hasUpload = Boolean(uploadMeta)
  const validationRows = uploadMeta?.validationRows || []
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
    { label: 'Rows Read', value: stats.rowsRead ?? 0, icon: FileSpreadsheet, tone: 'info', tab: 'ledger', filter: 'ledger-all', description: 'Total rows read from upload' },
    { label: 'Document Groups', value: stats.ledgerCases ?? 0, icon: ListTree, tone: 'success', tab: 'ledger', filter: 'ledger-all', description: 'Grouped by clearing / reference' },
    { label: 'Balanced Groups', value: stats.balancedLedgerCases ?? 0, icon: GitBranch, tone: 'success', tab: 'ledger', filter: 'ledger-balanced', description: 'Net amount is zero' },
    { label: 'Open Items', value: stats.openLedgerCases ?? 0, icon: AlertTriangle, tone: 'warning', tab: 'ledger', filter: 'ledger-open', description: 'No clearing document found' },
    { label: 'Issue Groups', value: stats.issueLedgerCases ?? 0, icon: ShieldAlert, tone: 'danger', tab: 'ledger', filter: 'ledger-issue', description: 'Ledger groups with issue' },
    { label: 'Issues', value: stats.issuesFound ?? 0, icon: ShieldAlert, tone: 'danger', tab: 'issues', filter: 'issues-all', description: 'Rows failing TDS rules' },
  ], [stats])

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

  function applyQuickFilter(tab, filter) {
    setActiveTab(tab)
    setQuickFilter(filter)
    setCaseSearch('')
    setExpandedLedgerKey(null)
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
        <select
          className="filter-select"
          value={issueTypeFilter}
          disabled={activeTab !== 'issues'}
          title={activeTab !== 'issues' ? 'Only applies to the Issues tab' : undefined}
          onChange={(event) => dispatch(setIssueTypeFilter(event.target.value))}
        >
          <option value="all">All Issue Types</option>
          <option value="Possible Missed TDS Deduction">Possible Missed TDS Deduction</option>
          <option value="Short TDS Deducted — Amount Mismatch">Short TDS Deducted — Amount Mismatch</option>
          <option value="Excess TDS Deducted — Amount Mismatch">Excess TDS Deducted — Amount Mismatch</option>
          <option value="Wrong TDS Rate">Wrong TDS Rate</option>
          <option value="TDS Deducted as per LDC — Mismatch">TDS Deducted as per LDC — Mismatch</option>
        </select>
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
