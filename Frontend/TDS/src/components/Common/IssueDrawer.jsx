import { X, CheckCheck, FileText, Lightbulb } from 'lucide-react'
import StatusBadge, { severityToTone, issueStatusToTone } from './StatusBadge'
import { getDisplayIssueType, getRecommendedAction } from '@/data/issueTypes'
import { formatCurrency, formatDate, formatStatusLabel } from '@/utils/utils'
import './Common.css'

export default function IssueDrawer({ issue, open, onClose }) {
  return (
    <div className={`issue-drawer-overlay ${open ? 'open' : ''}`} onClick={onClose}>
      <div
        className={`issue-drawer issue-drawer--${issue?.severity ?? 'medium'} ${open ? 'open' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {issue ? (
          <>
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
                {issue.plainEnglish && (
                  <div className="issue-drawer-desc" style={{ marginBottom: 10 }}>
                    {issue.plainEnglish}
                  </div>
                )}
                <div className="issue-drawer-fields-card">
                  {(() => {
                    const generalFields = [
                      { label: 'Issue Type',     value: getDisplayIssueType(issue),          mono: false },
                      { label: 'Doc No.',        value: issue.docNo,                         mono: true },
                      { label: 'Vendor ID',      value: issue.vendorId,                      mono: true },
                      { label: 'Section (effective)', value: issue.section,                    mono: true },
                      ...(issue.newSection ? [
                        { label: 'New-law Section', value: issue.newSection,                  mono: true },
                      ] : []),
                      ...(issue.legacySection ? [
                        { label: 'Legacy Section', value: issue.legacySection,                mono: true },
                      ] : []),
                      { label: 'Date',           value: formatDate(issue.date),              mono: false },
                      ...(issue.thresholdAmount != null ? [
                        { label: 'FY',            value: issue.financialYear || '—',         mono: true },
                        { label: 'Txn Count',     value: String(issue.txnCount ?? '—'),      mono: true },
                        { label: 'FY Threshold',  value: formatCurrency(issue.thresholdAmount), mono: true },
                        { label: 'FY Cumulative', value: formatCurrency(issue.cumulativeBasic ?? issue.baseAmount), mono: true },
                      ] : []),
                      { label: issue.thresholdAmount != null ? 'FY Base Amount' : 'Base Amount',
                        value: formatCurrency(issue.baseAmount), mono: true },
                      { label: 'TDS Amount',     value: formatCurrency(Math.abs(Number(issue.tdsAmount) || 0)), mono: true },
                    ]
                    const rateFields = [
                      { label: 'Applied Rate',   value: issue.appliedRate == null ? '—' : `${issue.appliedRate}%`, mono: true },
                      { label: 'Applied TDS Amount',
                        value: (issue.appliedRate == null || issue.baseAmount == null) ? '—'
                          : formatCurrency(issue.baseAmount * issue.appliedRate / 100), mono: true },
                      { label: 'Expected Rate',  value: issue.expectedRate == null ? '—' : `${issue.expectedRate}%`, mono: true },
                      { label: 'Expected TDS Amount',
                        value: (issue.expectedRate == null || issue.baseAmount == null) ? '—'
                          : formatCurrency(issue.baseAmount * issue.expectedRate / 100), mono: true },
                    ]
                    // Sits under the Applied/Expected TDS Amount column, not the rate column.
                    const taxImpactRow = [null, { label: 'Tax Impact', value: formatCurrency(Math.abs(Number(issue.taxImpact) || 0)), mono: true }]
                    const pairUp = (fields) => {
                      const rows = []
                      for (let i = 0; i < fields.length; i += 2) rows.push([fields[i], fields[i + 1]])
                      return rows
                    }
                    const rows = [...pairUp(generalFields), ...pairUp(rateFields), taxImpactRow]
                    return rows.map((pair, i) => (
                      <div className="issue-drawer-row-pair" key={i}>
                        {pair.map((field, j) => field ? (
                          <div className="issue-drawer-row" key={field.label}>
                            <span className="issue-drawer-row-label">{field.label}</span>
                            <span className={`issue-drawer-row-value ${field.mono ? 'font-mono' : ''}`}>{field.value}</span>
                          </div>
                        ) : <div key={j} />)}
                      </div>
                    ))
                  })()}
                </div>
              </div>

              <div className="issue-drawer-col issue-drawer-col--divided">
                {issue.status === 'resolved' && (
                  <div className="corrected-banner">
                    <CheckCheck size={14} />
                    This issue has been corrected. A reversal and corrected entry have been posted in the GL for this document.
                  </div>
                )}
                <div className="issue-drawer-section-title"><Lightbulb size={13} />Recommended Action</div>
                <div className="issue-drawer-desc" style={{ borderColor: 'var(--color-success-border)', background: 'var(--color-success-bg)' }}>
                  {issue.status === 'resolved' ? (
                    <em>No action needed — already corrected via GL reversal.</em>
                  ) : getRecommendedAction(issue)}
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
    </div>
  )
}
