import { useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { AlertTriangle, FileSpreadsheet, GitBranch, Link2, ShieldAlert, Upload } from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge from '@/components/Common/StatusBadge'
import issuesService from '@/services/issuesService'
import { formatCurrency } from '@/utils/utils'
import '@/components/Common/Common.css'
import './TDSCaseBuilder.css'

const ACCEPTED = '.csv,.xlsx,.xlsm'

function FilePicker({ label, file, onPick }) {
  const inputRef = useRef(null)
  return (
    <div className="case-file-box">
      <div className="case-file-icon"><FileSpreadsheet size={18} /></div>
      <div className="case-file-copy">
        <div className="case-file-label">{label}</div>
        <div className="case-file-name">{file?.name || 'No file selected'}</div>
      </div>
      <button className="btn btn-outline btn-sm" type="button" onClick={() => inputRef.current?.click()}>
        <Upload size={12} />Choose
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        className="case-hidden-input"
        onChange={(event) => onPick(event.target.files?.[0] || null)}
      />
    </div>
  )
}

export default function TDSCaseBuilder() {
  const [vendorFile, setVendorFile] = useState(null)
  const [tdsFile, setTdsFile] = useState(null)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('ledger')

  async function runCaseBuilder() {
    if (!vendorFile || !tdsFile) {
      toast.error('Select both Vendor Events and WITH_ITEM/TDS Events files.')
      return
    }
    setLoading(true)
    try {
      const data = await issuesService.uploadCaseSourceFiles(vendorFile, tdsFile)
      setResult(data)
      toast.success(`Built ${data.stats?.caseCount ?? 0} temporary TDS cases.`)
    } catch (error) {
      toast.error(error.message || 'Could not build TDS cases.')
    } finally {
      setLoading(false)
    }
  }

  const stats = result?.stats || {}
  const tdsCases = result?.tdsCases || []
  const joinedRows = result?.joinedRows || []
  const missingRows = result?.missingTdsCandidates || []
  const issueRows = result?.issues || []
  const ledgerRows = result?.caseLedger || []

  const activeRows = activeTab === 'ledger'
    ? ledgerRows
    : activeTab === 'cases'
    ? tdsCases
    : activeTab === 'issues'
      ? issueRows
      : activeTab === 'joined' ? joinedRows : missingRows

  const caseColumns = [
    { key: 'id', header: 'Case ID', render: (row) => (
      <div>
        <div className="font-mono case-strong">{row.id}</div>
        <div className="case-muted">{row.status}</div>
      </div>
    )},
    { key: 'eventType', header: 'Event', render: (row) => <StatusBadge label={row.eventType} tone={row.createsCase ? 'info' : 'neutral'} /> },
    { key: 'docNo', header: 'Doc No.', render: (row) => <span className="font-mono">{row.docNo}</span> },
    { key: 'vendor', header: 'Vendor / PAN', render: (row) => (
      <div>
        <div className="case-strong">{row.vendor}</div>
        <div className="font-mono case-muted">{row.vendorPan}</div>
      </div>
    )},
    { key: 'section', header: 'Section', render: (row) => <span className="font-mono">{row.section}</span> },
    { key: 'baseAmount', header: 'Base', render: (row) => <span className="font-mono">{formatCurrency(row.baseAmount)}</span> },
    { key: 'actualTds', header: 'TDS', render: (row) => <span className="font-mono">{formatCurrency(row.actualTds)}</span> },
  ]

  const ledgerColumns = [
    { key: 'caseId', header: 'Case ID', render: (row) => (
      <div>
        <div className="font-mono case-strong">{row.caseId}</div>
        <div className="case-muted">{row.eventCount} events</div>
      </div>
    )},
    { key: 'vendor', header: 'Vendor / PAN', render: (row) => (
      <div>
        <div className="case-strong">{row.vendor}</div>
        <div className="font-mono case-muted">{row.pan}</div>
      </div>
    )},
    { key: 'anchorDocNo', header: 'Anchor Doc', render: (row) => <span className="font-mono">{row.anchorDocNo}</span> },
    { key: 'base', header: 'Invoice/Advance', render: (row) => <span className="font-mono">{formatCurrency((row.invoiceAmount || 0) + (row.advanceAmount || 0))}</span> },
    { key: 'adjustments', header: 'Adjustments', render: (row) => <span className="font-mono">{formatCurrency((row.paymentAmount || 0) + (row.creditAmount || 0) + (row.reversalAmount || 0))}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (row) => <span className="font-mono">{formatCurrency(row.tdsAmount)}</span> },
    { key: 'openAmount', header: 'Open Amount', render: (row) => <span className="font-mono">{formatCurrency(row.openAmount)}</span> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge label={row.status} tone={row.status === 'ISSUE' ? 'danger' : row.status === 'CLOSED' ? 'success' : 'warning'} /> },
  ]

  const joinedColumns = [
    { key: 'docNo', header: 'Doc No.', render: (row) => <span className="font-mono">{row.docNo}</span> },
    { key: 'vendor', header: 'Vendor / PAN', render: (row) => (
      <div>
        <div className="case-strong">{row.vendor}</div>
        <div className="font-mono case-muted">{row.pan}</div>
      </div>
    )},
    { key: 'docType', header: 'Doc Type', render: (row) => <span className="font-mono">{row.docType}</span> },
    { key: 'amount', header: 'Amount', render: (row) => <span className="font-mono">{formatCurrency(row.amount)}</span> },
    { key: 'tdsFound', header: 'TDS Row', render: (row) => <StatusBadge label={row.tdsFound ? 'Found' : 'Missing'} tone={row.tdsFound ? 'success' : 'warning'} /> },
    { key: 'tdsSection', header: 'TDS Section', render: (row) => <span className="font-mono">{row.tdsSection}</span> },
    { key: 'tdsAmount', header: 'TDS Amount', render: (row) => <span className="font-mono">{row.tdsAmount == null ? '—' : formatCurrency(row.tdsAmount)}</span> },
  ]

  const issueColumns = [
    { key: 'docNo', header: 'Doc No.', render: (row) => <span className="font-mono">{row.docNo}</span> },
    { key: 'vendor', header: 'Vendor', render: (row) => (
      <div>
        <div className="case-strong">{row.vendor}</div>
        <div className="font-mono case-muted">{row.vendorId}</div>
      </div>
    )},
    { key: 'section', header: 'Section', render: (row) => <span className="font-mono">{row.section}</span> },
    { key: 'baseAmount', header: 'Base', render: (row) => <span className="font-mono">{formatCurrency(row.baseAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS', render: (row) => <span className="font-mono">{formatCurrency(row.tdsAmount)}</span> },
    { key: 'category', header: 'Issue Type', render: (row) => <span className="case-issue-type" title={row.category}>{row.category}</span> },
    { key: 'severity', header: 'Severity', render: (row) => <StatusBadge label={row.severity} tone={row.severity === 'high' ? 'danger' : 'warning'} /> },
  ]

  const columns = activeTab === 'ledger' ? ledgerColumns : activeTab === 'cases' ? caseColumns : activeTab === 'issues' ? issueColumns : joinedColumns

  const summaryCards = useMemo(() => [
    { label: 'Vendor Events', value: stats.vendorEvents ?? 0, icon: FileSpreadsheet, tone: 'info' },
    { label: 'TDS Events', value: stats.tdsEvents ?? 0, icon: Link2, tone: 'success' },
    { label: 'Case Ledger', value: stats.ledgerCases ?? 0, icon: GitBranch, tone: 'info' },
    { label: 'TDS Cases', value: stats.caseCount ?? 0, icon: GitBranch, tone: 'info' },
    { label: 'Rule Issues', value: stats.issuesFound ?? 0, icon: ShieldAlert, tone: 'danger' },
    { label: 'Missing TDS Candidates', value: stats.missingTdsCandidates ?? 0, icon: AlertTriangle, tone: 'warning' },
  ], [stats])

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">TDS Case Builder</span>
          </div>
          <h1 className="page-title">TDS Case Builder</h1>
        </div>
        <button className="btn btn-primary" type="button" disabled={loading} onClick={runCaseBuilder}>
          <GitBranch size={14} />{loading ? 'Building…' : 'Build Cases'}
        </button>
      </div>

      <div className="case-upload-grid">
        <FilePicker label="Vendor Accounting Events" file={vendorFile} onPick={setVendorFile} />
        <FilePicker label="WITH_ITEM / TDS Events" file={tdsFile} onPick={setTdsFile} />
      </div>

      <div className="case-summary-grid">
        {summaryCards.map((card) => (
          <div className="kpi-card" key={card.label}>
            <div className="kpi-icon-row">
              <span className="kpi-label">{card.label}</span>
              <div className={`kpi-icon-box ${card.tone}`}><card.icon size={14} /></div>
            </div>
            <span className="kpi-value">{Number(card.value || 0).toLocaleString()}</span>
            <span className="case-muted">Temporary upload session</span>
          </div>
        ))}
      </div>

      <div className="table-card">
        <div className="table-card-header">
          <div className="case-tabs" role="tablist" aria-label="Case builder results">
            <button type="button" className={`case-tab ${activeTab === 'ledger' ? 'active' : ''}`} onClick={() => setActiveTab('ledger')}>Case Ledger</button>
            <button type="button" className={`case-tab ${activeTab === 'cases' ? 'active' : ''}`} onClick={() => setActiveTab('cases')}>TDS Cases</button>
            <button type="button" className={`case-tab ${activeTab === 'issues' ? 'active' : ''}`} onClick={() => setActiveTab('issues')}>Rule Issues</button>
            <button type="button" className={`case-tab ${activeTab === 'joined' ? 'active' : ''}`} onClick={() => setActiveTab('joined')}>Joined Events</button>
            <button type="button" className={`case-tab ${activeTab === 'missing' ? 'active' : ''}`} onClick={() => setActiveTab('missing')}>Missing TDS Candidates</button>
          </div>
        </div>
        <DataTable
          columns={columns}
          data={activeRows}
          pageSize={8}
          emptyState={<div className="data-table-empty">Upload both sample files and build cases</div>}
        />
      </div>
    </div>
  )
}
