import { useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Activity, AlertOctagon, AlertTriangle, CheckCircle2,
  Clock, FileSearch, RefreshCw, Database, CalendarDays, ArrowUp, ArrowDown,
  SlidersHorizontal, RotateCcw, Maximize2, X,
} from 'lucide-react'
import IssuesByTypeChart from '@/components/Charts/IssuesByTypeChart'
import SectionComplianceChart from '@/components/Charts/SectionComplianceChart'
import MonthlyTrendChart from '@/components/Charts/MonthlyTrendChart'
import TopVendorsChart from '@/components/Charts/TopVendorsChart'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import {
  resetDashboardFilters, selectActiveSections, selectActiveVendorCodeOptions,
  selectDashboardKpis, selectIsLive, setDashboardDateFromFilter,
  setDashboardDateToFilter, setDashboardMonthFilter, setDashboardSectionFilter,
  setDashboardIssueTypeFilter, setDashboardVendorCodeFilter, setDashboardVendorNameFilter,
} from '@/redux/slices/issuesSlice'
import '@/components/Common/Common.css'
import './Dashboard.css'

export default function Dashboard() {
  const [expandedChart, setExpandedChart] = useState(null)
  const navigate = useNavigate()
  const dispatch = useDispatch()
  const { financialYear, lastSyncTime, dataSource } = useSelector((s) => s.app)
  const firstName = useSelector((s) => s.auth.user?.name?.split(' ')[0]) ?? 'there'
  const kpisLive = useSelector(selectDashboardKpis)
  const isLive = useSelector(selectIsLive)
  const sections = useSelector(selectActiveSections)
  const vendorCodeOptions = useSelector(selectActiveVendorCodeOptions)
  const {
    dashboardDateFromFilter,
    dashboardDateToFilter,
    dashboardMonthFilter,
    dashboardVendorCodeFilter,
    dashboardVendorNameFilter,
    dashboardSectionFilter,
    dashboardIssueTypeFilter,
  } = useSelector((s) => s.issues)
  const hasDashboardFilters = Boolean(
    dashboardDateFromFilter
    || dashboardDateToFilter
    || dashboardMonthFilter
    || dashboardVendorCodeFilter !== 'all'
    || dashboardVendorNameFilter !== 'all'
    || dashboardSectionFilter !== 'all'
    || dashboardIssueTypeFilter !== 'all'
  )
  const navigateToIssues = (filters = {}) => {
    const params = new URLSearchParams({ view: 'issue' })
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value)
    })
    navigate(`/issues?${params.toString()}`)
  }

  const chartDefinitions = {
    issuesType: {
      title: 'Issues by Type',
      subtitle: isLive ? 'From latest SAP upload' : 'Distribution by issue type',
      render: (props = {}) => <IssuesByTypeChart {...props} onBarClick={(row) => dispatch(setDashboardIssueTypeFilter(row.type || 'all'))} />,
    },
    sectionHealth: {
      title: 'Section-wise Compliance Health',
      subtitle: 'Issue count by TDS section',
      render: (props = {}) => <SectionComplianceChart {...props} onSectionClick={(row) => dispatch(setDashboardSectionFilter(row.section || 'all'))} />,
    },
    monthlyTrend: {
      title: 'Monthly Trend',
      subtitle: isLive ? 'Issues by posting month in upload' : 'Issues found vs. resolved',
      render: (props = {}) => <MonthlyTrendChart {...props} onMonthClick={(row) => dispatch(setDashboardMonthFilter(row.monthKey || ''))} />,
    },
    topVendors: {
      title: 'Top Vendors with Issues',
      subtitle: isLive ? 'Highest issue counts in this run' : 'Highest open issue counts',
      render: (props = {}) => <TopVendorsChart {...props} onBarClick={(row) => dispatch(setDashboardVendorNameFilter(row.vendor || 'all'))} />,
    },
  }
  const expandedChartConfig = expandedChart ? chartDefinitions[expandedChart] : null

  function renderChartCard(chartKey) {
    const chart = chartDefinitions[chartKey]
    return (
      <div className="chart-card">
        <div className="chart-card-header">
          <div>
            <p className="chart-title">{chart.title}</p>
            <p className="chart-subtitle">{chart.subtitle}</p>
          </div>
          <button
            className="dashboard-chart-expand-btn"
            type="button"
            title={`Expand ${chart.title}`}
            aria-label={`Expand ${chart.title}`}
            onClick={() => setExpandedChart(chartKey)}
          >
            <Maximize2 size={14} />
          </button>
        </div>
        {chart.render()}
      </div>
    )
  }

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

      <div className="filter-bar dashboard-filter-bar">
        <div className="filter-bar-top">
          <div className="filter-bar-label">
            <SlidersHorizontal size={14} />Dashboard Filters
          </div>
          {hasDashboardFilters && <span className="dashboard-filter-state">Filtered view</span>}
        </div>
        <div className="filter-bar-controls dashboard-filter-controls">
          <label className="dashboard-filter-control">
            <span>From Date</span>
            <input
              className="filter-input dashboard-date-filter"
              type="date"
              value={dashboardDateFromFilter}
              onChange={(e) => dispatch(setDashboardDateFromFilter(e.target.value))}
            />
          </label>
          <label className="dashboard-filter-control">
            <span>To Date</span>
            <input
              className="filter-input dashboard-date-filter"
              type="date"
              value={dashboardDateToFilter}
              onChange={(e) => dispatch(setDashboardDateToFilter(e.target.value))}
            />
          </label>
          <label className="dashboard-filter-control">
            <span>Month</span>
            <input
              className="filter-input dashboard-date-filter"
              type="month"
              value={dashboardMonthFilter}
              onChange={(e) => dispatch(setDashboardMonthFilter(e.target.value))}
            />
          </label>
          <label className="dashboard-filter-control">
            <span>Vendor Code</span>
            <select
              className="filter-select"
              value={dashboardVendorCodeFilter}
              onChange={(e) => dispatch(setDashboardVendorCodeFilter(e.target.value))}
            >
              <option value="all">All Vendor Codes</option>
              {vendorCodeOptions.map(({ vendorCode, supplierName }) => (
                <option key={vendorCode} value={vendorCode}>
                  {supplierName ? `${vendorCode} (${supplierName})` : vendorCode}
                </option>
              ))}
            </select>
          </label>
          <label className="dashboard-filter-control">
            <span>Section</span>
            <select
              className="filter-select"
              value={dashboardSectionFilter}
              onChange={(e) => dispatch(setDashboardSectionFilter(e.target.value))}
            >
              <option value="all">All Sections</option>
              {sections.map((section) => (
                <option key={section} value={section}>{section}</option>
              ))}
            </select>
          </label>
          <button
            className="filter-reset-btn dashboard-filter-reset"
            type="button"
            disabled={!hasDashboardFilters}
            onClick={() => dispatch(resetDashboardFilters())}
          >
            <RotateCcw size={12} />Reset
          </button>
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
        {renderChartCard('issuesType')}
        {renderChartCard('sectionHealth')}
      </div>

      <div className="chart-grid-2col">
        {renderChartCard('monthlyTrend')}
        {renderChartCard('topVendors')}
      </div>

      {expandedChartConfig && (
        <div className="dashboard-chart-modal-overlay open" onClick={() => setExpandedChart(null)}>
          <div className="dashboard-chart-modal" onClick={(event) => event.stopPropagation()}>
            <div className="dashboard-chart-modal-header">
              <div>
                <p className="chart-title">{expandedChartConfig.title}</p>
                <p className="chart-subtitle">{expandedChartConfig.subtitle}</p>
              </div>
              <button
                className="dashboard-chart-expand-btn"
                type="button"
                title="Collapse chart"
                aria-label="Collapse chart"
                onClick={() => setExpandedChart(null)}
              >
                <X size={15} />
              </button>
            </div>
            <div className="dashboard-chart-modal-body">
              {expandedChartConfig.render({ height: 430, expanded: true })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
