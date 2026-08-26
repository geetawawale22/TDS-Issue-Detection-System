import { useSelector } from 'react-redux'
import { Download, ChevronDown, ChevronRight, Circle, Undo2, CheckCircle2 } from 'lucide-react'
import { useState } from 'react'
import DataTable from '@/components/Common/DataTable'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import { selectGlCorrections, selectIsLive } from '@/redux/slices/issuesSlice'
import { formatCurrency, formatDate } from '@/utils/utils'
import '@/components/Common/Common.css'
import './CorrectionCenter.css'

export default function CorrectionCenter() {
  const [expandedId, setExpandedId] = useState(null)
  const glCorrections = useSelector(selectGlCorrections)
  const isLive = useSelector(selectIsLive)

  const totalShortfall = glCorrections.reduce((sum, c) => sum + c.shortfall, 0)

  const columns = [
    { key: 'vendor', header: 'Vendor', render: (r) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, fontSize: 12.5 }}>
        {expandedId === r.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {r.vendor}
      </div>
    )},
    { key: 'section',        header: 'Section',                  render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.section}</span> },
    { key: 'originalDoc',     header: 'Original Doc',             render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.originalDoc}</span> },
    { key: 'reversalDoc',     header: 'Reversal Doc',             render: (r) => <span className="font-mono" style={{ fontSize: 11.5, color: 'var(--color-warning)' }}>{r.reversalDoc}</span> },
    { key: 'correctionDoc',   header: 'Correction Doc',           render: (r) => <span className="font-mono" style={{ fontSize: 11.5, color: 'var(--color-success)' }}>{r.correctionDoc}</span> },
    { key: 'originalDate',    header: 'Original Date',            render: (r) => <span style={{ fontSize: 11.5 }}>{formatDate(r.originalDate)}</span> },
    { key: 'correctionDate',  header: 'Correction Date',          render: (r) => <span style={{ fontSize: 11.5 }}>{formatDate(r.correctionDate)}</span> },
    { key: 'wrongTds',        header: 'Wrong TDS (₹)',            render: (r) => <span className="font-mono" style={{ fontSize: 11.5, color: 'var(--color-danger)', fontWeight: 600 }}>{formatCurrency(r.wrongTds)}</span> },
    { key: 'correctTds',      header: 'Correct TDS (₹)',          render: (r) => <span className="font-mono" style={{ fontSize: 11.5, color: 'var(--color-success)', fontWeight: 600 }}>{formatCurrency(r.correctTds)}</span> },
    { key: 'shortfall',       header: 'Shortfall to Deposit (₹)', render: (r) => <span className="font-mono" style={{ fontSize: 12, color: 'var(--color-danger)', fontWeight: 700 }}>{formatCurrency(r.shortfall)}</span> },
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
        <div className="issues-header-actions">
          <LiveDataBadge />
          <button className="btn btn-outline" type="button"><Download size={14} />Export</button>
        </div>
      </div>

      <div className="table-card">
        <div className="table-card-header">
          <div>
            <div className="table-card-title">GL Correction Audit Trail</div>
            <div className="table-card-sub">
              {isLive
                ? 'Proposed corrections from shortfall issues in your SAP upload'
                : 'Sample correction trail'}
              {' · '}
              <strong>{glCorrections.length}</strong> correction{glCorrections.length === 1 ? '' : 's'}
              {' · '}Total additional TDS to deposit:{' '}
              <strong className="correction-total-shortfall">{formatCurrency(totalShortfall)}</strong>
            </div>
          </div>
        </div>

        <DataTable
          columns={columns}
          data={glCorrections}
          onRowClick={(row) => setExpandedId((id) => (id === row.id ? null : row.id))}
          pageSize={12}
          expandedRowKey={expandedId}
          renderExpandedRow={(row) => (
            <div className="audit-subtable-wrap">
              <table className="audit-subtable">
                <thead>
                  <tr>
                    <th>Entry Type</th>
                    <th>Doc No.</th>
                    <th>Date</th>
                    <th>Base Amount (₹)</th>
                    <th>TDS (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="audit-subtable-row audit-subtable-row--original">
                    <td><span className="audit-entry-type"><Circle size={8} fill="currentColor" />Original</span></td>
                    <td className="font-mono">{row.originalDoc}</td>
                    <td>{formatDate(row.originalDate)}</td>
                    <td className="font-mono">{formatCurrency(row.baseAmount)}</td>
                    <td className="font-mono">{formatCurrency(row.wrongTds)}</td>
                  </tr>
                  <tr className="audit-subtable-row audit-subtable-row--reversal">
                    <td><span className="audit-entry-type"><Undo2 size={12} />Reversal</span></td>
                    <td className="font-mono">{row.reversalDoc}</td>
                    <td>{formatDate(row.correctionDate)}</td>
                    <td className="font-mono">−{formatCurrency(row.baseAmount)}</td>
                    <td className="font-mono">+{formatCurrency(row.wrongTds)}</td>
                  </tr>
                  <tr className="audit-subtable-row audit-subtable-row--correction">
                    <td><span className="audit-entry-type"><CheckCircle2 size={12} />Correction</span></td>
                    <td className="font-mono">{row.correctionDoc}</td>
                    <td>{formatDate(row.correctionDate)}</td>
                    <td className="font-mono">{formatCurrency(row.baseAmount)}</td>
                    <td className="font-mono">{formatCurrency(row.correctTds)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          emptyState={
            <div className="empty-state">
              <div className="empty-state-title">No corrections found</div>
              <div className="empty-state-desc">
                {isLive
                  ? 'No shortfall issues in this SAP run. Upload data with rate gaps to see proposed GL corrections.'
                  : 'Resolved issues with a rate shortfall will appear here once posted to the GL.'}
              </div>
            </div>
          }
        />
      </div>
    </div>
  )
}
