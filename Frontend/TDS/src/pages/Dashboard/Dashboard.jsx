import { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Activity, AlertOctagon, AlertTriangle, CheckCircle2,
  Clock, FileSearch, RefreshCw, Database, CalendarDays, ArrowUp, ArrowDown,
  SlidersHorizontal, RotateCcw, Maximize2, X, BadgeCheck, BadgeX,
} from 'lucide-react'
import IssuesByTypeChart from '@/components/Charts/IssuesByTypeChart'
import SectionComplianceChart from '@/components/Charts/SectionComplianceChart'
import MonthlyTrendChart from '@/components/Charts/MonthlyTrendChart'
import TopVendorsChart from '@/components/Charts/TopVendorsChart'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import issuesService from '@/services/issuesService'
import ledgerService from '@/services/ledgerService'
import {
  resetDashboardFilters, selectDashboardSections, selectDashboardVendorCodeOptions,
  selectDashboardKpis, selectIsLive, selectUsesTrackedIssues, setTrackedIssues, setDashboardDateFromFilter,
  setDashboardDateToFilter, setDashboardMonthFilter, setDashboardSectionFilter,
  setDashboardVendorCodeFilter,
  setDashboardTdsDeductionFilter, selectDashboardTdsDeductionCounts,
} from '@/redux/slices/issuesSlice'
import '@/components/Common/Common.css'
import './Dashboard.css'

export default function Dashboard() {
  const [expandedChart, setExpandedChart] = useState(null)
  const navigate = useNavigate()
  const dispatch = useDispatch()
  const { financialYear, lastSyncTime, dataSource, selectedCompanyCode } = useSelector((s) => s.app)
  const firstName = useSelector((s) => s.auth.user?.name?.split(' ')[0]) ?? 'there'
  const kpisLive = useSelector(selectDashboardKpis)
  const uploadIsLive = useSelector(selectIsLive)
  const usesTrackedIssues = useSelector(selectUsesTrackedIssues)
  // Saved issues are real data too, even before a file is uploaded in this browser.
  const [ledgerCounts, setLedgerCounts] = useState(null)
  // Saved transactions are real data too, like saved issues.
  const isLive = uploadIsLive || usesTrackedIssues || Boolean(ledgerCounts)
  const sections = useSelector(selectDashboardSections)
  const vendorCodeOptions = useSelector(selectDashboardVendorCodeOptions)
  const trackingRunId = useSelector((s) => s.issues.uploadMeta?.tracking?.runId ?? null)

  // Every issue saved across runs: yesterday's and today's add up, each counted once.
  // Reloaded after each analysed file (new run).
  useEffect(() => {
    let cancelled = false
    issuesService.getAllTrackedIssues()
      .then((data) => { if (!cancelled) dispatch(setTrackedIssues(data.items || [])) })
      .catch(() => { /* keep the latest upload's issues as the fallback */ })
    return () => { cancelled = true }
  }, [dispatch, trackingRunId])
  const tdsDeductionCounts = useSelector(selectDashboardTdsDeductionCounts)
  const {
    dashboardDateFromFilter,
    dashboardDateToFilter,
    dashboardMonthFilter,
    dashboardVendorCodeFilter,
    dashboardVendorNameFilter,
    dashboardSectionFilter,
    dashboardIssueTypeFilter,
    dashboardTdsDeductionFilter,
  } = useSelector((s) => s.issues)
  // Transactions saved across every run (each SAP line once), under the same
  // company / FY / date / vendor / section filters as the issue counts.
  useEffect(() => {
    let cancelled = false
    ledgerService.getTransactionCounts({
      company_code: selectedCompanyCode || '',
      financial_year: financialYear || '',
      date_from: dashboardDateFromFilter || undefined,
      date_to: dashboardDateToFilter || undefined,
      month: dashboardMonthFilter || '',
      vendor_code: dashboardVendorCodeFilter !== 'all' ? dashboardVendorCodeFilter : '',
      vendor_name: dashboardVendorNameFilter !== 'all' ? dashboardVendorNameFilter : '',
      section: dashboardSectionFilter !== 'all' ? dashboardSectionFilter : '',
    })
      .then((data) => { if (!cancelled) setLedgerCounts(data) })
      // Keep the latest upload's numbers as the fallback.
      .catch(() => { if (!cancelled) setLedgerCounts(null) })
    return () => { cancelled = true }
  }, [
    selectedCompanyCode, financialYear, trackingRunId, dashboardDateFromFilter, dashboardDateToFilter,
    dashboardMonthFilter, dashboardVendorCodeFilter, dashboardVendorNameFilter, dashboardSectionFilter,
  ])
  const transactionsValue = ledgerCounts
    ? {
      deducted: ledgerCounts.tdsDeducted,
      not_deducted: ledgerCounts.tdsNotDeducted,
    }[dashboardTdsDeductionFilter] ?? ledgerCounts.transactions
    : kpisLive.transactions
  const deductionCounts = ledgerCounts
    ? { deducted: ledgerCounts.tdsDeducted, notDeducted: ledgerCounts.tdsNotDeducted }
    : tdsDeductionCounts

  const hasDashboardFilters = Boolean(
    dashboardDateFromFilter
    || dashboardDateToFilter
    || dashboardMonthFilter
    || dashboardVendorCodeFilter !== 'all'
    || dashboardVendorNameFilter !== 'all'
    || dashboardSectionFilter !== 'all'
    || dashboardIssueTypeFilter !== 'all'
    || dashboardTdsDeductionFilter !== 'all'
  )
  // Opens the Issues tab on the clicked item, carrying the Dashboard's own
  // filters so the rows there are the ones this Dashboard view counted.
  const navigateToIssues = ({ view = 'issue', ...filters } = {}) => {
    const deducted = dashboardTdsDeductionFilter === 'deducted'
    const deductionView = dashboardTdsDeductionFilter === 'all' ? view : {
      all: deducted ? 'tds_deducted' : 'tds_not_deducted',
      issue: deducted ? 'issue_deducted' : 'issue_not_deducted',
    }[view]
    const params = new URLSearchParams({ view: deductionView })
    Object.entries({
      section: dashboardSectionFilter,
      vendor: dashboardVendorNameFilter,
      search: dashboardVendorCodeFilter,
      type: dashboardIssueTypeFilter,
      month: dashboardMonthFilter,
      dateFrom: dashboardDateFromFilter,
      dateTo: dashboardDateToFilter,
      ...filters,
    }).forEach(([key, value]) => {
      if (value && value !== 'all') params.set(key, value)
    })
    navigate(`/issues?${params.toString()}`)
  }

  const chartDefinitions = {
    issuesType: {
      title: 'Issues by Type',
      subtitle: usesTrackedIssues ? 'All runs · open and resolved' : isLive ? 'From latest SAP upload' : 'Distribution by issue type',
      render: (props = {}) => <IssuesByTypeChart {...props} onBarClick={(row) => navigateToIssues({ type: row.type })} />,
    },
    sectionHealth: {
      title: 'Section-wise Compliance Health',
      subtitle: 'Issue count by TDS section',
      render: (props = {}) => <SectionComplianceChart {...props} onSectionClick={(row) => navigateToIssues({ section: row.section })} />,
    },
    monthlyTrend: {
      title: 'Monthly Trend',
      subtitle: isLive ? 'Issues by posting month (Apr → Mar), total or by section' : 'Issues found vs. resolved',
      render: (props = {}) => <MonthlyTrendChart {...props} onMonthClick={(row) => navigateToIssues(row.section ? { month: row.monthKey, section: row.section } : { month: row.monthKey })} />,
    },
    topVendors: {
      title: 'Top Vendors with Issues',
      subtitle: usesTrackedIssues ? 'Highest issue counts across all runs' : isLive ? 'Highest issue counts in this run' : 'Highest open issue counts',
      render: (props = {}) => <TopVendorsChart {...props} onBarClick={(row) => navigateToIssues({ vendor: row.vendor })} />,
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
      note: ledgerCounts ? 'All runs' : usesTrackedIssues ? 'Latest file' : null,
      value: Number(transactionsValue).toLocaleString('en-IN'),
      change: isLive ? null : 4.2,
      up: true,
      icon: Activity,
      tone: 'default',
      target: { view: 'all' },
    },
    {
      label: 'Issues Found',
      value: Number(kpisLive.issuesFound).toLocaleString('en-IN'),
      change: isLive ? null : 2.8,
      up: true,
      icon: FileSearch,
      tone: 'warning',
      target: {},
    },
    {
      label: 'High Severity',
      value: String(kpisLive.high),
      change: isLive ? null : 6.1,
      up: true,
      icon: AlertOctagon,
      tone: 'danger',
      target: { severity: 'high' },
    },
    {
      label: 'Medium Severity',
      value: String(kpisLive.medium),
      change: isLive ? null : 1.4,
      up: false,
      icon: AlertTriangle,
      tone: 'warning',
      target: { severity: 'medium' },
    },
    {
      label: 'Resolved',
      value: Number(kpisLive.resolved).toLocaleString('en-IN'),
      change: isLive ? null : 9.3,
      up: true,
      icon: CheckCircle2,
      tone: 'success',
      target: { status: 'resolved' },
    },
    {
      label: 'Pending',
      value: Number(kpisLive.pending).toLocaleString('en-IN'),
      change: isLive ? null : 3.5,
      up: false,
      icon: Clock,
      tone: 'default',
      target: { status: 'open' },
    },
  ]

  const tdsDeductionCards = [
    {
      label: 'TDS Deducted',
      value: deductionCounts.deducted,
      filter: 'deducted',
      icon: BadgeCheck,
      tone: 'success',
      description: ledgerCounts ? 'All runs · rows with TDS amount' : usesTrackedIssues ? 'Latest file · rows with TDS amount' : 'Rows with TDS amount',
    },
    {
      label: 'TDS Not Deducted',
      value: deductionCounts.notDeducted,
      filter: 'not_deducted',
      icon: BadgeX,
      tone: 'danger',
      description: ledgerCounts ? 'All runs · rows with no TDS amount' : usesTrackedIssues ? 'Latest file · rows with no TDS amount' : 'Rows with no TDS amount',
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
                ? (ledgerCounts
                  ? 'Issues and transactions from every run, each counted once.'
                  : usesTrackedIssues
                    ? 'Issues from every run (each counted once); transaction counts from your latest SAP upload.'
                    : 'Showing compliance metrics from your latest SAP upload.')
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
          <label className="dashboard-filter-control">
            <span>TDS Deduction</span>
            <select
              className="filter-select"
              value={dashboardTdsDeductionFilter}
              onChange={(e) => dispatch(setDashboardTdsDeductionFilter(e.target.value))}
            >
              <option value="all">All Rows</option>
              <option value="deducted">TDS Deducted</option>
              <option value="not_deducted">TDS Not Deducted</option>
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
            onClick={() => navigateToIssues(k.target)}
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
              <span className="kpi-trend" style={{ color: 'var(--color-text-muted)' }}>
                {k.note || (usesTrackedIssues ? 'All runs' : 'From SAP run')}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="dashboard-tds-grid">
        {tdsDeductionCards.map((card) => (
          <button
            key={card.filter}
            className={`kpi-card kpi-card-clickable ${dashboardTdsDeductionFilter === card.filter ? 'is-active' : ''}`}
            type="button"
            onClick={() => dispatch(setDashboardTdsDeductionFilter(
              dashboardTdsDeductionFilter === card.filter ? 'all' : card.filter,
            ))}
            aria-pressed={dashboardTdsDeductionFilter === card.filter}
            aria-label={`Filter dashboard by ${card.label}`}
          >
            <div className="kpi-icon-row">
              <span className="kpi-label">{card.label}</span>
              <div className={`kpi-icon-box ${card.tone}`}>
                <card.icon size={14} />
              </div>
            </div>
            <span className="kpi-value">{Number(card.value).toLocaleString('en-IN')}</span>
            <span className="kpi-trend" style={{ color: 'var(--color-text-muted)' }}>{card.description}</span>
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
