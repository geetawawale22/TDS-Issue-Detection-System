import { useSelector } from 'react-redux'
import { Download, ChevronDown, ChevronRight, Circle, Undo2, CheckCircle2, ClipboardList } from 'lucide-react'
import { useState } from 'react'
import DataTable from '@/components/Common/DataTable'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import { selectActiveIssues, selectCorrectionGroups, selectGlCorrections, selectIsLive } from '@/redux/slices/issuesSlice'
import { formatCurrency, formatDate, formatStatusLabel } from '@/utils/utils'
import '@/components/Common/Common.css'
import './CorrectionCenter.css'



function actorName(group) {
  return group.actionBy?.name || group.matchedBy?.name || group.createdBy?.name || 'Unknown user'
}

function actorSubtext(group) {
  return group.actionBy?.email || group.matchedBy?.email || group.createdBy?.email || group.actionLabel || ''
}

function expectedTdsFromIssue(issue) {
  const base = Number(issue?.baseAmount) || 0
  const rate = Number(issue?.expectedRate)
  if (!base || Number.isNaN(rate)) return Math.abs(Number(issue?.tdsAmount) || 0) + Math.abs(Number(issue?.taxImpact) || 0)
  return Number((base * rate / 100).toFixed(2))
}

function rateLabel(value) {
  return value == null || value === '' ? '—' : `${value}%`
}

function RateAmountCell({ rate, amount, tone = 'neutral' }) {
  return (
    <div className={`manual-rate-amount manual-rate-amount--${tone}`}>
      <span className="font-mono">{rateLabel(rate)}</span>
      <strong className="font-mono">{formatCurrency(amount)}</strong>
    </div>
  )
}

export default function CorrectionCenter() {
  const [expandedId, setExpandedId] = useState(null)
  const glCorrections = useSelector(selectGlCorrections)
  const manualCorrections = useSelector(selectCorrectionGroups)
  const activeIssues = useSelector(selectActiveIssues)
  const isLive = useSelector(selectIsLive)

  const issuesByDoc = new Map(activeIssues.map((issue) => [String(issue.docNo || ''), issue]))
  const manualCorrectionRows = manualCorrections.map((group) => {
    const issue = issuesByDoc.get(String(group.originalDocumentNumber || ''))
    const appliedTdsAmount = group.appliedTdsAmount ?? Math.abs(Number(issue?.tdsAmount) || 0)
    const expectedTdsAmount = group.expectedTdsAmount ?? expectedTdsFromIssue(issue)
    const appliedRate = group.appliedRate ?? issue?.appliedRate
    const expectedRate = group.expectedRate ?? issue?.expectedRate
    const originalEntries = group.entries || []
    const entries = group.method === 'FULL_REVERSAL'
      ? originalEntries.map((entry) => ({
        ...entry,
        appliedRate: entry.appliedRate ?? appliedRate,
        appliedTdsAmount: entry.appliedTdsAmount ?? appliedTdsAmount,
        expectedRate: entry.expectedRate ?? expectedRate,
        expectedTdsAmount: entry.expectedTdsAmount ?? expectedTdsAmount,
        amount: entry.role === 'REVERSAL' ? -Math.abs(appliedTdsAmount) : Math.abs(expectedTdsAmount),
        displayAmount: entry.role === 'REVERSAL' ? Math.abs(appliedTdsAmount) : Math.abs(expectedTdsAmount),
      }))
      : originalEntries.map((entry) => ({
        ...entry,
        appliedRate: entry.appliedRate ?? appliedRate,
        appliedTdsAmount: entry.appliedTdsAmount ?? appliedTdsAmount,
        expectedRate: entry.expectedRate ?? expectedRate,
        expectedTdsAmount: entry.expectedTdsAmount ?? expectedTdsAmount,
      }))
    return {
      ...group,
      entries,
      id: group.groupId,
      vendor: entries[0]?.vendor || issue?.vendor || 'Unknown vendor',
      vendorId: entries[0]?.vendorId || issue?.vendorId || '—',
      section: entries[0]?.section || issue?.section || '—',
      appliedRate,
      appliedTdsAmount,
      expectedRate,
      expectedTdsAmount,
      netAmount: entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0),
      actorName: actorName(group),
      actorSubtext: actorSubtext(group),
    }
  })
  const totalManualNet = manualCorrectionRows.reduce((sum, group) => sum + group.netAmount, 0)

  const totalShortfall = glCorrections.reduce((sum, c) => sum + c.shortfall, 0)

  const manualColumns = [
    { key: 'groupId', header: 'Group ID', render: (r) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 12.5 }}>
        {expandedId === r.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="font-mono">{r.groupId}</span>
      </div>
    )},
    { key: 'vendor', header: 'Vendor', render: (r) => (
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.vendor}</div>
        <div className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.vendorId}</div>
      </div>
    )},
    { key: 'originalDocumentNumber', header: 'Original Doc', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.originalDocumentNumber}</span> },
    { key: 'method', header: 'Method', render: (r) => <span className="manual-method-pill">{r.method === 'FULL_REVERSAL' ? 'Full Reversal' : 'Difference Only'}</span> },
    { key: 'section', header: 'Section', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.section}</span> },
    { key: 'appliedTdsAmount', header: 'Applied', render: (r) => <RateAmountCell rate={r.appliedRate} amount={r.appliedTdsAmount} tone="danger" /> },
    { key: 'expectedTdsAmount', header: 'Expected', render: (r) => <RateAmountCell rate={r.expectedRate} amount={r.expectedTdsAmount} tone="success" /> },
    { key: 'netAmount', header: 'Net Impact', render: (r) => <span className="font-mono manual-net-amount">{formatCurrency(r.netAmount)}</span> },
    { key: 'createdBy', header: 'User', render: (r) => (
      <div>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{r.actorName}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.actorSubtext || r.actionLabel || '—'}</div>
      </div>
    )},
    { key: 'createdAt', header: 'Created', render: (r) => <span style={{ fontSize: 11.5 }}>{formatDate(r.createdAt)}</span> },
    { key: 'status', header: 'Status', render: (r) => <span className="manual-status-pill">{formatStatusLabel(r.status)}</span> },
  ]

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

      <div className="table-card correction-register-card">
        <div className="table-card-header">
          <div>
            <div className="table-card-title"><ClipboardList size={15} />Manual Correction Register</div>
            <div className="table-card-sub">
              Saved correction groups created from issue review
              {' · '}
              <strong>{manualCorrectionRows.length}</strong> group{manualCorrectionRows.length === 1 ? '' : 's'}
              {' · '}Net correction impact:{' '}
              <strong className="manual-net-amount">{formatCurrency(totalManualNet)}</strong>
            </div>
          </div>
        </div>

        <DataTable
          columns={manualColumns}
          data={manualCorrectionRows}
          onRowClick={(row) => setExpandedId((id) => (id === row.id ? null : row.id))}
          pageSize={12}
          expandedRowKey={expandedId}
          renderExpandedRow={(row) => (
            <div className="manual-correction-detail">
              <table className="audit-subtable">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Correction Doc</th>
                    <th>Original Doc</th>
                    <th>Base Amount (₹)</th>
                    <th>Applied Rate</th>
                    <th>Applied TDS (₹)</th>
                    <th>Expected Rate</th>
                    <th>Expected TDS (₹)</th>
                    <th>Correction TDS (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {(row.entries || []).map((entry) => (
                    <tr className="audit-subtable-row audit-subtable-row--correction" key={entry.correctionDocumentNumber}>
                      <td><span className="audit-entry-type"><CheckCircle2 size={12} />{formatStatusLabel(entry.role)}</span></td>
                      <td className="font-mono">{entry.correctionDocumentNumber}</td>
                      <td className="font-mono">{entry.originalDocumentNumber}</td>
                      <td className="font-mono">{formatCurrency(entry.baseAmount)}</td>
                      <td className="font-mono">{rateLabel(entry.appliedRate ?? row.appliedRate)}</td>
                      <td className="font-mono">{formatCurrency(entry.appliedTdsAmount ?? row.appliedTdsAmount)}</td>
                      <td className="font-mono">{rateLabel(entry.expectedRate ?? row.expectedRate)}</td>
                      <td className="font-mono">{formatCurrency(entry.expectedTdsAmount ?? row.expectedTdsAmount)}</td>
                      <td className="font-mono">{formatCurrency(entry.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="manual-correction-remarks">
                <strong>{row.actionLabel || (row.status === 'matched_in_sap' ? 'Matched SAP rows' : 'Created correction')}</strong> by {row.actorName}
                {row.remarks ? ` · ${row.remarks}` : ''}
              </div>
            </div>
          )}
          emptyState={
            <div className="empty-state">
              <div className="empty-state-title">No manual corrections saved</div>
              <div className="empty-state-desc">Open an issue, click Create Correction, and saved groups will appear here.</div>
            </div>
          }
        />
      </div>

      {/* GL Correction Audit Trail temporarily hidden. */}
    </div>
  )
}
