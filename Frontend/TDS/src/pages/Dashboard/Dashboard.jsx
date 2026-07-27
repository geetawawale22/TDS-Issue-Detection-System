import { useSelector } from 'react-redux'
import {
  Activity, AlertOctagon, AlertTriangle, CheckCircle2,
  Clock, FileSearch, RefreshCw, Database, CalendarDays, ArrowUp, ArrowDown,
} from 'lucide-react'
import IssuesBySectionChart from '@/components/Charts/IssuesBySectionChart'
import ComplianceHealthChart from '@/components/Charts/ComplianceHealthChart'
import MonthlyTrendChart from '@/components/Charts/MonthlyTrendChart'
import TopVendorsChart from '@/components/Charts/TopVendorsChart'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import { selectDashboardKpis, selectIsLive } from '@/redux/slices/issuesSlice'
import '@/components/Common/Common.css'
import './Dashboard.css'

export default function Dashboard() {
  const { financialYear, lastSyncTime, dataSource } = useSelector((s) => s.app)
  const firstName = useSelector((s) => s.auth.user?.name?.split(' ')[0]) ?? 'there'
  const kpisLive = useSelector(selectDashboardKpis)
  const isLive = useSelector(selectIsLive)

  const kpis = [
    {
      label: 'Transactions',
      value: Number(kpisLive.transactions).toLocaleString('en-IN'),
      change: isLive ? null : 4.2,
      up: true,
      icon: Activity,
      tone: 'default',
    },
    {
      label: 'Issues Found',
      value: Number(kpisLive.issuesFound).toLocaleString('en-IN'),
      change: isLive ? null : 2.8,
      up: true,
      icon: FileSearch,
      tone: 'warning',
    },
    {
      label: 'High Severity',
      value: String(kpisLive.high),
      change: isLive ? null : 6.1,
      up: true,
      icon: AlertOctagon,
      tone: 'danger',
    },
    {
      label: 'Medium Severity',
      value: String(kpisLive.medium),
      change: isLive ? null : 1.4,
      up: false,
      icon: AlertTriangle,
      tone: 'warning',
    },
    {
      label: 'Resolved',
      value: Number(kpisLive.resolved).toLocaleString('en-IN'),
      change: isLive ? null : 9.3,
      up: true,
      icon: CheckCircle2,
      tone: 'success',
    },
    {
      label: 'Pending',
      value: Number(kpisLive.pending).toLocaleString('en-IN'),
      change: isLive ? null : 3.5,
      up: false,
      icon: Clock,
      tone: 'default',
    },
  ]

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">Dashboard</span>
          </div>
          <h1 className="page-title">Dashboard</h1>
        </div>
        <div className="issues-header-actions">
          <LiveDataBadge />
          <button className="btn btn-outline" type="button">
            <RefreshCw size={14} />Sync Data
          </button>
        </div>
      </div>

      <div className="dashboard-banner">
        <div className="dashboard-banner-grid" />
        <div className="dashboard-banner-content">
          <div>
            <p className="dashboard-banner-greeting">Welcome back, {firstName}</p>
            <p className="dashboard-banner-sub">
              {isLive
                ? 'Showing compliance metrics from your latest SAP upload.'
                : 'Compliance tracking for your organization'}
            </p>
          </div>
          <div className="dashboard-banner-meta">
            {[
              { icon: CalendarDays, label: 'Financial Year', value: financialYear },
              { icon: Clock,        label: 'Last Sync',      value: lastSyncTime },
              { icon: Database,     label: 'Data Source',    value: dataSource.split('—')[0].trim() },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="dashboard-banner-meta-item">
                <Icon size={13} className="dashboard-banner-meta-icon" />
                <div>
                  <div className="dashboard-banner-meta-label">{label}</div>
                  <div className="dashboard-banner-meta-value">{value}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="kpi-grid">
        {kpis.map((k) => (
          <div key={k.label} className="kpi-card">
            <div className="kpi-icon-row">
              <span className="kpi-label">{k.label}</span>
              <div className={`kpi-icon-box ${k.tone}`}>
                <k.icon size={14} />
              </div>
            </div>
            <span className="kpi-value">{k.value}</span>
            {k.change != null && (
              <span className={`kpi-trend ${k.up ? 'up' : 'down'}`}>
                {k.up ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
                {k.change}%
              </span>
            )}
            {isLive && k.change == null && (
              <span className="kpi-trend" style={{ color: 'var(--color-text-muted)' }}>From SAP run</span>
            )}
          </div>
        ))}
      </div>

      <div className="chart-grid-2col">
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Issues by Section</p>
              <p className="chart-subtitle">
                {isLive ? 'From latest SAP upload' : 'Distribution across TDS sections'}
              </p>
            </div>
          </div>
          <IssuesBySectionChart />
        </div>
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Compliance Health</p>
              <p className="chart-subtitle">
                {isLive ? 'Based on transactions vs issues found' : 'Overall posture this quarter'}
              </p>
            </div>
          </div>
          <ComplianceHealthChart />
        </div>
      </div>

      <div className="chart-grid-2col">
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Monthly Trend</p>
              <p className="chart-subtitle">
                {isLive ? 'Issues by posting month in upload' : 'Issues found vs. resolved'}
              </p>
            </div>
          </div>
          <MonthlyTrendChart />
        </div>
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Top Vendors with Issues</p>
              <p className="chart-subtitle">
                {isLive ? 'Highest issue counts in this run' : 'Highest open issue counts'}
              </p>
            </div>
          </div>
          <TopVendorsChart />
        </div>
      </div>
    </div>
  )
}
