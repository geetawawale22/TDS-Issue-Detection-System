import { useMemo, useState } from 'react'
import { AlertOctagon, Gauge, ShieldCheck, Download } from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge, { thresholdStatusToTone } from '@/components/Common/StatusBadge'
import ProgressBar from '@/components/Common/ProgressBar'
import ThresholdConsumptionChart from '@/components/Charts/ThresholdConsumptionChart'
import { vendors, thresholdSectionBreakdown } from '@/data/mockData'
import { formatCurrency, formatStatusLabel } from '@/utils/utils'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import '@/components/Common/Common.css'
import './ThresholdMonitoring.css'

export default function ThresholdMonitoring() {
  const [search, setSearch] = useState('')

  const exceeded = vendors.filter((v) => v.status === 'exceeded')
  const near      = vendors.filter((v) => v.status === 'near')
  const safe      = vendors.filter((v) => v.status === 'safe')

  const filtered = useMemo(
    () => vendors.filter((v) => v.name.toLowerCase().includes(search.toLowerCase())),
    [search]
  )

  const summaryCards = [
    { label: 'Exceeded',   value: exceeded.length, icon: AlertOctagon, tone: 'danger',  sub: 'Requires immediate review' },
    { label: 'Near Limit', value: near.length,      icon: Gauge,        tone: 'warning', sub: 'Within 75–100% of limit' },
    { label: 'Safe',       value: safe.length,      icon: ShieldCheck,  tone: 'success', sub: 'Comfortably under threshold' },
  ]

  const columns = [
    { key: 'name', header: 'Vendor', render: (r) => (
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.name}</div>
        <div className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.pan}</div>
      </div>
    )},
    { key: 'section',       header: 'Section',   render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.section}</span> },
    { key: 'threshold',     header: 'Threshold', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.threshold)}</span> },
    { key: 'currentAmount', header: 'Current',   render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.currentAmount)}</span> },
    { key: 'status',        header: 'Status',    render: (r) => <StatusBadge label={formatStatusLabel(r.status)} tone={thresholdStatusToTone(r.status)} /> },
    { key: 'progress',      header: 'Progress',  render: (r) => (
      <div style={{ width: 130 }}><ProgressBar value={r.progress} showLabel /></div>
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
        <button className="btn btn-outline"><Download size={14} />Export</button>
      </div>

      <div className="summary-grid-3">
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

      <div className="chart-grid-2col">
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Threshold Consumption Trend</p>
              <p className="chart-subtitle">Average across vendors, last 6 months</p>
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
              <Bar dataKey="near"     stackId="a" fill="#F59E0B" maxBarSize={28} name="Near" />
              <Bar dataKey="exceeded" stackId="a" fill="#EF4444" radius={[4,4,0,0]} maxBarSize={28} name="Exceeded" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="table-card">
        <div className="table-card-header">
          <div>
            <div className="table-card-title">Vendor Threshold Tracker</div>
          </div>
          <input
            className="filter-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vendors…"
            style={{ width: 180 }}
          />
        </div>
        <DataTable columns={columns} data={filtered} pageSize={8} />
      </div>
    </div>
  )
}
