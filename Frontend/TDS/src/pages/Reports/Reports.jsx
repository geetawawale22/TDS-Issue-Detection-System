import { useState } from 'react'
import {
  FileBarChart, FileSpreadsheet, Eye, Download, ShieldAlert,
  Gauge, ClipboardCheck, CalendarRange, Search,
} from 'lucide-react'
import { reports } from '@/data/mockData'
import '@/components/Common/Common.css'
import './Reports.css'

const iconMap = {
  'Compliance Summary':        FileBarChart,
  'Vendor Risk Report':        ShieldAlert,
  'Threshold Analysis':        Gauge,
  'Audit Report':              ClipboardCheck,
  'Monthly Compliance Report': CalendarRange,
}

const typeColors = {
  'Summary':      { bg: 'var(--color-primary-50)',   text: 'var(--color-primary)' },
  'Risk Analysis':{ bg: '#FEF3C7',                   text: '#92400E' },
  'Threshold':    { bg: '#EFF6FF',                   text: '#1E40AF' },
  'Audit':        { bg: '#F0FDF4',                   text: '#166534' },
  'Monthly':      { bg: '#F5F3FF',                   text: '#5B21B6' },
}

export default function Reports() {
  const [search, setSearch] = useState('')

  const filtered = reports.filter((r) =>
    r.name.toLowerCase().includes(search.toLowerCase()) ||
    r.type.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">Reports</span>
          </div>
          <h1 className="page-title">Reports</h1>
        </div>
        <div className="reports-search-wrapper">
          <Search size={14} className="reports-search-icon" />
          <input
            className="filter-input reports-search"
            placeholder="Search reports…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><FileBarChart size={20} /></div>
          <div className="empty-state-title">No reports found</div>
          <div className="empty-state-desc">Try a different search term.</div>
        </div>
      ) : (
        <div className="reports-grid">
          {filtered.map((report) => {
            const Icon = iconMap[report.name] ?? FileBarChart
            const tc = typeColors[report.type] ?? typeColors.Summary
            return (
              <div key={report.id} className="report-card">
                <div className="report-card-header">
                  <div className="report-icon-box" style={{ background: tc.bg }}>
                    <Icon size={18} style={{ color: tc.text }} />
                  </div>
                  <div className="report-type-tag" style={{ background: tc.bg, color: tc.text }}>
                    {report.type}
                  </div>
                </div>
                <h3 className="report-name">{report.name}</h3>
                <p className="report-desc">{report.description}</p>
                <div className="report-meta">
                  <span>{report.period}</span>
                  <span className="font-mono">{report.lastGenerated}</span>
                </div>
                <div className="report-actions">
                  <button className="btn btn-outline btn-sm report-action-btn">
                    <Eye size={12} />View
                  </button>
                  <button className="btn btn-outline btn-sm report-action-btn">
                    <Download size={12} />PDF
                  </button>
                  <button className="btn btn-outline btn-sm report-action-btn">
                    <FileSpreadsheet size={12} />Excel
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
