import { useMemo } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Download, FileSearch, SlidersHorizontal, RotateCcw } from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge, { severityToTone, issueStatusToTone } from '@/components/Common/StatusBadge'
import IssueDrawer from '@/components/Common/IssueDrawer'
import {
  setSearchQuery, setVendorFilter, setSectionFilter,
  setSeverityFilter, setStatusFilter, openDrawer, closeDrawer, resetFilters,
} from '@/redux/slices/issuesSlice'
import { issues, sections, vendorNames } from '@/data/mockData'
import { formatCurrency, formatStatusLabel } from '@/utils/utils'
import '@/components/Common/Common.css'
import './Issues.css'

const SEVERITY_OPTIONS = [['all','All Severity'],['high','High'],['medium','Medium'],['low','Low']]
const STATUS_OPTIONS   = [['all','All Status'],['open','Open'],['in_review','In Review'],['resolved','Resolved'],['rejected','Rejected']]

export default function Issues() {
  const dispatch = useDispatch()
  const { searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter, selectedIssueId, drawerOpen } =
    useSelector((s) => s.issues)

  const filtered = useMemo(() => issues.filter((issue) => {
    if (searchQuery && !issue.vendor.toLowerCase().includes(searchQuery.toLowerCase()) && !issue.id.toLowerCase().includes(searchQuery.toLowerCase())) return false
    if (vendorFilter   !== 'all' && issue.vendor   !== vendorFilter)   return false
    if (sectionFilter  !== 'all' && issue.section  !== sectionFilter)  return false
    if (severityFilter !== 'all' && issue.severity !== severityFilter) return false
    if (statusFilter   !== 'all' && issue.status   !== statusFilter)   return false
    return true
  }), [searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter])

  const selectedIssue = issues.find((i) => i.id === selectedIssueId) ?? null

  const columns = [
    { key: 'id',     header: 'Issue ID',  render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.id}</span> },
    { key: 'vendor', header: 'Vendor',    render: (r) => (
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.vendor}</div>
        <div className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.vendorId}</div>
      </div>
    )},
    { key: 'section',           header: 'Section',   render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.section}</span> },
    { key: 'transactionAmount', header: 'Amount',    render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.transactionAmount)}</span> },
    { key: 'expectedRate',      header: 'Exp. Rate', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.expectedRate}%</span> },
    { key: 'appliedRate',       header: 'App. Rate', render: (r) => (
      <span className="font-mono" style={{ fontSize: 11.5, color: r.appliedRate < r.expectedRate ? 'var(--color-danger)' : undefined, fontWeight: r.appliedRate < r.expectedRate ? 600 : 400 }}>
        {r.appliedRate}%
      </span>
    )},
    { key: 'severity', header: 'Severity', render: (r) => <StatusBadge label={formatStatusLabel(r.severity)} tone={severityToTone(r.severity)} /> },
    { key: 'status',   header: 'Status',   render: (r) => <StatusBadge label={formatStatusLabel(r.status)}   tone={issueStatusToTone(r.status)} /> },
    { header: '', render: (r) => (
      <button className="issues-review-btn" onClick={(e) => { e.stopPropagation(); dispatch(openDrawer(r.id)) }}>Review</button>
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

      {/* Filter bar */}
      <div className="filter-bar">
        <div className="filter-bar-label">
          <SlidersHorizontal size={14} />Filters
        </div>
        <input
          className="filter-input"
          value={searchQuery}
          onChange={(e) => dispatch(setSearchQuery(e.target.value))}
          placeholder="Search vendor or ID…"
        />
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
        <select className="filter-select" value={statusFilter} onChange={(e) => dispatch(setStatusFilter(e.target.value))}>
          {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button className="filter-reset-btn" onClick={() => dispatch(resetFilters())}>
          <RotateCcw size={12} />Reset
        </button>
      </div>

      <div className="table-card">
        <DataTable
          columns={columns}
          data={filtered}
          onRowClick={(row) => dispatch(openDrawer(row.id))}
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
