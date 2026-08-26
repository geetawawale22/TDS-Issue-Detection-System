import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  Activity, AlertOctagon, AlertTriangle, CheckCheck, Info,
  Clock, FileSearch, RefreshCw, Database, CalendarDays, ArrowUp, ArrowDown,
} from 'lucide-react'
import IssuesByTypeChart from '@/components/Charts/IssuesByTypeChart'
import SectionComplianceChart from '@/components/Charts/SectionComplianceChart'
import MonthlyTrendChart from '@/components/Charts/MonthlyTrendChart'
import TopVendorsChart from '@/components/Charts/TopVendorsChart'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import {
  selectDashboardKpis, selectUploadKpis, selectIsLive,
  resetFilters, setSeverityFilter, setStatusFilter, setViewFilter,
} from '@/redux/slices/issuesSlice'
import '@/components/Common/Common.css'
import './Dashboard.css'

export default function Dashboard() {
  const { financialYear, lastSyncTime, dataSource, selectedCompanyCode } = useSelector((s) => s.app)
  const { uploadMeta } = useSelector((s) => s.issues)
  const firstName = useSelector((s) => s.auth.user?.name?.split(' ')[0]) ?? 'there'
  const kpisLive = useSelector(selectDashboardKpis)
  const kpisUpload = useSelector(selectUploadKpis)
  const isLive = useSelector(selectIsLive)
  const dispatch = useDispatch()
  const navigate = useNavigate()

  // Every KPI drills into the Issues page — filters are reset first so a
  // card always shows exactly the rows behind its own number, not whatever
  // was left over from a previous visit to that page. Company/FY are global
  // Navbar state, untouched by this, so they carry over automatically.
  function goToIssues(applyFilter) {
    dispatch(resetFilters())
    if (applyFilter) applyFilter()
    navigate('/issues')
  }

  // Demo/sample mode (no real upload yet) keeps the original simple strip —
  // "Uploaded Rows / Passed / Insufficient Data" are upload-derived concepts
  // that don't exist for synthetic mock data.
  const demoKpis = [
    {
      key: 'transactions', label: 'Transactions', value: Number(kpisLive.transactions).toLocaleString('en-IN'),
      change: 4.2, up: true, icon: Activity, tone: 'default',
      tooltip: 'Click to view all transactions', onClick: () => goToIssues(),
    },
    {
      key: 'issuesFound', label: 'Issues Found', value: Number(kpisLive.issuesFound).toLocaleString('en-IN'),
      change: 2.8, up: true, icon: FileSearch, tone: 'danger',
      tooltip: 'Click to view Issues Found', onClick: () => goToIssues(),
    },
    {
      key: 'high', label: 'High Severity', value: String(kpisLive.high),
      change: 6.1, up: true, icon: AlertOctagon, tone: 'danger',
      tooltip: 'Click to view High Severity issues', onClick: () => goToIssues(() => dispatch(setSeverityFilter('high'))),
    },
    {
      key: 'medium', label: 'Medium Severity', value: String(kpisLive.medium),
      change: 1.4, up: false, icon: AlertTriangle, tone: 'warning',
      tooltip: 'Click to view Medium Severity issues', onClick: () => goToIssues(() => dispatch(setSeverityFilter('medium'))),
    },
    {
      key: 'resolved', label: 'Resolved', value: Number(kpisLive.resolved).toLocaleString('en-IN'),
      change: 9.3, up: true, icon: CheckCheck, tone: 'neutral',
      tooltip: 'Informational — Resolved does not drill into the Issues page',
      // Intentionally no onClick: Resolved is informational only.
    },
    {
      key: 'pending', label: 'Pending', value: Number(kpisLive.pending).toLocaleString('en-IN'),
      change: 3.5, up: false, icon: Clock, tone: 'warning',
      tooltip: 'Click to view Pending issues', onClick: () => goToIssues(() => dispatch(setStatusFilter('pending'))),
    },
  ]

  // Live-upload strip — every value comes from selectUploadKpis, which reads
  // the exact same scoped/adjusted arrays the Issues page reads, so a number
  // here can never drift from what you see after clicking through to it.
  const liveKpis = [
    {
      key: 'transactionsProcessed', label: 'Transactions Processed', value: Number(kpisUpload.transactionsProcessed).toLocaleString('en-IN'),
      icon: Activity, tone: 'info',
      tooltip: 'Click to view all processed transactions',
      onClick: () => goToIssues(() => dispatch(setViewFilter('all'))),
    },
    {
      key: 'issuesFound', label: 'Issues Found', value: Number(kpisUpload.issuesFound).toLocaleString('en-IN'),
      icon: FileSearch, tone: 'danger',
      tooltip: 'Click to view Issues Found',
      onClick: () => goToIssues(() => dispatch(setViewFilter('issue'))),
    },
    {
      key: 'high', label: 'High Severity', value: Number(kpisUpload.high).toLocaleString('en-IN'),
      icon: AlertOctagon, tone: 'danger',
      tooltip: 'Click to view High Severity issues',
      onClick: () => goToIssues(() => { dispatch(setViewFilter('issue')); dispatch(setSeverityFilter('high')) }),
    },
    {
      key: 'medium', label: 'Medium Severity', value: Number(kpisUpload.medium).toLocaleString('en-IN'),
      icon: AlertTriangle, tone: 'warning',
      tooltip: 'Click to view Medium Severity issues',
      onClick: () => goToIssues(() => { dispatch(setViewFilter('issue')); dispatch(setSeverityFilter('medium')) }),
    },
    // Low severity is only ever generated when "include informational
    // items" was checked on upload — most uploads have none, so this card
    // stays out of the way instead of always showing a static zero.
    ...(kpisUpload.low > 0 ? [{
      key: 'low', label: 'Low Severity', value: Number(kpisUpload.low).toLocaleString('en-IN'),
      icon: Info, tone: 'caution',
      tooltip: 'Click to view Low Severity issues',
      onClick: () => goToIssues(() => { dispatch(setViewFilter('issue')); dispatch(setSeverityFilter('low')) }),
    }] : []),
    {
      key: 'pending', label: 'Pending', value: Number(kpisUpload.pending).toLocaleString('en-IN'),
      icon: Clock, tone: 'warning',
      tooltip: 'Click to view Pending issues',
      onClick: () => goToIssues(() => { dispatch(setViewFilter('issue')); dispatch(setStatusFilter('pending')) }),
    },
    {
      key: 'resolved', label: 'Resolved', value: Number(kpisUpload.resolved).toLocaleString('en-IN'),
      icon: CheckCheck, tone: 'neutral',
      tooltip: 'Informational — Resolved does not drill into the Issues page',
      // Intentionally no onClick: Resolved is informational only.
    },
  ]

  const kpis = isLive ? liveKpis : demoKpis
  const companyLabel = uploadMeta?.companyCode || selectedCompanyCode || 'All Companies'
  const uploadSummaryLine = isLive
    ? `Latest SAP Upload — ${financialYear} | Company ${companyLabel} — `
      + `${Number(kpisUpload.transactionsProcessed).toLocaleString('en-IN')} Transactions Processed • `
      + `${Number(kpisUpload.issuesFound).toLocaleString('en-IN')} Issues Found`
    : 'Compliance tracking for your organization'

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
            <p className="dashboard-banner-sub">{uploadSummaryLine}</p>
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

      <div className={`kpi-grid ${isLive ? 'kpi-grid--flow' : ''}`}>
        {kpis.map((k) => {
          const Tag = k.onClick ? 'button' : 'div'
          // Explicit confirmation on every click — clicking through to a
          // zero-count filter (e.g. no Resolved issues yet) lands on a page
          // that looks identical to what was already on screen, which reads
          // as "nothing happened" without this.
          const handleClick = k.onClick
            ? () => {
              k.onClick()
              toast(`Issues page — ${k.label}: ${k.value}`)
            }
            : undefined
          return (
            <Tag
              key={k.key}
              type={k.onClick ? 'button' : undefined}
              className={`kpi-card ${k.onClick ? '' : 'kpi-card--static'}`}
              onClick={handleClick}
              title={k.tooltip}
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
            </Tag>
          )
        })}
      </div>

      <div className="chart-grid-2col">
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Issues by Type</p>
              <p className="chart-subtitle">
                {isLive ? 'From latest SAP upload' : 'Distribution across issue categories'}
              </p>
            </div>
          </div>
          <IssuesByTypeChart />
        </div>
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Section-wise Compliance Health</p>
              <p className="chart-subtitle">
                {isLive ? 'Issue count by TDS section' : 'Ranked by issue count'}
              </p>
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
                {isLive ? 'Issues by posting month in upload' : 'Issues found vs. resolved'} · Click a point to view that month's issues
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
