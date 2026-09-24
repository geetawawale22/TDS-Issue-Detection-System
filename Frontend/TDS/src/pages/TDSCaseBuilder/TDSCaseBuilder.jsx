import { useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { AlertTriangle, FileSpreadsheet, GitBranch, ListTree, Search, ShieldAlert } from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge from '@/components/Common/StatusBadge'
import { formatCurrency } from '@/utils/utils'
import '@/components/Common/Common.css'
import './TDSCaseBuilder.css'

const ADVANCE_ISSUE_TEXT = /advance|advance adjusted invoice|advance payment/i
const CASE_BUILDER_VIEW_STORAGE_KEY = 'tds_case_builder_view'
const DEFAULT_CASE_BUILDER_VIEW = { activeTab: 'ledger', quickFilter: 'ledger-all' }
const VALID_TABS = new Set(['ledger', 'advance', 'advanceIssues', 'issues'])

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

function hasAdvanceSignal(row) {
  if (Number(row.advanceAmount || 0) > 0) return true
  if ((row.events || []).some((event) => event.eventType === 'ADVANCE_PAYMENT')) return true
  return (row.events || []).some((event) => event.referenceDoc && event.referenceDoc !== '—')
}

export default function TDSCaseBuilder() {
  const savedView = useMemo(readSavedCaseBuilderView, [])
  const [activeTab, setActiveTab] = useState(savedView.activeTab)
  const [quickFilter, setQuickFilter] = useState(savedView.quickFilter)
  const [caseSearch, setCaseSearch] = useState('')
  const [expandedLedgerKey, setExpandedLedgerKey] = useState(null)
  const uploadMeta = useSelector((state) => state.issues.uploadMeta)
  const uploadedIssues = useSelector((state) => state.issues.uploadedIssues)

  const stats = uploadMeta?.stats || {}
  const caseStats = uploadMeta?.caseStats || {}
  const ledgerRows = useMemo(() => (
    (uploadMeta?.caseLedger || []).map((row) => ({ ...row, id: row.caseId }))
  ), [uploadMeta])
  const issueRows = uploadedIssues || []
  const advanceIssueRows = useMemo(() => (
    issueRows.filter((issue) => ADVANCE_ISSUE_TEXT.test(issue.category || issue.issueTypeLabel || ''))
  ), [issueRows])
  const advanceLedgerRows = useMemo(() => ledgerRows.filter(hasAdvanceSignal), [ledgerRows])
  const hasUpload = Boolean(uploadMeta)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(CASE_BUILDER_VIEW_STORAGE_KEY, JSON.stringify({
      activeTab,
      quickFilter,
    }))
  }, [activeTab, quickFilter])
  const advanceTotals = useMemo(() => {
    const totals = advanceLedgerRows.reduce((acc, row) => {
      acc.invoice += Number(row.invoiceAmount || 0)
      acc.advance += Number(row.advanceAmount || 0)
      acc.payment += Number(row.paymentAmount || 0)
      acc.tds += Number(row.tdsAmount || 0)
      if (row.status === 'ISSUE') acc.issueGroups += 1
      return acc
    }, { invoice: 0, advance: 0, payment: 0, tds: 0, issueGroups: 0 })
    return {
      ...totals,
      groups: advanceLedgerRows.length,
      issues: advanceIssueRows.length,
    }
  }, [advanceLedgerRows, advanceIssueRows])

  const summaryCards = useMemo(() => [
    { label: 'Rows Read', value: stats.rowsRead ?? 0, icon: FileSpreadsheet, tone: 'info', tab: 'ledger', filter: 'ledger-all' },
    { label: 'Document Groups', value: stats.ledgerCases ?? 0, icon: ListTree, tone: 'success', tab: 'ledger', filter: 'ledger-all' },
    { label: 'Balanced Groups', value: stats.balancedLedgerCases ?? 0, icon: GitBranch, tone: 'success', tab: 'ledger', filter: 'ledger-balanced' },
    { label: 'Open Groups', value: stats.openLedgerCases ?? 0, icon: AlertTriangle, tone: 'warning', tab: 'ledger', filter: 'ledger-open' },
    { label: 'Advance Rows', value: caseStats.advanceCases ?? 0, icon: GitBranch, tone: 'info', tab: 'advance', filter: 'advance-with-amount' },
    { label: 'Rule Issues', value: stats.issuesFound ?? 0, icon: ShieldAlert, tone: 'danger', tab: 'issues', filter: 'issues-all' },
  ], [stats, caseStats])

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
        <div className="case-muted">{row.groupType} · {row.eventCount} rows</div>
      </div>
    )},
    { key: 'section', header: 'Section', render: renderSection },
    { key: 'assignmentNumber', header: 'Assignment No.', render: (row) => <span className="font-mono case-strong">{row.assignmentNumber || '—'}</span> },
    { key: 'invoiceAmount', header: 'Invoice', render: (row) => <span className="font-mono">{formatCurrency(row.invoiceAmount)}</span> },
    { key: 'advanceAmount', header: 'Advance', render: (row) => <span className="font-mono">{formatCurrency(row.advanceAmount)}</span> },
    { key: 'paymentAmount', header: 'Payment', render: (row) => <span className="font-mono">{formatCurrency(row.paymentAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (row) => <span className="font-mono">{formatCurrency(row.tdsAmount)}</span> },
    { key: 'issueCount', header: 'Issues', render: (row) => <span className="font-mono">{row.issueCount}</span> },
    { key: 'status', header: 'Status', sortValue: (row) => row.status, render: (row) => <StatusBadge label={row.status} tone={row.status === 'ISSUE' ? 'danger' : row.status === 'BALANCED' ? 'success' : 'warning'} /> },
  ]

  const issueColumns = [
    { key: 'vendor', header: 'Vendor', render: (row) => (
      <div>
        <div className="case-strong">{row.vendor}</div>
        <div className="font-mono case-muted">{row.vendorId || '—'}</div>
      </div>
    )},
    { key: 'pan', header: 'PAN', render: (row) => <span className="font-mono case-muted">{row.vendorPan || row.pan || row.vendorId || '—'}</span> },
    { key: 'docNo', header: 'Doc No.', render: (row) => <span className="font-mono">{row.docNo}</span> },
    { key: 'section', header: 'Section', render: renderSection },
    { key: 'baseAmount', header: 'Base', render: (row) => <span className="font-mono">{formatCurrency(row.baseAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (row) => <span className="font-mono">{formatCurrency(row.tdsAmount)}</span> },
    { key: 'category', header: 'Issue Type', render: (row) => <span className="case-issue-type" title={row.category}>{row.category}</span> },
    { key: 'description', header: 'Reason', render: (row) => <span className="case-reason" title={row.description || row.plainEnglish}>{row.description || row.plainEnglish}</span> },
    { key: 'severity', header: 'Severity', render: (row) => <StatusBadge label={row.severity} tone={row.severity === 'high' ? 'danger' : 'warning'} /> },
  ]

  const activeRows = useMemo(() => {
    if (activeTab === 'advance') {
      if (quickFilter === 'advance-with-amount') return advanceLedgerRows.filter((row) => Number(row.advanceAmount || 0) > 0)
      if (quickFilter === 'advance-invoice') return advanceLedgerRows.filter((row) => Number(row.invoiceAmount || 0) > 0)
      if (quickFilter === 'advance-tds') return advanceLedgerRows.filter((row) => Number(row.tdsAmount || 0) > 0)
      if (quickFilter === 'advance-issue-groups') return advanceLedgerRows.filter((row) => row.status === 'ISSUE')
      return advanceLedgerRows
    }
    if (activeTab === 'advanceIssues') return advanceIssueRows
    if (activeTab === 'issues') return issueRows
    if (quickFilter === 'ledger-balanced') return ledgerRows.filter((row) => row.status === 'BALANCED')
    if (quickFilter === 'ledger-open') return ledgerRows.filter((row) => row.status === 'OPEN')
    if (quickFilter === 'ledger-issue') return ledgerRows.filter((row) => row.status === 'ISSUE')
    return ledgerRows
  }, [activeTab, quickFilter, advanceLedgerRows, advanceIssueRows, issueRows, ledgerRows])
  const visibleRows = useMemo(() => {
    const query = caseSearch.trim().toLowerCase()
    if (!query) return activeRows

    return activeRows.filter((row) => {
      const eventText = (row.events || []).map((event) => [
        event.docNo,
        event.docType,
        event.assignmentNumber,
        event.eventType,
        event.glAccount,
        event.tdsSection,
        event.referenceDoc,
      ].join(' ')).join(' ')
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
  }, [activeRows, caseSearch])
  const columns = activeTab === 'advanceIssues' || activeTab === 'issues' ? issueColumns : ledgerColumns
  const canExpand = activeTab === 'advance' || activeTab === 'ledger'

  function applyQuickFilter(tab, filter) {
    setActiveTab(tab)
    setQuickFilter(filter)
    setCaseSearch('')
    setExpandedLedgerKey(null)
  }

  function renderLedgerLines(row) {
    return (
      <div className="case-ledger-detail">
        <div className="case-ledger-line case-ledger-line--head">
          <span>Type</span>
          <span>Doc No.</span>
          <span>Assignment</span>
          <span>Event</span>
          <span>GL</span>
          <span>D/C</span>
          <span>Amount</span>
          <span>Section</span>
          <span>TDS</span>
          <span>Reference</span>
        </div>
        {(row.events || []).map((event, index) => (
          <div className="case-ledger-line" key={`${event.docNo}-${event.lineItem}-${index}`}>
            <span className="font-mono">{event.docType}</span>
            <span className="font-mono">{event.docNo}</span>
            <span className="font-mono">{event.assignmentNumber}</span>
            <span>{event.eventType}</span>
            <span className="font-mono">{event.glAccount}</span>
            <span className="font-mono">{event.debitCredit}</span>
            <span className="font-mono">{formatCurrency(event.amount)}</span>
            <span className="font-mono">{event.tdsSection}</span>
            <span className="font-mono">{formatCurrency(event.tdsAmount)}</span>
            <span className="font-mono">{event.referenceDoc}</span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">TDS Case Builder</span>
          </div>
          <h1 className="page-title">TDS Case Builder</h1>
          {hasUpload && <div className="case-source-line">Using latest Issues upload: <span className="font-mono">{uploadMeta.fileName}</span></div>}
        </div>
      </div>

      {!hasUpload && (
        <div className="case-empty-source">
          Upload a combined SAP extract from the Issues page to build the document ledger here.
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
            <span className="case-muted">Latest Issues upload</span>
          </button>
        ))}
      </div>

      {hasUpload && (
        <div className="case-advance-overview">
          <button
            type="button"
            className={`case-overview-button ${quickFilter === 'advance-all' ? 'is-active' : ''}`}
            onClick={() => applyQuickFilter('advance', 'advance-all')}
          >
            <span className="case-overview-label">Linked Groups</span>
            <strong>{advanceTotals.groups.toLocaleString()}</strong>
          </button>
          <button
            type="button"
            className={`case-overview-button ${quickFilter === 'advance-with-amount' ? 'is-active' : ''}`}
            onClick={() => applyQuickFilter('advance', 'advance-with-amount')}
          >
            <span className="case-overview-label">Advance Amount</span>
            <strong>{formatCurrency(advanceTotals.advance)}</strong>
          </button>
          <button
            type="button"
            className={`case-overview-button ${quickFilter === 'advance-invoice' ? 'is-active' : ''}`}
            onClick={() => applyQuickFilter('advance', 'advance-invoice')}
          >
            <span className="case-overview-label">Invoice Amount</span>
            <strong>{formatCurrency(advanceTotals.invoice)}</strong>
          </button>
          <button
            type="button"
            className={`case-overview-button ${quickFilter === 'advance-tds' ? 'is-active' : ''}`}
            onClick={() => applyQuickFilter('advance', 'advance-tds')}
          >
            <span className="case-overview-label">TDS In Chain</span>
            <strong>{formatCurrency(advanceTotals.tds)}</strong>
          </button>
          <button
            type="button"
            className={`case-overview-button ${quickFilter === 'advance-issues' ? 'is-active' : ''}`}
            onClick={() => applyQuickFilter('advanceIssues', 'advance-issues')}
          >
            <span className="case-overview-label">Advance Issues</span>
            <strong>{advanceTotals.issues.toLocaleString()}</strong>
          </button>
        </div>
      )}

      <div className="table-card">
        <div className="table-card-header">
          <div className="case-toolbar">
            <div className="case-tabs" role="tablist" aria-label="Case builder results">
              <button type="button" className={`case-tab ${activeTab === 'ledger' ? 'active' : ''}`} onClick={() => applyQuickFilter('ledger', 'ledger-all')}>
                Document Ledger ({ledgerRows.length.toLocaleString()})
              </button>
              <button type="button" className={`case-tab ${activeTab === 'advance' ? 'active' : ''}`} onClick={() => applyQuickFilter('advance', 'advance-all')}>
                Advance Review ({advanceLedgerRows.length.toLocaleString()})
              </button>
              <button type="button" className={`case-tab ${activeTab === 'advanceIssues' ? 'active' : ''}`} onClick={() => applyQuickFilter('advanceIssues', 'advance-issues')}>
                Advance Issues ({advanceIssueRows.length.toLocaleString()})
              </button>
              <button type="button" className={`case-tab ${activeTab === 'issues' ? 'active' : ''}`} onClick={() => applyQuickFilter('issues', 'issues-all')}>
                Rule Issues ({issueRows.length.toLocaleString()})
              </button>
            </div>
            <label className="case-search">
              <Search size={14} />
              <input
                type="search"
                value={caseSearch}
                onChange={(event) => setCaseSearch(event.target.value)}
                placeholder="Search cases..."
              />
            </label>
          </div>
        </div>
        <DataTable
          columns={columns}
          data={visibleRows}
          pageSize={10}
          expandedRowKey={canExpand ? expandedLedgerKey : null}
          onRowClick={canExpand ? (row) => setExpandedLedgerKey((key) => key === row.id ? null : row.id) : undefined}
          renderExpandedRow={canExpand ? renderLedgerLines : undefined}
          emptyState={<div className="data-table-empty">No rows found for this view</div>}
        />
      </div>
    </div>
  )
}
