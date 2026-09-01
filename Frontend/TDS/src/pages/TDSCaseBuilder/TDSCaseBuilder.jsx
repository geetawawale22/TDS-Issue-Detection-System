import { useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { AlertTriangle, FileSpreadsheet, GitBranch, ListTree, ShieldAlert } from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge from '@/components/Common/StatusBadge'
import { formatCurrency } from '@/utils/utils'
import '@/components/Common/Common.css'
import './TDSCaseBuilder.css'

const ADVANCE_ISSUE_TEXT = /advance|advance adjusted invoice|advance payment/i

function renderSection(row) {
  if (row.newSection && row.legacySection && row.newSection !== row.legacySection) {
    return <span className="font-mono">{row.legacySection} / {row.newSection}</span>
  }
  return <span className="font-mono">{row.section || '—'}</span>
}

function hasAdvanceSignal(row) {
  if (Number(row.advanceAmount || 0) > 0) return true
  if ((row.events || []).some((event) => event.eventType === 'ADVANCE_PAYMENT')) return true
  return (row.events || []).some((event) => event.referenceDoc && event.referenceDoc !== '—')
}

export default function TDSCaseBuilder() {
  const [activeTab, setActiveTab] = useState('advance')
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
    { label: 'Rows Read', value: stats.rowsRead ?? 0, icon: FileSpreadsheet, tone: 'info' },
    { label: 'Document Groups', value: stats.ledgerCases ?? 0, icon: ListTree, tone: 'success' },
    { label: 'Balanced Groups', value: stats.balancedLedgerCases ?? 0, icon: GitBranch, tone: 'success' },
    { label: 'Open Groups', value: stats.openLedgerCases ?? 0, icon: AlertTriangle, tone: 'warning' },
    { label: 'Advance Rows', value: caseStats.advanceCases ?? 0, icon: GitBranch, tone: 'info' },
    { label: 'Rule Issues', value: stats.issuesFound ?? 0, icon: ShieldAlert, tone: 'danger' },
  ], [stats, caseStats])

  const ledgerColumns = [
    { key: 'anchorDocNo', header: 'Document Group', render: (row) => (
      <div>
        <div className="font-mono case-strong">{row.anchorDocNo}</div>
        <div className="case-muted">{row.groupType} · {row.eventCount} rows</div>
      </div>
    )},
    { key: 'vendor', header: 'Vendor / PAN', render: (row) => (
      <div>
        <div className="case-strong">{row.vendor}</div>
        <div className="font-mono case-muted">{row.pan}</div>
      </div>
    )},
    { key: 'assignmentNumber', header: 'Link', render: (row) => (
      <div>
        <div className="font-mono case-strong">{row.assignmentNumber || '—'}</div>
        <div className="font-mono case-muted">{row.clearingDocument || '—'}</div>
      </div>
    )},
    { key: 'invoiceAmount', header: 'Invoice', render: (row) => <span className="font-mono">{formatCurrency(row.invoiceAmount)}</span> },
    { key: 'advanceAmount', header: 'Advance', render: (row) => <span className="font-mono">{formatCurrency(row.advanceAmount)}</span> },
    { key: 'paymentAmount', header: 'Payment', render: (row) => <span className="font-mono">{formatCurrency(row.paymentAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (row) => <span className="font-mono">{formatCurrency(row.tdsAmount)}</span> },
    { key: 'issueCount', header: 'Issues', render: (row) => <span className="font-mono">{row.issueCount}</span> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge label={row.status} tone={row.status === 'ISSUE' ? 'danger' : row.status === 'BALANCED' ? 'success' : 'warning'} /> },
  ]

  const issueColumns = [
    { key: 'docNo', header: 'Doc No.', render: (row) => <span className="font-mono">{row.docNo}</span> },
    { key: 'vendor', header: 'Vendor', render: (row) => <div><div className="case-strong">{row.vendor}</div><div className="font-mono case-muted">{row.vendorId}</div></div> },
    { key: 'section', header: 'Section', render: renderSection },
    { key: 'baseAmount', header: 'Base', render: (row) => <span className="font-mono">{formatCurrency(row.baseAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (row) => <span className="font-mono">{formatCurrency(row.tdsAmount)}</span> },
    { key: 'category', header: 'Issue Type', render: (row) => <span className="case-issue-type" title={row.category}>{row.category}</span> },
    { key: 'description', header: 'Reason', render: (row) => <span className="case-reason" title={row.description || row.plainEnglish}>{row.description || row.plainEnglish}</span> },
    { key: 'severity', header: 'Severity', render: (row) => <StatusBadge label={row.severity} tone={row.severity === 'high' ? 'danger' : 'warning'} /> },
  ]

  const activeRows = activeTab === 'advance'
    ? advanceLedgerRows
    : activeTab === 'advanceIssues'
      ? advanceIssueRows
      : activeTab === 'issues'
        ? issueRows
        : ledgerRows
  const columns = activeTab === 'advanceIssues' || activeTab === 'issues' ? issueColumns : ledgerColumns
  const canExpand = activeTab === 'advance' || activeTab === 'ledger'

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
          <div className="kpi-card" key={card.label}>
            <div className="kpi-icon-row">
              <span className="kpi-label">{card.label}</span>
              <div className={`kpi-icon-box ${card.tone}`}><card.icon size={14} /></div>
            </div>
            <span className="kpi-value">{Number(card.value || 0).toLocaleString()}</span>
            <span className="case-muted">Latest Issues upload</span>
          </div>
        ))}
      </div>

      {hasUpload && (
        <div className="case-advance-overview">
          <div>
            <span className="case-overview-label">Linked Groups</span>
            <strong>{advanceTotals.groups.toLocaleString()}</strong>
          </div>
          <div>
            <span className="case-overview-label">Advance Amount</span>
            <strong>{formatCurrency(advanceTotals.advance)}</strong>
          </div>
          <div>
            <span className="case-overview-label">Invoice Amount</span>
            <strong>{formatCurrency(advanceTotals.invoice)}</strong>
          </div>
          <div>
            <span className="case-overview-label">TDS In Chain</span>
            <strong>{formatCurrency(advanceTotals.tds)}</strong>
          </div>
          <div>
            <span className="case-overview-label">Advance Issues</span>
            <strong>{advanceTotals.issues.toLocaleString()}</strong>
          </div>
        </div>
      )}

      <div className="table-card">
        <div className="table-card-header">
          <div className="case-tabs" role="tablist" aria-label="Case builder results">
            <button type="button" className={`case-tab ${activeTab === 'advance' ? 'active' : ''}`} onClick={() => setActiveTab('advance')}>
              Advance Review ({advanceLedgerRows.length.toLocaleString()})
            </button>
            <button type="button" className={`case-tab ${activeTab === 'advanceIssues' ? 'active' : ''}`} onClick={() => setActiveTab('advanceIssues')}>
              Advance Issues ({advanceIssueRows.length.toLocaleString()})
            </button>
            <button type="button" className={`case-tab ${activeTab === 'issues' ? 'active' : ''}`} onClick={() => setActiveTab('issues')}>
              Rule Issues ({issueRows.length.toLocaleString()})
            </button>
            <button type="button" className={`case-tab ${activeTab === 'ledger' ? 'active' : ''}`} onClick={() => setActiveTab('ledger')}>
              Document Ledger ({ledgerRows.length.toLocaleString()})
            </button>
          </div>
        </div>
        <DataTable
          columns={columns}
          data={activeRows}
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
