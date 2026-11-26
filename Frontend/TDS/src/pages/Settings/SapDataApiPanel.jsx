import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Code2, Download, Eye,
  FileText, Loader2, Plus, RotateCcw, ShieldCheck, Square, Table2, X, Zap,
} from 'lucide-react'
import { fetchSapDataConfig, getLatestSapAnalysisJob, importLdcFromSap, querySapTable } from '@/services/sapDataService'
import {
  ACTIVE_STATUSES, startSapAnalysis, stopSapAnalysis, subscribeSapAnalysisJob,
} from '@/utils/sapAnalysisJob'
import { invalidateLdcPageCache } from '@/pages/LDCCompliance/LDCCompliance'
import { downloadCsv } from '@/utils/csvExport'
import './SapDataApiPanel.css'

const OTHER_TABLE = '__other__'
const PAGE_SIZES = [100, 500, 1000, 5000]

// The SAP views Mahindra provides. Each filter lists candidate column names:
// the first one present in data already fetched from that view is used, else
// the first in the list.
const TABLES = {
  ZAPI_TDS_VENDOR_ITEMS: {
    label: 'Vendor line items',
    hint: 'Runs the TDS analysis',
    icon: Zap,
    action: 'analyse',
    date: { label: 'Posting date', columns: ['Posting_Date', 'Document_Date'] },
    lists: [
      { key: 'docNo', label: 'Document no.', columns: ['Document_No', 'Document_Number', 'Accounting_Document_Number'] },
      { key: 'vendor', label: 'Vendor code', columns: ['Vendor_Code', 'Vendor_Number', 'Supplier'] },
      { key: 'gl', label: 'GL account', columns: ['GL', 'GL_Account'] },
    ],
  },
  ZAPI_TDS_EXEMPTION: {
    label: 'Exemption / LDC master',
    hint: 'Updates LDC Master',
    icon: ShieldCheck,
    action: 'ldc',
    date: null,
    lists: [
      { key: 'vendor', label: 'Vendor code', columns: ['Vendor_Code', 'Supplier', 'Vendor_Number'] },
      { key: 'certificate', label: 'Certificate no.', columns: ['Certificate_Number', 'Exemption_Number'] },
    ],
  },
}

const OPERATORS = [
  { value: 'in', label: 'is / any of' },
  { value: 'like', label: 'contains' },
  { value: 'ne', label: 'is not' },
  { value: 'gte', label: '≥ (from)' },
  { value: 'lte', label: '≤ (to)' },
]

const COLUMN_NAME = /^[A-Za-z][A-Za-z0-9_]*$/

function iso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function lastMonth() {
  const now = new Date()
  return { from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) }
}

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`

/** Codes pasted from Excel (one per line), or typed with commas / spaces. */
const splitCodes = (text) => text.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean)
/** Free values may contain spaces (names), so only lines / commas / semicolons separate them. */
const splitValues = (text) => text.split(/[\n,;\t]+/).map((v) => v.trim()).filter(Boolean)

function inClause(column, values) {
  const unique = [...new Set(values)]
  return unique.length === 1 ? `${column} = ${quote(unique[0])}` : `${column} IN (${unique.map(quote).join(', ')})`
}

function pickColumn(candidates, knownFields) {
  return candidates.find((name) => knownFields?.has(name)) || candidates[0]
}

function displayValue(value) {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** Every field seen across the rows, in first-seen order. */
function fieldNames(rows) {
  const names = new Set()
  rows.forEach((row) => Object.keys(row).forEach((name) => names.add(name)))
  return [...names]
}

function totalFromMeta(meta) {
  const key = Object.keys(meta || {}).find((k) => /^(total|totalcount|total_count|totalrecords)$/i.test(k))
  const total = key ? Number(meta[key]) : NaN
  return Number.isFinite(total) ? total : null
}

function elapsedText(seconds) {
  const s = Math.max(0, Math.round(seconds || 0))
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`
}

function errorText(err, fallback) {
  const detail = err.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map((d) => d.msg).join('; ')
  return err.message || fallback
}

function emptyFilters(table) {
  const range = TABLES[table]?.date ? lastMonth() : { from: '', to: '' }
  return { dateFrom: range.from, dateTo: range.to, lists: {}, extra: [], raw: '' }
}

// The form (view, company, filters per view, page size) is kept in this
// browser, so switching Settings tabs, pages or views doesn't wipe it.
const FORM_STORAGE_KEY = 'tds_sap_api_form'

function readSavedForm() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FORM_STORAGE_KEY) || 'null')
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}

/** Saved filters for one view, or null if missing / from an older shape. */
function savedFilters(value) {
  if (!value || typeof value !== 'object') return null
  const text = (v) => (typeof v === 'string' ? v : '')
  const lists = value.lists && typeof value.lists === 'object' ? value.lists : {}
  return {
    dateFrom: text(value.dateFrom),
    dateTo: text(value.dateTo),
    lists: Object.fromEntries(Object.entries(lists).filter(([, v]) => typeof v === 'string')),
    extra: Array.isArray(value.extra)
      ? value.extra
        .filter((row) => row && typeof row === 'object')
        .map((row) => ({ column: text(row.column), op: OPERATORS.some((o) => o.value === row.op) ? row.op : 'in', value: text(row.value) }))
      : [],
    raw: text(value.raw),
  }
}

/** The otherConditions string the API filters on, built from the form. */
function buildConditions({ table, companyCode, filters, knownFields }) {
  const spec = TABLES[table]
  const parts = []
  if (companyCode) parts.push(`Company_Code = ${quote(companyCode)}`)
  if (spec?.date) {
    const column = pickColumn(spec.date.columns, knownFields)
    if (filters.dateFrom && filters.dateTo) parts.push(`${column} BETWEEN ${quote(filters.dateFrom)} AND ${quote(filters.dateTo)}`)
    else if (filters.dateFrom) parts.push(`${column} >= ${quote(filters.dateFrom)}`)
    else if (filters.dateTo) parts.push(`${column} <= ${quote(filters.dateTo)}`)
  }
  spec?.lists.forEach((filter) => {
    const values = splitCodes(filters.lists[filter.key] || '')
    if (values.length) parts.push(inClause(pickColumn(filter.columns, knownFields), values))
  })
  filters.extra.forEach(({ column, op, value }) => {
    const name = column.trim()
    if (!COLUMN_NAME.test(name) || !value.trim()) return
    if (op === 'in') parts.push(inClause(name, splitValues(value)))
    else if (op === 'like') parts.push(`${name} LIKE ${quote(`%${value.trim()}%`)}`)
    else if (op === 'ne') parts.push(`${name} <> ${quote(value.trim())}`)
    else if (op === 'gte') parts.push(`${name} >= ${quote(value.trim())}`)
    else if (op === 'lte') parts.push(`${name} <= ${quote(value.trim())}`)
  })
  if (filters.raw.trim()) parts.push(`(${filters.raw.trim()})`)
  return parts.join(' AND ')
}

/**
 * Settings → SAP Data API: pull rows from Mahindra's SAP query service with
 * filters, preview them, and send them into the TDS analysis (vendor line
 * items) or LDC Master (exemptions) — the same paths as the Excel uploads.
 */
export default function SapDataApiPanel() {
  const dispatch = useDispatch()
  const navigate = useNavigate()
  const { availableCompanyCodes, selectedCompanyCode } = useSelector((s) => s.app)
  const [saved] = useState(readSavedForm)
  const [config, setConfig] = useState(null)
  const [table, setTable] = useState(() => (saved.table === OTHER_TABLE || TABLES[saved.table] ? saved.table : 'ZAPI_TDS_VENDOR_ITEMS'))
  const [customTable, setCustomTable] = useState(() => (typeof saved.customTable === 'string' ? saved.customTable : ''))
  const [companyCode, setCompanyCode] = useState(() => (
    saved.companyCode === '' || availableCompanyCodes.includes(saved.companyCode) ? saved.companyCode : selectedCompanyCode ?? ''
  ))
  // Each view keeps its own filters, so switching views and back restores them.
  const [filtersByTable, setFiltersByTable] = useState(() => Object.fromEntries(
    Object.entries(saved.filtersByTable && typeof saved.filtersByTable === 'object' ? saved.filtersByTable : {})
      .map(([name, value]) => [name, savedFilters(value)])
      .filter(([, value]) => value),
  ))
  const [pageSize, setPageSize] = useState(() => (PAGE_SIZES.includes(saved.pageSize) ? saved.pageSize : 500))
  const [showQuery, setShowQuery] = useState(false)
  // Field names seen in data fetched from each table: drive column suggestions
  // and which candidate column name a filter uses.
  const [fieldsByTable, setFieldsByTable] = useState({})
  const [busy, setBusy] = useState('') // '' | 'preview' | 'process'
  const [result, setResult] = useState(null)
  const [lastQuery, setLastQuery] = useState(null)
  const [processed, setProcessed] = useState(null)
  const [error, setError] = useState('')
  // Background analysis (utils/sapAnalysisJob): followed across pages and refreshes.
  const [job, setJob] = useState(null)
  const jobRunning = Boolean(job && ACTIVE_STATUSES.has(job.status))

  useEffect(() => {
    fetchSapDataConfig().then(setConfig).catch(() => setConfig({ configured: false, url: null }))
  }, [])

  useEffect(() => subscribeSapAnalysisJob(setJob), [])
  // A pull started in another tab or before a backend-side refresh: show it too.
  useEffect(() => {
    getLatestSapAnalysisJob()
      .then((latest) => { if (latest && ACTIVE_STATUSES.has(latest.status)) setJob((now) => now || latest) })
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (job?.status === 'done' && job.summary) {
      setProcessed({ kind: 'analyse', stats: job.summary.stats || {}, serverOnly: !job.hasFullResult, jobId: job.jobId })
    }
  }, [job])

  useEffect(() => {
    try {
      window.localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify({ table, customTable, companyCode, pageSize, filtersByTable }))
    } catch {
      // Storage full or blocked: the form just isn't remembered.
    }
  }, [table, customTable, companyCode, pageSize, filtersByTable])

  const filters = filtersByTable[table] || emptyFilters(table)
  const setFilters = (update) => setFiltersByTable((all) => {
    const current = all[table] || emptyFilters(table)
    return { ...all, [table]: typeof update === 'function' ? update(current) : update }
  })

  const tableName = table === OTHER_TABLE ? customTable.trim() : table
  const spec = TABLES[table]
  const knownFields = fieldsByTable[tableName]
  const conditions = buildConditions({ table, companyCode, filters, knownFields })
  const columns = useMemo(() => fieldNames(result?.rows || []), [result])
  const total = totalFromMeta(result?.meta)
  const ready = Boolean(config?.configured && tableName) && !busy
  const canProcess = ready && !(spec?.action === 'analyse' && jobRunning)

  const setList = (key) => (event) => setFilters((f) => ({ ...f, lists: { ...f.lists, [key]: event.target.value } }))
  const setExtra = (index, key, value) => setFilters((f) => ({
    ...f,
    extra: f.extra.map((row, i) => (i === index ? { ...row, [key]: value } : row)),
  }))

  function changeTable(value) {
    setTable(value)
    setProcessed(null)
    setError('')
  }

  function reset() {
    setFilters(emptyFilters(table))
    setCompanyCode(selectedCompanyCode ?? '')
    setError('')
  }

  async function fetchPage(query) {
    setBusy('preview')
    setError('')
    try {
      const data = await querySapTable(query)
      setResult(data)
      setLastQuery(query)
      const names = fieldNames(data.rows)
      if (names.length) {
        setFieldsByTable((current) => ({ ...current, [query.table]: new Set([...(current[query.table] || []), ...names]) }))
      }
    } catch (err) {
      setResult(null)
      setError(errorText(err, 'The query failed.'))
    } finally {
      setBusy('')
    }
  }

  function preview(event) {
    event?.preventDefault()
    if (!tableName) return
    fetchPage({ table: tableName, pageNo: 1, pageSize, otherConditions: conditions })
  }

  async function process() {
    if (!spec?.action) return
    setBusy('process')
    setError('')
    setProcessed(null)
    const request = { table: tableName, otherConditions: conditions, companyCode }
    try {
      if (spec.action === 'analyse') {
        // Runs in the backend; progress and the result arrive through the job.
        await startSapAnalysis(dispatch, request, `SAP API — ${spec.label}`)
      } else {
        const data = await importLdcFromSap(request)
        invalidateLdcPageCache()
        setProcessed({ kind: 'ldc', stats: data })
        toast.success(`LDC Master updated · ${data.inserted} added · ${data.updated} updated`)
      }
    } catch (err) {
      const message = errorText(err, 'Processing failed.')
      setError(message)
      toast.error(message)
    } finally {
      setBusy('')
    }
  }

  const goToPage = (pageNo) => fetchPage({ ...lastQuery, pageNo })

  const fileBase = result ? `${result.table}-page${result.pageNo}` : 'sap-data'
  const downloadRowsCsv = () => downloadCsv(
    `${fileBase}.csv`,
    columns.map((name) => ({ label: name, value: (row) => displayValue(row[name]) })),
    result.rows,
  )
  const downloadRowsJson = () => {
    const blob = new Blob([JSON.stringify(result.rows, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${fileBase}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const firstRow = result ? (result.pageNo - 1) * result.pageSize + 1 : 0
  const hasNextPage = result && (total !== null ? firstRow - 1 + result.rowCount < total : result.rowCount === result.pageSize)
  const noDateRange = spec?.date && !filters.dateFrom && !filters.dateTo

  return (
    <div className="sap-api">
      <section className="settings-card sap-api-card">
        <header className="sap-api-head">
          <div>
            <h3 className="settings-card-title">SAP Data API</h3>
            <p className="sap-api-sub">Pull data straight from SAP, check it, then send it into TDS Analysis or LDC Master.</p>
          </div>
          {config && (
            <span className={`sap-api-status ${config.configured ? 'is-on' : 'is-off'}`} title={config.url || 'No URL set'}>
              <span className="sap-api-dot" />
              {config.configured ? 'Connected' : 'Not configured'}
            </span>
          )}
        </header>
        {config && !config.configured && (
          <p className="sap-api-hint">
            Set <code>SAP_DATA_API_URL</code> and <code>SAP_DATA_API_TOKEN</code> in <code>backend/.env</code>, then restart the backend.
          </p>
        )}

        <div className="sap-api-sources" role="tablist" aria-label="SAP data">
          {Object.entries(TABLES).map(([name, t]) => {
            const Icon = t.icon
            return (
              <button key={name} type="button" role="tab" aria-selected={table === name}
                className={`sap-api-source${table === name ? ' is-active' : ''}`} onClick={() => changeTable(name)}>
                <Icon size={16} />
                <span>
                  <strong>{t.label}</strong>
                  <small>{t.hint}</small>
                </span>
              </button>
            )
          })}
          <button type="button" role="tab" aria-selected={table === OTHER_TABLE}
            className={`sap-api-source${table === OTHER_TABLE ? ' is-active' : ''}`} onClick={() => changeTable(OTHER_TABLE)}>
            <Table2 size={16} />
            <span>
              <strong>Other view</strong>
              <small>Preview only</small>
            </span>
          </button>
        </div>

        <form onSubmit={preview}>
          <div className="sap-api-filters">
            {table === OTHER_TABLE && (
              <label className="sap-api-field sap-api-span-2">
                <span>Table / view name</span>
                <input className="sap-api-control font-mono" value={customTable} onChange={(e) => setCustomTable(e.target.value)} placeholder="ZAPI_…" required />
              </label>
            )}
            <label className="sap-api-field">
              <span>Company code</span>
              <select className="sap-api-control" value={companyCode} onChange={(e) => setCompanyCode(e.target.value)}>
                <option value="">All company codes</option>
                {availableCompanyCodes.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            </label>
            {spec?.date && (
              <>
                <label className="sap-api-field">
                  <span>{spec.date.label} from</span>
                  <input className="sap-api-control" type="date" value={filters.dateFrom}
                    onChange={(e) => {
                      const value = e.target.value
                      // A from-date past the to-date moves the to-date along (one-day range), instead of blocking it.
                      setFilters((f) => ({ ...f, dateFrom: value, dateTo: value && f.dateTo && value > f.dateTo ? value : f.dateTo }))
                    }} />
                </label>
                <label className="sap-api-field">
                  <span>{spec.date.label} to</span>
                  <input className="sap-api-control" type="date" value={filters.dateTo}
                    onChange={(e) => {
                      const value = e.target.value
                      setFilters((f) => ({ ...f, dateTo: value, dateFrom: value && f.dateFrom && value < f.dateFrom ? value : f.dateFrom }))
                    }} />
                </label>
              </>
            )}
            {spec?.lists.map((filter) => {
              const count = splitCodes(filters.lists[filter.key] || '').length
              return (
                <label key={filter.key} className="sap-api-field">
                  <span>{filter.label}</span>
                  <span className="sap-api-with-badge">
                    <input
                      className="sap-api-control font-mono"
                      value={filters.lists[filter.key] || ''}
                      onChange={setList(filter.key)}
                      placeholder="Any · paste one or many"
                    />
                    {count > 1 && <span className="sap-api-badge">{count}</span>}
                  </span>
                </label>
              )
            })}
          </div>

          {filters.extra.length > 0 && (
            <div className="sap-api-extra">
              <datalist id="sap-api-columns">
                {[...(knownFields || [])].map((name) => <option key={name} value={name} />)}
              </datalist>
              {filters.extra.map((row, index) => (
                <div key={index} className="sap-api-extra-row">
                  <input
                    className={`sap-api-control font-mono${row.column && !COLUMN_NAME.test(row.column.trim()) ? ' is-invalid' : ''}`}
                    list="sap-api-columns"
                    value={row.column}
                    onChange={(e) => setExtra(index, 'column', e.target.value)}
                    placeholder={knownFields ? 'Column' : 'Column (preview once for suggestions)'}
                    aria-label="Column"
                  />
                  <select className="sap-api-control" value={row.op} onChange={(e) => setExtra(index, 'op', e.target.value)} aria-label="Condition">
                    {OPERATORS.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
                  </select>
                  <input
                    className="sap-api-control font-mono"
                    value={row.value}
                    onChange={(e) => setExtra(index, 'value', e.target.value)}
                    placeholder={row.op === 'in' ? 'Value, or several separated by commas' : 'Value'}
                    aria-label="Value"
                  />
                  <button type="button" className="sap-api-icon-btn" aria-label="Remove filter"
                    onClick={() => setFilters((f) => ({ ...f, extra: f.extra.filter((_, i) => i !== index) }))}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="sap-api-links">
            <button type="button" className="sap-api-link"
              onClick={() => setFilters((f) => ({ ...f, extra: [...f.extra, { column: '', op: 'in', value: '' }] }))}>
              <Plus size={13} />Add filter on any column
            </button>
            <button type="button" className="sap-api-link" onClick={() => setShowQuery((v) => !v)}>
              <Code2 size={13} />{showQuery ? 'Hide query' : 'Show query'}
            </button>
            <button type="button" className="sap-api-link" onClick={reset}>
              <RotateCcw size={13} />Reset
            </button>
          </div>

          {showQuery && (
            <div className="sap-api-query">
              <code>{conditions || '(no filter: all rows)'}</code>
              <input className="sap-api-control font-mono" value={filters.raw}
                onChange={(e) => setFilters((f) => ({ ...f, raw: e.target.value }))}
                placeholder="Extra SQL condition (optional), e.g. TDS_Amount > 0" />
            </div>
          )}

          {noDateRange && (
            <p className="sap-api-warning">No posting date range: this reads every row for the selected company code(s) and may be slow.</p>
          )}

          <div className="sap-api-actions-bar">
            <div className="sap-api-preview-group">
              <select className="sap-api-control sap-api-page-size" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} aria-label="Rows per preview page">
                {PAGE_SIZES.map((size) => <option key={size} value={size}>{size.toLocaleString('en-IN')} rows</option>)}
              </select>
              <button className="btn btn-outline sap-api-btn" type="submit" disabled={!ready}>
                {busy === 'preview' ? <Loader2 size={14} className="spin" /> : <Eye size={14} />}
                Preview
              </button>
            </div>
            {spec?.action && (
              <button className="btn btn-primary sap-api-btn" type="button" onClick={process} disabled={!canProcess}>
                {busy === 'process' || (spec.action === 'analyse' && jobRunning) ? <Loader2 size={14} className="spin" /> : spec.action === 'analyse' ? <Zap size={14} /> : <ShieldCheck size={14} />}
                {spec.action === 'analyse'
                  ? (jobRunning ? 'Analysis running…' : busy === 'process' ? 'Starting…' : 'Run TDS analysis')
                  : (busy === 'process' ? 'Saving…' : 'Save to LDC Master')}
              </button>
            )}
          </div>
        </form>

        {error && <div className="sap-api-error" role="alert">{error}</div>}

        {jobRunning && (
          <div className="sap-api-job" role="status" aria-live="polite">
            <Loader2 size={18} className="spin" />
            <div className="sap-api-job-text">
              <strong>{job.stage}</strong>
              <span>
                {Number(job.rowsFetched || 0).toLocaleString('en-IN')} rows fetched
                {job.expectedRows ? ` of ${Number(job.expectedRows).toLocaleString('en-IN')}` : ''}
                {job.batchesTotal > 1 ? ` · batch ${Math.min(job.batchesDone + 1, job.batchesTotal)} of ${job.batchesTotal}` : ''}
                {' · '}{elapsedText(job.elapsedSeconds)}
              </span>
              <small>Runs on the server: you can switch pages or refresh. The result loads when it finishes.</small>
            </div>
            {job.batchesTotal > 1 && (
              <div className="sap-api-job-bar" aria-hidden="true">
                <span style={{ width: `${Math.round((job.batchesDone / job.batchesTotal) * 100)}%` }} />
              </div>
            )}
            <button type="button" className="btn btn-outline sap-api-btn" onClick={() => stopSapAnalysis(job.jobId).catch((err) => toast.error(err.message))}
              disabled={job.stage?.startsWith('Stopping')}>
              <Square size={13} />Stop
            </button>
          </div>
        )}
        {job && (job.status === 'failed' || job.status === 'stopped') && (
          <div className="sap-api-error" role="alert">{job.error || 'The analysis did not finish.'}</div>
        )}

        {processed?.kind === 'analyse' && (
          <div className="sap-api-done">
            <CheckCircle2 size={18} />
            <div>
              <strong>Analysis done · {Number(processed.stats.transactionsBuilt || 0).toLocaleString('en-IN')} transactions</strong>
              <span>
                {Number(processed.stats.issuesFound || 0).toLocaleString('en-IN')} issues · {Number(processed.stats.passedRows || 0).toLocaleString('en-IN')} passed.
                {processed.serverOnly
                  ? ' Saved on the server (too many rows to keep in the browser): Open Issues, Document Ledger, GL Ledger and the Dashboard show it.'
                  : ' All pages now show this data.'}
              </span>
            </div>
            <div className="sap-api-done-links">
              <button type="button" className="btn btn-outline sap-api-btn" onClick={() => navigate('/dashboard')}>Dashboard</button>
              <button type="button" className="btn btn-primary sap-api-btn" onClick={() => navigate('/issues')}>Open TDS Analysis<ArrowRight size={14} /></button>
            </div>
          </div>
        )}
        {processed?.kind === 'ldc' && (
          <div className="sap-api-done">
            <CheckCircle2 size={18} />
            <div>
              <strong>LDC Master updated · {processed.stats.totalRows} rows read</strong>
              <span>{processed.stats.inserted} added · {processed.stats.updated} updated · {processed.stats.issueRows} with issues</span>
            </div>
            <div className="sap-api-done-links">
              <button type="button" className="btn btn-primary sap-api-btn" onClick={() => navigate('/ldc-compliance')}>Open LDC Master<ArrowRight size={14} /></button>
            </div>
          </div>
        )}
      </section>

      {result && (
        <section className="settings-card sap-api-card sap-api-results">
          <div className="sap-api-result-head">
            <span className="sap-api-count">
              <FileText size={14} />
              {result.rowCount
                ? `Rows ${firstRow.toLocaleString('en-IN')}–${(firstRow + result.rowCount - 1).toLocaleString('en-IN')}${total !== null ? ` of ${total.toLocaleString('en-IN')}` : ''}`
                : 'No rows match these filters'}
            </span>
            <div className="sap-api-result-actions">
              <button className="sap-api-icon-btn" type="button" onClick={() => goToPage(result.pageNo - 1)} disabled={!!busy || result.pageNo <= 1} aria-label="Previous page">
                <ChevronLeft size={15} />
              </button>
              <span className="sap-api-page">Page {result.pageNo}</span>
              <button className="sap-api-icon-btn" type="button" onClick={() => goToPage(result.pageNo + 1)} disabled={!!busy || !hasNextPage} aria-label="Next page">
                <ChevronRight size={15} />
              </button>
              <button className="btn btn-outline sap-api-btn" type="button" onClick={downloadRowsCsv} disabled={!result.rowCount}><Download size={14} />CSV</button>
              <button className="btn btn-outline sap-api-btn" type="button" onClick={downloadRowsJson} disabled={!result.rowCount}><Download size={14} />JSON</button>
            </div>
          </div>
          {result.rowCount > 0 && (
            <div className="data-table-wrapper sap-api-rows">
              <table className="data-table">
                <thead>
                  <tr><th>#</th>{columns.map((name) => <th key={name}>{name}</th>)}</tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={index}>
                      <td>{firstRow + index}</td>
                      {columns.map((name) => <td key={name} className="font-mono">{displayValue(row[name])}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
