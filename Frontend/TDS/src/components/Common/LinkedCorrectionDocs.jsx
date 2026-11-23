import { Link2 } from 'lucide-react'
import { formatCurrency, formatDate } from '@/utils/utils'
import './LinkedCorrectionDocs.css'

// What a linked document did to the issue (see services/issue_tracker.py).
export const LINK_LABELS = {
  TDS_CORRECTION: 'TDS correction',
  CANCELLATION: 'Credit memo / reversal',
  SUPPLEMENTARY: 'Supplementary entry',
  REVERSAL: 'Reversal document',
  REVERSED_BY: 'Reversed by',
  REFERENCE: 'Referencing entry',
  MANUAL: 'Matched SAP row',
}

function signedCurrency(value) {
  const number = Number(value) || 0
  return `${number < 0 ? '−' : '+'}${formatCurrency(Math.abs(number))}`
}

/**
 * The SAP documents that corrected an issue (credit memo, reversal, TDS
 * top-up), shown in the Review drawer on Correction Center and TDS Analysis.
 * `emptyText` is shown when no document is linked yet.
 */
export default function LinkedCorrectionDocs({ docs = [], emptyText = null }) {
  return (
    <>
      <div className="issue-drawer-section-title" style={{ marginTop: 12 }}><Link2 size={13} />Linked Correction Documents</div>
      {docs.length ? (
        <div className="linked-docs">
          {docs.map((doc) => (
            <div className="linked-doc" key={`${doc.docNo}-${doc.link}`}>
              <div>
                <span className="font-mono" style={{ fontWeight: 600 }}>{doc.docNo}</span>
                {doc.docType ? <span className="font-mono"> · {doc.docType}</span> : null}
              </div>
              <span className="linked-doc-pill">{LINK_LABELS[doc.link] || doc.link}</span>
              <div className="linked-doc-meta">
                {[
                  doc.postingDate && `Posted ${formatDate(doc.postingDate)}`,
                  doc.amount != null && `Amount ${formatCurrency(doc.amount)}`,
                  doc.tdsAmount != null && `TDS ${formatCurrency(doc.tdsAmount)}`,
                  doc.tdsEffect != null && Number(doc.tdsEffect) !== 0 && `TDS effect ${signedCurrency(doc.tdsEffect)}`,
                  doc.baseEffect != null && Number(doc.baseEffect) !== 0 && `Base effect ${signedCurrency(doc.baseEffect)}`,
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      ) : emptyText ? (
        <div className="linked-docs-empty">{emptyText}</div>
      ) : null}
    </>
  )
}
