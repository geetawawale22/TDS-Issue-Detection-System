import { NO_SECTION, hasSection } from '@/utils/sectionAliases'
/**
 * Derive page-level analytics from the active issue list
 * (sample mock or live SAP upload).
 */

import { getFinancialYear } from '@/utils/utils'

// Same values as backend config/tds_sections.yaml (Budget 2025).
const SECTION_THRESHOLDS = {
  '194Q': 5_000_000,
  '194C': 100_000,
  '194H': 20_000,
  '194J': 50_000,
  '194A': 10_000,
  '194I': 50_000, // per month, not per FY
  '194R': 20_000,
  '192': 0,
  '193': 10_000,
  '195': 0,
}

export function countBy(items, keyFn) {
  const map = new Map()
  for (const item of items) {
    const key = keyFn(item)
    if (!key) continue
    map.set(key, (map.get(key) || 0) + 1)
  }
  return map
}

export function deriveIssuesBySection(issues) {
  const map = countBy(issues, (i) => i.section)
  return [...map.entries()]
    .map(([section, count]) => ({ section, count }))
    .sort((a, b) => b.count - a.count)
}

export function deriveIssuesByType(issues) {
  const map = countBy(issues, (i) => i.issueTypeLabel || i.category || i.issueType)
  return [...map.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
}

export function deriveTopVendors(issues, limit = 6) {
  const map = countBy(issues, (i) => i.vendor || i.vendorId)
  return [...map.entries()]
    .map(([name, issuesCount]) => ({
      vendor: String(name),
      name: String(name).split(' ').slice(0, 2).join(' '),
      issues: issuesCount,
    }))
    .sort((a, b) => b.issues - a.issues)
    .slice(0, limit)
}

export function deriveComplianceHealth(issues, transactionsBuilt = null) {
  const high = issues.filter((i) => i.severity === 'high').length
  const medium = issues.filter((i) => i.severity === 'medium').length
  const low = issues.filter((i) => i.severity === 'low').length
  const flagged = high + medium + low

  let compliant
  if (transactionsBuilt && transactionsBuilt > 0) {
    compliant = Math.max(0, transactionsBuilt - flagged)
  } else {
    // Sample mode: express as shares of the issue set itself
    compliant = Math.max(flagged, 1)
  }

  const total = compliant + high + medium || 1
  const pct = (n) => Math.round((n / total) * 100)

  return [
    { name: 'Compliant', value: pct(compliant), color: '#10B981' },
    { name: 'Minor Issues', value: pct(medium + low), color: '#F59E0B' },
    { name: 'Critical Issues', value: pct(high), color: '#EF4444' },
  ]
}

export function deriveDashboardKpis(issues, uploadStats = null) {
  const high = issues.filter((i) => i.severity === 'high').length
  const medium = issues.filter((i) => i.severity === 'medium').length
  const resolved = issues.filter((i) => i.status === 'resolved').length
  const pending = issues.filter((i) => i.status !== 'resolved' && i.status !== 'rejected').length

  const transactions = uploadStats?.transactionsBuilt
    ?? uploadStats?.rowsRead
    ?? null

  return {
    transactions: transactions ?? issues.length,
    issuesFound: issues.length,
    high,
    medium,
    resolved,
    pending,
    isLive: Boolean(uploadStats),
  }
}

export function deriveThresholdVendors(issues) {
  const byKey = new Map()

  for (const issue of issues) {
    const pan = issue.vendorPan || '—'
    const section = issue.section || '—'
    const hasKnownSection = section !== '—' && Object.prototype.hasOwnProperty.call(SECTION_THRESHOLDS, section)
    const hasPanIssue = (
      String(issue.issueType || '').startsWith('PAN_')
      || /PAN Missing\/Invalid/i.test(issue.category || '')
    )
    const financialYear = getFinancialYear(issue.date || issue.postingDate) || ''
    const key = `${issue.companyCode || ''}||${financialYear}||${pan}||${section}`
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: key,
        name: issue.vendor || issue.vendorId || 'Unknown',
        pan,
        vendorCodes: new Set(),
        vendorNames: new Set(),
        section,
        hasKnownSection,
        baseSum: 0,
        issueCount: 0,
        crossed: false,
        panIssue: false,
      })
    }
    const row = byKey.get(key)
    if (issue.vendorId) row.vendorCodes.add(issue.vendorId)
    if (issue.vendor) row.vendorNames.add(issue.vendor)
    row.baseSum += Number(issue.baseAmount) || 0
    row.issueCount += 1
    row.panIssue = row.panIssue || hasPanIssue
    if (issue.issueType === 'THRESHOLD_CROSSED' || /Threshold Crossed/i.test(issue.category || '')) {
      row.crossed = true
    }
  }

  return [...byKey.values()].map((row) => {
    const threshold = row.hasKnownSection ? SECTION_THRESHOLDS[row.section] : null
    const currentAmount = row.baseSum
    let status = row.hasKnownSection ? 'safe' : 'unclassified'
    let progress = 0

    if (!row.hasKnownSection) {
      status = 'unclassified'
      progress = 0
    } else if (row.panIssue) {
      status = 'pan_issue'
      progress = threshold > 0 ? (currentAmount / threshold) * 100 : 0
    } else if (row.crossed || (threshold > 0 && currentAmount >= threshold)) {
      status = 'exceeded'
      progress = threshold > 0 ? (currentAmount / threshold) * 100 : 100
    } else if (threshold > 0 && currentAmount >= threshold * 0.75) {
      status = 'near'
      progress = threshold > 0 ? (currentAmount / threshold) * 100 : 80
    } else {
      status = 'safe'
      progress = threshold > 0 ? Math.min(74, (currentAmount / threshold) * 100) : 20
    }

    return {
      id: row.id,
      name: row.vendorNames.size ? [...row.vendorNames].slice(0, 2).join(' / ') : row.name,
      pan: row.pan,
      vendorCodes: [...row.vendorCodes],
      section: row.section,
      threshold,
      currentAmount,
      status,
      progress: Math.round(progress),
      issueCount: row.issueCount,
    }
  }).sort((a, b) => {
    const rank = { exceeded: 0, pan_issue: 1, near: 2, unclassified: 3, safe: 4 }
    return (rank[a.status] - rank[b.status]) || (b.currentAmount - a.currentAmount)
  })
}

export function deriveThresholdVendorsFromUpload(thresholdRows, issues) {
  if (!Array.isArray(thresholdRows) || thresholdRows.length === 0) {
    return deriveThresholdVendors(issues)
  }

  const issueGroups = new Map()
  for (const issue of issues || []) {
    const pan = issue.vendorPan || '—'
    const section = issue.section || '—'
    const financialYear = getFinancialYear(issue.date || issue.postingDate) || ''
    const key = `${issue.companyCode || ''}||${financialYear}||${pan}||${section}`
    if (!issueGroups.has(key)) {
      issueGroups.set(key, { issueCount: 0, crossed: false, panIssue: false })
    }
    const group = issueGroups.get(key)
    group.issueCount += 1
    group.panIssue = group.panIssue || (
      String(issue.issueType || '').startsWith('PAN_')
      || /PAN Missing\/Invalid/i.test(issue.category || '')
    )
    group.crossed = group.crossed || (
      issue.issueType === 'THRESHOLD_CROSSED'
      || /Threshold Crossed/i.test(issue.category || '')
    )
  }

  return thresholdRows.map((sourceRow) => {
    const pan = sourceRow.pan || sourceRow.vendorId || '—'
    const section = sourceRow.section || '—'
    const financialYear = sourceRow.financialYear
      ? (String(sourceRow.financialYear).startsWith('FY ') ? sourceRow.financialYear : `FY ${sourceRow.financialYear}`)
      : ''
    const key = sourceRow.id || `${pan}||${section}`
    const issueGroup = issueGroups.get(`${sourceRow.companyCode || ''}||${financialYear}||${pan}||${section}`) || {}
    const hasKnownSection = section !== '—' && Object.prototype.hasOwnProperty.call(SECTION_THRESHOLDS, section)
    const threshold = hasKnownSection ? SECTION_THRESHOLDS[section] : null
    const currentAmount = Number(sourceRow.currentAmount) || 0
    let status = hasKnownSection ? 'safe' : 'unclassified'
    let progress = 0

    if (!hasKnownSection) {
      status = 'unclassified'
      progress = 0
    } else if (issueGroup.panIssue) {
      status = 'pan_issue'
      progress = threshold > 0 ? (currentAmount / threshold) * 100 : 0
    } else if (issueGroup.crossed || (threshold > 0 && currentAmount >= threshold)) {
      status = 'exceeded'
      progress = threshold > 0 ? (currentAmount / threshold) * 100 : 100
    } else if (threshold > 0 && currentAmount >= threshold * 0.75) {
      status = 'near'
      progress = threshold > 0 ? (currentAmount / threshold) * 100 : 80
    } else {
      status = 'safe'
      progress = threshold > 0 ? Math.min(74, (currentAmount / threshold) * 100) : 20
    }

    return {
      id: key,
      name: sourceRow.name || pan || 'Unknown',
      pan,
      vendorCodes: sourceRow.vendorCodes || [],
      section,
      threshold,
      currentAmount,
      status,
      progress: Math.round(progress),
      issueCount: issueGroup.issueCount || 0,
      rowCount: sourceRow.rowCount || 0,
    }
  }).sort((a, b) => {
    const rank = { exceeded: 0, pan_issue: 1, near: 2, unclassified: 3, safe: 4 }
    return (rank[a.status] - rank[b.status]) || (b.currentAmount - a.currentAmount)
  })
}

export function deriveThresholdSectionBreakdown(vendors) {
  const map = new Map()
  for (const v of vendors) {
    if (!map.has(v.section)) {
      map.set(v.section, { section: v.section, exceeded: 0, pan_issue: 0, near: 0, unclassified: 0, safe: 0 })
    }
    const row = map.get(v.section)
    row[v.status] = (row[v.status] || 0) + 1
  }
  return [...map.values()].sort((a, b) => a.section.localeCompare(b.section))
}

export function deriveMonthlyTrend(issues) {
  const byMonth = new Map()
  for (const issue of issues) {
    if (!issue.date) continue
    const d = new Date(issue.date)
    if (Number.isNaN(d.getTime())) continue
    const label = d.toLocaleString('en-IN', { month: 'short' })
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, { month: label, monthKey, issues: 0, resolved: 0 })
    const row = byMonth.get(monthKey)
    row.issues += 1
    if (issue.status === 'resolved') row.resolved += 1
  }
  // Year-month keys sort chronologically, so an FY upload runs Apr → Mar.
  const rows = [...byMonth.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey))
  if (rows.length === 0) {
    return [{ month: 'Current', monthKey: null, issues: issues.length, resolved: issues.filter((i) => i.status === 'resolved').length }]
  }
  return rows.map(({ month, monthKey, issues: iss, resolved }) => ({ month, monthKey, issues: iss, resolved }))
}

export const SECTION_TREND_OTHERS = 'Others'

/**
 * Issue counts per posting month split by TDS section, for the stacked
 * "By Section" and "Compare" views of the Monthly Trend chart. The top
 * `limit` sections keep their own series; the rest are grouped as Others.
 * Months are chronological (Apr → Mar for an FY upload).
 */
export function deriveSectionMonthlyTrend(issues, limit = 5) {
  const sectionOf = (issue) => (hasSection(issue.section) ? String(issue.section).trim().toUpperCase() : NO_SECTION)
  const totals = countBy(issues.filter((i) => i.date), sectionOf)
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([section]) => section)
  const sections = ranked.slice(0, limit)
  const kept = new Set(sections)
  if (ranked.length > limit) sections.push(SECTION_TREND_OTHERS)

  const byMonth = new Map()
  for (const issue of issues) {
    if (!issue.date) continue
    const d = new Date(issue.date)
    if (Number.isNaN(d.getTime())) continue
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!byMonth.has(monthKey)) {
      const row = { month: d.toLocaleString('en-IN', { month: 'short' }), monthKey, total: 0 }
      sections.forEach((section) => { row[section] = 0 })
      byMonth.set(monthKey, row)
    }
    const row = byMonth.get(monthKey)
    const section = sectionOf(issue)
    row[kept.has(section) ? section : SECTION_TREND_OTHERS] += 1
    row.total += 1
  }
  const months = [...byMonth.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey))
  return { sections, months }
}

/** Month-on-month totals with severity mix and % change vs. the prior month. */
export function deriveMonthlyComparison(issues) {
  const byMonth = new Map()
  for (const issue of issues) {
    if (!issue.date) continue
    const d = new Date(issue.date)
    if (Number.isNaN(d.getTime())) continue
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!byMonth.has(key)) {
      byMonth.set(key, {
        key,
        month: d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
        high: 0,
        medium: 0,
        low: 0,
        total: 0,
      })
    }
    const row = byMonth.get(key)
    row.total += 1
    row[issue.severity] = (row[issue.severity] || 0) + 1
  }
  const sorted = [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key))
  return sorted.map((row, idx) => {
    const prev = sorted[idx - 1]?.total ?? null
    let change = null
    if (prev != null) change = prev === 0 ? (row.total === 0 ? 0 : null) : ((row.total - prev) / prev) * 100
    return { ...row, change: change == null ? null : Number(change.toFixed(1)) }
  })
}

/** Issue-count trend per month for the top N vendors, pivoted for a multi-line chart. */
export function deriveVendorMonthlyTrend(issues, limit = 5) {
  const totals = countBy(issues, (i) => i.vendor)
  const topVendors = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name)

  const byMonth = new Map()
  for (const issue of issues) {
    if (!issue.date || !issue.vendor || !topVendors.includes(issue.vendor)) continue
    const d = new Date(issue.date)
    if (Number.isNaN(d.getTime())) continue
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!byMonth.has(key)) {
      const row = { key, month: d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) }
      topVendors.forEach((v) => { row[v] = 0 })
      byMonth.set(key, row)
    }
    byMonth.get(key)[issue.vendor] += 1
  }
  const data = [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key))
  return { data, vendors: topVendors }
}

export function deriveThresholdConsumptionTrend(issues) {
  const months = deriveMonthlyTrend(issues)
  return months.map((m) => ({
    month: m.month,
    consumption: Math.min(100, Math.round((m.issues / Math.max(issues.length, 1)) * 100) + 40),
  }))
}
