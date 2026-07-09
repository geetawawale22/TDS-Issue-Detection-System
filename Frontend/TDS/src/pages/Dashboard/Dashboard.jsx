import { useNavigate } from 'react-router-dom'
import { useSelector } from 'react-redux'
import {
  Activity, AlertOctagon, AlertTriangle, CheckCircle2,
  Clock, FileSearch, RefreshCw, Database, CalendarDays, ArrowUp, ArrowDown,
} from 'lucide-react'
import IssuesBySectionChart from '@/components/Charts/IssuesBySectionChart'
import ComplianceHealthChart from '@/components/Charts/ComplianceHealthChart'
import MonthlyTrendChart from '@/components/Charts/MonthlyTrendChart'
import TopVendorsChart from '@/components/Charts/TopVendorsChart'
import DataTable from '@/components/Common/DataTable'
import StatusBadge, { severityToTone, issueStatusToTone } from '@/components/Common/StatusBadge'
import { issues } from '@/data/mockData'
import { formatCurrency, formatDate, formatStatusLabel } from '@/utils/utils'
import '@/components/Common/Common.css'
import './Dashboard.css'

const recentIssues = issues.slice(0, 5)

const columns = [
  { key: 'id',     header: 'Issue ID',  render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.id}</span> },
  { key: 'vendor', header: 'Vendor',    render: (r) => <span style={{ fontSize: 12.5, fontWeight: 500 }}>{r.vendor}</span> },
  { key: 'section',header: 'Section',   render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.section}</span> },
  { key: 'transactionAmount', header: 'Amount', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.transactionAmount)}</span> },
  { key: 'severity', header: 'Severity', render: (r) => <StatusBadge label={formatStatusLabel(r.severity)} tone={severityToTone(r.severity)} /> },
  { key: 'status',   header: 'Status',   render: (r) => <StatusBadge label={formatStatusLabel(r.status)}   tone={issueStatusToTone(r.status)}   /> },
]

export default function Dashboard() {
  const navigate = useNavigate()
  const { financialYear, lastSyncTime, dataSource } = useSelector((s) => s.app)
  const firstName = useSelector((s) => s.auth.user?.name?.split(' ')[0]) ?? 'there'

  const totalTx     = 28450
  const totalIssues = issues.length * 14
  const highSev     = issues.filter((i) => i.severity === 'high').length   * 3
  const medSev      = issues.filter((i) => i.severity === 'medium').length * 3
  const resolved    = issues.filter((i) => i.status   === 'resolved').length * 6
  const pending     = totalIssues - resolved

  const kpis = [
    { label: 'Transactions',    value: totalTx.toLocaleString('en-IN'),       change: 4.2, up: true,  icon: Activity,     tone: 'default'  },
    { label: 'Issues Found',    value: totalIssues.toLocaleString('en-IN'),   change: 2.8, up: true,  icon: FileSearch,   tone: 'warning'  },
    { label: 'High Severity',   value: highSev.toString(),                    change: 6.1, up: true,  icon: AlertOctagon, tone: 'danger'   },
    { label: 'Medium Severity', value: medSev.toString(),                     change: 1.4, up: false, icon: AlertTriangle,tone: 'warning'  },
    { label: 'Resolved',        value: resolved.toLocaleString('en-IN'),      change: 9.3, up: true,  icon: CheckCircle2, tone: 'success'  },
    { label: 'Pending',         value: pending.toLocaleString('en-IN'),       change: 3.5, up: false, icon: Clock,        tone: 'default'  },
  ]

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">Dashboard</span>
          </div>
          <h1 className="page-title">Dashboard</h1>
        </div>
        <button className="btn btn-outline">
          <RefreshCw size={14} />Sync Data
        </button>
      </div>

      {/* Welcome banner */}
      <div className="dashboard-banner">
        <div className="dashboard-banner-grid" />
        <div className="dashboard-banner-content">
          <div>
            <p className="dashboard-banner-greeting">Welcome back, {firstName}</p>
            <p className="dashboard-banner-sub">Compliance tracking for your organization</p>
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

      {/* KPI Cards */}
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
            <span className={`kpi-trend ${k.up ? 'up' : 'down'}`}>
              {k.up ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
              {k.change}%
            </span>
          </div>
        ))}
      </div>

      {/* Charts Row 1 */}
      <div className="chart-grid-2col">
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Issues by Section</p>
              <p className="chart-subtitle">Distribution across TDS sections</p>
            </div>
          </div>
          <IssuesBySectionChart />
        </div>
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Compliance Health</p>
              <p className="chart-subtitle">Overall posture this quarter</p>
            </div>
          </div>
          <ComplianceHealthChart />
        </div>
      </div>

      {/* Charts Row 2 */}
      <div className="chart-grid-2col">
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Monthly Trend</p>
              <p className="chart-subtitle">Issues found vs. resolved</p>
            </div>
          </div>
          <MonthlyTrendChart />
        </div>
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">Top Vendors with Issues</p>
              <p className="chart-subtitle">Highest open issue counts</p>
            </div>
          </div>
          <TopVendorsChart />
        </div>
      </div>

      {/* Recent Issues */}
      <div className="table-card">
        <div className="table-card-header">
          <div>
            <div className="table-card-title">Recent Issues</div>
            <div className="table-card-sub">Latest flags from automated reconciliation</div>
          </div>
          <button className="btn btn-outline btn-sm" onClick={() => navigate('/issues')}>
            View all →
          </button>
        </div>
        <DataTable columns={columns} data={recentIssues} onRowClick={() => navigate('/issues')} pageSize={5} />
      </div>
    </div>
  )
}
