import { useEffect, useMemo, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'
import {
  AlertTriangle, Download, FileSpreadsheet, IdCard, Upload,
  ShieldCheck, Search,
} from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import ProgressBar from '@/components/Common/ProgressBar'
import StatusBadge from '@/components/Common/StatusBadge'
import { selectLdcUtilization } from '@/redux/slices/issuesSlice'
import { fetchLdcCertificates, uploadLdcCertificates } from '@/services/ldcService'
import { downloadCsv, downloadExcel } from '@/utils/csvExport'
import { formatDate } from '@/utils/utils'
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

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/
const LDC_TEMP_STORAGE_KEY = 'tds.ldcCompliance.tempRows'
const LDC_UPLOAD_META_KEY = 'tds.ldcCompliance.uploadMeta'
const ldcPageCache = {
  rows: null,
  fileName: '',
  search: '',
  quickFilter: 'all',
  uploadResult: null,
  uploadIssues: null,
  stats: null,
  loaded: false,
}
const TODAY = new Date()
TODAY.setHours(0, 0, 0, 0)
const EXPIRING_SOON_DAYS = 30
const ALLOWED_LDC_COMPANY_CODES = new Set(['1001', '1079', '1081'])
const amountDisplay = (value) => (
  value == null || value === '' ? '—' : Number(value).toLocaleString('en-IN')
)
const roundToTwo = (value) => Math.round(Number(value || 0) * 100) / 100
const ldcLimitStatus = (utilization) => {
  if (utilization == null) return ['safe', 'Within LDC Limit']
  if (utilization > 100) return ['over_utilized', 'LDC Over-utilized']
  if (utilization >= 100) return ['exhausted', 'LDC Limit Exhausted']
  if (utilization >= 90) return ['high_warning', 'LDC Limit 90% Utilized']
  if (utilization >= 80) return ['warning', 'LDC Limit 80% Utilized']
  return ['safe', 'Within LDC Limit']
}
const hasPositiveLimit = (row) => Number(row?.approvedLimit) > 0
const isAllowedLdcCompanyCode = (companyCode) => ALLOWED_LDC_COMPANY_CODES.has(String(companyCode || '').trim())
const NEW_SECTION_BY_OLD_SECTION = {
  '193': '393(1)5(i)',
  '194': '393(1)7',
  '194A': '393(1)5(ii)',
  '194C': '393(1)6(i)',
  '194H': '393(1)1(ii)',
  '194I': '393(1)2(ii)',
  '194IA': '393(1)3(i)',
  '194J': '393(1)6(iii)',
  '194K': '393(1)4(i)',
  '194LA': '393(1)3(iii)',
  '194O': '393(1)8(v)',
  '194Q': '393(1)8(ii)',
  '194R': '393(1)8(iv)',
  '195': '393(2)',
}
const OLD_SECTION_BY_NEW_CLAUSE = {
  '1(i)': '194D',
  '1(ii)': '194H',
  '2(i)': '194IB',
  '2(ii)': '194I',
  '3(i)': '194IA',
  '3(ii)': '194IC',
  '3(iii)': '194LA',
  '4(i)': '194K',
  '5(i)': '193',
  '5(ii)': '194A',
  '5(iii)': '194A',
  '6(i)': '194C',
  '6(ii)': '194M',
  '6(iii)(a)': '194J',
  '6(iii)(b)': '194J',
  '6(iii)(c)': '194J',
  '6(iii)(d)': '194J',
  '6(iii)(e)': '194J',
  '7': '194',
  '8(ii)': '194Q',
  '8(iv)': '194R',
  '8(v)': '194O',
}
const OLD_SECTION_BY_WTAX_CODE = {
  '8I': '194I',
  C1: '194C',
  C4: '194C',
  CP: '194C',
  JI: '194J',
  JP: '194J',
  HP: '194H',
  LP: '194Q',
  MI: '194R',
}
const SECTION_BY_WTAX_PAIR = {
  '8I/IA': { oldSection: '194I', newSection: '393(1)2(ii)' },
  'CI/C3': { oldSection: '194C', newSection: '393(1)6(i)' },
  'HI/H1': { oldSection: '194H', newSection: '393(1)1(ii)' },
  'II/I1': { oldSection: '194I', newSection: '393(1)2(ii)' },
  'II/I4': { oldSection: '194I', newSection: '393(1)2(ii)' },
  'IP/I1': { oldSection: '194I', newSection: '393(1)2(ii)' },
  'JI/J3': { oldSection: '194J', newSection: '393(1)6(iii)(a)' },
  'JP/J3': { oldSection: '194J', newSection: '393(1)6(iii)(b)' },
  'L1/L1': { oldSection: '194Q', newSection: '393(1)8(ii)' },
  'R1/I1': { oldSection: '194R', newSection: '393(1)8(iv)' },
}

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

function normalizeNewClause(rawClause) {
  const parts = clean(rawClause).toLowerCase().match(/\d+|[a-z]+/g)
  if (!parts?.length) return ''
  return parts[0] + parts.slice(1).map((part) => `(${part})`).join('')
}

function formatSectionDisplay(value) {
  const text = clean(value).toUpperCase()
  if (!text) return ''

  const newSectionMatch = text.match(/393\s*\(\s*(\d+)\s*\)\s*(\d+(?:\s*\(\s*[A-Z]+\s*\)?){0,2})/i)
  const newSection = newSectionMatch
    ? `393(${newSectionMatch[1]})${normalizeNewClause(newSectionMatch[2])}`
    : ''
  const legacyMatch = text.match(/\b(19\d[A-Z]{0,3})\b/i)
  const oldFromNew = newSection.startsWith('393(1)')
    ? OLD_SECTION_BY_NEW_CLAUSE[newSection.replace('393(1)', '')]
    : ''
  const codeParts = text.split('/').map((part) => part.trim()).filter(Boolean)
  const pairSection = SECTION_BY_WTAX_PAIR[codeParts.join('/')]
  if (pairSection) return `${pairSection.oldSection} / ${pairSection.newSection}`
  const oldFromWtax = codeParts.map((part) => OLD_SECTION_BY_WTAX_CODE[part]).find(Boolean)
  const oldSection = legacyMatch?.[1]?.toUpperCase() || oldFromNew || oldFromWtax
  const fallbackNewSection = oldSection ? NEW_SECTION_BY_OLD_SECTION[oldSection] : ''

  if (oldSection && (newSection || fallbackNewSection)) return `${oldSection} / ${newSection || fallbackNewSection}`
  return oldSection || text
}

function dateStatus(row) {
  if (!row.validFrom || !row.validTo) return 'Unknown'
  if (TODAY < row.validFrom) return 'Future'
  if (TODAY > row.validTo) return 'Expired'
  return 'Active'
}

function certificateStatus(validFromValue, validToValue) {
  return dateStatus({
    validFrom: parseDateValue(validFromValue),
    validTo: parseDateValue(validToValue),
  })
}

function utilizationLookupKeys(row) {
  const cert = clean(row?.certificateNumber).toUpperCase()
  const pan = clean(row?.pan).toUpperCase()
  return [
    `${cert}||${pan}`,
    `${cert}||`,
  ]
}

function isActiveCertificate(row) {
  return row.status === 'ACTIVE' && dateStatus(row) === 'Active'
}

function isExpiringSoon(row) {
  if (!isActiveCertificate(row)) return false
  const daysUntilExpiry = (row.validTo.getTime() - TODAY.getTime()) / (1000 * 60 * 60 * 24)
  return daysUntilExpiry >= 0 && daysUntilExpiry <= EXPIRING_SOON_DAYS
}

function dateKey(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : ''
}

function certificateBaseKey(row) {
  return [
    row.certificateNumber,
    row.pan,
    row.vendorCode,
    row.companyCode,
    row.deductorTan,
    row.wtaxType,
    row.wtx,
    dateKey(row.validFrom),
    dateKey(row.validTo),
    row.approvedRate ?? '',
  ].map((value) => clean(value).toUpperCase()).join('|')
}

function isMappedSection(section) {
  return clean(section).includes(' / ')
}

function isSpecificMappedSection(section) {
  return /\(\s*[a-z]\s*\)/i.test(clean(section).replace(/^.*393\(1\)6\(iii\)/i, ''))
}

function isGenericMappedSection(section) {
  return clean(section).toUpperCase() === '194J / 393(1)6(III)'
}

function certificateIdentityKey(row) {
  const sectionKey = isMappedSection(row.section) ? clean(row.section).toUpperCase() : ''
  return `${certificateBaseKey(row)}|${sectionKey}`
}

function preferCertificateRow(current, candidate) {
  if (!current) return candidate
  if (hasPositiveLimit(candidate) && !hasPositiveLimit(current)) return candidate
  const currentHasMappedSection = isMappedSection(current.section)
  const candidateHasMappedSection = isMappedSection(candidate.section)
  if (candidateHasMappedSection && !currentHasMappedSection) return candidate
  if (!current.vendorName && candidate.vendorName) return candidate
  return current
}

function uniqueCertificateRows(sourceRows) {
  const mappedBaseKeys = new Set(
    sourceRows
      .filter((row) => isMappedSection(row.section))
      .map(certificateBaseKey)
  )
  const specificBaseKeys = new Set(
    sourceRows
      .filter((row) => isSpecificMappedSection(row.section))
      .map(certificateBaseKey)
  )
  const rowsByCertificate = new Map()
  sourceRows.forEach((row) => {
    if (!isMappedSection(row.section) && mappedBaseKeys.has(certificateBaseKey(row))) return
    if (isGenericMappedSection(row.section) && specificBaseKeys.has(certificateBaseKey(row))) return
    const key = certificateIdentityKey(row)
    rowsByCertificate.set(key, preferCertificateRow(rowsByCertificate.get(key), row))
  })
  return [...rowsByCertificate.values()]
}

function ldcSectionKey(normalized) {
  const explicitSection = clean(normalized.TDS_Section || normalized.Applicable_TDS_Section).toUpperCase()
  if (explicitSection) return explicitSection
  const wtaxType = clean(normalized.WTax_Type).toUpperCase()
  const wtx = clean(normalized.WTx).toUpperCase()
  if (wtaxType && wtx) return `${wtaxType}/${wtx}`
  return wtx || wtaxType
}

function restoreRowsFromStorage() {
  // The backend is the source of truth for saved certificates. Older builds
  // stored the complete upload here, which can exceed the browser quota.
  try { window.localStorage.removeItem(LDC_TEMP_STORAGE_KEY) } catch { /* storage may be unavailable */ }
  return []
}

function restoreUploadMeta() {
  try {
    return JSON.parse(window.localStorage.getItem(LDC_UPLOAD_META_KEY) || 'null')
  } catch {
    return null
  }
}

function compactIssueRow(row) {
  return {
    id: `issue-${row.rowNumber || row.id}`,
    rowNumber: row.rowNumber,
    certificateNumber: row.certificateNumber || '',
    pan: row.pan || '',
    vendorName: row.vendorName || '',
    vendorCode: row.vendorCode || '',
    companyCode: row.companyCode || '',
    section: row.section || '',
    approvedRate: row.approvedRate ?? null,
    validFrom: row.validFrom instanceof Date ? row.validFrom.toISOString() : row.validFrom || null,
    validTo: row.validTo instanceof Date ? row.validTo.toISOString() : row.validTo || null,
    issues: row.issues ?? [],
  }
}

function restoreIssueRows(rows) {
  return (rows ?? []).map((row, index) => ({
    ...row,
    id: row.id || `issue-${row.rowNumber || index}`,
    isIssueRow: true,
    validFrom: parseDateValue(row.validFrom),
    validTo: parseDateValue(row.validTo),
  }))
}

function restoreUploadResult(uploadMeta, issueRows = []) {
  if (!uploadMeta) return null
  return {
    inserted: uploadMeta.inserted ?? 0,
    updated: uploadMeta.updated ?? 0,
    issueRows: uploadMeta.issueRows ?? issueRows.length,
    totalRows: uploadMeta.totalRows,
  }
}

function saveUploadMeta(fileName, result, issueRows = []) {
  try {
    window.localStorage.setItem(LDC_UPLOAD_META_KEY, JSON.stringify({
      fileName,
      inserted: result.inserted ?? 0,
      updated: result.updated ?? 0,
      issueRows: result.issueRows ?? 0,
      totalRows: result.totalRows,
      issues: issueRows.map(compactIssueRow),
    }))
  } catch {
    // Summary metadata is helpful after refresh, but not required for upload.
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
  const limit = Number(clean(normalized.Approved_Amount_Limit || normalized.Exemption_Threshold))

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
    wtaxType: clean(normalized.WTax_Type).toUpperCase(),
    wtx: clean(normalized.WTx).toUpperCase(),
    section: formatSectionDisplay(ldcSectionKey(normalized)),
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
    const key = `${row.certificateNumber}|${row.pan}|${row.vendorCode}|${row.companyCode}|${row.deductorTan}|${row.wtaxType}|${row.wtx}|${row.section}`
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

    const duplicateKey = `${row.certificateNumber}|${row.pan}|${row.vendorCode}|${row.companyCode}|${row.deductorTan}|${row.wtaxType}|${row.wtx}|${row.section}`
    if (certificateCounts.get(duplicateKey) > 1) issues.push('Duplicate certificate scope in upload')

    return {
      ...row,
      vendorCodes: row.vendorCode ? [row.vendorCode] : [],
      validationStatus: validationStatusForIssues(issues),
      issues,
    }
  })
}

function validationStatusForIssues(issues = []) {
  if (issues.includes('PAN format invalid')) return 'Invalid PAN'
  if (issues.includes('PAN missing')) return 'PAN Missing'
  return issues.length ? 'Issue' : 'Valid'
}

export default function LDCCompliance() {
  const liveLdcUtilization = useSelector(selectLdcUtilization)
  const [rows, setRows] = useState(() => ldcPageCache.rows ?? [])
  const [fileName, setFileName] = useState(() => ldcPageCache.fileName)
  const [search, setSearch] = useState(() => ldcPageCache.search)
  const [quickFilter, setQuickFilter] = useState(() => ldcPageCache.quickFilter)
  const [uploadResult, setUploadResult] = useState(() => ldcPageCache.uploadResult)
  const [uploadIssues, setUploadIssues] = useState(() => ldcPageCache.uploadIssues ?? [])
  const [isLoadingCertificates, setIsLoadingCertificates] = useState(() => !(ldcPageCache.rows ?? []).some((row) => !row.isIssueRow))
  const [isUploading, setIsUploading] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    if (rows.length || !(ldcPageCache.rows ?? []).length) {
      ldcPageCache.rows = rows
    }
    ldcPageCache.fileName = fileName
    ldcPageCache.search = search
    ldcPageCache.quickFilter = quickFilter
    ldcPageCache.uploadResult = uploadResult
    ldcPageCache.uploadIssues = uploadIssues
  }, [rows, fileName, search, quickFilter, uploadResult, uploadIssues])

  useEffect(() => {
    const cacheHasCertificateRows = (ldcPageCache.rows ?? []).some((row) => !row.isIssueRow)
    if (ldcPageCache.loaded && cacheHasCertificateRows) return
    ldcPageCache.loaded = true
    let isMounted = true
    setIsLoadingCertificates(!cacheHasCertificateRows)
    const tempRows = restoreRowsFromStorage()
    const uploadMeta = restoreUploadMeta()
    const restoredIssueRows = restoreIssueRows(uploadMeta?.issues)
    setUploadIssues(restoredIssueRows)
    const restoredUploadResult = restoreUploadResult(uploadMeta, restoredIssueRows)
    if (restoredUploadResult) {
      setUploadResult(restoredUploadResult)
      setFileName(uploadMeta?.fileName || 'Saved LDC certificate master')
    }
    if (tempRows.length) {
      setRows(tempRows)
      setIsLoadingCertificates(false)
      setFileName(uploadMeta?.fileName || 'Saved temporary LDC upload')
      setUploadResult({
        inserted: 0,
        updated: tempRows.length,
        issueRows: tempRows.filter((row) => row.issues.length).length,
        totalRows: uploadMeta?.totalRows ?? tempRows.length,
      })
    }
    fetchLdcCertificates()
      .then((result) => {
        if (!isMounted || tempRows.length) return
        const savedRows = (result.certificates ?? []).map((row, index) => {
          const issues = row.issues ?? []
          return {
            id: `saved-ldc-${index}`,
            rowNumber: row.rowNumber,
            certificateNumber: row.certificateNumber || '',
            certificateType: row.certificateType || '',
            pan: row.pan || '',
            vendorName: row.vendorName || '',
            vendorCode: row.vendorCode || '',
            companyCode: row.companyCode || '',
            deductorTan: row.deductorTan || '',
            wtaxType: row.wtaxType || '',
            wtx: row.wtx || '',
            section: formatSectionDisplay(row.section),
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
            validationStatus: validationStatusForIssues(issues),
            issues,
          }
        })
        const savedIssueRows = restoreIssueRows(result.issueRows)
        const unsavedIssueRows = savedIssueRows.filter((row) => !row.savedToMaster)
        setUploadIssues(savedIssueRows.length ? savedIssueRows : restoreIssueRows(uploadMeta?.issues))
        setRows([...savedRows, ...unsavedIssueRows])
        setIsLoadingCertificates(false)
        if (savedRows.length || unsavedIssueRows.length) {
          setFileName(uploadMeta?.fileName || 'Saved LDC certificate master')
          setUploadResult({
            inserted: 0,
            updated: savedRows.length,
            issueRows: savedIssueRows.length,
            totalRows: savedRows.length + unsavedIssueRows.length,
          })
        }
      })
      .catch(() => {
        if (isMounted) setIsLoadingCertificates(false)
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
          validationStatus: validationStatusForIssues(backendIssues),
        }
      })
      const issueDetails = mergedRows.filter((row) => row.issues.length)
      setRows(mergedRows)
      setUploadIssues(issueDetails)
      setIsLoadingCertificates(false)
      // Do not cache the full certificate master in localStorage. The backend
      // persists this upload and the saved-list endpoint restores it on load.
      try { window.localStorage.removeItem(LDC_TEMP_STORAGE_KEY) } catch { /* storage may be unavailable */ }
      setUploadResult(result)
      saveUploadMeta(file.name, result, issueDetails)
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
    const allowedRows = rows.filter((row) => isAllowedLdcCompanyCode(row.companyCode))
    const allowedIssueCount = [
      ...uploadIssues.filter((row) => isAllowedLdcCompanyCode(row.companyCode) && (row.issues ?? []).length),
      ...allowedRows.filter((row) => (row.issues ?? []).length),
    ].reduce((seen, row) => {
      const key = row.id || `${row.rowNumber || ''}|${row.certificateNumber || ''}|${row.pan || ''}|${row.companyCode || ''}`
      seen.add(key)
      return seen
    }, new Set()).size
    const activeRows = uniqueCertificateRows(allowedRows.filter(isActiveCertificate))
    const uniquePans = new Set(allowedRows.map((row) => row.pan).filter(Boolean))
    const expiringSoon = activeRows.filter(isExpiringSoon)
    const nextStats = {
      total: allowedRows.length,
      valid: activeRows.length,
      issues: allowedIssueCount,
      uniquePans: uniquePans.size,
      active: activeRows.length,
      expiringSoon: expiringSoon.length,
    }
    if (rows.some((row) => !row.isIssueRow)) {
      ldcPageCache.stats = nextStats
    }
    return nextStats
  }, [rows, uploadResult, uploadIssues])

  const hasCertificateRows = rows.some((row) => !row.isIssueRow)
  const isCertificateDataPending = isLoadingCertificates && !hasCertificateRows
  const visibleStats = isCertificateDataPending && ldcPageCache.stats ? ldcPageCache.stats : stats
  const kpiValue = (value) => (
    isCertificateDataPending && !ldcPageCache.stats ? '...' : value
  )

  const allowedRows = useMemo(
    () => rows.filter((row) => isAllowedLdcCompanyCode(row.companyCode)),
    [rows],
  )

  const allowedIssueRows = useMemo(() => {
    const byKey = new Map()
    const addRow = (row) => {
      if (!isAllowedLdcCompanyCode(row.companyCode) || !(row.issues ?? []).length) return
      const key = row.id || `${row.rowNumber || ''}|${row.certificateNumber || ''}|${row.pan || ''}|${row.companyCode || ''}`
      if (!byKey.has(key)) byKey.set(key, row)
    }
    uploadIssues.forEach(addRow)
    allowedRows.forEach(addRow)
    return [...byKey.values()]
  }, [allowedRows, uploadIssues])

  const filteredRows = useMemo(() => {
    const needle = search.toLowerCase()
    const activeRows = uniqueCertificateRows(allowedRows.filter(isActiveCertificate))
    const displayRows = quickFilter === 'issues'
      ? allowedIssueRows
      : quickFilter === 'all' || quickFilter === 'unique-pans'
        ? allowedRows
        : activeRows
    return displayRows.filter((row) => {
      if (quickFilter === 'unique-pans') {
        const firstPanRow = allowedRows.find((candidate) => candidate.pan && candidate.pan === row.pan)
        if (firstPanRow?.id !== row.id) return false
      }
      if (quickFilter === 'active' && !isActiveCertificate(row)) return false
      if (quickFilter === 'expiring' && !isExpiringSoon(row)) return false

      return (
      row.certificateNumber.toLowerCase().includes(needle) ||
      row.pan.toLowerCase().includes(needle) ||
      row.vendorName.toLowerCase().includes(needle) ||
      row.vendorCode.toLowerCase().includes(needle) ||
      row.section.toLowerCase().includes(needle) ||
      (row.issues ?? []).join(' ').toLowerCase().includes(needle)
      )
    })
  }, [allowedRows, allowedIssueRows, search, quickFilter])

  const currentCertificateByKey = useMemo(() => {
    const byKey = new Map()
    const byCertificate = new Map()
    rows
      .filter((row) => !row.isIssueRow && row.certificateNumber && isAllowedLdcCompanyCode(row.companyCode))
      .forEach((row) => {
        const cert = String(row.certificateNumber || '').trim()
        const pan = String(row.pan || '').trim().toUpperCase()
        byCertificate.set(cert, preferCertificateRow(byCertificate.get(cert), row))
        if (pan) {
          const key = `${cert}||${pan}`
          byKey.set(key, preferCertificateRow(byKey.get(key), row))
        }
      })
    return { byKey, byCertificate }
  }, [rows])

  const currentLdcUtilization = useMemo(() => {
    const hasCurrentCertificates = currentCertificateByKey.byCertificate.size > 0
    if (!hasCurrentCertificates) {
      return liveLdcUtilization
        .filter((row) => isAllowedLdcCompanyCode(row.companyCode))
        .map((row) => ({
          ...row,
          certificateStatus: certificateStatus(row.validFrom, row.validTo),
        }))
    }

    return liveLdcUtilization
      .filter((row) => isAllowedLdcCompanyCode(row.companyCode))
      .map((row) => {
        const cert = String(row.certificateNumber || '').trim()
        const pan = String(row.pan || '').trim().toUpperCase()
        const masterRow = currentCertificateByKey.byKey.get(`${cert}||${pan}`) || currentCertificateByKey.byCertificate.get(cert)
        if (!masterRow) return null
        const limit = masterRow.approvedLimit ?? row.limit
        const used = Number(row.used || 0)
        const numericLimit = Number(limit)
        const hasLimit = Number.isFinite(numericLimit) && numericLimit > 0
        const available = hasLimit ? numericLimit - used : null
        const utilization = hasLimit ? roundToTwo((used / numericLimit) * 100) : null
        const [status, statusLabel] = ldcLimitStatus(utilization)
        const validFrom = masterRow.validFrom ?? row.validFrom ?? null
        const validTo = masterRow.validTo ?? row.validTo ?? null
        return {
          ...row,
          vendor: masterRow.vendorName || row.vendor,
          vendorId: masterRow.vendorCode || row.vendorId,
          vendorCode: masterRow.vendorCode || row.vendorCode || row.vendorId,
          pan: masterRow.pan || row.pan,
          companyCode: masterRow.companyCode || row.companyCode,
          section: masterRow.section || row.section,
          approvedRate: masterRow.approvedRate ?? row.approvedRate,
          validFrom,
          validTo,
          certificateStatus: certificateStatus(validFrom, validTo),
          limit: hasLimit ? numericLimit : limit,
          available,
          utilization,
          status,
          statusLabel,
        }
      })
      .filter(Boolean)
  }, [currentCertificateByKey, liveLdcUtilization])

  const utilizationByCertificate = useMemo(() => {
    const byKey = new Map()
    currentLdcUtilization.forEach((row) => {
      const [certPanKey, certOnlyKey] = utilizationLookupKeys(row)
      if (!byKey.has(certPanKey)) byKey.set(certPanKey, row)
      if (!byKey.has(certOnlyKey)) byKey.set(certOnlyKey, row)
    })
    return byKey
  }, [currentLdcUtilization])

  const exportRows = useMemo(() => (
    filteredRows.map((row) => {
      const [certPanKey, certOnlyKey] = utilizationLookupKeys(row)
      const utilizationRow = utilizationByCertificate.get(certPanKey) || utilizationByCertificate.get(certOnlyKey) || null
      return { ...row, utilizationRow }
    })
  ), [filteredRows, utilizationByCertificate])

  const exportColumns = useMemo(() => ([
    { label: 'Supplier', value: (row) => row.vendorName || '—' },
    { label: 'Vendor Code', value: (row) => row.vendorCode || '—' },
    { label: 'PAN', value: (row) => row.pan || '—' },
    { label: 'Certificate Number', value: (row) => row.certificateNumber || '—' },
    { label: 'Certificate Type', value: (row) => row.certificateType || '—' },
    { label: 'Company Code', value: (row) => row.companyCode || '—' },
    { label: 'Deductor TAN', value: (row) => row.deductorTan || '—' },
    { label: 'Old Section / New Section', value: (row) => row.section || '—' },
    { label: 'Exemption %', value: (row) => row.approvedRate == null ? '—' : `${row.approvedRate}%` },
    { label: 'Threshold', value: (row) => amountDisplay(row.approvedLimit) },
    { label: 'Valid From', value: (row) => formatDate(row.validFrom) },
    { label: 'Valid Till', value: (row) => formatDate(row.validTo) },
    { label: 'Certificate Status', value: (row) => certificateStatus(row.validFrom, row.validTo) },
    { label: 'Validation Status', value: (row) => row.validationStatus || '—' },
    { label: 'Issue Details', value: (row) => (row.issues ?? []).join('; ') || '—' },
    { label: 'LDC Limit', value: (row) => row.utilizationRow ? amountDisplay(row.utilizationRow.limit) : '—' },
    { label: 'LDC Used', value: (row) => row.utilizationRow ? amountDisplay(row.utilizationRow.used) : '—' },
    { label: 'LDC Available', value: (row) => row.utilizationRow ? amountDisplay(row.utilizationRow.available) : '—' },
    { label: 'LDC Utilization %', value: (row) => row.utilizationRow?.utilization == null ? '—' : `${row.utilizationRow.utilization}%` },
    { label: 'LDC Utilization Status', value: (row) => row.utilizationRow?.statusLabel || '—' },
  ]), [])

  function handleExport(format) {
    if (!exportRows.length) {
      toast('No LDC rows to export')
      return
    }
    const suffix = quickFilter === 'issues' ? 'issues' : 'certificates'
    const baseName = `ldc-compliance-${suffix}`
    if (format === 'excel') {
      downloadExcel(`${baseName}.xlsx`, exportColumns, exportRows, 'LDC Compliance')
      return
    }
    downloadCsv(`${baseName}.csv`, exportColumns, exportRows)
  }

  const quickFilterLabel = {
    all: 'Uploaded Rows',
    'unique-pans': 'Unique PANs',
    active: 'Active Certificates',
    issues: 'LDC Upload Issues',
    expiring: `Expiring in ${EXPIRING_SOON_DAYS} Days`,
  }[quickFilter]

  const columns = [
    { key: 'pan', header: 'PAN', render: (row) => <span className="font-mono ldc-strong">{row.pan || '—'}</span> },
    { key: 'vendorName', header: 'Supplier', render: (row) => (
      <div className="ldc-strong">{row.vendorName || '—'}</div>
    )},
    { key: 'vendorCode', header: 'Vendor Code', render: (row) => <span className="font-mono ldc-strong">{row.vendorCode || '—'}</span> },
    { key: 'certificateNumber', header: 'Certificate', render: (row) => (
      <div>
        <div className="ldc-strong">{row.certificateNumber || '—'}</div>
        <div className="ldc-muted">{row.certificateType || '—'}</div>
      </div>
    )},
    { key: 'companyCode', header: 'Company / TAN', render: (row) => (
      <div>
        <div className="font-mono">{row.companyCode || '—'}</div>
        <div className="ldc-muted">{row.deductorTan || 'TAN not supplied'}</div>
      </div>
    )},
    { key: 'section', header: 'Old Section / New Section', render: (row) => <span className="font-mono">{row.section || '—'}</span> },
    { key: 'approvedRate', header: 'Exemption %', render: (row) => <span className="font-mono">{row.approvedRate == null ? '—' : `${row.approvedRate}%`}</span> },
    { key: 'approvedLimit', header: 'Threshold', render: (row) => <span className="font-mono">{amountDisplay(row.approvedLimit)}</span> },
    { key: 'validTo', header: 'Valid Till', render: (row) => (
      <div>
        <div className="font-mono">{formatDate(row.validTo)}</div>
        <div className="ldc-muted">{dateStatus(row)} · from {formatDate(row.validFrom)}</div>
      </div>
    )},
    { key: 'validationStatus', header: 'Status', sortValue: (row) => row.validationStatus, render: (row) => (
      <StatusBadge label={row.validationStatus} tone={row.issues.length ? 'danger' : 'success'} />
    )},
  ]

  const utilizationTone = (status) => {
    if (status === 'over_utilized' || status === 'exhausted') return 'danger'
    if (status === 'high_warning' || status === 'warning') return 'warning'
    return 'success'
  }

  const utilizationColumns = [
    { key: 'pan', header: 'PAN', render: (row) => <span className="font-mono ldc-strong">{row.pan || '—'}</span> },
    { key: 'vendor', header: 'Vendor', render: (row) => (
      <div className="ldc-strong">{row.vendor}</div>
    )},
    { key: 'vendorCode', header: 'Vendor Code', render: (row) => <span className="font-mono ldc-strong">{row.vendorCode || row.vendorId || '—'}</span> },
    { key: 'certificateNumber', header: 'Certificate', render: (row) => (
      <div>
        <div className="ldc-strong">{row.certificateNumber}</div>
        <div className="ldc-muted">{row.section} · exemption {row.approvedRate ?? '—'}%</div>
      </div>
    )},
    { key: 'limit', header: 'Limit', render: (row) => <span className="font-mono">{row.limit == null ? 'Not set' : amountDisplay(row.limit)}</span> },
    { key: 'used', header: 'Used', render: (row) => <span className="font-mono">{Number(row.used || 0).toLocaleString('en-IN')}</span> },
    { key: 'available', header: 'Available', render: (row) => <span className="font-mono">{amountDisplay(row.available)}</span> },
    { key: 'certificateStatus', header: 'Certificate Status', render: (row) => <StatusBadge label={row.certificateStatus || 'Unknown'} tone={row.certificateStatus === 'Active' ? 'success' : row.certificateStatus === 'Expired' ? 'danger' : 'warning'} /> },
    { key: 'status', header: 'Status', sortValue: (row) => row.statusLabel || 'Within LDC Limit', render: (row) => <StatusBadge label={row.statusLabel || 'Within LDC Limit'} tone={utilizationTone(row.status)} /> },
    { key: 'utilization', header: 'Utilization', render: (row) => (
      row.utilization == null
        ? <span className="ldc-muted">—</span>
        : <div style={{ width: 130 }}><ProgressBar value={Math.min(row.utilization, 100)} showLabel /></div>
    )},
  ]

  const issueColumns = columns

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
              ? uploadSummary({ ...uploadResult, issueRows: visibleStats.issues }, rows.length)
              : `Required columns: ${REQUIRED_COLUMNS.join(', ')}`}
          </div>
        </div>
      </div>

      <div className="ldc-summary-grid">
        <button type="button" className={`kpi-card ldc-kpi-button ${quickFilter === 'all' ? 'is-active' : ''}`} onClick={() => setQuickFilter('all')}>
          <div className="kpi-icon-row"><span className="kpi-label">Uploaded Rows</span><div className="kpi-icon-box info"><FileSpreadsheet size={14} /></div></div>
          <span className="kpi-value">{kpiValue(visibleStats.total)}</span>
          <span className="ldc-muted">Rows from latest LDC CSV</span>
        </button>
        <button type="button" className={`kpi-card ldc-kpi-button ${quickFilter === 'unique-pans' ? 'is-active' : ''}`} onClick={() => setQuickFilter('unique-pans')}>
          <div className="kpi-icon-row"><span className="kpi-label">Unique PANs</span><div className="kpi-icon-box warning"><IdCard size={14} /></div></div>
          <span className="kpi-value">{kpiValue(visibleStats.uniquePans)}</span>
          <span className="ldc-muted">Distinct vendor PANs</span>
        </button>
        <button type="button" className={`kpi-card ldc-kpi-button ${quickFilter === 'active' ? 'is-active' : ''}`} onClick={() => setQuickFilter('active')}>
          <div className="kpi-icon-row"><span className="kpi-label">Active Certificates</span><div className="kpi-icon-box success"><ShieldCheck size={14} /></div></div>
          <span className="kpi-value">{kpiValue(visibleStats.active)}</span>
          <span className="ldc-muted">Currently valid certificates</span>
        </button>
        <button type="button" className={`kpi-card ldc-kpi-button ${quickFilter === 'issues' ? 'is-active' : ''}`} onClick={() => setQuickFilter('issues')}>
          <div className="kpi-icon-row"><span className="kpi-label">LDC Upload Issues</span><div className="kpi-icon-box danger"><AlertTriangle size={14} /></div></div>
          <span className="kpi-value">{kpiValue(visibleStats.issues)}</span>
          <span className="ldc-muted">Rows needing review</span>
        </button>
        <button type="button" className={`kpi-card ldc-kpi-button ${quickFilter === 'expiring' ? 'is-active' : ''}`} onClick={() => setQuickFilter('expiring')}>
          <div className="kpi-icon-row"><span className="kpi-label">Expiring in 30 Days</span><div className="kpi-icon-box danger"><AlertTriangle size={14} /></div></div>
          <span className="kpi-value">{kpiValue(visibleStats.expiringSoon)}</span>
          <span className="ldc-muted">Active certificates near expiry</span>
        </button>
      </div>

      <div className="ldc-master-grid">
        <div className="table-card">
          <div className="table-card-header">
            <div>
              <div className="table-card-title">{quickFilter === 'issues' ? 'LDC Upload Issues' : 'LDC Certificate Validation'}</div>
              <div className="ldc-muted">
                {isCertificateDataPending && quickFilter !== 'issues'
                  ? `${quickFilterLabel} · loading saved certificates...`
                  : `${quickFilterLabel} · ${filteredRows.length} rows shown`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => handleExport('csv')}>
                <Download size={13} />CSV
              </button>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => handleExport('excel')}>
                <FileSpreadsheet size={13} />Excel
              </button>
              <div className="ldc-search-wrapper">
                <Search size={14} />
                <input
                  className="filter-input"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search LDC, PAN, vendor..."
                />
              </div>
            </div>
          </div>
          <DataTable
            columns={quickFilter === 'issues' ? issueColumns : columns}
            data={filteredRows}
            pageSize={8}
            stateKey="ldc-certificate-validation"
            emptyState={
              isCertificateDataPending && quickFilter !== 'issues'
                ? <div className="data-table-empty">Loading saved LDC certificates...</div>
                : null
            }
          />
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
          data={currentLdcUtilization}
          pageSize={8}
          emptyState={<div className="data-table-empty">Upload and analyse an SAP file to see live LDC utilization</div>}
        />
      </div>
    </div>
  )
}
