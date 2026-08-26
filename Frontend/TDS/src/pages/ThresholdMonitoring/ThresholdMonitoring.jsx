import { useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { AlertOctagon, Gauge, ShieldCheck, Download, BadgePercent } from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge, { thresholdStatusToTone } from '@/components/Common/StatusBadge'
import ProgressBar from '@/components/Common/ProgressBar'
import ThresholdConsumptionChart from '@/components/Charts/ThresholdConsumptionChart'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import {
  selectThresholdVendors,
  selectThresholdSectionBreakdown,
  selectIsLive,
  selectLdcUtilization,
} from '@/redux/slices/issuesSlice'
import { formatCurrency, formatStatusLabel } from '@/utils/utils'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import '@/components/Common/Common.css'
import './ThresholdMonitoring.css'

export default function ThresholdMonitoring() {
  const [search, setSearch] = useState('')
  const [activeTracker, setActiveTracker] = useState('vendor')
  const vendors = useSelector(selectThresholdVendors)
  const thresholdSectionBreakdown = useSelector(selectThresholdSectionBreakdown)
  const ldcUtilization = useSelector(selectLdcUtilization)
  const isLive = useSelector(selectIsLive)

  const exceeded = vendors.filter((v) => v.status === 'exceeded')
  const near      = vendors.filter((v) => v.status === 'near')
  const safe      = vendors.filter((v) => v.status === 'safe')
  const panIssues = vendors.filter((v) => v.status === 'pan_issue')

  const filtered = useMemo(
    () => vendors.filter((v) => v.name.toLowerCase().includes(search.toLowerCase())),
    [search, vendors],
  )
  const filteredLdc = useMemo(
    () => ldcUtilization.filter((r) =>
      (r.vendor || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.pan || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.certificateNumber || '').toLowerCase().includes(search.toLowerCase())
    ),
    [ldcUtilization, search],
  )

  const ldcWarning = ldcUtilization.filter((r) => ['warning', 'high_warning'].includes(r.status))
  const ldcCritical = ldcUtilization.filter((r) => ['exhausted', 'over_utilized'].includes(r.status))

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
    { key: 'status',        header: 'Status',    render: (r) => (
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
    { key: 'status', header: 'Status', render: (r) => <StatusBadge label={r.statusLabel || 'Within LDC Limit'} tone={ldcStatusTone(r.status)} /> },
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
            <span className="kpi-value">{ldcUtilization.length}</span>
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
            <span className="kpi-value">{formatCurrency(ldcUtilization.reduce((sum, row) => sum + (Number(row.used) || 0), 0))}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Eligible base under LDC</span>
          </div>
        </div>
      )}

      <div className="chart-grid-2col">
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Threshold Consumption Trend</p>
              <p className="chart-subtitle">
                {isLive ? 'From SAP upload posting months' : 'Average across vendors, last 6 months'}
              </p>
            </div>
          </div>
          <ThresholdConsumptionChart />
        </div>
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Section Analysis</p>
              <p className="chart-subtitle">Vendor status distribution per section</p>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={thresholdSectionBreakdown} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
              <XAxis dataKey="section" tick={{ fontSize: 11, fill: '#64748B', fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: '#E5E7EB' }} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }} cursor={{ fill: '#F8FAFC' }} />
              <Bar dataKey="safe"     stackId="a" fill="#10B981" maxBarSize={28} name="Safe" />
              <Bar dataKey="unclassified" stackId="a" fill="#94A3B8" maxBarSize={28} name="Unclassified" />
              <Bar dataKey="near"     stackId="a" fill="#F59E0B" maxBarSize={28} name="Near" />
              <Bar dataKey="pan_issue" stackId="a" fill="#DC2626" maxBarSize={28} name="PAN Issue" />
              <Bar dataKey="exceeded" stackId="a" fill="#EF4444" radius={[4,4,0,0]} maxBarSize={28} name="Exceeded" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="table-card">
        <div className="table-card-header">
          <div>
            <div className="threshold-tabs" role="tablist" aria-label="Threshold trackers">
              <button
                type="button"
                role="tab"
                aria-selected={activeTracker === 'vendor'}
                className={`threshold-tab ${activeTracker === 'vendor' ? 'active' : ''}`}
                onClick={() => setActiveTracker('vendor')}
              >
                Vendor Threshold Tracker
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTracker === 'ldc'}
                className={`threshold-tab ${activeTracker === 'ldc' ? 'active' : ''}`}
                onClick={() => setActiveTracker('ldc')}
              >
                LDC Certificate Limit Tracker
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
        {activeTracker === 'vendor' ? (
          <DataTable columns={columns} data={filtered} pageSize={8} />
        ) : (
          <DataTable
            columns={ldcColumns}
            data={filteredLdc}
            pageSize={8}
            emptyState={<div className="data-table-empty">No LDC utilization found in the latest SAP upload</div>}
          />
        )}
      </div>
    </div>
  )
}
