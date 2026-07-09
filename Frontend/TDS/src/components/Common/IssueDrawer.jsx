import { X } from 'lucide-react'
import StatusBadge, { severityToTone, issueStatusToTone } from './StatusBadge'
import { formatCurrency, formatDate, formatStatusLabel } from '@/utils/utils'
import './Common.css'

export default function IssueDrawer({ issue, open, onClose }) {
  return (
    <>
      {open && <div className="issue-drawer-overlay" onClick={onClose} />}
      <div className={`issue-drawer ${open ? 'open' : ''}`}>
        {issue ? (
          <>
            <div className="issue-drawer-header">
              <div style={{ minWidth: 0 }}>
                <div className="issue-drawer-id">{issue.id}</div>
                <div className="issue-drawer-vendor">{issue.vendor}</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <StatusBadge label={formatStatusLabel(issue.severity)} tone={severityToTone(issue.severity)} />
                  <StatusBadge label={formatStatusLabel(issue.status)} tone={issueStatusToTone(issue.status)} />
                </div>
              </div>
              <button className="issue-drawer-close" onClick={onClose}>
                <X size={16} />
              </button>
            </div>

            <div className="issue-drawer-body">
              <div className="issue-drawer-section-title">Issue Details</div>

              {[
                { label: 'Vendor ID',      value: issue.vendorId,                      mono: true },
                { label: 'Section',        value: issue.section,                       mono: true },
                { label: 'Date',           value: formatDate(issue.date),              mono: false },
                { label: 'Amount',         value: formatCurrency(issue.transactionAmount), mono: true },
                { label: 'Expected Rate',  value: `${issue.expectedRate}%`,             mono: true },
                { label: 'Applied Rate',   value: `${issue.appliedRate}%`,              mono: true },
                { label: 'Tax Impact',     value: formatCurrency(issue.taxImpact),      mono: true },
              ].map(({ label, value, mono }) => (
                <div className="issue-drawer-row" key={label}>
                  <span className="issue-drawer-row-label">{label}</span>
                  <span className={`issue-drawer-row-value ${mono ? 'font-mono' : ''}`}>{value}</span>
                </div>
              ))}

              <div style={{ height: 16 }} />
              <div className="issue-drawer-section-title">Description</div>
              <div className="issue-drawer-desc">{issue.description}</div>

              <div className="issue-drawer-section-title">Suggested Correction</div>
              <div className="issue-drawer-desc" style={{ borderColor: 'var(--color-success-border)', background: 'var(--color-success-bg)' }}>
                {issue.suggestedCorrection}
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
