import { X, Download, FileSpreadsheet, FileText } from 'lucide-react'
import DataTable from './DataTable'
import { downloadCsv, downloadExcel, downloadPdf } from '@/utils/csvExport'

/**
 * Generic report viewer — every report on the Reports page is just a
 * (title, columns, rows) triple, rendered through one shared modal instead
 * of six bespoke pages. `columns` uses the same {label, value(row)} shape
 * csvExport.js already expects, so the same column list drives the on-screen
 * table and all three export formats with no duplication.
 */
export default function ReportViewModal({ title, description, columns, rows, filenameBase, onClose }) {
  if (!title) return null

  const tableColumns = columns.map((c) => ({
    header: c.label,
    render: (row) => {
      const v = c.value(row)
      return v == null || v === '' ? '—' : v
    },
  }))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="report-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="report-modal-header">
          <div style={{ minWidth: 0 }}>
            <h3 className="settings-card-title">{title}</h3>
            {description && <p className="report-modal-desc">{description}</p>}
          </div>
          <button className="issue-drawer-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="report-modal-toolbar">
          <span className="report-modal-count">{rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'}</span>
          <div className="report-modal-export-actions">
            <button
              className="btn btn-outline btn-sm"
              type="button"
              disabled={rows.length === 0}
              onClick={() => downloadCsv(`${filenameBase}.csv`, columns, rows)}
            >
              <Download size={12} />CSV
            </button>
            <button
              className="btn btn-outline btn-sm"
              type="button"
              disabled={rows.length === 0}
              onClick={() => downloadExcel(`${filenameBase}.xlsx`, columns, rows)}
            >
              <FileSpreadsheet size={12} />Excel
            </button>
            <button
              className="btn btn-outline btn-sm"
              type="button"
              disabled={rows.length === 0}
              onClick={() => downloadPdf(`${filenameBase}.pdf`, title, columns, rows)}
            >
              <FileText size={12} />PDF
            </button>
          </div>
        </div>

        <div className="report-modal-table">
          <DataTable
            columns={tableColumns}
            data={rows}
            pageSize={20}
            emptyState={
              <div className="empty-state">
                <div className="empty-state-title">No rows for this report</div>
                <div className="empty-state-desc">Nothing in the current Company/FY scope matches this report.</div>
              </div>
            }
          />
        </div>
      </div>
    </div>
  )
}
