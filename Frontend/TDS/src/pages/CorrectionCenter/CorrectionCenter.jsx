import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import toast from 'react-hot-toast'
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ClipboardList, Download, RotateCcw, ThumbsDown, ThumbsUp, X,
} from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import SearchInput from '@/components/Common/SearchInput'
import StatusBadge from '@/components/Common/StatusBadge'
import IssueHistory from './IssueHistory'
import correctionsService from '@/services/correctionsService'
import { loadCorrectionRegister } from '@/redux/correctionRegister'
import { correctionGroupUpdated, selectCorrectionGroups } from '@/redux/slices/issuesSlice'
import { stripLeadingZeros } from '@/utils/correctionMatching'
import {
  CORRECTION_METHOD_LABELS, CORRECTION_ROLE_LABELS, CORRECTION_STATUS_LABELS, RECONCILE_TOLERANCE, correctionStatusTone,
} from '@/utils/correctionLabels'
import { downloadCsv } from '@/utils/csvExport'
import { formatCurrency, formatDate } from '@/utils/utils'
import '@/components/Common/Common.css'
import './CorrectionCenter.css'

const STATUS_FILTERS = [
  ['active', 'Active (awaiting + approved)'],
  ['all', 'All statuses'],
  ['matched_in_sap', 'Awaiting approval'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['undone', 'Undone'],
]
const RECONCILE_FILTERS = [
  ['all', 'All amounts'],
  ['reconciled', 'Fully reconciled'],
  ['difference', 'Has difference'],
]
const EMPTY_FILTERS = { search: '', method: 'all', status: 'active', section: 'all', reconcile: 'all', from: '', to: '' }

const isActive = (group) => group.status === 'matched_in_sap' || group.status === 'approved'
const hasDifference = (group) => Math.abs(Number(group.unreconciledAmount) || 0) > RECONCILE_TOLERANCE

function rateLabel(value) {
  return value == null || value === '' ? '—' : `${value}%`
}

function signedCurrency(value) {
  const number = Number(value) || 0
  if (number === 0) return formatCurrency(0)
  return `${number < 0 ? '−' : '+'}${formatCurrency(Math.abs(number))}`
}

function docLine(parts) {
  return [parts.companyCode, parts.fiscalYear, parts.lineItem ? `Line ${parts.lineItem}` : null].filter(Boolean).join(' · ')
}

/** Group ID, doc numbers (leading zeros ignored), vendor name or vendor no. contain the search text. */
function matchesSearch(group, term) {
  if (!term) return true
  const docTerm = stripLeadingZeros(term)
  const docs = [group.groupId, group.originalDocumentNumber, ...(group.entries || []).map((entry) => entry.docNo)]
  return docs.some((doc) => doc && stripLeadingZeros(String(doc).toLowerCase()).includes(docTerm))
    || [group.vendor, group.vendorId].some((field) => field && String(field).toLowerCase().includes(term))
}

function matchesFilters(group, filters, term) {
  if (filters.method !== 'all' && group.method !== filters.method) return false
  if (filters.status === 'active' ? !isActive(group) : filters.status !== 'all' && group.status !== filters.status) return false
  if (filters.section !== 'all' && group.section !== filters.section) return false
  if (filters.reconcile === 'reconciled' && hasDifference(group)) return false
  if (filters.reconcile === 'difference' && !hasDifference(group)) return false
  const created = String(group.createdAt || '').slice(0, 10)
  if (filters.from && (!created || created < filters.from)) return false
  if (filters.to && (!created || created > filters.to)) return false
  return matchesSearch(group, term)
}

function RateAmountCell({ rate, amount, tone = 'neutral' }) {
  return (
    <div className={`manual-rate-amount manual-rate-amount--${tone}`}>
      <span className="font-mono">{rateLabel(rate)}</span>
      <strong className="font-mono">{formatCurrency(amount)}</strong>
    </div>
  )
}

function UnreconciledCell({ group }) {
  if (!hasDifference(group)) {
    return <span className="manual-reconciled"><CheckCircle2 size={13} />Reconciled</span>
  }
  const value = Number(group.unreconciledAmount)
  return (
    <span className="manual-unreconciled" title={value > 0 ? 'TDS still short of the expected amount' : 'More TDS than expected'}>
      <AlertTriangle size={13} />{value > 0 ? 'Short ' : 'Excess '}{formatCurrency(Math.abs(value))}
    </span>
  )
}

/** Reason box for undo / approve / reject; the backend enforces the same rules. */
function ActionDialog({ action, group, busy, onCancel, onConfirm }) {
  const [note, setNote] = useState('')
  if (!action) return null
  const needsReason = action !== 'approve'
  const copy = {
    undo: { title: 'Undo this match', button: 'Undo match', hint: 'The issue opens again in TDS Analysis and the issue history. The group stays in the register as Undone.' },
    approve: { title: 'Approve this correction', button: 'Approve', hint: 'Confirms the matched SAP rows correct the issue.' },
    reject: { title: 'Reject this correction', button: 'Reject', hint: 'The issue opens again. The group stays in the register as Rejected.' },
  }[action]
  return (
    <div className="cc-dialog-overlay" onClick={busy ? undefined : onCancel}>
      <div className="cc-dialog" role="dialog" aria-modal="true" aria-label={copy.title} onClick={(event) => event.stopPropagation()}>
        <div className="cc-dialog-head">
          <div>
            <div className="cc-dialog-kicker font-mono">{group.groupId} · Doc {group.originalDocumentNumber}</div>
            <h2>{copy.title}</h2>
          </div>
          <button className="cc-dialog-close" type="button" onClick={onCancel} disabled={busy} aria-label="Close"><X size={16} /></button>
        </div>
        <p className="cc-dialog-hint">{copy.hint}</p>
        <label className="cc-dialog-field">
          <span>{needsReason ? 'Reason (required)' : 'Note (optional)'}</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} autoFocus
            placeholder={action === 'undo' ? 'e.g. Matched the wrong SAP rows' : action === 'reject' ? 'e.g. Rows belong to another invoice' : ''} />
        </label>
        <div className="cc-dialog-actions">
          <button className="btn btn-outline" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={`btn ${action === 'approve' ? 'btn-primary' : 'btn-danger'}`} type="button"
            disabled={busy || (needsReason && !note.trim())} onClick={() => onConfirm(note.trim())}>
            {busy ? 'Saving…' : copy.button}
          </button>
        </div>
      </div>
    </div>
  )
}

function GroupDetail({ group, onAction }) {
  return (
    <div className="manual-correction-detail">
      <table className="audit-subtable">
        <thead>
          <tr>
            <th>Role</th>
            <th>SAP Doc</th>
            <th>Doc Type</th>
            <th>Posting Date</th>
            <th>Base Amount (₹)</th>
            <th>Rate</th>
            <th>TDS on SAP Row (₹)</th>
            <th>Effect on TDS (₹)</th>
          </tr>
        </thead>
        <tbody>
          {(group.entries || []).map((entry) => (
            <tr className={`audit-subtable-row audit-subtable-row--${entry.role === 'REVERSAL' ? 'reversal' : 'correction'}`} key={entry.id ?? `${entry.docNo}-${entry.role}`}>
              <td><span className="audit-entry-type"><CheckCircle2 size={12} />{CORRECTION_ROLE_LABELS[entry.role] || entry.role}</span></td>
              <td>
                <div className="font-mono">{entry.docNo}</div>
                {docLine(entry) && <div className="manual-doc-sub font-mono">{docLine(entry)}</div>}
              </td>
              <td className="font-mono">{entry.docType || '—'}</td>
              <td>{formatDate(entry.postingDate)}</td>
              <td className="font-mono">{entry.baseAmount != null ? formatCurrency(entry.baseAmount) : '—'}</td>
              <td className="font-mono">{rateLabel(entry.appliedRate)}</td>
              <td className="font-mono">{formatCurrency(entry.tdsAmount)}</td>
              <td className="font-mono"><strong>{signedCurrency(entry.amount)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={`manual-reconcile-strip ${hasDifference(group) ? 'manual-reconcile-strip--diff' : ''}`}>
        <div><span>TDS applied</span><strong className="font-mono">{formatCurrency(group.appliedTdsAmount)}</strong></div>
        <div><span>SAP corrections</span><strong className="font-mono">{signedCurrency(group.netAmount)}</strong></div>
        <div><span>TDS after correction</span><strong className="font-mono">{formatCurrency(group.correctedTdsAmount)}</strong></div>
        <div><span>Expected TDS</span><strong className="font-mono">{formatCurrency(group.expectedTdsAmount)}</strong></div>
        <div><span>Difference</span><strong className="font-mono"><UnreconciledCell group={group} /></strong></div>
      </div>

      <div className="manual-correction-remarks">
        <div>
          <strong>Matched</strong> by {group.createdBy?.name || 'Unknown user'} on {formatDate(group.createdAt)}
          {group.remarks ? ` · ${group.remarks}` : ''}
        </div>
        {group.statusChangedBy && (
          <div>
            <strong>{CORRECTION_STATUS_LABELS[group.status] || group.status}</strong> by {group.statusChangedBy.name} on {formatDate(group.statusChangedAt)}
            {group.statusNote ? ` · ${group.statusNote}` : ''}
          </div>
        )}
        {!group.statusChangedBy && group.statusNote && <div>{group.statusNote}</div>}
      </div>

      {(group.canUndo || group.canReview) && (
        <div className="manual-correction-actions">
          {group.canReview && (
            <>
              <button className="btn btn-primary btn-sm" type="button" onClick={() => onAction('approve', group)}><ThumbsUp size={13} />Approve</button>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => onAction('reject', group)}><ThumbsDown size={13} />Reject</button>
            </>
          )}
          {group.canUndo && (
            <button className="btn btn-outline btn-sm" type="button" onClick={() => onAction('undo', group)}><RotateCcw size={13} />Undo match</button>
          )}
        </div>
      )}
    </div>
  )
}

const EXPORT_COLUMNS = [
  { label: 'Group ID', value: (r) => r.group.groupId },
  { label: 'Status', value: (r) => CORRECTION_STATUS_LABELS[r.group.status] || r.group.status },
  { label: 'Method', value: (r) => CORRECTION_METHOD_LABELS[r.group.method] || r.group.method },
  { label: 'Company Code', value: (r) => r.group.companyCode || '' },
  { label: 'Fiscal Year', value: (r) => r.group.fiscalYear || '' },
  { label: 'Original Doc', value: (r) => r.group.originalDocumentNumber },
  { label: 'Original Line', value: (r) => r.group.originalLineItem || '' },
  { label: 'Vendor', value: (r) => r.group.vendor },
  { label: 'Vendor No.', value: (r) => r.group.vendorId || '' },
  { label: 'Section', value: (r) => r.group.section || '' },
  { label: 'Applied Rate %', value: (r) => r.group.appliedRate ?? '' },
  { label: 'TDS Applied', value: (r) => r.group.appliedTdsAmount },
  { label: 'Expected Rate %', value: (r) => r.group.expectedRate ?? '' },
  { label: 'Expected TDS', value: (r) => r.group.expectedTdsAmount },
  { label: 'SAP Correction (Net)', value: (r) => r.group.netAmount },
  { label: 'TDS After Correction', value: (r) => r.group.correctedTdsAmount },
  { label: 'Unreconciled Difference', value: (r) => r.group.unreconciledAmount },
  { label: 'Row Role', value: (r) => CORRECTION_ROLE_LABELS[r.entry?.role] || r.entry?.role || '' },
  { label: 'SAP Doc', value: (r) => r.entry?.docNo || '' },
  { label: 'SAP Doc Type', value: (r) => r.entry?.docType || '' },
  { label: 'SAP Posting Date', value: (r) => r.entry?.postingDate || '' },
  { label: 'TDS on SAP Row', value: (r) => r.entry?.tdsAmount ?? '' },
  { label: 'Effect on TDS', value: (r) => r.entry?.amount ?? '' },
  { label: 'Matched By', value: (r) => r.group.createdBy?.name || '' },
  { label: 'Matched On', value: (r) => String(r.group.createdAt || '').slice(0, 10) },
  { label: 'Remarks', value: (r) => r.group.remarks || '' },
  { label: 'Status Changed By', value: (r) => r.group.statusChangedBy?.name || '' },
  { label: 'Status Changed On', value: (r) => String(r.group.statusChangedAt || '').slice(0, 10) },
  { label: 'Status Note', value: (r) => r.group.statusNote || '' },
]

export default function CorrectionCenter() {
  const dispatch = useDispatch()
  const groups = useSelector(selectCorrectionGroups)
  const [expandedId, setExpandedId] = useState(null)
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [loadError, setLoadError] = useState('')
  const [dialog, setDialog] = useState(null)
  const [busy, setBusy] = useState(false)
  const [historyKey, setHistoryKey] = useState(0)

  const reload = useCallback(() => {
    setLoadError('')
    return loadCorrectionRegister(dispatch, { background: true })
      .catch((error) => setLoadError(error.message || 'Could not load the correction register'))
  }, [dispatch])

  // Fresh copy on every visit: other users may have matched, undone or approved since.
  useEffect(() => { reload() }, [reload])

  const setFilter = (key) => (value) => setFilters((prev) => ({ ...prev, [key]: value }))
  const term = filters.search.trim().toLowerCase()
  const sections = useMemo(() => [...new Set(groups.map((group) => group.section).filter(Boolean))].sort(), [groups])
  const rows = useMemo(
    () => groups.filter((group) => matchesFilters(group, filters, term)),
    [groups, filters, term],
  )
  const totals = useMemo(() => rows.reduce((sum, group) => ({
    net: sum.net + (Number(group.netAmount) || 0),
    short: sum.short + (isActive(group) ? Math.max(0, Number(group.unreconciledAmount) || 0) : 0),
    awaiting: sum.awaiting + (group.status === 'matched_in_sap' ? 1 : 0),
  }), { net: 0, short: 0, awaiting: 0 }), [rows])
  const filtersChanged = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS)

  function exportRows() {
    if (!rows.length) {
      toast('No corrections to export')
      return
    }
    // One line per SAP row, so the file shows exactly which entries make up each group.
    const lines = rows.flatMap((group) => (group.entries?.length ? group.entries : [null]).map((entry) => ({ group, entry })))
    downloadCsv(`correction-register-${new Date().toISOString().slice(0, 10)}.csv`, EXPORT_COLUMNS, lines)
  }

  async function confirmAction(note) {
    if (!dialog) return
    setBusy(true)
    try {
      const call = { undo: correctionsService.undo, approve: correctionsService.approve, reject: correctionsService.reject }[dialog.action]
      const updated = await call(dialog.group.id, note)
      dispatch(correctionGroupUpdated(updated))
      setHistoryKey((key) => key + 1)
      const done = { undo: 'Match undone', approve: 'Correction approved', reject: 'Correction rejected' }[dialog.action]
      toast.success(updated.issueReopened ? `${done} · issue reopened` : done)
      setDialog(null)
    } catch (error) {
      toast.error(error.message || 'Could not update the correction')
    } finally {
      setBusy(false)
    }
  }

  const columns = [
    { key: 'groupId', header: 'Group ID', render: (r) => (
      <div className="manual-group-id">
        {expandedId === r.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="font-mono">{r.groupId}</span>
      </div>
    )},
    { key: 'vendor', header: 'Vendor', render: (r) => (
      <div>
        <div className="manual-cell-main">{r.vendor}</div>
        <div className="manual-doc-sub font-mono">{r.vendorId || '—'}</div>
      </div>
    )},
    { key: 'originalDocumentNumber', header: 'Original Doc', render: (r) => (
      <div>
        <div className="font-mono manual-cell-doc">{r.originalDocumentNumber}</div>
        {docLine({ companyCode: r.companyCode, fiscalYear: r.fiscalYear, lineItem: r.originalLineItem }) && (
          <div className="manual-doc-sub font-mono">{docLine({ companyCode: r.companyCode, fiscalYear: r.fiscalYear, lineItem: r.originalLineItem })}</div>
        )}
      </div>
    )},
    { key: 'method', header: 'Method', render: (r) => <span className="manual-method-pill">{CORRECTION_METHOD_LABELS[r.method] || r.method}</span> },
    { key: 'section', header: 'Section', render: (r) => <span className="font-mono manual-cell-doc">{r.section || '—'}</span> },
    { key: 'appliedTdsAmount', header: 'Applied', render: (r) => <RateAmountCell rate={r.appliedRate} amount={r.appliedTdsAmount} tone="danger" /> },
    { key: 'expectedTdsAmount', header: 'Expected', render: (r) => <RateAmountCell rate={r.expectedRate} amount={r.expectedTdsAmount} tone="success" /> },
    { key: 'netAmount', header: 'SAP Correction', render: (r) => <span className="font-mono manual-net-amount">{signedCurrency(r.netAmount)}</span> },
    { key: 'unreconciledAmount', header: 'Unreconciled', render: (r) => <UnreconciledCell group={r} /> },
    { key: 'createdAt', header: 'Matched', render: (r) => (
      <div>
        <div className="manual-cell-user">{r.createdBy?.name || 'Unknown user'}</div>
        <div className="manual-doc-sub">{formatDate(r.createdAt)}</div>
      </div>
    )},
    { key: 'status', header: 'Status', render: (r) => (
      <StatusBadge label={CORRECTION_STATUS_LABELS[r.status] || r.status} tone={correctionStatusTone(r.status)} />
    )},
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
          <button className="btn btn-outline" type="button" onClick={exportRows} title="Download the rows shown below as CSV">
            <Download size={14} />Export
          </button>
        </div>
      </div>

      <div className="table-card correction-register-card">
        <div className="table-card-header">
          <div>
            <div className="table-card-title"><ClipboardList size={15} />Manual Correction Register</div>
            <div className="table-card-sub">
              SAP rows matched to issues from TDS Analysis · shared by all users
              {' · '}
              <strong>{rows.length}</strong>{rows.length !== groups.length ? ` of ${groups.length}` : ''} group{groups.length === 1 ? '' : 's'}
              {' · '}SAP correction: <strong className="manual-net-amount">{signedCurrency(totals.net)}</strong>
              {totals.short > 0 && <>{' · '}Still short: <strong className="manual-short-amount">{formatCurrency(totals.short)}</strong></>}
              {totals.awaiting > 0 && <>{' · '}<strong>{totals.awaiting}</strong> awaiting approval</>}
            </div>
          </div>
        </div>

        <div className="correction-register-toolbar">
          <SearchInput
            wrapperClassName="search-input--fill"
            value={filters.search}
            onChange={setFilter('search')}
            placeholder="Search document no. / vendor name / vendor no."
            aria-label="Search manual corrections by document number or vendor"
          />
          <select className="filter-select" value={filters.status} onChange={(e) => setFilter('status')(e.target.value)} aria-label="Status">
            {STATUS_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select className="filter-select" value={filters.method} onChange={(e) => setFilter('method')(e.target.value)} aria-label="Method">
            <option value="all">All methods</option>
            {Object.entries(CORRECTION_METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select className="filter-select" value={filters.section} onChange={(e) => setFilter('section')(e.target.value)} aria-label="Section">
            <option value="all">All sections</option>
            {sections.map((section) => <option key={section} value={section}>{section}</option>)}
          </select>
          <select className="filter-select" value={filters.reconcile} onChange={(e) => setFilter('reconcile')(e.target.value)} aria-label="Reconciliation">
            {RECONCILE_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <label className="correction-date-filter">
            <span>Matched from</span>
            <input type="date" className="filter-input" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter('from')(e.target.value)} />
          </label>
          <label className="correction-date-filter">
            <span>to</span>
            <input type="date" className="filter-input" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to')(e.target.value)} />
          </label>
          {filtersChanged && (
            <button className="btn btn-outline btn-sm" type="button" onClick={() => setFilters(EMPTY_FILTERS)}>Reset filters</button>
          )}
        </div>

        {loadError && (
          <div className="correction-load-error">
            {loadError} <button className="btn btn-outline btn-sm" type="button" onClick={reload}>Retry</button>
          </div>
        )}

        <DataTable
          columns={columns}
          data={rows}
          onRowClick={(row) => setExpandedId((id) => (id === row.id ? null : row.id))}
          pageSize={12}
          expandedRowKey={expandedId}
          renderExpandedRow={(row) => <GroupDetail group={row} onAction={(action, group) => setDialog({ action, group })} />}
          emptyState={groups.length > 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">No matching corrections</div>
              <div className="empty-state-desc">No correction group matches these filters. Reset the filters to see all groups.</div>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-state-title">No manual corrections saved</div>
              <div className="empty-state-desc">In TDS Analysis, review an issue and click Match SAP Rows. Saved groups appear here.</div>
            </div>
          )}
        />
      </div>

      <IssueHistory mode="resolved" refreshKey={historyKey} />

      {dialog && (
        <ActionDialog action={dialog.action} group={dialog.group} busy={busy}
          onCancel={() => !busy && setDialog(null)} onConfirm={confirmAction} />
      )}
    </div>
  )
}
