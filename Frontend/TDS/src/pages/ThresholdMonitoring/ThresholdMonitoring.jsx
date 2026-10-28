import { useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { AlertOctagon, Gauge, ShieldCheck, Download, BadgePercent, ChevronDown, ChevronRight } from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
// Vendor Threshold Tracker disabled: thresholdStatusToTone was only used by its table.
// import StatusBadge, { thresholdStatusToTone } from '@/components/Common/StatusBadge'
import StatusBadge from '@/components/Common/StatusBadge'
import ProgressBar from '@/components/Common/ProgressBar'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import {
  // selectThresholdVendors, // Vendor Threshold Tracker disabled
  selectActiveValidationRows,
  selectIsLive,
  selectLdcUtilization,
} from '@/redux/slices/issuesSlice'
import { fetchLdcCertificates } from '@/services/ldcService'
import { formatCurrency, formatDate } from '@/utils/utils'
// formatStatusLabel was only used by the (disabled) Vendor Threshold Tracker.
import { Bar, BarChart, CartesianGrid, LabelList, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import '@/components/Common/Common.css'
import './ThresholdMonitoring.css'

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
const preferCertificateRow = (current, candidate) => {
  if (!current) return candidate
  if (hasPositiveLimit(candidate) && !hasPositiveLimit(current)) return candidate
  return current
}
const CRORE = 10000000
const toCrore = (value) => roundToTwo(Number(value || 0) / CRORE)
const TOP_LIMIT_BARS = 5
const TOP_TREND_LINES = 4
const TREND_COLORS = ['#E01330', '#2563EB', '#10B981', '#F59E0B', '#64748B']
// Worst-first ranking used to pick a PAN's overall utilization status.
const LDC_STATUS_RANK = { safe: 0, warning: 1, high_warning: 2, exhausted: 3, over_utilized: 4 }
const TODAY = new Date()
TODAY.setHours(0, 0, 0, 0)

function parseDateValue(value) {
  if (!value) return null
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  date.setHours(0, 0, 0, 0)
  return date
}

// Chart order: active certificates first, then by amount used (highest
// first), then by limit.
function compareForCharts(a, b) {
  const active = Number(b.validityLabel === 'Active') - Number(a.validityLabel === 'Active')
  if (active) return active
  const used = Number(b.used || 0) - Number(a.used || 0)
  if (used) return used
  return Number(b.limit || 0) - Number(a.limit || 0)
}

function certificateValidity(validFromValue, validToValue) {
  const validFrom = parseDateValue(validFromValue)
  const validTo = parseDateValue(validToValue)
  if (!validFrom || !validTo) return ['neutral', 'Validity Unknown']
  if (TODAY < validFrom) return ['warning', 'Future']
  if (TODAY > validTo) return ['danger', 'Expired']
  return ['success', 'Active']
}

export default function ThresholdMonitoring() {
  const [search, setSearch] = useState('')
  // Vendor Threshold Tracker disabled; the LDC tracker is the only table.
  // const [activeTracker, setActiveTracker] = useState('ldc')
  const [ldcCertificates, setLdcCertificates] = useState([])
  const [expandedLdcKey, setExpandedLdcKey] = useState(null)
  // const vendors = useSelector(selectThresholdVendors)
  const ldcUtilization = useSelector(selectLdcUtilization)
  const validationRows = useSelector(selectActiveValidationRows)
  const selectedCompanyCode = useSelector((state) => state.app.selectedCompanyCode)
  const isLive = useSelector(selectIsLive)

  useEffect(() => {
    let isMounted = true
    fetchLdcCertificates()
      .then((result) => {
        if (isMounted) setLdcCertificates(result.certificates ?? [])
      })
      .catch(() => {
        if (isMounted) setLdcCertificates([])
      })
    return () => {
      isMounted = false
    }
  }, [])

  const ldcCertificateByKey = useMemo(() => {
    const byKey = new Map()
    const byCertificate = new Map()
    ldcCertificates.forEach((row) => {
      const cert = String(row.certificateNumber || '').trim()
      const pan = String(row.pan || '').trim().toUpperCase()
      if (!cert) return
      byCertificate.set(cert, preferCertificateRow(byCertificate.get(cert), row))
      if (pan) {
        const key = `${cert}||${pan}`
        byKey.set(key, preferCertificateRow(byKey.get(key), row))
      }
    })
    return { byKey, byCertificate }
  }, [ldcCertificates])

  const currentLdcUtilization = useMemo(() => {
    if (!ldcCertificateByKey.byCertificate.size) return ldcUtilization
    return ldcUtilization
      .map((row) => {
        const cert = String(row.certificateNumber || '').trim()
        const pan = String(row.pan || '').trim().toUpperCase()
        const masterRow = ldcCertificateByKey.byKey.get(`${cert}||${pan}`) || ldcCertificateByKey.byCertificate.get(cert)
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
        const [validityTone, validityLabel] = certificateValidity(validFrom, validTo)

        return {
          ...row,
          vendor: masterRow.vendorName || row.vendor,
          vendorId: masterRow.vendorCode || row.vendorId,
          pan: masterRow.pan || row.pan,
          section: masterRow.section || row.section,
          approvedRate: masterRow.approvedRate ?? row.approvedRate,
          limit: hasLimit ? numericLimit : limit,
          available,
          utilization,
          status,
          statusLabel,
          validFrom,
          validTo,
          validityTone,
          validityLabel,
        }
      })
      .filter(Boolean)
  }, [ldcCertificateByKey, ldcUtilization])

  // Certificates that are active today for a PAN (or, without a PAN, a vendor
  // code) in the upload but have no usage in it yet. They are listed with
  // ₹0 used so the tracker always shows the certificates that matter now.
  const unusedActiveCertificates = useMemo(() => {
    const pans = new Set(validationRows.map((row) => String(row.vendorPan || '').trim().toUpperCase()).filter((pan) => pan && pan !== '—'))
    const vendorCodes = new Set(validationRows.map((row) => String(row.vendorId || '').trim()).filter((code) => code && code !== '—'))
    const listed = new Set(currentLdcUtilization.map((row) => String(row.certificateNumber || '').trim()))
    return [...ldcCertificateByKey.byCertificate.values()]
      .filter((cert) => {
        const certificateNumber = String(cert.certificateNumber || '').trim()
        if (!certificateNumber || listed.has(certificateNumber)) return false
        if (selectedCompanyCode && cert.companyCode && cert.companyCode !== selectedCompanyCode) return false
        const pan = String(cert.pan || '').trim().toUpperCase()
        const vendorCode = String(cert.vendorCode || '').trim()
        if (!(pan ? pans.has(pan) : vendorCodes.has(vendorCode))) return false
        return certificateValidity(cert.validFrom, cert.validTo)[1] === 'Active'
      })
      .map((cert) => {
        const numericLimit = Number(cert.approvedLimit)
        const hasLimit = Number.isFinite(numericLimit) && numericLimit > 0
        const [validityTone, validityLabel] = certificateValidity(cert.validFrom, cert.validTo)
        const [status, statusLabel] = ldcLimitStatus(hasLimit ? 0 : null)
        return {
          certificateNumber: cert.certificateNumber,
          vendor: cert.vendorName || cert.vendorCode || 'Unknown vendor',
          vendorId: cert.vendorCode || '—',
          pan: cert.pan || '—',
          companyCode: cert.companyCode || null,
          section: cert.section,
          approvedRate: cert.approvedRate,
          used: 0,
          transactions: 0,
          vendors: [],
          monthlyUsage: [],
          limit: hasLimit ? numericLimit : null,
          available: hasLimit ? numericLimit : null,
          utilization: hasLimit ? 0 : null,
          status,
          statusLabel,
          validFrom: cert.validFrom,
          validTo: cert.validTo,
          validityTone,
          validityLabel,
        }
      })
  }, [ldcCertificateByKey, currentLdcUtilization, validationRows, selectedCompanyCode])

  // ---- Vendor Threshold Tracker (disabled) ----
  // const exceeded = vendors.filter((v) => v.status === 'exceeded')
  // const near      = vendors.filter((v) => v.status === 'near')
  // const safe      = vendors.filter((v) => v.status === 'safe')
  // const panIssues = vendors.filter((v) => v.status === 'pan_issue')
  //
  // const filtered = useMemo(
  //   () => vendors.filter((v) => v.name.toLowerCase().includes(search.toLowerCase())),
  //   [search, vendors],
  // )
  // One row per PAN + certificate; the vendors billed under it are listed
  // when the row is expanded, and are searchable too.
  const filteredLdc = useMemo(() => {
    const needle = search.toLowerCase()
    return [...currentLdcUtilization, ...unusedActiveCertificates]
      .map((r) => ({ ...r, id: `${r.certificateNumber || ''}||${r.pan || ''}` }))
      .filter((r) =>
        (r.vendor || '').toLowerCase().includes(needle) ||
        (r.pan || '').toLowerCase().includes(needle) ||
        (r.certificateNumber || '').toLowerCase().includes(needle) ||
        (r.vendors || []).some((v) => `${v.vendor} ${v.vendorId}`.toLowerCase().includes(needle))
      )
  }, [currentLdcUtilization, unusedActiveCertificates, search])

  const ldcWarning = currentLdcUtilization.filter((r) => ['warning', 'high_warning'].includes(r.status))
  const ldcCritical = currentLdcUtilization.filter((r) => ['exhausted', 'over_utilized'].includes(r.status))

  const ldcLimitVsUsedData = useMemo(() => {
    // One bar per PAN, like the tracker table: PANs holding an active
    // certificate, by total used across their certificates, highest first.
    const byPan = new Map()
    for (const cert of [...currentLdcUtilization, ...unusedActiveCertificates]) {
      const pan = cert.pan || '—'
      if (!byPan.has(pan)) byPan.set(pan, { pan, vendor: cert.vendor, certificates: [], used: 0, limit: null, available: null, active: false })
      const group = byPan.get(pan)
      group.certificates.push(cert.certificateNumber)
      group.used += Number(cert.used || 0)
      if (cert.limit != null && Number.isFinite(Number(cert.limit))) {
        group.limit = (group.limit || 0) + Number(cert.limit)
        group.available = (group.available || 0) + Number(cert.available ?? 0)
      }
      if (cert.validityLabel === 'Active') group.active = true
    }
    const rows = [...byPan.values()]
      .filter((group) => group.active)
      .sort((a, b) => (b.used - a.used) || (Number(b.limit || 0) - Number(a.limit || 0)))
    const visible = rows.slice(0, TOP_LIMIT_BARS)
    const rest = rows.slice(TOP_LIMIT_BARS)
    const data = visible.map((row) => ({
      certificate: row.pan,
      vendor: `${row.vendor || '—'} · ${row.certificates.join(', ')}`,
      limit: toCrore(row.limit),
      used: toCrore(row.used),
      available: row.available == null ? null : toCrore(row.available),
    }))
    if (rest.length) {
      data.push({
        certificate: `Other (${rest.length})`,
        vendor: 'Remaining active PANs',
        limit: toCrore(rest.reduce((sum, row) => sum + (Number(row.limit) || 0), 0)),
        used: toCrore(rest.reduce((sum, row) => sum + (Number(row.used) || 0), 0)),
        available: toCrore(rest.reduce((sum, row) => sum + (Number(row.available) || 0), 0)),
      })
    }
    return data
  }, [currentLdcUtilization, unusedActiveCertificates])

  const ldcTrendSeries = useMemo(() => {
    const rowsWithMonthlyUsage = currentLdcUtilization.filter((row) => Array.isArray(row.monthlyUsage) && row.monthlyUsage.length)
    if (!rowsWithMonthlyUsage.length) return { data: [], keys: [] }

    const topRows = [...rowsWithMonthlyUsage]
      .sort(compareForCharts)
      .slice(0, TOP_TREND_LINES)
    const topCertificates = new Set(topRows.map((row) => row.certificateNumber))
    const months = new Map()

    for (const row of rowsWithMonthlyUsage) {
      const key = topCertificates.has(row.certificateNumber) ? row.certificateNumber : 'Other'
      for (const item of row.monthlyUsage) {
        if (!months.has(item.monthKey)) {
          months.set(item.monthKey, { monthKey: item.monthKey, month: item.month })
        }
        const monthRow = months.get(item.monthKey)
        monthRow[key] = (monthRow[key] || 0) + Number(item.used || 0)
      }
    }

    const sortedMonths = [...months.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey))
    const keys = [...topRows.map((row) => row.certificateNumber)]
    if (rowsWithMonthlyUsage.length > topRows.length) keys.push('Other')

    const cumulative = Object.fromEntries(keys.map((key) => [key, 0]))
    const data = sortedMonths.map((row) => {
      const next = { month: row.month, monthKey: row.monthKey }
      for (const key of keys) {
        cumulative[key] += Number(row[key] || 0)
        next[key] = toCrore(cumulative[key])
      }
      return next
    })

    return { data, keys }
  }, [currentLdcUtilization])

  // ---- Vendor Threshold Tracker (disabled): summary cards and table columns ----
  // const summaryCards = [
  //   { label: 'Exceeded',   value: exceeded.length, icon: AlertOctagon, tone: 'danger',  sub: 'Requires immediate review' },
  //   { label: 'PAN Issues', value: panIssues.length, icon: AlertOctagon, tone: 'danger', sub: 'PAN missing or invalid' },
  //   { label: 'Near Limit', value: near.length,      icon: Gauge,        tone: 'warning', sub: 'Within 75–100% of limit' },
  //   { label: 'Safe',       value: safe.length,      icon: ShieldCheck,  tone: 'success', sub: 'Comfortably under threshold' },
  // ]
  //
  // const columns = [
  //   { key: 'pan', header: 'PAN', render: (r) => <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{r.pan || '—'}</span> },
  //   { key: 'name', header: 'Vendor', render: (r) => <div style={{ fontSize: 12.5, fontWeight: 600 }}>{r.name || '—'}</div> },
  //   { key: 'vendorCodes', header: 'Vendor Code', render: (r) => (
  //     <span className="font-mono" style={{ fontSize: 11.5, fontWeight: 600 }}>
  //       {(r.vendorCodes || []).length ? r.vendorCodes.join(', ') : '—'}
  //     </span>
  //   )},
  //   { key: 'section',       header: 'Section',   render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.section}</span> },
  //   { key: 'threshold',     header: 'Threshold', render: (r) => (
  //     <span className="font-mono" style={{ fontSize: 11.5 }}>
  //       {r.threshold == null ? 'Not determined' : formatCurrency(r.threshold)}
  //     </span>
  //   )},
  //   { key: 'currentAmount', header: 'Current',   render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.currentAmount)}</span> },
  //   { key: 'status',        header: 'Status',    sortValue: (r) => (
  //     r.status === 'pan_issue' ? 'PAN Issue' : formatStatusLabel(r.status)
  //   ), render: (r) => (
  //     <StatusBadge label={r.status === 'pan_issue' ? 'PAN Issue' : formatStatusLabel(r.status)} tone={thresholdStatusToTone(r.status)} />
  //   )},
  //   { key: 'progress',      header: 'Progress',  render: (r) => (
  //     r.threshold == null
  //       ? <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>—</span>
  //       : <div style={{ width: 130 }}><ProgressBar value={r.progress} showLabel /></div>
  //   )},
  // ]

  const ldcStatusTone = (status) => {
    if (status === 'over_utilized' || status === 'exhausted') return 'danger'
    if (status === 'high_warning' || status === 'warning') return 'warning'
    return 'success'
  }

  // Unique PAN rows. A PAN can hold several certificates (one per section),
  // each with its own limit, so those stay separate inside the expanded row;
  // the PAN row shows the totals and the worst status across them.
  const ldcPanRows = useMemo(() => {
    const byPan = new Map()
    filteredLdc.forEach((cert) => {
      const pan = cert.pan || '—'
      if (!byPan.has(pan)) byPan.set(pan, { id: pan, pan, certificates: [], vendorMap: new Map() })
      const group = byPan.get(pan)
      group.certificates.push(cert)
      const certVendors = cert.vendors?.length
        ? cert.vendors
        : [{ vendorId: cert.vendorId || cert.vendorCode || '—', vendor: cert.vendor || '—', used: Number(cert.used || 0), transactions: cert.transactions }]
      certVendors.forEach((v) => {
        const vendor = group.vendorMap.get(v.vendorId) || { vendorId: v.vendorId, vendor: v.vendor, used: 0, transactions: 0, certificates: [] }
        vendor.used += Number(v.used || 0)
        vendor.transactions += Number(v.transactions || 0)
        if (!vendor.certificates.includes(cert.certificateNumber)) vendor.certificates.push(cert.certificateNumber)
        group.vendorMap.set(v.vendorId, vendor)
      })
    })
    const isActive = (cert) => cert.validityLabel === 'Active'
    // Active certificates are the ones that matter now: their PANs come first,
    // and inside a PAN its active certificates are listed first.
    return [...byPan.values()].map(({ vendorMap, ...group }) => {
      const certs = [...group.certificates].sort((a, b) => Number(isActive(b)) - Number(isActive(a)))
      group.certificates = certs
      const worst = certs.reduce((a, b) => ((LDC_STATUS_RANK[b.status] ?? 0) > (LDC_STATUS_RANK[a.status] ?? 0) ? b : a))
      const active = certs.find((c) => c.validityLabel === 'Active')
      const latest = [...certs].sort((a, b) => String(b.validTo || '').localeCompare(String(a.validTo || '')))[0]
      const utilizations = certs.map((c) => c.utilization).filter((u) => u != null)
      // Limit / balance add up only certificates that have a limit set.
      const limited = certs.filter((c) => c.limit != null && Number.isFinite(Number(c.limit)))
      return {
        ...group,
        vendors: [...vendorMap.values()].sort((a, b) => b.used - a.used),
        used: certs.reduce((sum, c) => sum + Number(c.used || 0), 0),
        limit: limited.length ? limited.reduce((sum, c) => sum + Number(c.limit), 0) : null,
        available: limited.length ? limited.reduce((sum, c) => sum + Number(c.available ?? 0), 0) : null,
        limitNotSet: certs.length - limited.length,
        status: worst.status,
        statusLabel: worst.statusLabel,
        validityLabel: (active || latest).validityLabel,
        validityTone: (active || latest).validityTone,
        utilization: utilizations.length ? Math.max(...utilizations) : null,
      }
    }).sort((a, b) => Number(b.validityLabel === 'Active') - Number(a.validityLabel === 'Active'))
  }, [filteredLdc])

  function renderLdcPan(p) {
    return (
      <div className="ldc-pan-detail">
        <div className="ldc-sub-title">Certificates ({p.certificates.length})</div>
        <table className="ldc-vendor-table">
          <thead>
            <tr><th>Certificate</th><th>LDC Limit</th><th>Utilized</th><th>Available</th><th>Validity</th><th>Cert Status</th><th>Utilization Status</th><th>Progress</th></tr>
          </thead>
          <tbody>
            {p.certificates.map((c) => (
              <tr key={c.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{c.certificateNumber}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{c.section} · exemption {c.approvedRate ?? '—'}%</div>
                </td>
                <td className="font-mono">{c.limit == null ? 'Not set' : formatCurrency(c.limit)}</td>
                <td className="font-mono">{formatCurrency(c.used || 0)}</td>
                <td className="font-mono">{c.available == null ? '—' : formatCurrency(c.available)}</td>
                <td className="font-mono">{formatDate(c.validFrom)} - {formatDate(c.validTo)}</td>
                <td><StatusBadge label={c.validityLabel || 'Validity Unknown'} tone={c.validityTone || 'neutral'} /></td>
                <td><StatusBadge label={c.statusLabel || 'Within LDC Limit'} tone={ldcStatusTone(c.status)} /></td>
                <td>{c.utilization == null ? '—' : <div style={{ width: 120 }}><ProgressBar value={Math.min(c.utilization, 100)} showLabel /></div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ldc-sub-title">Vendors ({p.vendors.length})</div>
        <table className="ldc-vendor-table">
          <thead>
            <tr><th>Vendor Code</th><th>Vendor</th><th>Certificate</th><th>Utilized</th><th>Share of PAN</th><th>Transactions</th></tr>
          </thead>
          <tbody>
            {p.vendors.map((v) => (
              <tr key={v.vendorId}>
                <td className="font-mono">{v.vendorId}</td>
                <td>{v.vendor}</td>
                <td className="font-mono">{v.certificates.join(', ')}</td>
                <td className="font-mono">{formatCurrency(v.used || 0)}</td>
                <td className="font-mono">{p.used ? `${roundToTwo((v.used / p.used) * 100)}%` : '—'}</td>
                <td className="font-mono">{v.transactions || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {p.certificates.some((c) => !c.vendors?.length) && (
          <div className="ldc-vendor-empty">Re-upload the SAP file to see every vendor code under each certificate.</div>
        )}
      </div>
    )
  }

  const ldcColumns = [
    { key: 'pan', header: 'PAN', render: (p) => (
      <span className="ldc-pan-cell">
        {expandedLdcKey === p.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-mono" style={{ fontSize: 11.5, fontWeight: 600 }}>{p.pan}</span>
      </span>
    )},
    { key: 'vendors', header: 'Vendor', sortValue: (p) => p.vendors[0]?.vendor || '', render: (p) => (
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{p.vendors[0]?.vendor || '—'}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {p.vendors.length === 1 ? p.vendors[0].vendorId : `${p.vendors.length} vendor codes`}
        </div>
      </div>
    )},
    { key: 'certificates', header: 'Certificates', sortValue: (p) => p.certificates.length, render: (p) => (
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
          {p.certificates.length === 1 ? p.certificates[0].certificateNumber : `${p.certificates.length} certificates`}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {p.certificates.length === 1
            ? `${p.certificates[0].section} · exemption ${p.certificates[0].approvedRate ?? '—'}%`
            : p.certificates.map((c) => c.certificateNumber).join(', ')}
        </div>
      </div>
    )},
    { key: 'limit', header: 'LDC Limit', sortValue: (p) => p.limit ?? -1, render: (p) => (
      <div>
        <span className="font-mono" style={{ fontSize: 11.5 }}>{p.limit == null ? 'Not set' : formatCurrency(p.limit)}</span>
        {p.limit != null && p.limitNotSet > 0 && (
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{p.limitNotSet} of {p.certificates.length} not set</div>
        )}
      </div>
    )},
    { key: 'used', header: 'Total Utilized', render: (p) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(p.used || 0)}</span> },
    { key: 'available', header: 'Balance', sortValue: (p) => p.available ?? -Infinity, render: (p) => (
      <span className="font-mono" style={{ fontSize: 11.5, color: p.available != null && p.available < 0 ? '#DC2626' : undefined }}>
        {p.available == null ? '—' : formatCurrency(p.available)}
      </span>
    )},
    { key: 'validityStatus', header: 'Cert Status', sortValue: (p) => p.validityLabel || 'Validity Unknown', render: (p) => (
      <StatusBadge label={p.validityLabel || 'Validity Unknown'} tone={p.validityTone || 'neutral'} />
    )},
    { key: 'status', header: 'Utilization Status', sortValue: (p) => LDC_STATUS_RANK[p.status] ?? 0, render: (p) => <StatusBadge label={p.statusLabel || 'Within LDC Limit'} tone={ldcStatusTone(p.status)} /> },
    { key: 'utilization', header: 'Highest Utilization', sortValue: (p) => p.utilization ?? -1, render: (p) => (
      p.utilization == null
        ? <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>—</span>
        : <div style={{ width: 130 }}><ProgressBar value={Math.min(p.utilization, 100)} showLabel /></div>
    )},
  ]

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">Threshold Monitoring</span>
          </div>
          <h1 className="page-title">Threshold Monitoring</h1>
        </div>
        <div className="issues-header-actions">
          <LiveDataBadge />
          <button className="btn btn-outline" type="button"><Download size={14} />Export</button>
        </div>
      </div>

      {/* Vendor Threshold Tracker disabled: its hint and Exceeded / PAN Issues / Near Limit / Safe cards.
      {isLive && (
        <p className="sap-hint" style={{ border: '1px solid var(--color-border)', borderRadius: 8, marginBottom: 10, background: 'var(--color-surface)' }}>
          Vendor thresholds are derived from your latest SAP upload (issue amounts by vendor + section).
        </p>
      )}

      <div className="summary-grid-4">
        {summaryCards.map((c) => (
          <div key={c.label} className="kpi-card">
            <div className="kpi-icon-row">
              <span className="kpi-label">{c.label}</span>
              <div className={`kpi-icon-box ${c.tone}`}><c.icon size={14} /></div>
            </div>
            <span className="kpi-value">{c.value}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{c.sub}</span>
          </div>
        ))}
      </div>
      */}

      {isLive && (
        <div className="summary-grid-4" style={{ marginTop: 12 }}>
          <div className="kpi-card">
            <div className="kpi-icon-row"><span className="kpi-label">LDC Certificates Used</span><div className="kpi-icon-box info"><BadgePercent size={14} /></div></div>
            <span className="kpi-value">{currentLdcUtilization.length}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>From latest SAP upload</span>
          </div>
          <div className="kpi-card">
            <div className="kpi-icon-row"><span className="kpi-label">LDC Warnings</span><div className="kpi-icon-box warning"><Gauge size={14} /></div></div>
            <span className="kpi-value">{ldcWarning.length}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>80% or 90% utilized</span>
          </div>
          <div className="kpi-card">
            <div className="kpi-icon-row"><span className="kpi-label">LDC Critical</span><div className="kpi-icon-box danger"><AlertOctagon size={14} /></div></div>
            <span className="kpi-value">{ldcCritical.length}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Exhausted or over-utilized</span>
          </div>
          <div className="kpi-card">
            <div className="kpi-icon-row"><span className="kpi-label">LDC Utilized Base</span><div className="kpi-icon-box success"><ShieldCheck size={14} /></div></div>
            <span className="kpi-value">{formatCurrency(currentLdcUtilization.reduce((sum, row) => sum + (Number(row.used) || 0), 0))}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Eligible base under LDC</span>
          </div>
        </div>
      )}

      <div className="chart-grid-2col">
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">LDC Limit vs Used Amount</p>
              <p className="chart-subtitle">PANs with an active certificate · top 5 by used, highest first · ₹ crore</p>
            </div>
          </div>
          {ldcLimitVsUsedData.length === 0 ? (
            <div className="data-table-empty" style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              No active LDC certificates for the vendors in this upload
            </div>
          ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={ldcLimitVsUsedData} margin={{ top: 2, right: 4, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
              <XAxis dataKey="certificate" tick={{ fontSize: 10, fill: '#64748B', fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: '#E5E7EB' }} tickLine={false} interval={0} />
              <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }}
                formatter={(value, name) => [`₹${Number(value || 0).toLocaleString('en-IN')} Cr`, name]}
                labelFormatter={(label, rows) => {
                  const row = rows?.[0]?.payload
                  return row?.vendor ? `${label} · ${row.vendor}` : label
                }}
                cursor={{ fill: '#F8FAFC' }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="limit" fill="#CBD5E1" radius={[4, 4, 0, 0]} maxBarSize={24} name="Limit" />
              <Bar dataKey="used" fill="#E01330" radius={[4, 4, 0, 0]} maxBarSize={24} name="Used">
                {/* Used is often tiny next to the limit, so print its value. */}
                <LabelList
                  dataKey="used"
                  position="top"
                  formatter={(value) => (Number(value) > 0 ? `₹${Number(value).toLocaleString('en-IN')} Cr` : '')}
                  style={{ fontSize: 10, fill: '#E01330', fontWeight: 600 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          )}
        </div>
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <p className="chart-title">LDC Utilization Trend Over Time</p>
              <p className="chart-subtitle">Cumulative used base by posting month · active first, highest used first</p>
            </div>
          </div>
          {ldcTrendSeries.data.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={ldcTrendSeries.data} margin={{ top: 2, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} axisLine={{ stroke: '#E5E7EB' }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }}
                  formatter={(value, name) => [`₹${Number(value || 0).toLocaleString('en-IN')} Cr`, name]}
                  cursor={{ stroke: '#E5E7EB' }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {ldcTrendSeries.keys.map((key, index) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stroke={TREND_COLORS[index % TREND_COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                    name={key}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="data-table-empty" style={{ height: 220 }}>
              Re-analyse the SAP file to build month-wise LDC utilization from posting dates.
            </div>
          )}
        </div>
      </div>

      <div className="table-card">
        <div className="table-card-header">
          <div>
            <div className="threshold-tabs" role="tablist" aria-label="Threshold trackers">
              <button
                type="button"
                role="tab"
                aria-selected
                className="threshold-tab active"
              >
                LDC Certificate Limit Tracker
              </button>
              {/* Vendor Threshold Tracker disabled.
              <button
                type="button"
                role="tab"
                aria-selected={activeTracker === 'vendor'}
                className={`threshold-tab ${activeTracker === 'vendor' ? 'active' : ''}`}
                onClick={() => setActiveTracker('vendor')}
              >
                Vendor Threshold Tracker
              </button>
              */}
            </div>
          </div>
          <input
            className="filter-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search LDC, PAN, vendor…"
            style={{ width: 180 }}
          />
        </div>
        <DataTable
          columns={ldcColumns}
          data={ldcPanRows}
          pageSize={8}
          expandedRowKey={expandedLdcKey}
          onRowClick={(row) => setExpandedLdcKey((key) => (key === row.id ? null : row.id))}
          renderExpandedRow={renderLdcPan}
          emptyState={<div className="data-table-empty">No LDC utilization found in the latest SAP upload</div>}
        />
        {/* Vendor Threshold Tracker disabled.
        <DataTable columns={columns} data={filtered} pageSize={8} />
        */}
      </div>
    </div>
  )
}
