import { useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Activity, AlertOctagon, AlertTriangle, CheckCircle2,
  Clock, FileSearch, RefreshCw, Database, CalendarDays, ArrowUp, ArrowDown, X,
} from 'lucide-react'
import IssuesByTypeChart from '@/components/Charts/IssuesByTypeChart'
import SectionComplianceChart from '@/components/Charts/SectionComplianceChart'
import MonthlyTrendChart from '@/components/Charts/MonthlyTrendChart'
import TopVendorsChart from '@/components/Charts/TopVendorsChart'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import IssueDrawer from '@/components/Common/IssueDrawer'
import { closeDrawer, openDrawer, selectActiveIssues, selectDashboardKpis, selectIsLive } from '@/redux/slices/issuesSlice'
import '@/components/Common/Common.css'
import './Dashboard.css'

export default function Dashboard() {
  const navigate = useNavigate()
  const dispatch = useDispatch()
  const [selectedMonth, setSelectedMonth] = useState(null)
  const { financialYear, lastSyncTime, dataSource } = useSelector((s) => s.app)
  const firstName = useSelector((s) => s.auth.user?.name?.split(' ')[0]) ?? 'there'
  const kpisLive = useSelector(selectDashboardKpis)
  const isLive = useSelector(selectIsLive)
  const issues = useSelector(selectActiveIssues)
  const selectedIssueId = useSelector((s) => s.issues.selectedIssueId)
  const drawerOpen = useSelector((s) => s.issues.drawerOpen)
  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId) ?? null
  const monthIssues = useMemo(() => selectedMonth
    ? issues.filter((issue) => {
      const date = new Date(issue.date)
      if (Number.isNaN(date.getTime())) return false
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` === selectedMonth.monthKey
    })
    : [], [issues, selectedMonth])

  const kpis = [
    {
      label: 'Transactions',
      value: Number(kpisLive.transactions).toLocaleString('en-IN'),
      change: isLive ? null : 4.2,
      up: true,
      icon: Activity,
      tone: 'default',
      target: '/issues?view=all',
    },
    {
      label: 'Issues Found',
      value: Number(kpisLive.issuesFound).toLocaleString('en-IN'),
      change: isLive ? null : 2.8,
      up: true,
      icon: FileSearch,
      tone: 'warning',
      target: '/issues?view=issue',
    },
    {
      label: 'High Severity',
      value: String(kpisLive.high),
      change: isLive ? null : 6.1,
      up: true,
      icon: AlertOctagon,
      tone: 'danger',
      target: '/issues?view=issue&severity=high',
    },
    {
      label: 'Medium Severity',
      value: String(kpisLive.medium),
      change: isLive ? null : 1.4,
      up: false,
      icon: AlertTriangle,
      tone: 'warning',
      target: '/issues?view=issue&severity=medium',
    },
    {
      label: 'Resolved',
      value: Number(kpisLive.resolved).toLocaleString('en-IN'),
      change: isLive ? null : 9.3,
      up: true,
      icon: CheckCircle2,
      tone: 'success',
      target: '/issues?view=issue&status=resolved',
    },
    {
      label: 'Pending',
      value: Number(kpisLive.pending).toLocaleString('en-IN'),
      change: isLive ? null : 3.5,
      up: false,
      icon: Clock,
      tone: 'default',
      target: '/issues?view=issue&status=open',
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
          <button
            key={k.label}
            className="kpi-card kpi-card-clickable"
            type="button"
            onClick={() => navigate(k.target)}
            aria-label={`Open issues filtered by ${k.label}`}
          >
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
          </button>
        ))}
      </div>

      <div className="chart-grid-2col">
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Issues by Type</p>
              <p className="chart-subtitle">
                {isLive ? 'From latest SAP upload' : 'Distribution by issue type'}
              </p>
            </div>
          </div>
          <IssuesByTypeChart />
        </div>
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Section-wise Compliance Health</p>
              <p className="chart-subtitle">Issue count by TDS section</p>
            </div>
          </div>
          <SectionComplianceChart />
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
          <MonthlyTrendChart onMonthClick={setSelectedMonth} />
          {selectedMonth && (
            <div className="dashboard-month-drilldown">
              <div className="dashboard-month-drilldown-header">
                <div>
                  <p className="chart-title">Issues in {selectedMonth.month}</p>
                  <p className="chart-subtitle">{monthIssues.length.toLocaleString()} issues found in this posting month</p>
                </div>
                <button className="btn-icon" type="button" onClick={() => setSelectedMonth(null)} aria-label="Close month issues">
                  <X size={15} />
                </button>
              </div>
              <div className="dashboard-month-issue-list">
                {monthIssues.length ? (
                  <>
                    <div className="dashboard-month-issue-header" aria-hidden="true">
                      <span>Document No.</span>
                      <span>Vendor</span>
                      <span>Issue Type</span>
                      <span>Action</span>
                    </div>
                    {monthIssues.map((issue) => (
                      <button key={issue.id} type="button" className="dashboard-month-issue-row" onClick={() => dispatch(openDrawer(issue.id))}>
                        <span className="font-mono">{issue.docNo || issue.id}</span>
                        <span>{issue.vendor}</span>
                        <span className="dashboard-month-issue-category">{issue.category || 'Issue'}</span>
                        <span className="dashboard-month-issue-review">Review</span>
                      </button>
                    ))}
                  </>
                ) : <div className="empty-state-desc">No issue records are available for this month.</div>}
              </div>
            </div>
          )}
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
      <IssueDrawer issue={selectedIssue} open={drawerOpen} onClose={() => dispatch(closeDrawer())} />
    </div>
  )
}
