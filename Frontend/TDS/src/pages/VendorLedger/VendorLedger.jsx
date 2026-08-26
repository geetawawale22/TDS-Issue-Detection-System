import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, BookOpenText, CheckCircle2, Download, FileSearch,
  IndianRupee, Search, TriangleAlert, Users,
} from 'lucide-react'
import { useSelector } from 'react-redux'
import DataTable from '@/components/Common/DataTable'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import StatusBadge from '@/components/Common/StatusBadge'
import { selectActiveValidationRows, selectIsLive } from '@/redux/slices/issuesSlice'
import { downloadCsv } from '@/utils/csvExport'
import { formatCurrency, formatDate } from '@/utils/utils'
import '@/components/Common/Common.css'
import './VendorLedger.css'

function panLedgerKeyFor(row) {
  return row.vendorPan || 'NO-PAN'
}

function statusTone(status) {
  if (status === 'issue') return 'danger'
  if (status === 'insufficient') return 'warning'
  return 'success'
}

function statusLabel(status) {
  if (status === 'issue') return 'Issue'
  if (status === 'insufficient') return 'Insufficient Data'
  return 'Correct'
}

function numberValue(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function hasAmount(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}

function formatOptionalCurrency(value) {
  return hasAmount(value) ? formatCurrency(value) : 'Not available'
}

function buildPanLedger(rows) {
  const panGroups = new Map()

  rows.forEach((row) => {
    const key = panLedgerKeyFor(row)
    if (!panGroups.has(key)) {
      panGroups.set(key, {
        id: key,
        ledgerKey: key,
        pan: row.vendorPan || '—',
        vendorCodes: new Set(),
        vendorNames: new Set(),
        companyCodes: new Set(),
        sections: new Set(),
        transactionCount: 0,
        correctCount: 0,
        issueCount: 0,
        insufficientCount: 0,
        totalBillAmount: 0,
        billAmountAvailable: false,
        totalBaseAmount: 0,
        totalTdsDeducted: 0,
        transactions: [],
      })
    }

    const group = panGroups.get(key)
    group.transactionCount += 1
    if (hasAmount(row.billAmount)) {
      group.totalBillAmount += numberValue(row.billAmount)
      group.billAmountAvailable = true
    }
    group.totalBaseAmount += numberValue(row.baseAmount)
    group.totalTdsDeducted += Math.abs(numberValue(row.tdsAmount))
    if (row.vendorId) group.vendorCodes.add(row.vendorId)
    if (row.vendor) group.vendorNames.add(row.vendor)
    if (row.companyCode) group.companyCodes.add(row.companyCode)
    if (row.section) group.sections.add(row.section)
    if (row.status === 'issue') group.issueCount += 1
    else if (row.status === 'insufficient') group.insufficientCount += 1
    else group.correctCount += 1
    group.transactions.push({
      ...row,
      billAmount: hasAmount(row.billAmount) ? row.billAmount : null,
      tdsAmount: Math.abs(numberValue(row.tdsAmount)),
    })
  })

  return [...panGroups.values()]
    .map((group) => ({
      ...group,
      vendorCodesLabel: [...group.vendorCodes].sort().join(', ') || '—',
      vendorNamesLabel: [...group.vendorNames].sort().join(', ') || 'Unknown vendor',
      companyCodesLabel: [...group.companyCodes].sort().join(', ') || '—',
      sectionsLabel: [...group.sections].sort().join(', ') || '—',
      totalBillAmountExport: group.billAmountAvailable ? group.totalBillAmount : '',
    }))
    .sort((a, b) => a.pan.localeCompare(b.pan))
}

export default function VendorLedger() {
  const navigate = useNavigate()
  const { vendorKey } = useParams()
  const [search, setSearch] = useState('')
  const [transactionFilter, setTransactionFilter] = useState('all')
  const [documentTypeFilter, setDocumentTypeFilter] = useState('all')
  const [sectionFilter, setSectionFilter] = useState('all')
  const rows = useSelector(selectActiveValidationRows)
  const isLive = useSelector(selectIsLive)
  const fileName = useSelector((s) => s.issues.uploadMeta?.fileName)

  const panGroups = useMemo(() => buildPanLedger(rows), [rows])
  const selectedPanGroup = vendorKey ? panGroups.find((group) => group.ledgerKey === vendorKey) : null

  const filteredPanGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return panGroups
    return panGroups.filter((group) => (
      group.vendorNamesLabel.toLowerCase().includes(q) ||
      group.vendorCodesLabel.toLowerCase().includes(q) ||
      group.pan.toLowerCase().includes(q) ||
      group.sectionsLabel.toLowerCase().includes(q)
    ))
  }, [search, panGroups])

  const summary = useMemo(() => ({
    pans: panGroups.length,
    vendorCodes: panGroups.reduce((codes, group) => codes + group.vendorCodes.size, 0),
    transactions: panGroups.reduce((sum, group) => sum + group.transactionCount, 0),
    issues: panGroups.reduce((sum, group) => sum + group.issueCount, 0),
    tds: panGroups.reduce((sum, group) => sum + group.totalTdsDeducted, 0),
  }), [panGroups])

  const selectedTransactions = useMemo(() => {
    if (!selectedPanGroup) return []
    const statusFiltered = transactionFilter === 'all'
      ? selectedPanGroup.transactions
      : transactionFilter === 'correct'
        ? selectedPanGroup.transactions.filter((row) => row.status === 'passed')
        : selectedPanGroup.transactions.filter((row) => row.status === transactionFilter)

    return statusFiltered
      .filter((row) => documentTypeFilter === 'all' || (row.docType || '—') === documentTypeFilter)
      .filter((row) => sectionFilter === 'all' || (row.section || '—') === sectionFilter)
  }, [selectedPanGroup, transactionFilter, documentTypeFilter, sectionFilter])

  const documentTypeOptions = useMemo(() => {
    if (!selectedPanGroup) return []
    return [...new Set(
      selectedPanGroup.transactions
        .map((row) => row.docType || '—')
        .filter(Boolean)
    )].sort()
  }, [selectedPanGroup])

  const sectionOptions = useMemo(() => {
    if (!selectedPanGroup) return []
    return [...new Set(
      selectedPanGroup.transactions
        .map((row) => row.section || '—')
        .filter(Boolean)
    )].sort()
  }, [selectedPanGroup])

  const selectedStatusRowCount = useMemo(() => {
    if (!selectedPanGroup) return 0
    if (transactionFilter === 'all') return selectedPanGroup.transactions.length
    if (transactionFilter === 'correct') {
      return selectedPanGroup.transactions.filter((row) => row.status === 'passed').length
    }
    return selectedPanGroup.transactions.filter((row) => row.status === transactionFilter).length
  }, [selectedPanGroup, transactionFilter])

  const selectedFilterLabel = {
    all: 'All PAN Transactions',
    correct: 'Correct PAN Transactions',
    issue: 'Issue PAN Transactions',
    insufficient: 'Insufficient Data PAN Transactions',
  }[transactionFilter]

  const selectedTransactionTotals = useMemo(() => ({
    baseAmount: selectedTransactions.reduce((sum, row) => sum + numberValue(row.baseAmount), 0),
    tdsDeducted: selectedTransactions.reduce((sum, row) => sum + numberValue(row.tdsAmount), 0),
  }), [selectedTransactions])

  const panColumns = [
    { key: 'pan', header: 'PAN', render: (row) => (
      <div>
        <div className="vendor-ledger-primary font-mono">{row.pan}</div>
        <div className="vendor-ledger-muted">{row.vendorNamesLabel}</div>
      </div>
    )},
    { key: 'vendorCodesLabel', header: 'Vendor Codes', render: (row) => <span className="vendor-ledger-reason font-mono">{row.vendorCodesLabel}</span> },
    { key: 'totalBillAmount', header: 'Total Bill Amount', render: (row) => <span className="font-mono">{row.billAmountAvailable ? formatCurrency(row.totalBillAmount) : 'Not available'}</span> },
    { key: 'totalBaseAmount', header: 'Total Base Amount', render: (row) => <span className="font-mono">{formatCurrency(row.totalBaseAmount)}</span> },
    { key: 'totalTdsDeducted', header: 'Total TDS Deducted', render: (row) => <span className="font-mono">{formatCurrency(row.totalTdsDeducted)}</span> },
    { key: 'transactionCount', header: 'Transactions', render: (row) => (
      <div className="vendor-ledger-counts">
        <span>{row.transactionCount}</span>
        <StatusBadge label={`${row.issueCount} Issue`} tone={row.issueCount ? 'danger' : 'success'} />
      </div>
    )},
  ]

  const transactionColumns = [
    { key: 'date', header: 'Date', render: (row) => <span>{formatDate(row.date)}</span> },
    { key: 'docNo', header: 'Document No', render: (row) => <span className="font-mono">{row.docNo}</span> },
    { key: 'poNo', header: 'PO No', render: (row) => <span className="font-mono">{row.poNo || '—'}</span> },
    { key: 'docType', header: 'Document Type', render: (row) => <span className="font-mono">{row.docType || '—'}</span> },
    { key: 'companyCode', header: 'Company', render: (row) => <span className="font-mono">{row.companyCode || '—'}</span> },
    { key: 'section', header: 'Section', render: (row) => <span className="font-mono">{row.section || '—'}</span> },
    { key: 'billAmount', header: 'Bill Amount', render: (row) => <span className="font-mono">{formatOptionalCurrency(row.billAmount)}</span> },
    { key: 'baseAmount', header: 'Base Amount', render: (row) => <span className="font-mono">{formatCurrency(row.baseAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS Deducted', render: (row) => <span className="font-mono">{formatCurrency(row.tdsAmount)}</span> },
    { key: 'appliedRate', header: 'Applied Rate', render: (row) => <span className="font-mono">{row.appliedRate == null ? '—' : `${row.appliedRate}%`}</span> },
    { key: 'expectedRate', header: 'Expected Rate', render: (row) => <span className="font-mono">{row.expectedRate == null ? '—' : `${row.expectedRate}%`}</span> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge label={statusLabel(row.status)} tone={statusTone(row.status)} /> },
    { key: 'reason', header: 'Validation Detail', render: (row) => <span className="vendor-ledger-reason">{row.reason}</span> },
  ]

  function exportSummary() {
    downloadCsv('vendor-ledger-pan-summary.csv', [
      { key: 'pan', header: 'PAN' },
      { key: 'vendorCodesLabel', header: 'Vendor Codes' },
      { key: 'vendorNamesLabel', header: 'Vendor Names' },
      { key: 'companyCodesLabel', header: 'Company Codes' },
      { key: 'sectionsLabel', header: 'Sections' },
      { key: 'transactionCount', header: 'Transactions' },
      { key: 'correctCount', header: 'Correct Transactions' },
      { key: 'issueCount', header: 'Issue Transactions' },
      { key: 'insufficientCount', header: 'Insufficient Data Transactions' },
      { key: 'totalBillAmountExport', header: 'Total Bill Amount' },
      { key: 'totalBaseAmount', header: 'Total Base Amount' },
      { key: 'totalTdsDeducted', header: 'Total TDS Deducted' },
    ], filteredPanGroups)
  }

  function exportTransactions() {
    if (!selectedPanGroup) return
    downloadCsv(`${selectedPanGroup.pan}-${transactionFilter}-pan-transactions.csv`, [
      { key: 'date', header: 'Date' },
      { key: 'docNo', header: 'Document No' },
      { key: 'poNo', header: 'PO No' },
      { key: 'docType', header: 'Document Type' },
      { key: 'companyCode', header: 'Company Code' },
      { key: 'vendorId', header: 'Vendor Code' },
      { key: 'vendorPan', header: 'PAN' },
      { key: 'vendor', header: 'Vendor Name' },
      { key: 'section', header: 'Section' },
      { key: 'billAmount', header: 'Bill Amount' },
      { key: 'baseAmount', header: 'Base Amount' },
      { key: 'tdsAmount', header: 'TDS Deducted' },
      { key: 'appliedRate', header: 'Applied Rate' },
      { key: 'expectedRate', header: 'Expected Rate' },
      { key: 'status', header: 'Status' },
      { key: 'reason', header: 'Validation Detail' },
    ], selectedTransactions)
  }

  function FilterCard({ filter, label, value, icon: Icon, tone = '' }) {
    const active = transactionFilter === filter
    return (
      <button
        className={`kpi-card vendor-ledger-filter-card ${active ? 'active' : ''}`}
        type="button"
        onClick={() => {
          setTransactionFilter(filter)
          setDocumentTypeFilter('all')
          setSectionFilter('all')
        }}
        aria-pressed={active}
      >
        <div className="kpi-icon-row">
          <span className="kpi-label">{label}</span>
          <div className={`kpi-icon-box ${tone}`}><Icon size={14} /></div>
        </div>
        <span className="kpi-value">{value}</span>
      </button>
    )
  }

  if (selectedPanGroup) {
    return (
      <div>
        <div className="page-header">
          <div>
            <div className="breadcrumb">
              <span>Home</span><span className="breadcrumb-sep">›</span>
              <button className="vendor-ledger-breadcrumb-btn" type="button" onClick={() => navigate('/vendor-ledger')}>Vendor Ledger</button>
              <span className="breadcrumb-sep">›</span>
              <span className="breadcrumb-current">{selectedPanGroup.pan}</span>
            </div>
            <h1 className="page-title">PAN Ledger Detail</h1>
          </div>
          <div className="issues-header-actions">
            <LiveDataBadge />
            <button className="btn btn-outline" type="button" onClick={exportTransactions}>
              <Download size={14} />Export
            </button>
          </div>
        </div>

        <button className="btn btn-outline vendor-ledger-back" type="button" onClick={() => navigate('/vendor-ledger')}>
          <ArrowLeft size={14} />Back to Vendor Ledger
        </button>

        <div className="vendor-ledger-profile">
          <div>
            <div className="vendor-ledger-profile-kicker">PAN</div>
            <h2 className="font-mono">{selectedPanGroup.pan}</h2>
            <div className="vendor-ledger-profile-meta">
              <span>Vendor Names: {selectedPanGroup.vendorNamesLabel}</span>
              <span className="font-mono">Vendor Codes: {selectedPanGroup.vendorCodesLabel}</span>
              <span>Company: {selectedPanGroup.companyCodesLabel}</span>
              <span>Sections: {selectedPanGroup.sectionsLabel}</span>
            </div>
          </div>
          <div className="vendor-ledger-profile-stats">
            <div><span>Total Bill</span><strong>{selectedPanGroup.billAmountAvailable ? formatCurrency(selectedPanGroup.totalBillAmount) : 'Not available'}</strong></div>
            <div><span>Total Base</span><strong>{formatCurrency(selectedPanGroup.totalBaseAmount)}</strong></div>
            <div><span>TDS Deducted</span><strong>{formatCurrency(selectedPanGroup.totalTdsDeducted)}</strong></div>
          </div>
        </div>

        <div className="summary-grid-4">
          <FilterCard filter="all" label="Transactions" value={selectedPanGroup.transactionCount} icon={FileSearch} />
          <FilterCard filter="correct" label="Correct" value={selectedPanGroup.correctCount} icon={CheckCircle2} tone="success" />
          <FilterCard filter="issue" label="Issues" value={selectedPanGroup.issueCount} icon={TriangleAlert} tone="danger" />
          <FilterCard filter="insufficient" label="Insufficient" value={selectedPanGroup.insufficientCount} icon={BookOpenText} tone="warning" />
        </div>

        <div className="table-card">
          <div className="table-card-header">
            <div>
              <div className="table-card-title">{selectedFilterLabel}</div>
              <div className="vendor-ledger-muted">
                {fileName ? `SAP · ${fileName}` : 'Latest SAP upload'} · {selectedTransactions.length.toLocaleString('en-IN')} rows
                {documentTypeFilter !== 'all' && ` of ${selectedStatusRowCount.toLocaleString('en-IN')}`}
              </div>
            </div>
            <label className="vendor-ledger-doc-type-filter">
              <span>Document Type</span>
              <select
                value={documentTypeFilter}
                onChange={(event) => setDocumentTypeFilter(event.target.value)}
              >
                <option value="all">All</option>
                {documentTypeOptions.map((docType) => (
                  <option key={docType} value={docType}>{docType}</option>
                ))}
              </select>
            </label>
            <label className="vendor-ledger-doc-type-filter">
              <span>Section</span>
              <select
                value={sectionFilter}
                onChange={(event) => setSectionFilter(event.target.value)}
              >
                <option value="all">All</option>
                {sectionOptions.map((section) => (
                  <option key={section} value={section}>{section}</option>
                ))}
              </select>
            </label>
          </div>
          <DataTable
            columns={transactionColumns}
            data={selectedTransactions}
            pageSize={50}
            showFloatingPager
            renderPreHeaderCell={(column) => {
              if (column.key === 'baseAmount') {
                return (
                  <div className="vendor-ledger-column-total">
                    <span>Total</span>
                    <strong>{formatCurrency(selectedTransactionTotals.baseAmount)}</strong>
                  </div>
                )
              }
              if (column.key === 'tdsAmount') {
                return (
                  <div className="vendor-ledger-column-total">
                    <span>Total</span>
                    <strong>{formatCurrency(selectedTransactionTotals.tdsDeducted)}</strong>
                  </div>
                )
              }
              return null
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">Vendor Ledger</span>
          </div>
          <h1 className="page-title">Vendor Ledger</h1>
        </div>
        <div className="issues-header-actions">
          <LiveDataBadge />
          <div className="vendor-ledger-search-wrapper">
            <Search size={14} className="vendor-ledger-search-icon" />
            <input
              className="filter-input vendor-ledger-search"
              placeholder="Search PAN, vendor, section..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <button className="btn btn-outline" type="button" disabled={filteredPanGroups.length === 0} onClick={exportSummary}>
            <Download size={14} />Export
          </button>
        </div>
      </div>

      {isLive && (
        <p className="sap-hint vendor-ledger-hint">
          Vendor Ledger is grouped PAN-wise from every transaction in the latest SAP upload, including correct, issue, and insufficient-data rows.
        </p>
      )}

      <div className="summary-grid-4">
        <div className="kpi-card"><div className="kpi-icon-row"><span className="kpi-label">PANs</span><div className="kpi-icon-box"><Users size={14} /></div></div><span className="kpi-value">{summary.pans}</span></div>
        <div className="kpi-card"><div className="kpi-icon-row"><span className="kpi-label">Transactions</span><div className="kpi-icon-box"><FileSearch size={14} /></div></div><span className="kpi-value">{summary.transactions}</span></div>
        <div className="kpi-card"><div className="kpi-icon-row"><span className="kpi-label">Issue Rows</span><div className="kpi-icon-box danger"><TriangleAlert size={14} /></div></div><span className="kpi-value">{summary.issues}</span></div>
        <div className="kpi-card"><div className="kpi-icon-row"><span className="kpi-label">TDS Deducted</span><div className="kpi-icon-box success"><IndianRupee size={14} /></div></div><span className="kpi-value">{formatCurrency(summary.tds)}</span></div>
      </div>

      <div className="table-card">
        <div className="table-card-header">
          <div>
            <div className="table-card-title">PAN-wise Vendor Summary</div>
            <div className="vendor-ledger-muted">{fileName ? `SAP · ${fileName}` : 'Upload SAP data to populate the ledger'}</div>
          </div>
        </div>
        <DataTable
          columns={panColumns}
          data={filteredPanGroups}
          pageSize={50}
          showFloatingPager
          onRowClick={(row) => navigate(`/vendor-ledger/${encodeURIComponent(row.ledgerKey)}`)}
          emptyState={(
            <div className="empty-state">
              <div className="empty-state-icon"><BookOpenText size={20} /></div>
              <div className="empty-state-title">No vendor ledger data</div>
              <div className="empty-state-desc">Upload SAP data from the Issues page to see PAN-wise vendor totals.</div>
            </div>
          )}
        />
      </div>
    </div>
  )
}
