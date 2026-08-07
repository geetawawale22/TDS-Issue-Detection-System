import { useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import toast from 'react-hot-toast'
import {
  Download, FileSearch, SlidersHorizontal, RotateCcw,
  AlertOctagon, AlertTriangle, CheckCircle2, CheckCheck, IdCard, Loader2,
} from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge, { severityToTone, issueStatusToTone } from '@/components/Common/StatusBadge'
import IssueDrawer from '@/components/Common/IssueDrawer'
import SapUploadPanel from '@/components/Common/SapUploadPanel'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import {
  setSearchQuery, setVendorFilter, setSectionFilter, setSeverityFilter,
  setStatusFilter, setIssueTypeFilter, openDrawer, closeDrawer, resetFilters,
  selectActiveIssues, selectActiveVendors, selectActiveSections,
} from '@/redux/slices/issuesSlice'
import { startVerifyPan, finishVerifyPan } from '@/redux/slices/panSlice'
import { issueTypeFilterOptions, getDisplayIssueType, simulatePanVerification, MULTI_CATEGORY_DELIMITER } from '@/data/issueTypes'
import { formatCurrency, formatStatusLabel } from '@/utils/utils'
import '@/components/Common/Common.css'
import './Issues.css'

const SEVERITY_OPTIONS = [['all','All Severity'],['high','High'],['medium','Medium'],['low','Low']]
const STATUS_OPTIONS   = [['all','All Status'],['open','Open'],['in_review','In Review'],['resolved','Resolved'],['rejected','Rejected']]
const ISSUE_TYPE_OPTIONS = issueTypeFilterOptions()

const SEVERITY_ICON = { high: AlertOctagon, medium: AlertTriangle, low: CheckCircle2 }

export default function Issues() {
  const dispatch = useDispatch()
  const {
    searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter,
    issueTypeFilter, selectedIssueId, drawerOpen, dataSource,
  } = useSelector((s) => s.issues)

  const issues = useSelector(selectActiveIssues)
  const vendorNames = useSelector(selectActiveVendors)
  const sections = useSelector(selectActiveSections)

  // PAN is verified for every vendor in the loaded issue set at once, not
  // per-issue (see IssueDrawer, which just displays the result) — this
  // mirrors how a real bulk PAN-verification API call would work: one
  // request per vendor, not one per issue row.
  const [bulkVerifying, setBulkVerifying] = useState(false)

  function handleVerifyAllPans() {
    if (bulkVerifying) return
    const vendorPanMap = new Map()
    for (const issue of issues) {
      if (issue.vendorId && issue.vendorId !== '—' && !vendorPanMap.has(issue.vendorId)) {
        vendorPanMap.set(issue.vendorId, issue.vendorPan)
      }
    }
    const vendorIds = [...vendorPanMap.keys()]
    if (vendorIds.length === 0) {
      toast('No vendors to verify')
      return
    }
    setBulkVerifying(true)
    vendorIds.forEach((id) => dispatch(startVerifyPan(id)))
    // Simulate the latency of a real bulk government PAN API round-trip.
    setTimeout(() => {
      let active = 0, inactive = 0, invalid = 0
      vendorIds.forEach((vendorId) => {
        const result = simulatePanVerification(vendorPanMap.get(vendorId))
        dispatch(finishVerifyPan({ vendorId, result: { ...result, checkedAt: new Date().toISOString() } }))
        if (result.status === 'Active') active++
        else if (result.status === 'Inactive') inactive++
        else invalid++
      })
      setBulkVerifying(false)
      toast.success(
        `Verified ${vendorIds.length} vendor PAN${vendorIds.length === 1 ? '' : 's'} — ${active} active`
        + (inactive ? `, ${inactive} inactive` : '')
        + (invalid ? `, ${invalid} invalid format` : ''),
      )
    }, 900)
  }

  const filtered = useMemo(() => issues.filter((issue) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (
        !issue.vendor?.toLowerCase().includes(q) &&
        !issue.id?.toLowerCase().includes(q) &&
        !String(issue.docNo ?? '').toLowerCase().includes(q) &&
        !String(issue.vendorId ?? '').toLowerCase().includes(q)
      ) return false
    }
    if (vendorFilter    !== 'all' && issue.vendor    !== vendorFilter)    return false
    if (sectionFilter   !== 'all' && issue.section   !== sectionFilter)   return false
    if (severityFilter  !== 'all' && issue.severity  !== severityFilter)  return false
    if (statusFilter    !== 'all' && issue.status    !== statusFilter)    return false
    if (issueTypeFilter !== 'all' && !issueTypeFilter.split(MULTI_CATEGORY_DELIMITER).includes(getDisplayIssueType(issue))) return false
    return true
  }), [issues, searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter, issueTypeFilter])

  const selectedIssue = issues.find((i) => i.id === selectedIssueId) ?? null

  const summary = useMemo(() => ({
    high: issues.filter((i) => i.severity === 'high').length,
    medium: issues.filter((i) => i.severity === 'medium').length,
    low: issues.filter((i) => i.severity === 'low').length,
  }), [issues])

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
      const displayType = getDisplayIssueType(r)
      return (
        <div className={`issue-type-cell issue-type-cell--${r.severity}`} title={displayType}>
          <Icon size={13} />
          <span className="issue-type-text">{displayType}</span>
        </div>
      )
    }},
    { key: 'severity', header: 'Severity', render: (r) => <StatusBadge label={formatStatusLabel(r.severity)} tone={severityToTone(r.severity)} /> },
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
        <div className="issues-header-actions">
          <LiveDataBadge />
          <button className="btn btn-outline" type="button" onClick={handleVerifyAllPans} disabled={bulkVerifying}>
            {bulkVerifying ? <Loader2 size={14} className="spin" /> : <IdCard size={14} />}
            {bulkVerifying ? 'Verifying PANs…' : 'Verify All PANs'}
          </button>
          <button className="btn btn-outline" type="button">
            <Download size={14} />Export
          </button>
        </div>
      </div>

      <SapUploadPanel />

      {/* Summary strip */}
      <div className="issues-summary-grid">
        <div className="issues-summary-card issues-summary-card--danger">
          <AlertOctagon size={16} />
          <div>
            <div className="issues-summary-value">{summary.high.toLocaleString()}</div>
            <div className="issues-summary-label">Require Immediate Action</div>
          </div>
        </div>
        <div className="issues-summary-card issues-summary-card--warning">
          <AlertTriangle size={16} />
          <div>
            <div className="issues-summary-value">{summary.medium.toLocaleString()}</div>
            <div className="issues-summary-label">Review Recommended</div>
          </div>
        </div>
        <div className="issues-summary-card issues-summary-card--success">
          <CheckCircle2 size={16} />
          <div>
            <div className="issues-summary-value">{summary.low.toLocaleString()}</div>
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
            {vendorNames.slice(0, 40).map((v) => <option key={v} value={v}>{v}</option>)}
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
            {ISSUE_TYPE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
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
        <div className="issues-count-label">
          Showing {filtered.length.toLocaleString()} issue{filtered.length === 1 ? '' : 's'}
          {dataSource === 'upload' ? ' from SAP upload' : ' (sample data)'}
        </div>
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
