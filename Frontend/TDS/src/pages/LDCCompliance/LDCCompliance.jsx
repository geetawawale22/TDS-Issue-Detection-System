import { useEffect, useMemo, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'
import {
  AlertTriangle, CheckCircle2, FileSpreadsheet, IdCard, Upload,
  ShieldCheck, Search, XCircle, BadgeIndianRupee,
} from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import ProgressBar from '@/components/Common/ProgressBar'
import StatusBadge from '@/components/Common/StatusBadge'
import { selectLdcUtilization } from '@/redux/slices/issuesSlice'
import { fetchLdcCertificates, uploadLdcCertificates } from '@/services/ldcService'
import '@/components/Common/Common.css'
import './LDCCompliance.css'

const REQUIRED_COLUMNS = [
  'Certificate_Number',
  'Certificate_Type',
  'PAN',
  'Vendor_Name',
  'Company_Code',
  'TDS_Section',
  'Approved_TDS_Rate',
  'Valid_From',
  'Valid_To',
  'Status',
  'Is_Verified',
]

const SAMPLE_VENDOR_MASTER = [
  { pan: 'AAAFE3841P', vendorName: 'EVERGREEN MOTORS', vendorCode: 'E5684' },
  { pan: 'AAAFE3841P', vendorName: 'EVERGREEN MOTORS', vendorCode: 'E010081' },
  { pan: 'AAEPZ9355R', vendorName: 'CAPITAL TRADERS & ENGINEE', vendorCode: 'EBU23812' },
  { pan: 'ABTPN5043J', vendorName: 'SITARA ENTERPRISES', vendorCode: 'DIS02169AA' },
  { pan: 'ABTPN5043J', vendorName: 'SITARA ENTERPRISES', vendorCode: 'SITAT105CH' },
  { pan: 'AACCS3003L', vendorName: 'STEEL STRIPS WHEELS LIMITED', vendorCode: 'DDS00033AJ' },
  { pan: 'AACCS3003L', vendorName: 'STEEL STRIPS WHEELS LIMITED', vendorCode: 'DS146' },
  { pan: 'AACCS3003L', vendorName: 'STEEL STRIPS WHEELS LIMITED', vendorCode: 'DS146A' },
  { pan: 'AACCS3003L', vendorName: 'STEEL STRIPS WHEELS LIMITED', vendorCode: 'DS146D' },
]

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/
const TODAY = new Date()
TODAY.setHours(0, 0, 0, 0)

function clean(value) {
  return String(value ?? '').trim()
}

function normalizeHeader(value) {
  return clean(value).replace(/\s+/g, '_')
}

function parseBool(value) {
  const text = clean(value).toLowerCase()
  return ['true', 'yes', 'y', '1', 'verified'].includes(text)
}

function parseDateValue(value) {
  if (!value) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const date = new Date(value)
    date.setHours(0, 0, 0, 0)
    return date
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (!parsed) return null
    return new Date(parsed.y, parsed.m - 1, parsed.d)
  }
  const date = new Date(clean(value))
  if (Number.isNaN(date.getTime())) return null
  date.setHours(0, 0, 0, 0)
  return date
}

function formatDate(date) {
  if (!date) return '—'
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function normalizeRow(row, index) {
  const normalized = {}
  Object.entries(row).forEach(([key, value]) => {
    normalized[normalizeHeader(key)] = value
  })

  const validFrom = parseDateValue(normalized.Valid_From)
  const validTo = parseDateValue(normalized.Valid_To)
  const rate = Number(clean(normalized.Approved_TDS_Rate))
  const limit = Number(clean(normalized.Approved_Amount_Limit))

  return {
    id: `ldc-${index}`,
    rowNumber: index + 2,
    certificateNumber: clean(normalized.Certificate_Number),
    certificateType: clean(normalized.Certificate_Type).toUpperCase(),
    pan: clean(normalized.PAN).toUpperCase(),
    vendorName: clean(normalized.Vendor_Name),
    vendorCode: clean(normalized.Vendor_Code),
    companyCode: clean(normalized.Company_Code),
    deductorTan: clean(normalized.Deductor_TAN).toUpperCase(),
    section: clean(normalized.TDS_Section).toUpperCase(),
    approvedRate: Number.isFinite(rate) ? rate : null,
    validFrom,
    validTo,
    taxYear: clean(normalized.Tax_Year),
    approvedLimit: Number.isFinite(limit) ? limit : null,
    status: clean(normalized.Status).toUpperCase(),
    isVerified: parseBool(normalized.Is_Verified),
    lastVerifiedDate: parseDateValue(normalized.Last_Verified_Date),
    parentCertificateNumber: clean(normalized.Parent_Certificate_Number),
    isChildCertificate: parseBool(normalized.Is_Child_Certificate),
    remarks: clean(normalized.Remarks),
  }
}

function validateRows(rows) {
  const certificateCounts = new Map()
  rows.forEach((row) => {
    if (!row.certificateNumber) return
    const key = `${row.certificateNumber}|${row.pan}|${row.companyCode}|${row.deductorTan}|${row.section}`
    certificateCounts.set(key, (certificateCounts.get(key) ?? 0) + 1)
  })

  const vendorCodesByPan = SAMPLE_VENDOR_MASTER.reduce((acc, vendor) => {
    if (!acc[vendor.pan]) acc[vendor.pan] = []
    acc[vendor.pan].push(vendor.vendorCode)
    return acc
  }, {})

  return rows.map((row) => {
    const issues = []
    if (!row.certificateNumber) issues.push('Certificate number missing')
    if (!['LOWER', 'NIL'].includes(row.certificateType)) issues.push('Certificate type must be LOWER or NIL')
    if (!PAN_RE.test(row.pan)) issues.push('PAN format invalid')
    if (!row.vendorName) issues.push('Vendor name missing')
    if (!row.companyCode) issues.push('Company code missing')
    if (!row.section) issues.push('TDS section missing')
    if (row.approvedRate == null) issues.push('Approved TDS rate missing/invalid')
    if (row.approvedRate != null && row.approvedRate < 0) issues.push('Approved TDS rate cannot be negative')
    if (row.certificateType === 'NIL' && row.approvedRate !== 0) issues.push('NIL certificate must have 0% approved rate')
    if (!row.validFrom) issues.push('Valid From date missing/invalid')
    if (!row.validTo) issues.push('Valid To date missing/invalid')
    if (row.validFrom && row.validTo && row.validFrom > row.validTo) issues.push('Valid From is after Valid To')
    if (row.validFrom && TODAY < row.validFrom) issues.push('Certificate not yet valid')
    if (row.validTo && TODAY > row.validTo) issues.push('Certificate expired')
    if (row.status !== 'ACTIVE') issues.push('Certificate status is not ACTIVE')
    if (!row.isVerified) issues.push('Certificate not verified')
    if (!vendorCodesByPan[row.pan]) issues.push('PAN not found in temporary vendor master')
    if (row.approvedLimit == null) issues.push('Approved amount limit missing/invalid')
    if (row.isChildCertificate && !row.parentCertificateNumber) issues.push('Child certificate missing parent certificate')

    const duplicateKey = `${row.certificateNumber}|${row.pan}|${row.companyCode}|${row.deductorTan}|${row.section}`
    if (certificateCounts.get(duplicateKey) > 1) issues.push('Duplicate certificate scope in upload')

    return {
      ...row,
      vendorCodes: vendorCodesByPan[row.pan] ?? [],
      validationStatus: issues.length ? 'Issue' : 'Valid',
      issues,
    }
  })
}

export default function LDCCompliance() {
  const liveLdcUtilization = useSelector(selectLdcUtilization)
  const [rows, setRows] = useState([])
  const [fileName, setFileName] = useState('')
  const [search, setSearch] = useState('')
  const [uploadResult, setUploadResult] = useState(null)
  const [isUploading, setIsUploading] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    let isMounted = true
    fetchLdcCertificates()
      .then((result) => {
        if (!isMounted) return
        const savedRows = (result.certificates ?? []).map((row, index) => ({
          id: `saved-ldc-${index}`,
          rowNumber: row.rowNumber,
          certificateNumber: row.certificateNumber || '',
          certificateType: row.certificateType || '',
          pan: row.pan || '',
          vendorName: row.vendorName || '',
          vendorCode: '',
          companyCode: row.companyCode || '',
          deductorTan: row.deductorTan || '',
          section: row.section || '',
          approvedRate: row.approvedRate ?? null,
          validFrom: parseDateValue(row.validFrom),
          validTo: parseDateValue(row.validTo),
          taxYear: row.taxYear || '',
          approvedLimit: row.approvedLimit ?? null,
          status: row.status || '',
          isVerified: Boolean(row.isVerified),
          lastVerifiedDate: parseDateValue(row.lastVerifiedDate),
          parentCertificateNumber: row.parentCertificateNumber || '',
          isChildCertificate: Boolean(row.isChildCertificate),
          remarks: row.remarks || '',
          vendorCodes: [],
          validationStatus: (row.issues ?? []).length ? 'Issue' : 'Valid',
          issues: row.issues ?? [],
        }))
        setRows(savedRows)
        if (savedRows.length) {
          setFileName('Saved LDC certificate master')
          setUploadResult({
            inserted: 0,
            updated: savedRows.length,
            issueRows: savedRows.filter((row) => row.issues.length).length,
          })
        }
      })
      .catch(() => {
        // The page can still be used for upload if the saved-list endpoint is temporarily unavailable.
      })
    return () => { isMounted = false }
  }, [])

  async function handleFile(file) {
    if (!file) return
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!['csv', 'xlsx', 'xls', 'xlsm'].includes(extension)) {
      toast.error('Upload a CSV, XLSX, XLSM, or XLS file.')
      return
    }

    try {
      setIsUploading(true)
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
      if (!rawRows.length) {
        toast.error('The uploaded file has no LDC rows.')
        return
      }

      const headers = Object.keys(rawRows[0]).map(normalizeHeader)
      const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column))
      if (missing.length) {
        toast.error(`Missing columns: ${missing.join(', ')}`)
      }

      const localRows = validateRows(rawRows.map(normalizeRow))
      const result = await uploadLdcCertificates(file)
      const backendIssuesByRow = new Map((result.certificates ?? []).map((row) => [row.rowNumber, row.issues ?? []]))

      setRows(localRows.map((row) => {
        const backendIssues = backendIssuesByRow.get(row.rowNumber)
        if (!backendIssues) return row
        return {
          ...row,
          issues: backendIssues,
          validationStatus: backendIssues.length ? 'Issue' : 'Valid',
        }
      }))
      setUploadResult(result)
      setFileName(file.name)
      toast.success(`LDC file saved. ${result.inserted} inserted, ${result.updated} updated.`)
    } catch (error) {
      toast.error(error.message || 'Could not upload this file. Check the format and try again.')
    } finally {
      setIsUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const stats = useMemo(() => {
    const issueRows = rows.filter((row) => row.issues.length)
    const uniquePans = new Set(rows.map((row) => row.pan).filter(Boolean))
    const active = rows.filter((row) => row.status === 'ACTIVE')
    return {
      total: rows.length,
      valid: rows.length - issueRows.length,
      issues: issueRows.length,
      uniquePans: uniquePans.size,
      active: active.length,
      totalLimit: rows.reduce((sum, row) => sum + (row.approvedLimit ?? 0), 0),
    }
  }, [rows])

  const filteredRows = useMemo(() => {
    const needle = search.toLowerCase()
    return rows.filter((row) =>
      row.certificateNumber.toLowerCase().includes(needle) ||
      row.pan.toLowerCase().includes(needle) ||
      row.vendorName.toLowerCase().includes(needle) ||
      row.section.toLowerCase().includes(needle)
    )
  }, [rows, search])

  const columns = [
    { key: 'certificateNumber', header: 'Certificate', render: (row) => (
      <div>
        <div className="ldc-strong">{row.certificateNumber || '—'}</div>
        <div className="ldc-muted">{row.certificateType || '—'} · {row.section || '—'}</div>
      </div>
    )},
    { key: 'pan', header: 'PAN / Vendor', render: (row) => (
      <div>
        <div className="font-mono ldc-strong">{row.pan || '—'}</div>
        <div className="ldc-muted">{row.vendorName || '—'}</div>
      </div>
    )},
    { key: 'companyCode', header: 'Company / TAN', render: (row) => (
      <div>
        <div className="font-mono">{row.companyCode || '—'}</div>
        <div className="ldc-muted">{row.deductorTan || 'TAN not supplied'}</div>
      </div>
    )},
    { key: 'approvedRate', header: 'Rate', render: (row) => <span className="font-mono">{row.approvedRate == null ? '—' : `${row.approvedRate}%`}</span> },
    { key: 'approvedLimit', header: 'Limit', render: (row) => <span className="font-mono">{row.approvedLimit == null ? '—' : row.approvedLimit.toLocaleString('en-IN')}</span> },
    { key: 'validTo', header: 'Validity', render: (row) => (
      <span className="ldc-muted">{formatDate(row.validFrom)} to {formatDate(row.validTo)}</span>
    )},
    { key: 'validationStatus', header: 'Status', render: (row) => (
      <StatusBadge label={row.validationStatus} tone={row.issues.length ? 'danger' : 'success'} />
    )},
    { key: 'issues', header: 'Issues', render: (row) => (
      row.issues.length
        ? <span className="ldc-issue-text">{row.issues.join('; ')}</span>
        : <span className="ldc-muted">No issue found</span>
    )},
  ]

  const utilizationTone = (status) => {
    if (status === 'over_utilized' || status === 'exhausted') return 'danger'
    if (status === 'high_warning' || status === 'warning') return 'warning'
    return 'success'
  }

  const utilizationColumns = [
    { key: 'certificateNumber', header: 'Certificate', render: (row) => (
      <div>
        <div className="ldc-strong">{row.certificateNumber}</div>
        <div className="ldc-muted">{row.section} · {row.approvedRate ?? '—'}%</div>
      </div>
    )},
    { key: 'vendor', header: 'Vendor / PAN', render: (row) => (
      <div>
        <div className="ldc-strong">{row.vendor}</div>
        <div className="font-mono ldc-muted">{row.pan}</div>
      </div>
    )},
    { key: 'limit', header: 'Limit', render: (row) => <span className="font-mono">{row.limit == null ? 'Not set' : row.limit.toLocaleString('en-IN')}</span> },
    { key: 'used', header: 'Used', render: (row) => <span className="font-mono">{Number(row.used || 0).toLocaleString('en-IN')}</span> },
    { key: 'available', header: 'Available', render: (row) => <span className="font-mono">{row.available == null ? '—' : Number(row.available).toLocaleString('en-IN')}</span> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge label={row.statusLabel || 'Within LDC Limit'} tone={utilizationTone(row.status)} /> },
    { key: 'utilization', header: 'Utilization', render: (row) => (
      row.utilization == null
        ? <span className="ldc-muted">—</span>
        : <div style={{ width: 130 }}><ProgressBar value={Math.min(row.utilization, 100)} showLabel /></div>
    )},
  ]

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">LDC Compliance</span>
          </div>
          <h1 className="page-title">LDC Compliance</h1>
        </div>
        <button className="btn btn-primary" type="button" disabled={isUploading} onClick={() => inputRef.current?.click()}>
          <Upload size={14} />{isUploading ? 'Uploading…' : 'Upload LDC File'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.xls,.xlsm"
          className="ldc-file-input"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      </div>

      <div className="ldc-upload-panel">
        <div className="ldc-upload-icon"><FileSpreadsheet size={22} /></div>
        <div className="ldc-upload-copy">
          <div className="ldc-upload-title">{fileName || 'Upload LDC certificate master'}</div>
          <div className="ldc-upload-sub">
            {uploadResult
              ? `${uploadResult.inserted} inserted · ${uploadResult.updated} updated · ${uploadResult.issueRows} issue rows`
              : `Required columns: ${REQUIRED_COLUMNS.join(', ')}`}
          </div>
        </div>
      </div>

      <div className="summary-grid-4">
        <div className="kpi-card">
          <div className="kpi-icon-row"><span className="kpi-label">Certificates</span><div className="kpi-icon-box info"><FileSpreadsheet size={14} /></div></div>
          <span className="kpi-value">{stats.total}</span>
          <span className="ldc-muted">Rows uploaded</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon-row"><span className="kpi-label">Valid Rows</span><div className="kpi-icon-box success"><CheckCircle2 size={14} /></div></div>
          <span className="kpi-value">{stats.valid}</span>
          <span className="ldc-muted">Ready for rule lookup</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon-row"><span className="kpi-label">Issue Rows</span><div className="kpi-icon-box danger"><AlertTriangle size={14} /></div></div>
          <span className="kpi-value">{stats.issues}</span>
          <span className="ldc-muted">Needs certificate cleanup</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon-row"><span className="kpi-label">Covered Limit</span><div className="kpi-icon-box warning"><BadgeIndianRupee size={14} /></div></div>
          <span className="kpi-value">{stats.totalLimit.toLocaleString('en-IN')}</span>
          <span className="ldc-muted">{stats.uniquePans} unique PANs · {stats.active} active</span>
        </div>
      </div>

      <div className="ldc-master-grid">
        <div className="table-card">
          <div className="table-card-header">
            <div>
              <div className="table-card-title">LDC Certificate Validation</div>
            </div>
            <div className="ldc-search-wrapper">
              <Search size={14} />
              <input
                className="filter-input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search LDC, PAN, vendor…"
              />
            </div>
          </div>
          <DataTable columns={columns} data={filteredRows} pageSize={8} />
        </div>

        <div className="ldc-side-panel">
          <div className="ldc-side-header">
            <ShieldCheck size={16} />
            <span>Temporary Vendor Master</span>
          </div>
          <div className="ldc-vendor-list">
            {Object.entries(
              SAMPLE_VENDOR_MASTER.reduce((acc, vendor) => {
                if (!acc[vendor.pan]) acc[vendor.pan] = { vendorName: vendor.vendorName, codes: [] }
                acc[vendor.pan].codes.push(vendor.vendorCode)
                return acc
              }, {})
            ).map(([pan, vendor]) => (
              <div className="ldc-vendor-row" key={pan}>
                <div>
                  <div className="font-mono ldc-strong">{pan}</div>
                  <div className="ldc-muted">{vendor.vendorName}</div>
                </div>
                <div className="ldc-code-list">{vendor.codes.join(', ')}</div>
              </div>
            ))}
          </div>
          <div className="ldc-side-footer">
            <XCircle size={14} />
            <span>Unknown PANs in an LDC upload are flagged until vendor master is updated.</span>
          </div>
        </div>
      </div>

      <div className="table-card ldc-utilization-card">
        <div className="table-card-header">
          <div>
            <div className="table-card-title">LDC Limit Utilization</div>
          </div>
        </div>
        <DataTable
          columns={utilizationColumns}
          data={liveLdcUtilization}
          pageSize={8}
          emptyState={<div className="data-table-empty">Upload and analyse an SAP file to see live LDC utilization</div>}
        />
      </div>
    </div>
  )
}
