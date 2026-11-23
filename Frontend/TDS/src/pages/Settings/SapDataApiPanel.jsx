import { useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { Database, Download, Play } from 'lucide-react'
import StatusBadge from '@/components/Common/StatusBadge'
import { fetchSapDataConfig, querySapTable } from '@/services/sapDataService'
import { downloadCsv } from '@/utils/csvExport'
import './SapDataApiPanel.css'

// Rows rendered in the preview table; downloads include every fetched row.
const PREVIEW_ROWS = 200

// The two SAP views Mahindra provides: the exemption (LDC) master, read once
// for LDC Master / PAN checks, and the vendor line items the TDS analysis runs on.
function presets(companyCode) {
  const company = companyCode ? `Company_Code = '${companyCode}'` : ''
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0)
  const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return [
    { label: 'Exemption / LDC master', table: 'ZAPI_TDS_EXEMPTION', otherConditions: company },
    {
      label: 'Vendor items · last month',
      table: 'ZAPI_TDS_VENDOR_ITEMS',
      otherConditions: [`Posting_Date BETWEEN '${iso(monthStart)}' AND '${iso(monthEnd)}'`, company].filter(Boolean).join(' AND '),
    },
  ]
}

function isFilled(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function displayValue(value) {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** Every field seen across the rows, in first-seen order, with how often it is filled. */
function describeFields(rows) {
  const fields = new Map()
  rows.forEach((row) => {
    Object.entries(row).forEach(([name, value]) => {
      if (!fields.has(name)) fields.set(name, { name, filled: 0, samples: new Set(), types: new Set() })
      const field = fields.get(name)
      if (!isFilled(value)) return
      field.filled += 1
      field.types.add(Array.isArray(value) ? 'list' : typeof value)
      if (field.samples.size < 3) field.samples.add(displayValue(value))
    })
  })
  return [...fields.values()]
}

/**
 * Settings → SAP Data API: fetch rows from Mahindra's SAP query service to
 * check what it sends (fields, fill rate, sample values) before the data is
 * used anywhere. Excel uploads are unchanged.
 */
export default function SapDataApiPanel() {
  const selectedCompanyCode = useSelector((s) => s.app.selectedCompanyCode)
  const [config, setConfig] = useState(null)
  const [form, setForm] = useState({
    table: 'ZAPI_TDS_EXEMPTION',
    otherConditions: selectedCompanyCode ? `Company_Code = '${selectedCompanyCode}'` : '',
    pageNo: 1,
    pageSize: 100,
  })
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchSapDataConfig().then(setConfig).catch(() => setConfig({ configured: false, url: null }))
  }, [])

  const fields = useMemo(() => describeFields(result?.rows || []), [result])

  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))

  async function runQuery(event) {
    event?.preventDefault()
    setLoading(true)
    setError('')
    try {
      setResult(await querySapTable({
        table: form.table.trim(),
        pageNo: Number(form.pageNo) || 1,
        pageSize: Number(form.pageSize) || 100,
        otherConditions: form.otherConditions.trim(),
      }))
    } catch (err) {
      setResult(null)
      const detail = err.response?.data?.detail
      setError(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((d) => d.msg).join('; ') : err.message || 'The query failed.')
    } finally {
      setLoading(false)
    }
  }

  const fileBase = result ? `${result.table}-page${result.pageNo}` : 'sap-data'
  const downloadRowsCsv = () => downloadCsv(
    `${fileBase}.csv`,
    fields.map((field) => ({ label: field.name, value: (row) => displayValue(row[field.name]) })),
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

  return (
    <div className="sap-api">
      <div className="settings-card sap-api-card">
        <h3 className="settings-card-title">SAP Data API</h3>
        <p className="sap-api-intro">
          Fetch rows straight from Mahindra&apos;s SAP query service to check what it sends.
          Nothing is saved and Excel uploads are unchanged.
        </p>
        <div className="settings-gcp-status">
          <div className="sap-api-status-label">
            <Database size={15} />
            <span className="font-mono">{config?.url || 'No URL set'}</span>
          </div>
          {config && (
            <StatusBadge
              label={config.configured ? 'Configured' : 'Not configured'}
              tone={config.configured ? 'success' : 'warning'}
            />
          )}
        </div>
        {config && !config.configured && (
          <p className="sap-api-hint">
            Set <code>SAP_DATA_API_URL</code> and <code>SAP_DATA_API_TOKEN</code> in <code>backend/.env</code>, then restart the backend.
          </p>
        )}

        <div className="sap-api-presets">
          <span>Quick fill:</span>
          {presets(selectedCompanyCode).map((preset) => (
            <button
              key={preset.table}
              type="button"
              className="btn btn-outline sap-api-preset"
              onClick={() => setForm((current) => ({ ...current, table: preset.table, otherConditions: preset.otherConditions, pageNo: 1 }))}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <form className="sap-api-form" onSubmit={runQuery}>
          <label className="sap-api-field sap-api-field--wide">
            <span>Table / view</span>
            <input className="settings-input font-mono" value={form.table} onChange={update('table')} required />
          </label>
          <label className="sap-api-field sap-api-field--wide">
            <span>Conditions (otherConditions)</span>
            <input className="settings-input font-mono" value={form.otherConditions} onChange={update('otherConditions')} placeholder="Company_Code = '1001'" />
          </label>
          <label className="sap-api-field">
            <span>Page no.</span>
            <input className="settings-input" type="number" min="1" value={form.pageNo} onChange={update('pageNo')} />
          </label>
          <label className="sap-api-field">
            <span>Page size</span>
            <input className="settings-input" type="number" min="1" max="5000" value={form.pageSize} onChange={update('pageSize')} />
          </label>
          <button className="btn btn-primary sap-api-run" type="submit" disabled={loading || !config?.configured}>
            <Play size={14} />
            {loading ? 'Fetching…' : 'Fetch'}
          </button>
        </form>

        {error && <div className="sap-api-error" role="alert">{error}</div>}
      </div>

      {result && (
        <>
          <div className="settings-card sap-api-card">
            <div className="sap-api-result-head">
              <div>
                <h3 className="settings-card-title">{result.rowCount.toLocaleString('en-IN')} rows · {fields.length} fields</h3>
                <p className="sap-api-intro">
                  {result.table} · page {result.pageNo} (size {result.pageSize}) · {(result.elapsedMs / 1000).toFixed(2)} s
                  {result.rowCount === result.pageSize ? ' · page is full, there may be more pages' : ''}
                </p>
              </div>
              <div className="sap-api-actions">
                <button className="btn btn-outline" type="button" onClick={downloadRowsCsv} disabled={!result.rowCount}><Download size={14} />CSV</button>
                <button className="btn btn-outline" type="button" onClick={downloadRowsJson} disabled={!result.rowCount}><Download size={14} />JSON</button>
              </div>
            </div>
            {Object.keys(result.meta || {}).length > 0 && (
              <pre className="sap-api-meta">{JSON.stringify(result.meta, null, 2)}</pre>
            )}
            {fields.length > 0 && (
              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr><th>Field</th><th>Filled</th><th>Type</th><th>Sample values</th></tr>
                  </thead>
                  <tbody>
                    {fields.map((field) => (
                      <tr key={field.name}>
                        <td className="font-mono">{field.name}</td>
                        <td>{field.filled} / {result.rowCount}</td>
                        <td>{[...field.types].join(', ') || '—'}</td>
                        <td className="font-mono sap-api-samples">{[...field.samples].join(' · ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {result.rowCount > 0 && (
            <div className="settings-card sap-api-card">
              <h3 className="settings-card-title">
                Rows{result.rowCount > PREVIEW_ROWS ? ` (first ${PREVIEW_ROWS} of ${result.rowCount.toLocaleString('en-IN')}; downloads include all)` : ''}
              </h3>
              <div className="data-table-wrapper sap-api-rows">
                <table className="data-table">
                  <thead>
                    <tr><th>#</th>{fields.map((field) => <th key={field.name}>{field.name}</th>)}</tr>
                  </thead>
                  <tbody>
                    {result.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                      <tr key={index}>
                        <td>{index + 1}</td>
                        {fields.map((field) => <td key={field.name} className="font-mono">{displayValue(row[field.name])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
