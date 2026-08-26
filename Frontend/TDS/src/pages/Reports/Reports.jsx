import { useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import {
  FileBarChart, FileSpreadsheet, FileText, Eye, Download, ShieldAlert,
  Gauge, Search, Users, IdCard, PieChart,
} from 'lucide-react'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import ReportViewModal from '@/components/Common/ReportViewModal'
import { selectActiveIssues, selectActiveValidationRows, selectIsLive } from '@/redux/slices/issuesSlice'
import { downloadCsv, downloadExcel, downloadPdf } from '@/utils/csvExport'
import {
  buildVendorMonthlyReport, buildExceptionReport,
  buildPanLevelReport, buildDeductionBifurcationReport, buildLdcThresholdReport,
} from '@/utils/reportBuilders'
import '@/components/Common/Common.css'
import './Reports.css'

const typeColors = {
  Trend:     { bg: 'var(--color-primary-50)', text: 'var(--color-primary)' },
  Vendor:    { bg: '#FEF3C7', text: '#92400E' },
  Exception: { bg: '#FEE2E2', text: 'var(--color-primary-dark)' },
  PAN:       { bg: '#EFF6FF', text: '#1E40AF' },
  Deduction: { bg: '#F0FDF4', text: '#166534' },
  Threshold: { bg: '#F5F3FF', text: '#5B21B6' },
}

export default function Reports() {
  const [search, setSearch] = useState('')
  const [openReportId, setOpenReportId] = useState(null)
  const isLive = useSelector(selectIsLive)
  const issues = useSelector(selectActiveIssues)
  const validationRows = useSelector(selectActiveValidationRows)
  const fileName = useSelector((s) => s.issues.uploadMeta?.fileName)

  const reportDefs = useMemo(() => {
    const fileBase = (fileName || 'report').replace(/\.[^.]+$/, '')
    const period = isLive ? (fileName ? `SAP · ${fileName}` : 'Latest SAP upload') : 'Awaiting SAP upload'

    const vendorMonthly = buildVendorMonthlyReport(issues)
    const exception = buildExceptionReport(issues)
    const panLevel = buildPanLevelReport(issues)
    const deduction = buildDeductionBifurcationReport(validationRows)
    const ldcThreshold = buildLdcThresholdReport(issues)

    return [
      {
        id: 'vendor-monthly',
        name: 'Vendor-wise Month-on-Month',
        type: 'Vendor',
        icon: Users,
        description: 'Issue count and tax impact per vendor, broken down by month.',
        period, filenameBase: `${fileBase}-vendor-month-on-month`, ...vendorMonthly,
      },
      {
        id: 'exception',
        name: 'Exception Report',
        type: 'Exception',
        icon: ShieldAlert,
        description: 'No TDS deduction / Not Applicable violations only — where TDS was missed or wrongly deducted.',
        period, filenameBase: `${fileBase}-exception-report`, ...exception,
      },
      {
        id: 'pan-level',
        name: 'PAN-Level Report',
        type: 'PAN',
        icon: IdCard,
        description: 'Issues grouped by vendor PAN rather than vendor code — surfaces one vendor operating under multiple codes.',
        period, filenameBase: `${fileBase}-pan-level`, ...panLevel,
      },
      {
        id: 'deduction',
        name: 'TDS Deduction Report',
        type: 'Deduction',
        icon: PieChart,
        description: 'Every transaction bifurcated into Correct, Short, Excess, No Deduction, or Not Applicable.',
        period, filenameBase: `${fileBase}-tds-deduction`, ...deduction,
      },
      {
        id: 'ldc-threshold',
        name: 'LDC & Threshold Monitoring',
        type: 'Threshold',
        icon: Gauge,
        description: 'Lower Deduction Certificate validity/mismatch issues plus threshold-crossed and premature-deduction cases.',
        period, filenameBase: `${fileBase}-ldc-threshold`, ...ldcThreshold,
      },
    ]
  }, [issues, validationRows, isLive, fileName])

  const filtered = reportDefs.filter((r) =>
    r.name.toLowerCase().includes(search.toLowerCase()) ||
    r.type.toLowerCase().includes(search.toLowerCase())
  )

  const openReport = reportDefs.find((r) => r.id === openReportId) ?? null

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
        <div className="issues-header-actions">
          <LiveDataBadge />
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
            const Icon = report.icon ?? FileBarChart
            const tc = typeColors[report.type] ?? typeColors.Trend
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
                  <span className="font-mono">{report.rows.length.toLocaleString()} rows</span>
                </div>
                <div className="report-actions">
                  <button className="btn btn-outline btn-sm report-action-btn" type="button" onClick={() => setOpenReportId(report.id)}>
                    <Eye size={12} />View
                  </button>
                  <button
                    className="btn btn-outline btn-sm report-action-btn"
                    type="button"
                    disabled={report.rows.length === 0}
                    onClick={() => downloadCsv(`${report.filenameBase}.csv`, report.columns, report.rows)}
                  >
                    <Download size={12} />CSV
                  </button>
                  <button
                    className="btn btn-outline btn-sm report-action-btn"
                    type="button"
                    disabled={report.rows.length === 0}
                    onClick={() => downloadExcel(`${report.filenameBase}.xlsx`, report.columns, report.rows)}
                  >
                    <FileSpreadsheet size={12} />Excel
                  </button>
                  <button
                    className="btn btn-outline btn-sm report-action-btn"
                    type="button"
                    disabled={report.rows.length === 0}
                    onClick={() => downloadPdf(`${report.filenameBase}.pdf`, report.name, report.columns, report.rows)}
                  >
                    <FileText size={12} />PDF
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {openReport && (
        <ReportViewModal
          title={openReport.name}
          description={openReport.description}
          columns={openReport.columns}
          rows={openReport.rows}
          filenameBase={openReport.filenameBase}
          onClose={() => setOpenReportId(null)}
        />
      )}
    </div>
  )
}
