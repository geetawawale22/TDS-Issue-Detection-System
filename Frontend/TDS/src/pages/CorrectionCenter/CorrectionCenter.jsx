import { useState } from 'react'
import { Clock, CheckCircle2, XCircle, IndianRupee, Download, X } from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge, { correctionStatusToTone } from '@/components/Common/StatusBadge'
import Timeline from '@/components/Common/Timeline'
import { corrections } from '@/data/mockData'
import { formatCurrency, formatStatusLabel } from '@/utils/utils'
import '@/components/Common/Common.css'
import './CorrectionCenter.css'

export default function CorrectionCenter() {
  const [selected, setSelected] = useState(corrections[0])

  const pending   = corrections.filter((c) => c.status === 'pending')
  const approved  = corrections.filter((c) => c.status === 'approved' || c.status === 'applied')
  const rejected  = corrections.filter((c) => c.status === 'rejected')
  const taxImpact = corrections.reduce((s, c) => s + c.taxImpact, 0)

  const summaryCards = [
    { label: 'Pending',    value: pending.length.toString(),  icon: Clock,        tone: 'warning' },
    { label: 'Approved',   value: approved.length.toString(), icon: CheckCircle2, tone: 'success' },
    { label: 'Rejected',   value: rejected.length.toString(), icon: XCircle,      tone: 'danger'  },
    { label: 'Tax Impact', value: formatCurrency(taxImpact),  icon: IndianRupee,  tone: 'default' },
  ]

  const columns = [
    { key: 'id',             header: 'ID',       render: (r) => <span className="font-mono" style={{ fontSize: 11 }}>{r.id}</span> },
    { key: 'vendor',         header: 'Vendor',   render: (r) => <span style={{ fontSize: 12.5, fontWeight: 500 }}>{r.vendor}</span> },
    { key: 'originalEntry',  header: 'Original', render: (r) => <span className="font-mono" style={{ fontSize: 11 }}>{r.originalEntry}</span> },
    { key: 'suggestedEntry', header: 'Suggested',render: (r) => <span className="font-mono" style={{ fontSize: 11, color: 'var(--color-success)' }}>{r.suggestedEntry}</span> },
    { key: 'reviewer',       header: 'Reviewer', render: (r) => <span style={{ fontSize: 12 }}>{r.reviewer}</span> },
    { key: 'status',         header: 'Status',   render: (r) => <StatusBadge label={formatStatusLabel(r.status)} tone={correctionStatusToTone(r.status)} /> },
  ]

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">Correction Center</span>
          </div>
          <h1 className="page-title">Correction Center</h1>
        </div>
        <button className="btn btn-outline"><Download size={14} />Export</button>
      </div>

      <div className="summary-grid-4">
        {summaryCards.map((c) => (
          <div key={c.label} className="kpi-card">
            <div className="kpi-icon-row">
              <span className="kpi-label">{c.label}</span>
              <div className={`kpi-icon-box ${c.tone}`}><c.icon size={14} /></div>
            </div>
            <span className="kpi-value" style={{ fontSize: 18 }}>{c.value}</span>
          </div>
        ))}
      </div>

      <div className="correction-split">
        <div className="table-card">
          <div className="table-card-header">
            <div>
              <div className="table-card-title">Correction Table</div>
              <div className="table-card-sub">Click a row to view the correction timeline</div>
            </div>
          </div>
          <DataTable columns={columns} data={corrections} onRowClick={(row) => setSelected(row)} pageSize={9} />
        </div>

        <div className="correction-detail-panel">
          {selected ? (
            <>
              <div className="correction-detail-header">
                <div style={{ minWidth: 0 }}>
                  <div className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{selected.id}</div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text)', margin: '2px 0 6px' }}>{selected.vendor}</div>
                  <StatusBadge label={formatStatusLabel(selected.status)} tone={correctionStatusToTone(selected.status)} />
                </div>
                <button className="issue-drawer-close" onClick={() => setSelected(null)}><X size={14} /></button>
              </div>

              <div className="correction-detail-body">
                <div className="issue-drawer-section-title">Correction Timeline</div>
                <Timeline stages={selected.timeline} />

                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
                  {[
                    { label: 'Original Entry',  value: selected.originalEntry,  color: '' },
                    { label: 'Suggested Entry', value: selected.suggestedEntry, color: 'color: var(--color-success)' },
                    { label: 'Tax Impact',      value: formatCurrency(selected.taxImpact), bold: true },
                    { label: 'Reviewer',        value: selected.reviewer },
                  ].map(({ label, value, bold }) => (
                    <div key={label} className="issue-drawer-row">
                      <span className="issue-drawer-row-label">{label}</span>
                      <span className={`issue-drawer-row-value ${bold ? 'font-bold' : ''}`}>{value}</span>
                    </div>
                  ))}
                </div>

                {selected.status === 'pending' && (
                  <div className="correction-actions">
                    <button className="btn btn-danger btn-sm" style={{ flex: 1 }}>Reject</button>
                    <button className="btn btn-primary btn-sm" style={{ flex: 1 }}>Approve</button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={{ padding: 32, textAlign: 'center', fontSize: 13, color: 'var(--color-text-muted)' }}>
              Select a correction to view its timeline.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
