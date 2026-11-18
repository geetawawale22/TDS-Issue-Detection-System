import { X, CheckCheck, FileText, Lightbulb, ClipboardList } from 'lucide-react'
import StatusBadge, { severityToTone, issueStatusToTone } from './StatusBadge'
import { getDisplayIssueType, getRecommendedAction } from '@/data/issueTypes'
import { formatCurrency, formatDate, formatStatusLabel } from '@/utils/utils'
import {
  CORRECTION_METHOD_LABELS, CORRECTION_ROLE_LABELS, CORRECTION_STATUS_LABELS, RECONCILE_TOLERANCE, correctionStatusTone,
} from '@/utils/correctionLabels'
import './Common.css'

/**
 * `resolvedNote` replaces the default "corrected" banner text (e.g. how a later
 * run resolved the issue); `children` adds sections under the action column.
 */
function signedCurrency(value) {
  const number = Number(value) || 0
  if (number === 0) return formatCurrency(0)
  return `${number < 0 ? '−' : '+'}${formatCurrency(Math.abs(number))}`
}

/** Banner text when no run-specific note is given: say what actually resolved the issue. */
function defaultResolvedText(issue) {
  if (issue.correctionGroupId) {
    const method = CORRECTION_METHOD_LABELS[issue.correctionMethod]
    return `This issue is corrected by matched SAP rows (${issue.correctionGroupId}${method ? ` · ${method}` : ''}). See the Correction Register below and in Correction Center.`
  }
  return 'This issue is marked corrected.'
}

export default function IssueDrawer({ issue, open, onClose, correctionGroups = [], onMatchSapRows, resolvedNote = null, children = null }) {
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
                      { label: 'PAN No.',        value: issue.vendorPan || issue.pan || '—', mono: true },
                      { label: 'Section (effective)', value: issue.section,                    mono: true },
                      ...(issue.newSection ? [
                        { label: 'New-law Section', value: issue.newSection,                  mono: true },
                      ] : []),
                      ...(issue.legacySection ? [
                        { label: 'Legacy Section', value: issue.legacySection,                mono: true },
                      ] : []),
                      { label: 'Posting Date',   value: formatDate(issue.postingDate || issue.date), mono: false },
                      ...(issue.documentDate ? [
                        { label: 'Document Date', value: formatDate(issue.documentDate), mono: false },
                      ] : []),
                      ...(issue.thresholdAmount != null ? [
                        { label: 'FY',            value: issue.financialYear || '—',         mono: true },
                        { label: 'Txn Count',     value: String(issue.txnCount ?? '—'),      mono: true },
                        { label: 'FY Threshold',  value: formatCurrency(issue.thresholdAmount), mono: true },
                        { label: 'FY Cumulative', value: formatCurrency(issue.cumulativeBasic ?? issue.baseAmount), mono: true },
                      ] : []),
                      { label: issue.thresholdAmount != null ? 'FY Base Amount' : 'Base Amount',
                        value: formatCurrency(issue.baseAmount), mono: true },
                      { label: 'TDS Amount',     value: formatCurrency(Math.abs(Number(issue.tdsAmount) || 0)), mono: true },
                      ...(issue.withholdingTaxType || issue.withholdingTaxCode ? [
                        { label: 'WTax Type/Code', value: `${issue.withholdingTaxType || '—'}/${issue.withholdingTaxCode || '—'}`, mono: true },
                      ] : []),
                      ...(issue.ldcCertificate || issue.ldcValidFrom || issue.ldcValidTo ? [
                        { label: 'LDC Certificate', value: issue.ldcCertificate || '—', mono: true },
                        { label: 'LDC Exemption', value: issue.ldcExemptionPercent == null ? '—' : `${issue.ldcExemptionPercent}%`, mono: true },
                        { label: 'LDC Valid From', value: issue.ldcValidFrom ? formatDate(issue.ldcValidFrom) : '—', mono: false },
                        { label: 'LDC Valid To', value: issue.ldcValidTo ? formatDate(issue.ldcValidTo) : '—', mono: false },
                      ] : []),
                    ]
                    const rateFields = [
                      { label: 'Applied Rate',   value: issue.appliedRate == null ? '—' : `${Number(issue.appliedRate).toFixed(2)}%`, mono: true },
                      // The TDS Amount *is* the applied amount — not baseAmount × appliedRate,
                      // which can drift from the actual figure by rounding.
                      { label: 'Applied TDS Amount', value: formatCurrency(Math.abs(Number(issue.tdsAmount) || 0)), mono: true },
                      { label: 'Expected Rate',  value: issue.expectedRate == null ? '—' : `${Number(issue.expectedRate).toFixed(2)}%`, mono: true },
                      { label: 'Expected TDS Amount',
                        value: (issue.expectedRate == null || issue.baseAmount == null) ? '—'
                          : formatCurrency(Math.abs(issue.baseAmount * issue.expectedRate / 100)), mono: true },
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
                    {resolvedNote || defaultResolvedText(issue)}
                  </div>
                )}
                <div className="issue-drawer-section-title"><Lightbulb size={13} />Recommended Action</div>
                <div className="issue-drawer-desc" style={{ borderColor: 'var(--color-success-border)', background: 'var(--color-success-bg)' }}>
                  {issue.status === 'resolved' ? (
                    <em>{resolvedNote ? 'No action needed — the issue was resolved by the entries listed below.' : 'No action needed — correction is recorded in the manual correction register.'}</em>
                  ) : getRecommendedAction(issue)}
                </div>

                {issue.status !== 'resolved' && onMatchSapRows && (
                  <div className="issue-correction-actions">
                    {onMatchSapRows && (
                      <button className="issue-correction-secondary" type="button" onClick={() => onMatchSapRows(issue)}>
                        <ClipboardList size={14} />
                        Match SAP Rows
                      </button>
                    )}
                  </div>
                )}

                {correctionGroups.length > 0 && (
                  <div className="issue-correction-panel">
                    <div className="issue-drawer-section-title"><ClipboardList size={13} />Correction Register</div>
                    {correctionGroups.map((group) => (
                      <div className="issue-correction-group" key={group.groupId}>
                        <div className="issue-correction-group-head">
                          <span className="font-mono">{group.groupId}</span>
                          <span className="issue-correction-badges">
                            <StatusBadge
                              label={CORRECTION_METHOD_LABELS[group.method] || group.method}
                              tone={group.method === 'FULL_REVERSAL' ? 'warning' : 'success'}
                            />
                            <StatusBadge label={CORRECTION_STATUS_LABELS[group.status] || group.status} tone={correctionStatusTone(group.status)} />
                          </span>
                        </div>
                        <div className="issue-correction-entry-list">
                          {group.entries.map((entry) => (
                            <div className="issue-correction-entry" key={entry.correctionDocumentNumber}>
                              <div>
                                <div className="font-mono issue-correction-doc">{entry.correctionDocumentNumber}</div>
                                <div className="issue-correction-role">{CORRECTION_ROLE_LABELS[entry.role] || formatStatusLabel(entry.role)}</div>
                              </div>
                              <strong className="font-mono" title={`TDS on SAP row ${formatCurrency(entry.tdsAmount)}`}>{signedCurrency(entry.amount)}</strong>
                            </div>
                          ))}
                        </div>
                        {group.expectedTdsAmount != null && (
                          <div className={`issue-correction-reconcile ${Math.abs(Number(group.unreconciledAmount) || 0) > RECONCILE_TOLERANCE ? 'issue-correction-reconcile--diff' : ''}`}>
                            TDS {formatCurrency(group.appliedTdsAmount)} {signedCurrency(group.netAmount)} = {formatCurrency(group.correctedTdsAmount)}
                            {' · '}expected {formatCurrency(group.expectedTdsAmount)}
                            {Math.abs(Number(group.unreconciledAmount) || 0) > RECONCILE_TOLERANCE
                              ? ` · ${group.unreconciledAmount > 0 ? 'short' : 'excess'} ${formatCurrency(Math.abs(group.unreconciledAmount))}`
                              : ' · reconciled'}
                          </div>
                        )}
                        <div className="issue-correction-remarks">
                          <strong>{group.createdBy?.name || 'Unknown user'}</strong>
                          {` · Matched SAP rows on ${formatDate(group.createdAt)}`}
                          {group.remarks ? ` · ${group.remarks}` : ''}
                          {group.statusChangedBy ? ` · ${CORRECTION_STATUS_LABELS[group.status] || group.status} by ${group.statusChangedBy.name}${group.statusNote ? `: ${group.statusNote}` : ''}` : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {children}
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
