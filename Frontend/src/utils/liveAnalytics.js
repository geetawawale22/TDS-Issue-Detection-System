/**
 * Derive page-level analytics from the active issue list
 * (sample mock or live SAP upload).
 */
import { getDisplayIssueType, issueTypeFilterOptions, MULTI_CATEGORY_DELIMITER } from '@/data/issueTypes'

const SECTION_THRESHOLDS = {
  '194Q': 5_000_000,
  '194C': 100_000,
  '194H': 15_000,
  '194J': 0,
  '194A': 10_000,
  '194I': 240_000,
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

/** Issue counts grouped by the same friendly labels used in the Issue Type filter dropdown. */
export function deriveIssuesByType(issues, limit = 10) {
  const options = issueTypeFilterOptions()
  const labelFor = (category) => {
    if (!category) return 'Uncategorized'
    const match = options.find(([key]) => key.split(MULTI_CATEGORY_DELIMITER).includes(category))
    return match ? match[1] : category
  }
  const map = countBy(issues, (i) => labelFor(getDisplayIssueType(i)))
  return [...map.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

export function deriveTopVendors(issues, limit = 6) {
  const map = countBy(issues, (i) => i.vendor || i.vendorId)
  return [...map.entries()]
    .map(([name, issuesCount]) => ({
      name: String(name).split(' ').slice(0, 2).join(' '),
      issues: issuesCount,
    }))
    .sort((a, b) => b.issues - a.issues)
    .slice(0, limit)
}

/**
 * A row with a zero base amount can't actually be rate-checked, so it reads
 * as "insufficient data" rather than a false "passed" — same reclassification
 * Issues.jsx applies to its own validation table, extracted here so every
 * page that counts Passed/Issues Found/Insufficient Data agrees exactly.
 */
export function deriveAdjustedValidationRows(validationRows) {
  return validationRows.map((row) => (
    Number(row.baseAmount) === 0
      ? { ...row, status: 'insufficient', reason: 'Base amount is zero, so TDS cannot be validated for this row.' }
      : row
  ))
}

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 }

/**
 * Per-transaction severity, worst-wins. A single transaction can trigger
 * more than one rule at once (e.g. wrong rate AND a missing PAN), so the
 * flat issue-instance list can have more rows than there are transactions.
 * Grouping by transaction here means High+Medium+Low always sums to the
 * transaction-level Issues Found count, not the larger instance count.
 * The key includes PO No — two transactions (e.g. a partial invoice booked
 * in stages) can legitimately share the same Doc No/vendor/section and are
 * only distinguished by PO, so leaving it out would wrongly merge them into
 * one. Rows without a usable doc number (blank/placeholder) fall back to a
 * per-row key so they never get incorrectly merged with each other.
 */
export function deriveTransactionSeverityCounts(issues) {
  const worstByTransaction = new Map()
  issues.forEach((issue, idx) => {
    const key = issue.docNo && issue.docNo !== '—'
      ? `${issue.docNo}|${issue.poNo}|${issue.vendorId}|${issue.section}`
      : `__row-${idx}`
    const current = worstByTransaction.get(key)
    if (!current || SEVERITY_RANK[issue.severity] > SEVERITY_RANK[current]) {
      worstByTransaction.set(key, issue.severity)
    }
  })
  const counts = { high: 0, medium: 0, low: 0 }
  worstByTransaction.forEach((sev) => { if (counts[sev] != null) counts[sev] += 1 })
  return counts
}

/**
 * The Dashboard's live-upload KPI strip — every number here is derived the
 * same way (same source arrays, same zero-base-amount reclassification,
 * same transaction-level severity grouping) as the Upload Results/Issues
 * page, so the two pages can never show different counts for the same
 * concept. `validationRows` must already be Company/FY-scoped
 * (selectActiveValidationRows); `uploadStats` is the raw, unscoped backend
 * stats object (only its whole-file rowsRead figure is used here).
 */
export function deriveUploadKpis(issues, validationRows, uploadStats) {
  const adjusted = deriveAdjustedValidationRows(validationRows)
  const passed = adjusted.filter((r) => r.status === 'passed').length
  const issuesFound = adjusted.filter((r) => r.status === 'issue').length
  const insufficientData = adjusted.filter((r) => r.status === 'insufficient').length
  const { high, medium, low } = deriveTransactionSeverityCounts(issues)
  const resolved = issues.filter((i) => i.status === 'resolved').length
  const pending = Math.max(0, issuesFound - resolved)

  return {
    uploadedRows: uploadStats?.rowsRead ?? validationRows.length,
    transactionsProcessed: validationRows.length,
    passed,
    issuesFound,
    insufficientData,
    high,
    medium,
    low,
    resolved,
    pending,
  }
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
    const vendorId = issue.vendorId || issue.vendor
    const section = issue.section || '—'
    const hasKnownSection = section !== '—' && Object.prototype.hasOwnProperty.call(SECTION_THRESHOLDS, section)
    const hasPanIssue = (
      String(issue.issueType || '').startsWith('PAN_')
      || /PAN Missing\/Invalid/i.test(issue.category || '')
    )
    const key = `${vendorId}||${section}`
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: key,
        name: issue.vendor || vendorId || 'Unknown',
        pan: issue.vendorPan || '—',
        section,
        hasKnownSection,
        baseSum: 0,
        issueCount: 0,
        crossed: false,
        panIssue: false,
      })
    }
    const row = byKey.get(key)
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
      name: row.name,
      pan: row.pan,
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
    const vendorId = issue.vendorId || issue.vendor
    const section = issue.section || '—'
    const key = `${vendorId}||${section}`
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
    const vendorId = sourceRow.vendorId || sourceRow.name
    const section = sourceRow.section || '—'
    const key = sourceRow.id || `${vendorId}||${section}`
    const issueGroup = issueGroups.get(`${vendorId}||${section}`) || {}
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
      name: sourceRow.name || vendorId || 'Unknown',
      pan: sourceRow.pan || '—',
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

/** GL correction audit rows from rate-shortfall style issues. */
export function deriveGlCorrections(issues) {
  return issues
    .filter((i) => {
      if (!i.isViolation) return false
      const impact = Number(i.taxImpact) || 0
      return impact > 0 || ['WRONG_TDS_RATE', 'PAN_MISSING_SHORT', 'NON_FILER_206AB', 'THRESHOLD_CROSSED'].includes(i.issueType)
    })
    .slice(0, 200)
    .map((issue, idx) => {
      const wrongTds = Number(issue.tdsAmount) || 0
      const expectedRate = Number(issue.expectedRate) || 0
      const base = Number(issue.baseAmount) || 0
      const correctTds = expectedRate
        ? Number(((base * expectedRate) / 100).toFixed(2))
        : Number((wrongTds + Math.max(0, Number(issue.taxImpact) || 0)).toFixed(2))
      const shortfall = Number(Math.max(0, correctTds - wrongTds, Number(issue.taxImpact) || 0).toFixed(2))

      const originalDate = issue.date || new Date().toISOString()
      return {
        id: issue.id || `CORR-${idx}`,
        vendor: issue.vendor,
        section: issue.section,
        originalDoc: issue.docNo,
        reversalDoc: String(6100000000 + idx),
        correctionDoc: String(6200000000 + idx),
        originalDate,
        correctionDate: originalDate,
        baseAmount: base,
        wrongTds,
        correctTds,
        shortfall,
      }
    })
    .filter((c) => c.shortfall > 0)
}

export function deriveMonthlyTrend(issues) {
  const byMonth = new Map()
  for (const issue of issues) {
    if (!issue.date) continue
    const d = new Date(issue.date)
    if (Number.isNaN(d.getTime())) continue
    const label = d.toLocaleString('en-IN', { month: 'short' })
    if (!byMonth.has(label)) byMonth.set(label, { month: label, issues: 0, resolved: 0, _order: d.getMonth() })
    const row = byMonth.get(label)
    row.issues += 1
    if (issue.status === 'resolved') row.resolved += 1
  }
  const rows = [...byMonth.values()].sort((a, b) => a._order - b._order)
  if (rows.length === 0) {
    return [{ month: 'Current', issues: issues.length, resolved: issues.filter((i) => i.status === 'resolved').length }]
  }
  return rows.map(({ month, issues: iss, resolved }) => ({ month, issues: iss, resolved }))
}

export function deriveThresholdConsumptionTrend(issues) {
  const months = deriveMonthlyTrend(issues)
  return months.map((m) => ({
    month: m.month,
    consumption: Math.min(100, Math.round((m.issues / Math.max(issues.length, 1)) * 100) + 40),
  }))
}
