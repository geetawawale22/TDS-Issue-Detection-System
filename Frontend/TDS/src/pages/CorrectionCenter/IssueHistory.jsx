import { useEffect, useState } from 'react'
import { AlertOctagon, AlertTriangle, BadgeCheck, BadgeX, ChevronLeft, ChevronRight, History, IndianRupee, Link2, ShieldAlert, Sparkles, Wrench } from 'lucide-react'
import IssueDrawer from '@/components/Common/IssueDrawer'
import issuesService from '@/services/issuesService'
import { formatCurrency, formatDate } from '@/utils/utils'
import './IssueHistory.css'

const PAGE_SIZE = 200

const RESOLUTION_LABELS = {
  REVERSED: 'Reversed / cancelled',
  CORRECTION_POSTED: 'Correction posted',
  NO_LONGER_FLAGGED: 'No longer flagged',
  MANUAL: 'Matched manually',
}

// What a linked document did to the issue (see services/issue_tracker.py).
const LINK_LABELS = {
  TDS_CORRECTION: 'TDS correction',
  CANCELLATION: 'Credit memo / reversal',
  SUPPLEMENTARY: 'Supplementary entry',
  REVERSAL: 'Reversal document',
  REVERSED_BY: 'Reversed by',
  REFERENCE: 'Referencing entry',
}

const RESOLUTION_OPTIONS = [
  ['', 'All resolutions'],
  ...Object.entries(RESOLUTION_LABELS),
]

function formatRate(rate) {
  return rate == null ? '—' : `${Number(rate).toFixed(2)}%`
}

function DocCell({ row }) {
  return (
    <div>
      <div className="font-mono" style={{ fontSize: 12, fontWeight: 600 }}>{row.docNo}</div>
      <div className="font-mono" style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>
        {[row.companyCode, row.fiscalYear].filter(Boolean).join(' · ')}
      </div>
    </div>
  )
}

function CorrectionDocs({ docs }) {
  if (!docs?.length) return <span style={{ color: 'var(--color-text-muted)' }}>—</span>
  return (
    <div className="issue-history-docs">
      {docs.map((doc) => (
        <span className="font-mono" key={`${doc.docNo}-${doc.link}`} title={doc.postingDate ? `Posted ${formatDate(doc.postingDate)}` : undefined}>
          {doc.docNo}{doc.tdsAmount ? ` (${formatCurrency(doc.tdsAmount)})` : ''}
        </span>
      ))}
    </div>
  )
}

function signedCurrency(value) {
  const number = Number(value) || 0
  return `${number < 0 ? '−' : '+'}${formatCurrency(Math.abs(number))}`
}

function trackingStatusLabel(row) {
  if (row.status === 'resolved') return RESOLUTION_LABELS[row.resolutionType] || 'Resolved'
  return row.remainingShortfall != null ? 'Partly corrected' : 'Open'
}

/** Extra drawer section: how the issue moved across runs and what corrected it. */
function TrackingPanel({ row }) {
  const fields = [
    ['Tracking Status', trackingStatusLabel(row)],
    ['First Seen', formatDate(row.firstSeenAt)],
    ['Last Seen', formatDate(row.lastSeenAt)],
    ['Runs Seen', String(row.timesSeen ?? '—')],
    ...(row.reopenedCount ? [['Reopened', `${row.reopenedCount}×`]] : []),
    ...(row.resolvedAt ? [['Resolved On', formatDate(row.resolvedAt)]] : []),
    ...(row.correctedTds != null ? [['TDS After Corrections', formatCurrency(row.correctedTds)]] : []),
    ...(row.remainingShortfall != null && row.status !== 'resolved'
      ? [[row.remainingShortfall > 0 ? 'Still Short' : 'Still Excess', formatCurrency(Math.abs(row.remainingShortfall))]]
      : []),
  ]
  const docs = row.correctionDocs || []
  return (
    <div className="issue-tracking-panel">
      <div className="issue-drawer-section-title"><History size={13} />Issue Tracking</div>
      <div className="issue-drawer-fields-card">
        {fields.map(([label, value]) => (
          <div className="issue-drawer-row" key={label}>
            <span className="issue-drawer-row-label">{label}</span>
            <span className="issue-drawer-row-value">{value}</span>
          </div>
        ))}
      </div>
      {row.resolutionNote && <div className="issue-drawer-desc" style={{ marginTop: 8 }}>{row.resolutionNote}</div>}

      <div className="issue-drawer-section-title" style={{ marginTop: 12 }}><Link2 size={13} />Linked Correction Documents</div>
      {docs.length ? (
        <div className="issue-tracking-docs">
          {docs.map((doc) => (
            <div className="issue-tracking-doc" key={`${doc.docNo}-${doc.link}`}>
              <div>
                <span className="font-mono" style={{ fontWeight: 600 }}>{doc.docNo}</span>
                {doc.docType ? <span className="font-mono"> · {doc.docType}</span> : null}
              </div>
              <span className="issue-history-pill">{LINK_LABELS[doc.link] || doc.link}</span>
              <div className="issue-tracking-doc-meta">
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
      ) : (
        <div className="issue-tracking-empty">
          No correction entry found yet. A later file with a document whose Reference Document Number is {row.docNo} will be linked here.
        </div>
      )}
    </div>
  )
}

/**
 * Issues saved across rule-engine runs. Paging, search and filters run on the
 * server, so this stays fast however many issues have been saved.
 */
// mode 'open' / 'resolved' fixes the list to one status (no Open/Resolved switch).
const MODE_TEXT = {
  open: {
    title: 'Open Issues',
    sub: 'Issues from every run that are still open. One is resolved automatically when a later run finds its reversal, a correction entry referencing it, or the document no longer raises it; it then moves to Correction Center.',
  },
  resolved: {
    title: 'Corrected / Resolved Issues',
    sub: 'Issues resolved by a later run (reversal, correction entry referencing the document, or no longer raised) or matched by hand. Open issues are on TDS Analysis.',
  },
  both: {
    title: 'Issue History',
    sub: 'Issues saved from every run. An issue is resolved automatically when a later run finds its reversal, a correction entry referencing it, or the document no longer raises it.',
  },
}

// Card filters for the open-issues view; each maps to list query params.
const CARD_FILTERS = {
  all: {},
  tds_deducted: { tds: 'deducted' },
  tds_not_deducted: { tds: 'not_deducted' },
  high: { severity: 'high' },
  medium: { severity: 'medium' },
  partial: { partial: true },
  new_latest: { run: 'latest' },
}

const CARD_FILTER_LABELS = {
  tds_deducted: 'TDS deducted',
  tds_not_deducted: 'TDS not deducted',
  high: 'High severity',
  medium: 'Medium severity',
  partial: 'Partly corrected',
  new_latest: 'New in latest run',
}

function SummaryCard({ tone, icon: Icon, value, label, breakdown, active, onClick }) {
  return (
    <div className={`issues-summary-card issues-summary-card--${tone} ${active ? 'issues-summary-card--active' : ''}`}>
      <button className="issues-summary-card-clickarea" type="button" onClick={onClick}>
        <Icon size={16} />
        <div>
          <div className="issues-summary-value">{value}</div>
          <div className="issues-summary-label">{label}</div>
          {breakdown && <div className="issues-summary-breakdown">{breakdown}</div>}
        </div>
      </button>
    </div>
  )
}

/** Cards over every open issue (all runs); a click filters the list below. */
function OpenIssueCards({ summary, view, onView }) {
  const n = (value) => Number(value || 0).toLocaleString()
  const pick = (next) => onView(view === next ? 'all' : next)
  return (
    <>
      <div className="issues-summary-grid issues-summary-grid--top">
        <SummaryCard tone="info" icon={ShieldAlert} value={n(summary.open)} label="Open Issues"
          breakdown={`All runs · tax impact ${formatCurrency(summary.openTaxImpact)}`}
          active={view === 'all'} onClick={() => onView('all')} />
        <SummaryCard tone="success" icon={BadgeCheck} value={n(summary.openTdsDeducted)} label="TDS Deducted"
          breakdown="Open issues where some TDS was deducted"
          active={view === 'tds_deducted'} onClick={() => pick('tds_deducted')} />
        <SummaryCard tone="danger" icon={BadgeX} value={n(summary.openTdsNotDeducted)} label="TDS Not Deducted"
          breakdown="Open issues with no TDS deducted"
          active={view === 'tds_not_deducted'} onClick={() => pick('tds_not_deducted')} />
      </div>
      <div className="issues-summary-grid issues-summary-grid--five issues-summary-grid--split">
        <SummaryCard tone="danger" icon={AlertOctagon} value={n(summary.openHigh)} label="High Severity"
          active={view === 'high'} onClick={() => pick('high')} />
        <SummaryCard tone="warning" icon={AlertTriangle} value={n(summary.openMedium)} label="Medium Severity"
          active={view === 'medium'} onClick={() => pick('medium')} />
        <SummaryCard tone="warning" icon={Wrench} value={n(summary.partlyCorrected)} label="Partly Corrected"
          active={view === 'partial'} onClick={() => pick('partial')} />
        <SummaryCard tone="info" icon={Sparkles} value={n(summary.openNewInLatestRun)} label="New in Latest Run"
          active={view === 'new_latest'} onClick={() => pick('new_latest')} />
        <SummaryCard tone="danger" icon={IndianRupee} value={formatCurrency(summary.openTaxImpact)} label="Open Tax Impact"
          active={false} onClick={() => onView('all')} />
      </div>
    </>
  )
}

export default function IssueHistory({ mode = 'both', initialStatus = 'resolved', refreshKey = null, showCards = false } = {}) {
  const [cardView, setCardView] = useState('all')
  const [summary, setSummary] = useState(null)
  const [status, setStatus] = useState(mode === 'both' ? initialStatus : mode)
  const [latestRunOnly, setLatestRunOnly] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [resolutionType, setResolutionType] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState({ items: [], total: 0, counts: { open: 0, resolved: 0 } })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reviewRow, setReviewRow] = useState(null)

  useEffect(() => {
    if (!showCards) return undefined
    let cancelled = false
    issuesService.getTrackedIssueSummary()
      .then((data) => { if (!cancelled) setSummary(data) })
      .catch(() => { if (!cancelled) setSummary(null) })
    return () => { cancelled = true }
  }, [showCards, refreshKey])

  // Wait for typing to pause before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    issuesService.getTrackedIssues({
      status,
      search,
      resolutionType: status === 'resolved' ? resolutionType : '',
      run: latestRunOnly ? 'latest' : '',
      ...CARD_FILTERS[cardView],
      page,
      pageSize: PAGE_SIZE,
    })
      .then((data) => { if (!cancelled) setResult(data) })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load issue history') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [status, search, resolutionType, latestRunOnly, cardView, page, refreshKey])

  function changeCardView(next) {
    setCardView(next)
    if (next === 'new_latest') setLatestRunOnly(false)
    setPage(1)
  }

  function changeStatus(next) {
    setStatus(next)
    setPage(1)
  }

  const totalPages = Math.max(1, Math.ceil((result.total || 0) / PAGE_SIZE))
  const isResolved = status === 'resolved'

  return (
    <>
    {showCards && summary && <OpenIssueCards summary={summary} view={cardView} onView={changeCardView} />}
    <div className="table-card issue-history-card">
      <div className="table-card-header">
        <div>
          <div className="table-card-title">
            <History size={15} />{MODE_TEXT[mode].title}
            {mode !== 'both' && <span className="issue-history-count">{(result.counts?.[status] ?? 0).toLocaleString()}</span>}
          </div>
          <div className="table-card-sub">{MODE_TEXT[mode].sub}</div>
          {cardView !== 'all' && (
            <div className="issue-history-card-filter">
              Showing: {CARD_FILTER_LABELS[cardView]}
              <button type="button" onClick={() => changeCardView('all')}>Clear</button>
            </div>
          )}
        </div>
      </div>

      <div className="issue-history-toolbar">
        {mode === 'both' && <div className="issue-history-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!isResolved}
            className={`issue-history-tab ${!isResolved ? 'active' : ''}`} onClick={() => changeStatus('open')}>
            Open <strong>{(result.counts?.open ?? 0).toLocaleString()}</strong>
          </button>
          <button type="button" role="tab" aria-selected={isResolved}
            className={`issue-history-tab ${isResolved ? 'active' : ''}`} onClick={() => changeStatus('resolved')}>
            Resolved <strong>{(result.counts?.resolved ?? 0).toLocaleString()}</strong>
          </button>
        </div>}
        <input
          className="filter-input"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search document no. / vendor / PAN"
        />
        <select className="filter-select" value={latestRunOnly ? 'latest' : ''}
          title="Latest run: open issues first raised by it, or issues it resolved"
          onChange={(event) => { setLatestRunOnly(event.target.value === 'latest'); setPage(1) }}>
          <option value="">All runs</option>
          <option value="latest">{isResolved ? 'Resolved in latest run' : 'New in latest run'}</option>
        </select>
        {isResolved && (
          <select className="filter-select" value={resolutionType}
            onChange={(event) => { setResolutionType(event.target.value); setPage(1) }}>
            {RESOLUTION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        )}
      </div>

      <div className="data-table-wrapper">
        <table className="data-table issue-history-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Vendor Name</th>
              <th>Vendor No.</th>
              <th>PAN</th>
              <th>Doc No.</th>
              <th>Doc Type</th>
              <th>Posting Date</th>
              <th>Section</th>
              <th>Profit Center</th>
              <th>Base Amt</th>
              <th>TDS (₹)</th>
              <th>Rate (Applied → Expected)</th>
              <th>Tax Impact</th>
              <th>Issue</th>
              <th>First Seen</th>
              {isResolved && (
                <>
                  <th>Resolution</th>
                  <th>Correction Docs</th>
                  <th>Resolved On</th>
                </>
              )}
              <th aria-label="Review" />
            </tr>
          </thead>
          <tbody>
            {result.items.map((row, index) => (
              <tr key={row.id}>
                <td className="issue-history-muted">{((page - 1) * PAGE_SIZE + index + 1).toLocaleString()}</td>
                <td className="issue-history-vendor">{row.vendor}</td>
                <td className="font-mono issue-history-small">{row.vendorId || '—'}</td>
                <td className="font-mono issue-history-small">{row.vendorPan || '—'}</td>
                <td><DocCell row={row} /></td>
                <td className="font-mono issue-history-small">{row.docType || '—'}</td>
                <td className="issue-history-small">{row.postingDate ? formatDate(row.postingDate) : '—'}</td>
                <td className="font-mono issue-history-small">{row.section || '—'}</td>
                <td className="font-mono issue-history-small">{row.profitCenter || '—'}</td>
                <td className="font-mono issue-history-small issue-history-num">{row.baseAmount != null ? formatCurrency(row.baseAmount) : '—'}</td>
                <td className="font-mono issue-history-small issue-history-num">{formatCurrency(Math.abs(Number(row.tdsAmount) || 0))}</td>
                <td className="font-mono issue-history-small">{formatRate(row.appliedRate)} → {formatRate(row.expectedRate)}</td>
                <td className="font-mono issue-history-small issue-history-num">{formatCurrency(row.taxImpact)}</td>
                <td>
                  <span className={`issue-history-pill issue-history-pill--${row.severity === 'high' ? 'open' : 'partial'}`} title={row.description || undefined}>
                    {row.category}
                  </span>
                </td>
                <td className="issue-history-small">{formatDate(row.firstSeenAt)}</td>
                {isResolved ? (
                  <>
                    <td>
                      <span className="issue-history-pill" title={row.resolutionNote || undefined}>
                        {RESOLUTION_LABELS[row.resolutionType] || row.resolutionType || '—'}
                      </span>
                    </td>
                    <td><CorrectionDocs docs={row.correctionDocs} /></td>
                    <td className="issue-history-small">{formatDate(row.resolvedAt)}</td>
                  </>
                ) : null}
                <td>
                  <button className="issue-history-review-btn" type="button" onClick={() => setReviewRow(row)}>Review</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !error && result.items.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-title">{isResolved ? 'No resolved issues yet' : 'No open issues'}</div>
            <div className="empty-state-desc">
              {search ? 'Nothing matches this search.' : 'Issues appear here after a file is analysed; later runs resolve them.'}
            </div>
          </div>
        )}
        {error && <div className="empty-state"><div className="empty-state-desc">{error}</div></div>}
      </div>

      <div className="issue-history-pager">
        <span>{loading ? 'Loading…' : `${(result.total || 0).toLocaleString()} issue${result.total === 1 ? '' : 's'}`}</span>
        <div>
          <button className="table-page-btn" type="button" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft size={13} />
          </button>
          <span style={{ margin: '0 8px' }}>Page {page} of {totalPages}</span>
          <button className="table-page-btn" type="button" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight size={13} />
          </button>
        </div>
      </div>

      <IssueDrawer
        open={Boolean(reviewRow)}
        onClose={() => setReviewRow(null)}
        issue={reviewRow ? {
          ...reviewRow,
          id: `${reviewRow.docNo}${reviewRow.lineItem ? ` · Line ${reviewRow.lineItem}` : ''}`,
          plainEnglish: reviewRow.description,
          severity: reviewRow.severity || 'medium',
        } : null}
        resolvedNote={reviewRow?.status === 'resolved' ? reviewRow.resolutionNote : null}
      >
        {reviewRow && <TrackingPanel row={reviewRow} />}
      </IssueDrawer>
    </div>
    </>
  )
}
