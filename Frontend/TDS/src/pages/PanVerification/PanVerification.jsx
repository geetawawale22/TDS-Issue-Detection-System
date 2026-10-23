import { useEffect, useMemo, useState } from 'react'
import { shallowEqual, useSelector } from 'react-redux'
import toast from 'react-hot-toast'
import {
  AlertTriangle, IdCard, RefreshCw, Search, ShieldCheck, ShieldX, HelpCircle,
} from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge from '@/components/Common/StatusBadge'
import { useAuth } from '@/context/AuthContext'
import { selectActiveValidationRows } from '@/redux/slices/issuesSlice'
import {
  fetchPanStatuses, fetchPanVerificationConfig, overridePanStatus, verifyPans,
} from '@/services/panService'
import { formatCurrency, formatDate } from '@/utils/utils'
import '@/components/Common/Common.css'
import './PanVerification.css'

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/

const STATUS_META = {
  VERIFIED:       { label: 'Verified',       tone: 'success' },
  INVALID:        { label: 'Invalid PAN',    tone: 'danger' },
  INOPERATIVE:    { label: 'Inoperative',    tone: 'danger' },
  INVALID_FORMAT: { label: 'Invalid Format', tone: 'danger' },
  MISSING:        { label: 'PAN Missing',    tone: 'danger' },
  NOT_VERIFIED:   { label: 'Not Verified',   tone: 'neutral' },
  ERROR:          { label: 'Check Failed',   tone: 'warning' },
  NOT_CHECKED:    { label: 'Not Checked',    tone: 'neutral' },
}

// Statuses where Section 206AA applies — same as the backend rule engine.
const FAILING_STATUSES = new Set(['INVALID', 'INOPERATIVE', 'INVALID_FORMAT', 'MISSING'])

const QUICK_FILTERS = {
  all:        { label: 'All PANs',             match: () => true },
  verified:   { label: 'Verified',             match: (s) => s === 'VERIFIED' },
  invalid:    { label: 'Invalid / Inoperative', match: (s) => s === 'INVALID' || s === 'INOPERATIVE' },
  missing:    { label: 'Missing / Bad Format', match: (s) => s === 'MISSING' || s === 'INVALID_FORMAT' },
  unverified: { label: 'Not Verified Yet',     match: (s) => s === 'NOT_VERIFIED' || s === 'NOT_CHECKED' || s === 'ERROR' },
}

function cleanPan(value) {
  const pan = String(value || '').trim().toUpperCase()
  return pan === '—' ? '' : pan
}

// One row per vendor PAN in the uploaded data. Rows without a PAN are kept
// per vendor code, since 206AA applies to them as well.
function buildPanRows(validationRows) {
  const byKey = new Map()
  validationRows.forEach((row) => {
    const pan = cleanPan(row.vendorPan)
    const key = pan || `missing:${row.vendorId || row.vendor}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        id: key, pan, vendors: new Set(), vendorCodes: new Set(), sections: new Set(),
        transactions: 0, baseAmount: 0, tdsAmount: 0,
      }
      byKey.set(key, entry)
    }
    if (row.vendor) entry.vendors.add(row.vendor)
    if (row.vendorId && row.vendorId !== '—') entry.vendorCodes.add(row.vendorId)
    if (row.section && row.section !== '—') entry.sections.add(String(row.section).toUpperCase())
    entry.transactions += 1
    entry.baseAmount += Number(row.baseAmount) || 0
    entry.tdsAmount += Number(row.tdsAmount) || 0
  })
  return [...byKey.values()].map((entry) => ({
    ...entry,
    vendor: [...entry.vendors][0] || 'Unknown vendor',
    vendors: [...entry.vendors],
    vendorCodes: [...entry.vendorCodes],
    sections: [...entry.sections],
  }))
}

function rowStatus(row, statusByPan) {
  if (!row.pan) return 'MISSING'
  if (!PAN_RE.test(row.pan)) return 'INVALID_FORMAT'
  return statusByPan[row.pan]?.status || 'NOT_CHECKED'
}

// Section 206AA rate: 20%, except 5% for 194Q (matches the rule engine).
function rate206AA(sections) {
  const has194Q = sections.some((section) => section.startsWith('194Q'))
  const hasOther = sections.some((section) => !section.startsWith('194Q'))
  if (has194Q && !hasOther) return '5% (194Q)'
  if (has194Q) return '20% (5% for 194Q)'
  return '20%'
}

export default function PanVerification() {
  // The selector builds a new array each call; shallowEqual keeps the same
  // reference while the rows are unchanged, so the memos below stay stable.
  const validationRows = useSelector(selectActiveValidationRows, shallowEqual)
  const hasUpload = useSelector((state) => Boolean(state.issues.uploadMeta))
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [apiConfigured, setApiConfigured] = useState(null)
  const [statusByPan, setStatusByPan] = useState({})
  const [quickFilter, setQuickFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [isVerifyingAll, setIsVerifyingAll] = useState(false)
  const [busyPan, setBusyPan] = useState(null)

  const panRows = useMemo(() => buildPanRows(validationRows), [validationRows])
  const checkablePans = useMemo(
    () => panRows.map((row) => row.pan).filter((pan) => PAN_RE.test(pan)),
    [panRows],
  )

  function mergeResults(results = []) {
    setStatusByPan((prev) => {
      const next = { ...prev }
      results.forEach((result) => { next[result.pan] = result })
      return next
    })
  }

  useEffect(() => {
    fetchPanVerificationConfig()
      .then((config) => setApiConfigured(Boolean(config.apiConfigured)))
      .catch(() => setApiConfigured(false))
  }, [])

  // Keyed on the PAN list's contents so saved results load once per data set.
  const pansKey = checkablePans.join(',')
  useEffect(() => {
    if (!pansKey) return
    fetchPanStatuses(pansKey.split(','))
      .then((data) => mergeResults(data.results))
      .catch((error) => toast.error(error.message || 'Could not load saved PAN results.'))
  }, [pansKey])

  const rowsWithStatus = useMemo(
    () => panRows.map((row) => ({ ...row, status: rowStatus(row, statusByPan) })),
    [panRows, statusByPan],
  )

  const counts = useMemo(() => {
    const result = {}
    Object.entries(QUICK_FILTERS).forEach(([key, filter]) => {
      result[key] = rowsWithStatus.filter((row) => filter.match(row.status)).length
    })
    return result
  }, [rowsWithStatus])

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase()
    return rowsWithStatus
      .filter((row) => QUICK_FILTERS[quickFilter].match(row.status))
      .filter((row) => !term || [row.pan, ...row.vendors, ...row.vendorCodes]
        .some((value) => String(value).toLowerCase().includes(term)))
      // Rows needing attention first.
      .sort((a, b) => Number(FAILING_STATUSES.has(b.status)) - Number(FAILING_STATUSES.has(a.status)))
  }, [rowsWithStatus, quickFilter, search])

  function reportVerifyResult(data) {
    mergeResults(data.results)
    const failing = (data.results || []).filter((r) => r.status === 'INVALID' || r.status === 'INOPERATIVE').length
    if (!data.apiConfigured) {
      toast(`Format checked for ${data.checked} PAN(s). Government API is not connected yet.`, { icon: 'ℹ️' })
    } else if (data.failed) {
      toast.error(`${data.failed} PAN check(s) failed. Try again later.`)
    } else {
      toast.success(`Checked ${data.checked} PAN(s).`)
    }
    if (failing) {
      toast(`${failing} invalid/inoperative PAN(s). Click Analyse on TDS Analysis to apply 206AA.`, { icon: '⚠️', duration: 6000 })
    }
  }

  async function handleVerifyAll() {
    if (!checkablePans.length) return
    setIsVerifyingAll(true)
    try {
      reportVerifyResult(await verifyPans(checkablePans))
    } catch (error) {
      toast.error(error.message || 'PAN verification failed.')
    } finally {
      setIsVerifyingAll(false)
    }
  }

  async function handleVerifyOne(pan) {
    setBusyPan(pan)
    try {
      reportVerifyResult(await verifyPans([pan], { force: true }))
    } catch (error) {
      toast.error(error.message || 'PAN verification failed.')
    } finally {
      setBusyPan(null)
    }
  }

  async function handleOverride(pan, status) {
    setBusyPan(pan)
    try {
      mergeResults([await overridePanStatus(pan, status)])
      toast.success(`${pan} marked ${STATUS_META[status].label.toLowerCase()}. Click Analyse on TDS Analysis to apply it.`)
    } catch (error) {
      toast.error(error.message || 'Could not update the PAN status.')
    } finally {
      setBusyPan(null)
    }
  }

  const columns = [
    { header: '#', render: (_r, i) => <span className="font-mono pan-muted">{i + 1}</span> },
    { key: 'vendor', header: 'Vendor', render: (row) => (
      <div>
        <div className="pan-strong">{row.vendor}</div>
        <div className="font-mono pan-muted">{row.vendorCodes.join(', ') || '—'}</div>
      </div>
    )},
    { key: 'pan', header: 'PAN', render: (row) => (
      <span className={`font-mono ${FAILING_STATUSES.has(row.status) ? 'pan-value--failing' : ''}`}>{row.pan || '—'}</span>
    )},
    { key: 'status', header: 'Status', render: (row) => {
      const meta = STATUS_META[row.status]
      const record = statusByPan[row.pan]
      return (
        <div>
          <StatusBadge label={meta.label} tone={meta.tone} />
          {record?.source === 'manual' && <div className="pan-muted">Marked manually</div>}
        </div>
      )
    }},
    { key: 'sections', header: 'Section', render: (row) => (
      <span className="font-mono pan-muted">{row.sections.join(', ') || '—'}</span>
    )},
    { key: 'transactions', header: 'Txns', render: (row) => <span className="font-mono">{row.transactions.toLocaleString()}</span> },
    { key: 'baseAmount', header: 'Base Amt', render: (row) => <span className="font-mono">{formatCurrency(row.baseAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS (₹)', render: (row) => <span className="font-mono">{formatCurrency(row.tdsAmount)}</span> },
    { key: 'rate', header: '206AA Rate', render: (row) => (
      FAILING_STATUSES.has(row.status)
        ? <span className="pan-rate--failing">{rate206AA(row.sections)}</span>
        : <span className="pan-muted">—</span>
    )},
    { key: 'checkedAt', header: 'Last Checked', render: (row) => {
      const checkedAt = statusByPan[row.pan]?.checkedAt
      return <span className="pan-muted">{checkedAt ? formatDate(checkedAt) : '—'}</span>
    }},
    { header: 'Action', render: (row) => {
      if (!PAN_RE.test(row.pan)) return <span className="pan-muted">Fix PAN in vendor master</span>
      const busy = busyPan === row.pan
      return (
        <div className="pan-actions">
          <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => handleVerifyOne(row.pan)}>
            {row.status === 'NOT_CHECKED' ? 'Verify' : 'Re-check'}
          </button>
          {isAdmin && row.status !== 'INVALID' && (
            <button type="button" className="pan-link pan-link--danger" disabled={busy} onClick={() => handleOverride(row.pan, 'INVALID')}>
              Mark invalid
            </button>
          )}
          {isAdmin && row.status !== 'VERIFIED' && (
            <button type="button" className="pan-link" disabled={busy} onClick={() => handleOverride(row.pan, 'VERIFIED')}>
              Mark verified
            </button>
          )}
        </div>
      )
    }},
  ]

  const cards = [
    { key: 'all',        icon: IdCard,        tone: 'default', sub: 'Unique vendor PANs in scope' },
    { key: 'verified',   icon: ShieldCheck,   tone: 'success', sub: 'Valid and operative' },
    { key: 'invalid',    icon: ShieldX,       tone: 'danger',  sub: 'Per Government PAN check' },
    { key: 'missing',    icon: AlertTriangle, tone: 'danger',  sub: 'No PAN or wrong structure' },
    { key: 'unverified', icon: HelpCircle,    tone: 'warning', sub: 'Awaiting Government check' },
  ]

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">PAN Verification</span>
          </div>
          <h1 className="page-title">PAN Verification</h1>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={isVerifyingAll || !checkablePans.length}
          onClick={handleVerifyAll}
        >
          <RefreshCw size={14} className={isVerifyingAll ? 'pan-spin' : ''} />
          {isVerifyingAll ? 'Verifying…' : 'Verify All PANs'}
        </button>
      </div>

      {apiConfigured === false && (
        <div className="pan-banner">
          <AlertTriangle size={16} />
          <div>
            <strong>Government PAN API not connected yet.</strong>{' '}
            PANs are only checked for the AAAAA9999A format, so none are marked invalid
            automatically. Add the API URL and key in <code>backend/.env</code>
            {' '}(<code>PAN_VERIFICATION_API_URL</code>, <code>PAN_VERIFICATION_API_KEY</code>) to enable it.
          </div>
        </div>
      )}

      <div className="pan-summary-grid">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            className={`kpi-card pan-kpi-button ${quickFilter === card.key ? 'is-active' : ''}`}
            onClick={() => setQuickFilter(card.key)}
          >
            <div className="kpi-icon-row">
              <span className="kpi-label">{QUICK_FILTERS[card.key].label}</span>
              <div className={`kpi-icon-box ${card.tone}`}><card.icon size={14} /></div>
            </div>
            <span className="kpi-value">{counts[card.key].toLocaleString()}</span>
            <span className="pan-muted">{card.sub}</span>
          </button>
        ))}
      </div>

      <div className="table-card">
        <div className="table-card-header">
          <div>
            <div className="table-card-title">Vendor PANs</div>
            <div className="pan-muted">
              {QUICK_FILTERS[quickFilter].label} · {filteredRows.length.toLocaleString()} shown ·
              {' '}Invalid, inoperative and missing PANs need TDS at the Section 206AA rate.
              {' '}Changes apply to issues the next time you click Analyse.
            </div>
          </div>
          <div className="pan-search-wrapper">
            <Search size={14} />
            <input
              className="filter-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search PAN, vendor, code..."
            />
          </div>
        </div>
        <DataTable
          columns={columns}
          data={filteredRows}
          pageSize={100}
          stateKey="pan-verification"
          rowClassName={(row) => (FAILING_STATUSES.has(row.status) ? 'pan-row--failing' : undefined)}
          emptyState={
            <div className="data-table-empty">
              {hasUpload
                ? 'No PANs match this view for the selected Company/FY'
                : 'Upload and analyse an SAP file on TDS Analysis to list vendor PANs'}
            </div>
          }
        />
      </div>
    </div>
  )
}
