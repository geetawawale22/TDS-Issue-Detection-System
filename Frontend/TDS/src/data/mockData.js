export const sections = ['194C', '194J', '194H', '194I', '194Q', '192', '194A', '194D']

export const vendorNames = [
  'Apex Logistics Pvt Ltd', 'Meridian Consulting Group', 'Bluewave Technologies',
  'Sterling Facility Services', 'Crestline Manufacturing', 'Northgate Properties',
  'Vantage Marketing Solutions', 'Pinnacle IT Services', 'Coastal Freight Carriers',
  'Harborview Constructions', 'Zenith Legal Associates', 'Brightpath Staffing',
  'Ironclad Security Services', 'Quantum Data Systems', 'Silverline Equipment Leasing',
  'Eastwood Realty Group', 'Cascade Engineering Works', 'Highline Media Productions',
  'Westbrook Insurance Brokers', 'Riverside Catering Co.',
]

function seededRandom(seed) {
  let value = seed
  return () => {
    value = (value * 9301 + 49297) % 233280
    return value / 233280
  }
}

const rand = seededRandom(42)
const randomFrom = (arr) => arr[Math.floor(rand() * arr.length)]

export const issues = Array.from({ length: 48 }, (_, i) => {
  const expectedRate = [1, 2, 5, 10, 0.1][Math.floor(rand() * 5)]
  const appliedRate = rand() > 0.5 ? expectedRate : Math.max(0, expectedRate - (1 + Math.floor(rand() * 3)))
  const transactionAmount = Math.floor(50000 + rand() * 4500000)
  const severity = appliedRate === expectedRate ? 'low' : appliedRate < expectedRate - 2 ? 'high' : 'medium'
  const statusPool = ['open', 'in_review', 'resolved', 'rejected']
  return {
    id: `ISS-${String(2400 + i).padStart(5, '0')}`,
    vendor: randomFrom(vendorNames),
    vendorId: `VND-${1000 + Math.floor(rand() * 20)}`,
    section: randomFrom(sections),
    transactionAmount,
    expectedRate,
    appliedRate,
    taxImpact: Math.round((transactionAmount * (expectedRate - appliedRate)) / 100),
    severity,
    status: randomFrom(statusPool),
    date: new Date(2026, Math.floor(rand() * 5), 1 + Math.floor(rand() * 28)).toISOString(),
    description: `TDS deducted at ${appliedRate}% against the applicable rate of ${expectedRate}% under Section ${randomFrom(sections)}, resulting in a short deduction flagged during automated reconciliation.`,
    suggestedCorrection: `Recompute deduction at ${expectedRate}% and file a correction statement for the affected quarter to reconcile the shortfall.`,
  }
})

export const vendors = vendorNames.map((name, i) => {
  const threshold = [30000, 100000, 240000, 1000000][Math.floor(rand() * 4)]
  const progress = rand() * 1.3
  const currentAmount = Math.round(threshold * progress)
  const status = progress >= 1 ? 'exceeded' : progress >= 0.75 ? 'near' : 'safe'
  return {
    id: `VND-${1000 + i}`,
    name,
    pan: `AAAC${String.fromCharCode(65 + Math.floor(rand() * 26))}${1000 + Math.floor(rand() * 9000)}${String.fromCharCode(65 + Math.floor(rand() * 26))}`,
    section: randomFrom(sections),
    threshold,
    currentAmount,
    status,
    progress: Math.min(progress, 1.3) * 100,
    issueCount: Math.floor(rand() * 6),
  }
})

const timelineStages = ['Original Entry', 'Suggested Correction', 'Approved', 'Applied']

export const corrections = Array.from({ length: 24 }, (_, i) => {
  const statusPool = ['pending', 'approved', 'rejected', 'applied']
  const status = randomFrom(statusPool)
  const stageIndex = status === 'pending' ? 1 : status === 'rejected' ? 2 : status === 'approved' ? 2 : 3
  return {
    id: `COR-${String(3100 + i).padStart(5, '0')}`,
    vendor: randomFrom(vendorNames),
    section: randomFrom(sections),
    originalEntry: `₹${(10000 + Math.floor(rand() * 400000)).toLocaleString('en-IN')} @ ${[1, 2, 5][Math.floor(rand() * 3)]}%`,
    suggestedEntry: `₹${(10000 + Math.floor(rand() * 400000)).toLocaleString('en-IN')} @ ${[2, 5, 10][Math.floor(rand() * 3)]}%`,
    reviewer: randomFrom(['Anita Rao', 'Karthik Iyer', 'Priya Menon', 'Suresh Nair', 'Divya Krishnan']),
    status,
    taxImpact: Math.floor(2000 + rand() * 80000),
    date: new Date(2026, Math.floor(rand() * 5), 1 + Math.floor(rand() * 28)).toISOString(),
    timeline: timelineStages.map((stage, idx) => ({
      stage,
      completed: idx <= stageIndex,
      date: idx <= stageIndex ? new Date(2026, Math.floor(rand() * 5), 1 + Math.floor(rand() * 28)).toLocaleDateString('en-IN') : undefined,
    })),
  }
})

export const reports = [
  { id: 'RPT-01', name: 'Compliance Summary', type: 'Summary', description: 'A consolidated view of compliance health across all sections and vendors for the selected period.', lastGenerated: '2 hours ago', period: 'FY 2025-26, Q4' },
  { id: 'RPT-02', name: 'Vendor Risk Report', type: 'Risk Analysis', description: 'Ranks vendors by deduction risk, flag frequency, and threshold proximity.', lastGenerated: '1 day ago', period: 'FY 2025-26, Q4' },
  { id: 'RPT-03', name: 'Threshold Analysis', type: 'Threshold', description: 'Tracks threshold consumption trends and forecasts upcoming breaches by section.', lastGenerated: '3 days ago', period: 'FY 2025-26, Q4' },
  { id: 'RPT-04', name: 'Audit Report', type: 'Audit', description: 'Full audit trail of issues, corrections, approvals, and filing-ready documentation.', lastGenerated: '5 days ago', period: 'FY 2025-26, Full Year' },
  { id: 'RPT-05', name: 'Monthly Compliance Report', type: 'Monthly', description: 'Month-over-month compliance metrics with issue resolution velocity.', lastGenerated: '6 hours ago', period: 'May 2026' },
]

export const monthlyTrend = [
  { month: 'Dec', issues: 32, resolved: 28 },
  { month: 'Jan', issues: 41, resolved: 35 },
  { month: 'Feb', issues: 38, resolved: 36 },
  { month: 'Mar', issues: 52, resolved: 40 },
  { month: 'Apr', issues: 45, resolved: 42 },
  { month: 'May', issues: 48, resolved: 44 },
]

export const issuesBySection = sections.map((s) => ({
  section: s,
  count: 4 + Math.floor(rand() * 18),
}))

export const complianceHealth = [
  { name: 'Compliant', value: 76, color: '#10B981' },
  { name: 'Minor Issues', value: 16, color: '#F59E0B' },
  { name: 'Critical Issues', value: 8, color: '#EF4444' },
]

export const topVendorsWithIssues = vendors
  .map((v) => ({ name: v.name.split(' ').slice(0, 2).join(' '), issues: v.issueCount }))
  .sort((a, b) => b.issues - a.issues)
  .slice(0, 6)

export const thresholdConsumptionTrend = [
  { month: 'Dec', consumption: 58 },
  { month: 'Jan', consumption: 64 },
  { month: 'Feb', consumption: 69 },
  { month: 'Mar', consumption: 78 },
  { month: 'Apr', consumption: 84 },
  { month: 'May', consumption: 91 },
]

export const thresholdSectionBreakdown = ['194C', '194J', '194H', '194I', '194Q', '192'].map((section) => ({
  section,
  exceeded: 1 + Math.floor(rand() * 4),
  near: 1 + Math.floor(rand() * 5),
  safe: 3 + Math.floor(rand() * 8),
}))
