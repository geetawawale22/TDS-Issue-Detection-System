import { useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { AlertOctagon, Gauge, ShieldCheck, Download, BadgePercent } from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge, { thresholdStatusToTone } from '@/components/Common/StatusBadge'
import ProgressBar from '@/components/Common/ProgressBar'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import {
  selectThresholdVendors,
  selectIsLive,
  selectLdcUtilization,
} from '@/redux/slices/issuesSlice'
import { fetchLdcCertificates } from '@/services/ldcService'
import { formatCurrency, formatDate, formatStatusLabel } from '@/utils/utils'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import '@/components/Common/Common.css'
import './ThresholdMonitoring.css'

const roundToTwo = (value) => Math.round(Number(value || 0) * 100) / 100
const ldcLimitStatus = (utilization) => {
  if (utilization == null) return ['safe', 'Within LDC Limit']
  if (utilization > 100) return ['over_utilized', 'LDC Over-utilized']
  if (utilization >= 100) return ['exhausted', 'LDC Limit Exhausted']
  if (utilization >= 90) return ['high_warning', 'LDC Limit 90% Utilized']
  if (utilization >= 80) return ['warning', 'LDC Limit 80% Utilized']
  return ['safe', 'Within LDC Limit']
}
const hasPositiveLimit = (row) => Number(row?.approvedLimit) > 0
const preferCertificateRow = (current, candidate) => {
  if (!current) return candidate
  if (hasPositiveLimit(candidate) && !hasPositiveLimit(current)) return candidate
  return current
}
const CRORE = 10000000
const toCrore = (value) => roundToTwo(Number(value || 0) / CRORE)
const TOP_LIMIT_BARS = 8
const TOP_TREND_LINES = 4
const TREND_COLORS = ['#E01330', '#2563EB', '#10B981', '#F59E0B', '#64748B']
const TODAY = new Date()
TODAY.setHours(0, 0, 0, 0)

function parseDateValue(value) {
  if (!value) return null
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  date.setHours(0, 0, 0, 0)
  return date
}

function certificateValidity(validFromValue, validToValue) {
  const validFrom = parseDateValue(validFromValue)
  const validTo = parseDateValue(validToValue)
  if (!validFrom || !validTo) return ['neutral', 'Validity Unknown']
  if (TODAY < validFrom) return ['warning', 'Future']
  if (TODAY > validTo) return ['danger', 'Expired']
  return ['success', 'Active']
}

export default function ThresholdMonitoring() {
  const [search, setSearch] = useState('')
  const [activeTracker, setActiveTracker] = useState('ldc')
  const [ldcCertificates, setLdcCertificates] = useState([])
  const vendors = useSelector(selectThresholdVendors)
  const ldcUtilization = useSelector(selectLdcUtilization)
  const isLive = useSelector(selectIsLive)

  useEffect(() => {
    let isMounted = true
    fetchLdcCertificates()
      .then((result) => {
        if (isMounted) setLdcCertificates(result.certificates ?? [])
      })
      .catch(() => {
        if (isMounted) setLdcCertificates([])
      })
    return () => {
      isMounted = false
    }
  }, [])

  const ldcCertificateByKey = useMemo(() => {
    const byKey = new Map()
    const byCertificate = new Map()
    ldcCertificates.forEach((row) => {
      const cert = String(row.certificateNumber || '').trim()
      const pan = String(row.pan || '').trim().toUpperCase()
      if (!cert) return
      byCertificate.set(cert, preferCertificateRow(byCertificate.get(cert), row))
      if (pan) {
        const key = `${cert}||${pan}`
        byKey.set(key, preferCertificateRow(byKey.get(key), row))
      }
    })
    return { byKey, byCertificate }
  }, [ldcCertificates])

  const currentLdcUtilization = useMemo(() => {
    if (!ldcCertificateByKey.byCertificate.size) return ldcUtilization
    return ldcUtilization
      .map((row) => {
        const cert = String(row.certificateNumber || '').trim()
        const pan = String(row.pan || '').trim().toUpperCase()
        const masterRow = ldcCertificateByKey.byKey.get(`${cert}||${pan}`) || ldcCertificateByKey.byCertificate.get(cert)
        if (!masterRow) return null

        const limit = masterRow.approvedLimit ?? row.limit
        const used = Number(row.used || 0)
        const numericLimit = Number(limit)
        const hasLimit = Number.isFinite(numericLimit) && numericLimit > 0
        const available = hasLimit ? numericLimit - used : null
        const utilization = hasLimit ? roundToTwo((used / numericLimit) * 100) : null
        const [status, statusLabel] = ldcLimitStatus(utilization)
        const validFrom = masterRow.validFrom ?? row.validFrom ?? null
        const validTo = masterRow.validTo ?? row.validTo ?? null
        const [validityTone, validityLabel] = certificateValidity(validFrom, validTo)

        return {
          ...row,
          vendor: masterRow.vendorName || row.vendor,
          vendorId: masterRow.vendorCode || row.vendorId,
          pan: masterRow.pan || row.pan,
          section: masterRow.section || row.section,
          approvedRate: masterRow.approvedRate ?? row.approvedRate,
          limit: hasLimit ? numericLimit : limit,
          available,
          utilization,
          status,
          statusLabel,
          validFrom,
          validTo,
          validityTone,
          validityLabel,
        }
      })
      .filter(Boolean)
  }, [ldcCertificateByKey, ldcUtilization])

  const exceeded = vendors.filter((v) => v.status === 'exceeded')
  const near      = vendors.filter((v) => v.status === 'near')
  const safe      = vendors.filter((v) => v.status === 'safe')
  const panIssues = vendors.filter((v) => v.status === 'pan_issue')

  const filtered = useMemo(
    () => vendors.filter((v) => v.name.toLowerCase().includes(search.toLowerCase())),
    [search, vendors],
  )
  const filteredLdc = useMemo(
    () => currentLdcUtilization.filter((r) =>
      (r.vendor || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.pan || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.certificateNumber || '').toLowerCase().includes(search.toLowerCase())
    ),
    [currentLdcUtilization, search],
  )

  const ldcWarning = currentLdcUtilization.filter((r) => ['warning', 'high_warning'].includes(r.status))
  const ldcCritical = currentLdcUtilization.filter((r) => ['exhausted', 'over_utilized'].includes(r.status))

  const ldcLimitVsUsedData = useMemo(() => {
    const rows = [...currentLdcUtilization]
      .sort((a, b) => Number(b.used || 0) - Number(a.used || 0))
    const visible = rows.slice(0, TOP_LIMIT_BARS)
    const rest = rows.slice(TOP_LIMIT_BARS)
    const data = visible.map((row) => ({
      certificate: row.certificateNumber || '—',
      vendor: row.vendor || row.pan || '—',
      limit: toCrore(row.limit),
      used: toCrore(row.used),
      available: row.available == null ? null : toCrore(row.available),
    }))
    if (rest.length) {
      data.push({
        certificate: `Other (${rest.length})`,
        vendor: 'Remaining certificates',
        limit: toCrore(rest.reduce((sum, row) => sum + (Number(row.limit) || 0), 0)),
        used: toCrore(rest.reduce((sum, row) => sum + (Number(row.used) || 0), 0)),
        available: toCrore(rest.reduce((sum, row) => sum + (Number(row.available) || 0), 0)),
      })
    }
    return data
  }, [currentLdcUtilization])

  const ldcTrendSeries = useMemo(() => {
    const rowsWithMonthlyUsage = currentLdcUtilization.filter((row) => Array.isArray(row.monthlyUsage) && row.monthlyUsage.length)
    if (!rowsWithMonthlyUsage.length) return { data: [], keys: [] }

    const topRows = [...rowsWithMonthlyUsage]
      .sort((a, b) => Number(b.used || 0) - Number(a.used || 0))
      .slice(0, TOP_TREND_LINES)
    const topCertificates = new Set(topRows.map((row) => row.certificateNumber))
    const months = new Map()

    for (const row of rowsWithMonthlyUsage) {
      const key = topCertificates.has(row.certificateNumber) ? row.certificateNumber : 'Other'
      for (const item of row.monthlyUsage) {
        if (!months.has(item.monthKey)) {
          months.set(item.monthKey, { monthKey: item.monthKey, month: item.month })
        }
        const monthRow = months.get(item.monthKey)
        monthRow[key] = (monthRow[key] || 0) + Number(item.used || 0)
      }
    }

    const sortedMonths = [...months.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey))
    const keys = [...topRows.map((row) => row.certificateNumber)]
    if (rowsWithMonthlyUsage.length > topRows.length) keys.push('Other')

    const cumulative = Object.fromEntries(keys.map((key) => [key, 0]))
    const data = sortedMonths.map((row) => {
      const next = { month: row.month, monthKey: row.monthKey }
      for (const key of keys) {
        cumulative[key] += Number(row[key] || 0)
        next[key] = toCrore(cumulative[key])
      }
      return next
    })

    return { data, keys }
  }, [currentLdcUtilization])

  const summaryCards = [
    { label: 'Exceeded',   value: exceeded.length, icon: AlertOctagon, tone: 'danger',  sub: 'Requires immediate review' },
    { label: 'PAN Issues', value: panIssues.length, icon: AlertOctagon, tone: 'danger', sub: 'PAN missing or invalid' },
    { label: 'Near Limit', value: near.length,      icon: Gauge,        tone: 'warning', sub: 'Within 75–100% of limit' },
    { label: 'Safe',       value: safe.length,      icon: ShieldCheck,  tone: 'success', sub: 'Comfortably under threshold' },
  ]

  const columns = [
    { key: 'pan', header: 'PAN / Vendor Codes', render: (r) => (
      <div>
        <div className="font-mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{r.pan}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {(r.vendorCodes || []).length ? r.vendorCodes.join(', ') : r.name}
        </div>
      </div>
    )},
    { key: 'section',       header: 'Section',   render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.section}</span> },
    { key: 'threshold',     header: 'Threshold', render: (r) => (
      <span className="font-mono" style={{ fontSize: 11.5 }}>
        {r.threshold == null ? 'Not determined' : formatCurrency(r.threshold)}
      </span>
    )},
    { key: 'currentAmount', header: 'Current',   render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.currentAmount)}</span> },
    { key: 'status',        header: 'Status',    sortValue: (r) => (
      r.status === 'pan_issue' ? 'PAN Issue' : formatStatusLabel(r.status)
    ), render: (r) => (
      <StatusBadge label={r.status === 'pan_issue' ? 'PAN Issue' : formatStatusLabel(r.status)} tone={thresholdStatusToTone(r.status)} />
    )},
    { key: 'progress',      header: 'Progress',  render: (r) => (
      r.threshold == null
        ? <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>—</span>
        : <div style={{ width: 130 }}><ProgressBar value={r.progress} showLabel /></div>
    )},
  ]

  const ldcStatusTone = (status) => {
    if (status === 'over_utilized' || status === 'exhausted') return 'danger'
    if (status === 'high_warning' || status === 'warning') return 'warning'
    return 'success'
  }

  const ldcColumns = [
    { key: 'certificateNumber', header: 'Certificate', render: (r) => (
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{r.certificateNumber}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.section} · {r.approvedRate ?? '—'}%</div>
      </div>
    )},
    { key: 'vendor', header: 'Vendor / PAN', render: (r) => (
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.vendor}</div>
        <div className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.pan}</div>
      </div>
    )},
    { key: 'limit', header: 'LDC Limit', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.limit == null ? 'Not set' : formatCurrency(r.limit)}</span> },
    { key: 'used', header: 'Utilized', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.used || 0)}</span> },
    { key: 'available', header: 'Available', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.available == null ? '—' : formatCurrency(r.available)}</span> },
    { key: 'validity', header: 'Validity', sortValue: (r) => `${r.validTo || ''}`, render: (r) => (
      <div>
        <div className="font-mono" style={{ fontSize: 11.5 }}>{formatDate(r.validFrom)} - {formatDate(r.validTo)}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Certificate period</div>
      </div>
    )},
    { key: 'validityStatus', header: 'Cert Status', sortValue: (r) => r.validityLabel || 'Validity Unknown', render: (r) => (
      <StatusBadge label={r.validityLabel || 'Validity Unknown'} tone={r.validityTone || 'neutral'} />
    )},
    { key: 'status', header: 'Utilization Status', sortValue: (r) => r.statusLabel || 'Within LDC Limit', render: (r) => <StatusBadge label={r.statusLabel || 'Within LDC Limit'} tone={ldcStatusTone(r.status)} /> },
    { key: 'utilization', header: 'Progress', render: (r) => (
      r.utilization == null
        ? <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>—</span>
        : <div style={{ width: 130 }}><ProgressBar value={Math.min(r.utilization, 100)} showLabel /></div>
    )},
  ]

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">Threshold Monitoring</span>
          </div>
          <h1 className="page-title">Threshold Monitoring</h1>
        </div>
        <div className="issues-header-actions">
          <LiveDataBadge />
          <button className="btn btn-outline" type="button"><Download size={14} />Export</button>
        </div>
      </div>

      {isLive && (
        <p className="sap-hint" style={{ border: '1px solid var(--color-border)', borderRadius: 8, marginBottom: 10, background: 'var(--color-surface)' }}>
          Vendor thresholds are derived from your latest SAP upload (issue amounts by vendor + section).
        </p>
      )}

      <div className="summary-grid-4">
        {summaryCards.map((c) => (
          <div key={c.label} className="kpi-card">
            <div className="kpi-icon-row">
              <span className="kpi-label">{c.label}</span>
              <div className={`kpi-icon-box ${c.tone}`}><c.icon size={14} /></div>
            </div>
            <span className="kpi-value">{c.value}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{c.sub}</span>
          </div>
        ))}
      </div>

      {isLive && (
        <div className="summary-grid-4" style={{ marginTop: 12 }}>
          <div className="kpi-card">
            <div className="kpi-icon-row"><span className="kpi-label">LDC Certificates Used</span><div className="kpi-icon-box info"><BadgePercent size={14} /></div></div>
            <span className="kpi-value">{currentLdcUtilization.length}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>From latest SAP upload</span>
          </div>
          <div className="kpi-card">
            <div className="kpi-icon-row"><span className="kpi-label">LDC Warnings</span><div className="kpi-icon-box warning"><Gauge size={14} /></div></div>
            <span className="kpi-value">{ldcWarning.length}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>80% or 90% utilized</span>
          </div>
          <div className="kpi-card">
            <div className="kpi-icon-row"><span className="kpi-label">LDC Critical</span><div className="kpi-icon-box danger"><AlertOctagon size={14} /></div></div>
            <span className="kpi-value">{ldcCritical.length}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Exhausted or over-utilized</span>
          </div>
          <div className="kpi-card">
            <div className="kpi-icon-row"><span className="kpi-label">LDC Utilized Base</span><div className="kpi-icon-box success"><ShieldCheck size={14} /></div></div>
            <span className="kpi-value">{formatCurrency(currentLdcUtilization.reduce((sum, row) => sum + (Number(row.used) || 0), 0))}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Eligible base under LDC</span>
          </div>
        </div>
      )}

      <div className="chart-grid-2col">
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">LDC Limit vs Used Amount</p>
              <p className="chart-subtitle">Top certificates by utilized base, values in ₹ crore</p>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={ldcLimitVsUsedData} margin={{ top: 2, right: 4, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
              <XAxis dataKey="certificate" tick={{ fontSize: 10, fill: '#64748B', fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: '#E5E7EB' }} tickLine={false} interval={0} />
              <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }}
                formatter={(value, name) => [`₹${Number(value || 0).toLocaleString('en-IN')} Cr`, name]}
                labelFormatter={(label, rows) => {
                  const row = rows?.[0]?.payload
                  return row?.vendor ? `${label} · ${row.vendor}` : label
                }}
                cursor={{ fill: '#F8FAFC' }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="limit" fill="#CBD5E1" radius={[4, 4, 0, 0]} maxBarSize={24} name="Limit" />
              <Bar dataKey="used" fill="#E01330" radius={[4, 4, 0, 0]} maxBarSize={24} name="Used" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">LDC Utilization Trend Over Time</p>
              <p className="chart-subtitle">Cumulative used base by posting month, top certificates + other</p>
            </div>
          </div>
          {ldcTrendSeries.data.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={ldcTrendSeries.data} margin={{ top: 2, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} axisLine={{ stroke: '#E5E7EB' }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }}
                  formatter={(value, name) => [`₹${Number(value || 0).toLocaleString('en-IN')} Cr`, name]}
                  cursor={{ stroke: '#E5E7EB' }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {ldcTrendSeries.keys.map((key, index) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stroke={TREND_COLORS[index % TREND_COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                    name={key}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="data-table-empty" style={{ height: 220 }}>
              Re-analyse the SAP file to build month-wise LDC utilization from posting dates.
            </div>
          )}
        </div>
      </div>

      <div className="table-card">
        <div className="table-card-header">
          <div>
            <div className="threshold-tabs" role="tablist" aria-label="Threshold trackers">
              <button
                type="button"
                role="tab"
                aria-selected={activeTracker === 'ldc'}
                className={`threshold-tab ${activeTracker === 'ldc' ? 'active' : ''}`}
                onClick={() => setActiveTracker('ldc')}
              >
                LDC Certificate Limit Tracker
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTracker === 'vendor'}
                className={`threshold-tab ${activeTracker === 'vendor' ? 'active' : ''}`}
                onClick={() => setActiveTracker('vendor')}
              >
                Vendor Threshold Tracker
              </button>
            </div>
          </div>
          <input
            className="filter-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={activeTracker === 'ldc' ? 'Search LDC, PAN, vendor…' : 'Search vendors…'}
            style={{ width: 180 }}
          />
        </div>
        {activeTracker === 'ldc' ? (
          <DataTable
            columns={ldcColumns}
            data={filteredLdc}
            pageSize={8}
            emptyState={<div className="data-table-empty">No LDC utilization found in the latest SAP upload</div>}
          />
        ) : (
          <DataTable columns={columns} data={filtered} pageSize={8} />
        )}
      </div>
    </div>
  )
}
