import { X, ShieldCheck, RotateCw, Loader2, CheckCheck, FileText, IdCard, ClipboardList, Lightbulb } from 'lucide-react'
import { useDispatch, useSelector } from 'react-redux'
import StatusBadge, { severityToTone, issueStatusToTone, panStatusToTone } from './StatusBadge'
import { startVerifyPan, finishVerifyPan } from '@/redux/slices/panSlice'
import { simulatePanVerification } from '@/data/issueTypes'
import { formatCurrency, formatDate, formatStatusLabel } from '@/utils/utils'
import './Common.css'

export default function IssueDrawer({ issue, open, onClose }) {
  const dispatch = useDispatch()
  const panInfo = useSelector((s) => (issue ? s.pan[issue.vendorId] : undefined))

  function handleVerifyPan() {
    if (!issue || !panInfo || panInfo.verifying) return
    dispatch(startVerifyPan(issue.vendorId))
    // Simulate the latency of a real government PAN API round-trip.
    setTimeout(() => {
      const result = simulatePanVerification(panInfo.pan)
      dispatch(finishVerifyPan({ vendorId: issue.vendorId, result: { ...result, checkedAt: new Date().toISOString() } }))
    }, 900)
  }

  return (
    <>
      {open && <div className="issue-drawer-overlay" onClick={onClose} />}
      <div className={`issue-drawer issue-drawer--${issue?.severity ?? 'medium'} ${open ? 'open' : ''}`}>
        {issue ? (
          <>
            <div className="issue-drawer-handle" />
            <div className="issue-drawer-header">
              <div style={{ minWidth: 0 }}>
                <div className="issue-drawer-id">{issue.id}</div>
                <div className="issue-drawer-vendor">{issue.vendor}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <StatusBadge label={formatStatusLabel(issue.severity)} tone={severityToTone(issue.severity)} />
                  <StatusBadge label={formatStatusLabel(issue.status)} tone={issueStatusToTone(issue.status)} />
                </div>
              </div>
              <button className="issue-drawer-close" onClick={onClose}>
                <X size={16} />
              </button>
            </div>

            <div className="issue-drawer-body issue-drawer-body--horizontal">
              <div className="issue-drawer-col">
                <div className="issue-drawer-section-title"><FileText size={13} />Issue Details</div>
                <div className="issue-drawer-fields-card">
                  {[
                    { label: 'Issue Type',     value: issue.issueTypeLabel,                mono: false },
                    { label: 'Category',      value: issue.category,                      mono: false },
                    { label: 'Doc No.',        value: issue.docNo,                         mono: true },
                    { label: 'Vendor ID',      value: issue.vendorId,                      mono: true },
                    { label: 'Section',        value: issue.section,                       mono: true },
                    { label: 'Date',           value: formatDate(issue.date),              mono: false },
                    { label: 'Base Amount',    value: formatCurrency(issue.baseAmount),    mono: true },
                    { label: 'TDS Amount',     value: formatCurrency(issue.tdsAmount),     mono: true },
                    { label: 'Expected Rate',  value: `${issue.expectedRate}%`,             mono: true },
                    { label: 'Applied Rate',   value: `${issue.appliedRate}%`,              mono: true },
                    { label: 'Tax Impact',     value: formatCurrency(issue.taxImpact),      mono: true },
                  ].map(({ label, value, mono }) => (
                    <div className="issue-drawer-row" key={label}>
                      <span className="issue-drawer-row-label">{label}</span>
                      <span className={`issue-drawer-row-value ${mono ? 'font-mono' : ''}`}>{value}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="issue-drawer-col issue-drawer-col--divided">
                <div className="issue-drawer-section-title"><IdCard size={13} />PAN Verification</div>
                <div className="pan-verification-card">
                  <div className="pan-verification-row">
                    <span className="font-mono">{panInfo?.pan || '—'}</span>
                    <StatusBadge label={panInfo?.status} tone={panStatusToTone(panInfo?.status)} />
                  </div>
                  <div className="issue-drawer-row">
                    <span className="issue-drawer-row-label">Aadhaar Linked</span>
                    <span className="issue-drawer-row-value">
                      {panInfo?.aadhaarLinked == null ? '—' : panInfo.aadhaarLinked ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div className="issue-drawer-row">
                    <span className="issue-drawer-row-label">Checked On</span>
                    <span className="issue-drawer-row-value">{formatDate(panInfo?.checkedAt)}</span>
                  </div>
                  <button className="pan-verify-btn" onClick={handleVerifyPan} disabled={panInfo?.verifying}>
                    {panInfo?.verifying ? <Loader2 size={12} className="spin" /> : <RotateCw size={12} />}
                    {panInfo?.verifying ? 'Verifying…' : 'Verify PAN'}
                  </button>
                  {panInfo?.isMocked && (
                    <div className="pan-verification-mock-note">
                      <ShieldCheck size={12} />
                      Mock result — pending Mahindra's government PAN API credentials.
                    </div>
                  )}
                </div>
              </div>

              <div className="issue-drawer-col issue-drawer-col--divided">
                {issue.status === 'resolved' && (
                  <div className="corrected-banner">
                    <CheckCheck size={14} />
                    This issue has been corrected. A reversal and corrected entry have been posted in the GL for this document.
                  </div>
                )}
                <div className="issue-drawer-section-title"><ClipboardList size={13} />Issue Detail</div>
                <div className="issue-drawer-desc">{issue.issueDetail}</div>

                <div className="issue-drawer-section-title"><Lightbulb size={13} />Recommended Action</div>
                <div className="issue-drawer-desc" style={{ borderColor: 'var(--color-success-border)', background: 'var(--color-success-bg)' }}>
                  {issue.status === 'resolved' ? (
                    <em>No action needed — already corrected via GL reversal.</em>
                  ) : issue.recommendedAction}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
            Select an issue to view details
          </div>
        )}
      </div>
    </>
  )
}
