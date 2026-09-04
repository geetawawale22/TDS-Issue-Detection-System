import { useEffect, useMemo, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'
import {
  AlertTriangle, CheckCircle2, FileSpreadsheet, IdCard, Upload,
  ShieldCheck, Search, XCircle,
} from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import ProgressBar from '@/components/Common/ProgressBar'
import StatusBadge from '@/components/Common/StatusBadge'
import { selectLdcUtilization } from '@/redux/slices/issuesSlice'
import { fetchLdcCertificates, uploadLdcCertificates } from '@/services/ldcService'
import '@/components/Common/Common.css'
import './LDCCompliance.css'

const REQUIRED_COLUMNS = [
  'PAN',
  'Company_Code',
  'Exemption_Number',
  'Exemption_Percentage',
  'Exemption_From',
  'Exemption_To',
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
const LDC_TEMP_STORAGE_KEY = 'tds.ldcCompliance.tempRows'
const TODAY = new Date()
TODAY.setHours(0, 0, 0, 0)
const EXPIRING_SOON_DAYS = 30

function clean(value) {
  return String(value ?? '').trim()
}

function normalizeHeader(value) {
  return clean(value).replace(/\s+/g, '_')
}

function parseBool(value) {
  if (clean(value) === '') return false
  const text = clean(value).toLowerCase()
  return ['true', 'yes', 'y', '1', 'verified', 'x', 'active'].includes(text)
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
  const text = clean(value)
  if (/^\d{8}$/.test(text)) {
    const date = new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)))
    return Number.isNaN(date.getTime()) ? null : date
  }
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return null
  date.setHours(0, 0, 0, 0)
  return date
}

function formatDate(date) {
  if (!date) return '—'
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function dateStatus(row) {
  if (!row.validFrom || !row.validTo) return 'Unknown'
  if (TODAY < row.validFrom) return 'Future'
  if (TODAY > row.validTo) return 'Expired'
  return 'Active'
}

function isExpiringSoon(row) {
  if (dateStatus(row) !== 'Active') return false
  const daysUntilExpiry = (row.validTo.getTime() - TODAY.getTime()) / (1000 * 60 * 60 * 24)
  return daysUntilExpiry >= 0 && daysUntilExpiry <= EXPIRING_SOON_DAYS
}

function ldcSectionKey(normalized) {
  const explicitSection = clean(normalized.TDS_Section || normalized.Applicable_TDS_Section).toUpperCase()
  if (explicitSection) return explicitSection
  const wtaxType = clean(normalized.WTax_Type).toUpperCase()
  const wtx = clean(normalized.WTx).toUpperCase()
  if (wtaxType && wtx) return `${wtaxType}/${wtx}`
  return wtx || wtaxType
}

function serializeRowsForStorage(rowsToStore) {
  return rowsToStore.map((row) => ({
    ...row,
    validFrom: row.validFrom instanceof Date ? row.validFrom.toISOString() : row.validFrom,
    validTo: row.validTo instanceof Date ? row.validTo.toISOString() : row.validTo,
    lastVerifiedDate: row.lastVerifiedDate instanceof Date ? row.lastVerifiedDate.toISOString() : row.lastVerifiedDate,
  }))
}

function restoreRowsFromStorage() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(LDC_TEMP_STORAGE_KEY) || '[]')
    return stored.map((row, index) => ({
      ...row,
      id: row.id || `temp-ldc-${index}`,
      validFrom: parseDateValue(row.validFrom),
      validTo: parseDateValue(row.validTo),
      lastVerifiedDate: parseDateValue(row.lastVerifiedDate),
      issues: row.issues ?? [],
      vendorCodes: row.vendorCodes ?? [],
      validationStatus: row.validationStatus || ((row.issues ?? []).length ? 'Issue' : 'Valid'),
    }))
  } catch {
    return []
  }
}

function uploadSummary(uploadResult, rowCount) {
  if (!uploadResult) return `Required columns: ${REQUIRED_COLUMNS.join(', ')}`
  const csvRows = uploadResult.totalRows ?? rowCount
  const uniqueSaved = uploadResult.inserted + uploadResult.updated
  return `${csvRows} CSV rows · ${uniqueSaved} unique saved · ${uploadResult.issueRows} issue rows`
}

function normalizeRow(row, index) {
  const normalized = {}
  Object.entries(row).forEach(([key, value]) => {
    normalized[normalizeHeader(key)] = value
  })

  const rawPan = clean(normalized.PAN || normalized.Tax_Number_3 || normalized.Tax_Number_1).toUpperCase()
  const pan = rawPan.length === 15 ? rawPan.slice(2, 12) : rawPan
  const validFrom = parseDateValue(normalized.Valid_From || normalized.Exemption_From)
  const validTo = parseDateValue(normalized.Valid_To || normalized.Exemption_To)
  const rate = Number(clean(normalized.Approved_TDS_Rate || normalized.Exemption_Percentage))
  const limit = Number(clean(normalized.Approved_Amount_Limit))

  return {
    id: `ldc-${index}`,
    rowNumber: index + 2,
    certificateNumber: clean(normalized.Certificate_Number || normalized.Exemption_Number),
    certificateType: clean(normalized.Certificate_Type || 'LOWER').toUpperCase(),
    pan,
    vendorName: clean(normalized.Vendor_Name || normalized.Supplier_Name || normalized.Supplier),
    vendorCode: clean(normalized.Vendor_Code || normalized.Supplier),
    companyCode: clean(normalized.Company_Code),
    deductorTan: clean(normalized.Deductor_TAN).toUpperCase(),
    section: ldcSectionKey(normalized),
    approvedRate: Number.isFinite(rate) ? rate : null,
    validFrom,
    validTo,
    taxYear: clean(normalized.Tax_Year),
    approvedLimit: Number.isFinite(limit) ? limit : null,
    status: clean(normalized.Status || 'ACTIVE').toUpperCase(),
    isVerified: parseBool(normalized.Is_Verified || normalized.W_Tax || 'true'),
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

  return rows.map((row) => {
    const issues = []
    if (!row.certificateNumber) issues.push('Certificate number missing')
    if (!['LOWER', 'NIL'].includes(row.certificateType)) issues.push('Certificate type must be LOWER or NIL')
    if (!PAN_RE.test(row.pan)) issues.push('PAN format invalid')
    if (!row.vendorName) issues.push('Vendor name missing')
    if (!row.companyCode) issues.push('Company code missing')
    if (!row.section) issues.push('TDS section missing')
    if (row.approvedRate == null) issues.push('Exemption percentage missing/invalid')
    if (row.approvedRate != null && row.approvedRate < 0) issues.push('Exemption percentage cannot be negative')
    if (!row.validFrom) issues.push('Valid From date missing/invalid')
    if (!row.validTo) issues.push('Valid To date missing/invalid')
    if (row.validFrom && row.validTo && row.validFrom > row.validTo) issues.push('Valid From is after Valid To')
    if (row.status !== 'ACTIVE') issues.push('Certificate status is not ACTIVE')
    if (!row.isVerified) issues.push('Certificate not verified')
    if (row.isChildCertificate && !row.parentCertificateNumber) issues.push('Child certificate missing parent certificate')

    const duplicateKey = `${row.certificateNumber}|${row.pan}|${row.companyCode}|${row.deductorTan}|${row.section}`
    if (certificateCounts.get(duplicateKey) > 1) issues.push('Duplicate certificate scope in upload')

    return {
      ...row,
      vendorCodes: row.vendorCode ? [row.vendorCode] : [],
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
  const [quickFilter, setQuickFilter] = useState('all')
  const [uploadResult, setUploadResult] = useState(null)
  const [isUploading, setIsUploading] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    let isMounted = true
    const tempRows = restoreRowsFromStorage()
    if (tempRows.length) {
      setRows(tempRows)
      setFileName('Saved temporary LDC upload')
      setUploadResult({
        inserted: 0,
        updated: tempRows.length,
        issueRows: tempRows.filter((row) => row.issues.length).length,
        totalRows: tempRows.length,
      })
    }
    fetchLdcCertificates()
      .then((result) => {
        if (!isMounted || tempRows.length) return
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

      const mergedRows = localRows.map((row) => {
        const backendIssues = backendIssuesByRow.get(row.rowNumber)
        if (!backendIssues) return row
        return {
          ...row,
          issues: backendIssues,
          validationStatus: backendIssues.length ? 'Issue' : 'Valid',
        }
      })
      setRows(mergedRows)
      window.localStorage.setItem(LDC_TEMP_STORAGE_KEY, JSON.stringify(serializeRowsForStorage(mergedRows)))
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
    const active = rows.filter((row) => row.status === 'ACTIVE' && dateStatus(row) === 'Active')
    const expired = rows.filter((row) => dateStatus(row) === 'Expired')
    const future = rows.filter((row) => dateStatus(row) === 'Future')
    const expiringSoon = rows.filter(isExpiringSoon)
    return {
      total: rows.length,
      valid: rows.length - issueRows.length,
      issues: issueRows.length,
      uniquePans: uniquePans.size,
      active: active.length,
      expired: expired.length,
      future: future.length,
      expiringSoon: expiringSoon.length,
    }
  }, [rows])

  const filteredRows = useMemo(() => {
    const needle = search.toLowerCase()
    return rows.filter((row) => {
      if (quickFilter === 'unique-pans') {
        const firstPanRow = rows.find((candidate) => candidate.pan && candidate.pan === row.pan)
        if (firstPanRow?.id !== row.id) return false
      }
      if (quickFilter === 'active' && !(row.status === 'ACTIVE' && dateStatus(row) === 'Active')) return false
      if (quickFilter === 'expiring' && !isExpiringSoon(row)) return false

      return (
      row.certificateNumber.toLowerCase().includes(needle) ||
      row.pan.toLowerCase().includes(needle) ||
      row.vendorName.toLowerCase().includes(needle) ||
      row.section.toLowerCase().includes(needle)
      )
    })
  }, [rows, search, quickFilter])

  const quickFilterLabel = {
    all: 'Uploaded Rows',
    'unique-pans': 'Unique PANs',
    active: 'Active Certificates',
    expiring: `Expiring in ${EXPIRING_SOON_DAYS} Days`,
  }[quickFilter]

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
    { key: 'approvedRate', header: 'Exemption %', render: (row) => <span className="font-mono">{row.approvedRate == null ? '—' : `${row.approvedRate}%`}</span> },
    { key: 'validTo', header: 'Valid Till', render: (row) => (
      <div>
        <div className="font-mono">{formatDate(row.validTo)}</div>
        <div className="ldc-muted">{dateStatus(row)} · from {formatDate(row.validFrom)}</div>
      </div>
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
        <div className="ldc-muted">{row.section} · exemption {row.approvedRate ?? '—'}%</div>
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
              ? uploadSummary(uploadResult, rows.length)
              : `Required columns: ${REQUIRED_COLUMNS.join(', ')}`}
          </div>
        </div>
      </div>

      <div className="summary-grid-4">
        <button type="button" className={`kpi-card ldc-kpi-button ${quickFilter === 'all' ? 'is-active' : ''}`} onClick={() => setQuickFilter('all')}>
          <div className="kpi-icon-row"><span className="kpi-label">Uploaded Rows</span><div className="kpi-icon-box info"><FileSpreadsheet size={14} /></div></div>
          <span className="kpi-value">{stats.total}</span>
          <span className="ldc-muted">Rows from latest LDC CSV</span>
        </button>
        <button type="button" className={`kpi-card ldc-kpi-button ${quickFilter === 'unique-pans' ? 'is-active' : ''}`} onClick={() => setQuickFilter('unique-pans')}>
          <div className="kpi-icon-row"><span className="kpi-label">Unique PANs</span><div className="kpi-icon-box warning"><IdCard size={14} /></div></div>
          <span className="kpi-value">{stats.uniquePans}</span>
          <span className="ldc-muted">Distinct vendor PANs</span>
        </button>
        <button type="button" className={`kpi-card ldc-kpi-button ${quickFilter === 'active' ? 'is-active' : ''}`} onClick={() => setQuickFilter('active')}>
          <div className="kpi-icon-row"><span className="kpi-label">Active Certificates</span><div className="kpi-icon-box success"><ShieldCheck size={14} /></div></div>
          <span className="kpi-value">{stats.active}</span>
          <span className="ldc-muted">{stats.expired} expired · {stats.future} future</span>
        </button>
        <button type="button" className={`kpi-card ldc-kpi-button ${quickFilter === 'expiring' ? 'is-active' : ''}`} onClick={() => setQuickFilter('expiring')}>
          <div className="kpi-icon-row"><span className="kpi-label">Expiring in 30 Days</span><div className="kpi-icon-box danger"><AlertTriangle size={14} /></div></div>
          <span className="kpi-value">{stats.expiringSoon}</span>
          <span className="ldc-muted">Active certificates near expiry</span>
        </button>
      </div>

      <div className="ldc-master-grid">
        <div className="table-card">
          <div className="table-card-header">
            <div>
              <div className="table-card-title">LDC Certificate Validation</div>
              <div className="ldc-muted">{quickFilterLabel} · {filteredRows.length} rows shown</div>
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
