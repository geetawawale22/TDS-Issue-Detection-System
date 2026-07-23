import { useMemo } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  Download, FileSearch, SlidersHorizontal, RotateCcw,
  AlertOctagon, AlertTriangle, CheckCircle2, CheckCheck,
} from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge, { severityToTone, issueStatusToTone } from '@/components/Common/StatusBadge'
import IssueDrawer from '@/components/Common/IssueDrawer'
import {
  setSearchQuery, setVendorFilter, setSectionFilter, setSeverityFilter,
  setStatusFilter, setIssueTypeFilter, openDrawer, closeDrawer, resetFilters,
} from '@/redux/slices/issuesSlice'
import { issues, sections, vendorNames } from '@/data/mockData'
import { groupedScenarioOptions } from '@/data/issueTypes'
import { formatCurrency, formatStatusLabel } from '@/utils/utils'
import '@/components/Common/Common.css'
import './Issues.css'

const SEVERITY_OPTIONS = [['all','All Severity'],['high','High'],['medium','Medium'],['low','Low']]
const STATUS_OPTIONS   = [['all','All Status'],['open','Open'],['in_review','In Review'],['resolved','Resolved'],['rejected','Rejected']]
const ISSUE_TYPE_GROUPS = groupedScenarioOptions()

const SEVERITY_ICON = { high: AlertOctagon, medium: AlertTriangle, low: CheckCircle2 }

export default function Issues() {
  const dispatch = useDispatch()
  const {
    searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter,
    issueTypeFilter, selectedIssueId, drawerOpen,
  } = useSelector((s) => s.issues)

  const filtered = useMemo(() => issues.filter((issue) => {
    if (searchQuery && !issue.vendor.toLowerCase().includes(searchQuery.toLowerCase()) && !issue.id.toLowerCase().includes(searchQuery.toLowerCase()) && !issue.docNo.toLowerCase().includes(searchQuery.toLowerCase())) return false
    if (vendorFilter    !== 'all' && issue.vendor    !== vendorFilter)    return false
    if (sectionFilter   !== 'all' && issue.section   !== sectionFilter)   return false
    if (severityFilter  !== 'all' && issue.severity  !== severityFilter)  return false
    if (statusFilter    !== 'all' && issue.status    !== statusFilter)    return false
    if (issueTypeFilter !== 'all' && issue.issueType !== issueTypeFilter) return false
    return true
  }), [searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter, issueTypeFilter])

  const selectedIssue = issues.find((i) => i.id === selectedIssueId) ?? null

  const summary = useMemo(() => ({
    high: issues.filter((i) => i.severity === 'high').length,
    medium: issues.filter((i) => i.severity === 'medium').length,
    low: issues.filter((i) => i.severity === 'low').length,
  }), [])

  const columns = [
    { header: '#', render: (_r, i) => <span className="font-mono" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{i + 1}</span> },
    { key: 'docNo',   header: 'Doc No.',  render: (r) => (
      <div>
        <span className="font-mono" style={{ fontSize: 11.5 }}>{r.docNo}</span>
        {r.status === 'resolved' ? (
          <div className="corrected-badge"><CheckCheck size={11} />Corrected</div>
        ) : r.status !== 'open' && (
          <div style={{ marginTop: 3 }}>
            <StatusBadge label={formatStatusLabel(r.status)} tone={issueStatusToTone(r.status)} />
          </div>
        )}
      </div>
    )},
    { key: 'vendor', header: 'Vendor',    render: (r) => (
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.vendor}</div>
        <div className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.vendorId}</div>
      </div>
    )},
    { key: 'section',      header: 'Section',  render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.section}</span> },
    { key: 'baseAmount',   header: 'Base Amt', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.baseAmount)}</span> },
    { key: 'tdsAmount',    header: 'TDS (₹)',  render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.tdsAmount)}</span> },
    { key: 'category', header: 'Issue Type', render: (r) => {
      const Icon = SEVERITY_ICON[r.severity] ?? AlertTriangle
      return (
        <div className={`issue-type-cell issue-type-cell--${r.severity}`} title={r.issueTypeLabel}>
          <Icon size={13} />
          <span className="issue-type-text">{r.category}</span>
        </div>
      )
    }},
    { key: 'severity', header: 'Severity', render: (r) => <StatusBadge label={formatStatusLabel(r.severity)} tone={severityToTone(r.severity)} /> },
    { key: 'issueDetail', header: 'Details', render: (r) => (
      <span className="issue-details-preview" title={r.issueDetail}>{r.issueDetail}</span>
    )},
    { header: '', render: (r) => (
      <button className="issues-review-btn" onClick={() => dispatch(openDrawer(r.id))}>Review</button>
    )},
  ]

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">Issues</span>
          </div>
          <h1 className="page-title">Issues</h1>
        </div>
        <button className="btn btn-outline">
          <Download size={14} />Export
        </button>
      </div>

      {/* Summary strip */}
      <div className="issues-summary-grid">
        <div className="issues-summary-card issues-summary-card--danger">
          <AlertOctagon size={16} />
          <div>
            <div className="issues-summary-value">{summary.high}</div>
            <div className="issues-summary-label">Require Immediate Action</div>
          </div>
        </div>
        <div className="issues-summary-card issues-summary-card--warning">
          <AlertTriangle size={16} />
          <div>
            <div className="issues-summary-value">{summary.medium}</div>
            <div className="issues-summary-label">Review Recommended</div>
          </div>
        </div>
        <div className="issues-summary-card issues-summary-card--success">
          <CheckCircle2 size={16} />
          <div>
            <div className="issues-summary-value">{summary.low}</div>
            <div className="issues-summary-label">Informational</div>
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="filter-bar">
        <div className="filter-bar-top">
          <div className="filter-bar-label">
            <SlidersHorizontal size={14} />Filters
          </div>
          <input
            className="filter-input"
            value={searchQuery}
            onChange={(e) => dispatch(setSearchQuery(e.target.value))}
            placeholder="Search vendor / doc / ID…"
          />
        </div>
        <div className="filter-bar-controls">
          <select className="filter-select" value={vendorFilter} onChange={(e) => dispatch(setVendorFilter(e.target.value))}>
            <option value="all">All Vendors</option>
            {vendorNames.slice(0, 12).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select className="filter-select" value={sectionFilter} onChange={(e) => dispatch(setSectionFilter(e.target.value))}>
            <option value="all">All Sections</option>
            {sections.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="filter-select" value={severityFilter} onChange={(e) => dispatch(setSeverityFilter(e.target.value))}>
            {SEVERITY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="filter-select" value={issueTypeFilter} onChange={(e) => dispatch(setIssueTypeFilter(e.target.value))}>
            <option value="all">All Issue Types</option>
            {ISSUE_TYPE_GROUPS.map(({ group, options }) => (
              <optgroup key={group} label={group}>
                {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </optgroup>
            ))}
          </select>
          <select className="filter-select" value={statusFilter} onChange={(e) => dispatch(setStatusFilter(e.target.value))}>
            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button className="filter-reset-btn" onClick={() => dispatch(resetFilters())}>
            <RotateCcw size={12} />Reset
          </button>
        </div>
      </div>

      <div className="table-card">
        <div className="issues-count-label">Showing {filtered.length} issue{filtered.length === 1 ? '' : 's'}</div>
        <DataTable
          columns={columns}
          data={filtered}
          pageSize={12}
          emptyState={
            <div className="empty-state">
              <div className="empty-state-icon"><FileSearch size={20} /></div>
              <div className="empty-state-title">No issues match your filters</div>
              <div className="empty-state-desc">Try adjusting your search or filter criteria.</div>
              <button className="btn btn-outline btn-sm" onClick={() => dispatch(resetFilters())}>Reset Filters</button>
            </div>
          }
        />
      </div>

      <IssueDrawer issue={selectedIssue} open={drawerOpen} onClose={() => dispatch(closeDrawer())} />
    </div>
  )
}
