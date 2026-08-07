/**
 * Derive page-level analytics from the active issue list
 * (sample mock or live SAP upload).
 */

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
      progress = threshold > 0 ? Math.min(130, (currentAmount / threshold) * 100) : 0
    } else if (row.crossed || (threshold > 0 && currentAmount >= threshold)) {
      status = 'exceeded'
      progress = threshold > 0 ? Math.min(130, (currentAmount / threshold) * 100) : 100
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
      return impact > 0 || ['SHORT_TDS', 'PAN_MISSING_SHORT', 'NON_FILER_206AB', 'THRESHOLD_CROSSED'].includes(i.issueType)
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
