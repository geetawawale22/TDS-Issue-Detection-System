import { pickWeightedScenario, simulatePanVerification } from './issueTypes'

export const sections = ['194C', '194J', '194H', '194I', '194Q', '192', '194A', '194D', '195']

export const vendorNames = [
  'Apex Logistics Pvt Ltd', 'Meridian Consulting Group', 'Bluewave Technologies',
  'Sterling Facility Services', 'Crestline Manufacturing', 'Northgate Properties',
  'Vantage Marketing Solutions', 'Pinnacle IT Services', 'Coastal Freight Carriers',
  'Harborview Constructions', 'Zenith Legal Associates', 'Brightpath Staffing',
  'Ironclad Security Services', 'Quantum Data Systems', 'Silverline Equipment Leasing',
  'Eastwood Realty Group', 'Cascade Engineering Works', 'Highline Media Productions',
  'Westbrook Insurance Brokers', 'Riverside Catering Co.',
]

// Overseas vendors used for non-resident-specific issue types (Wrong Section
// for Non-Resident, DTAA / Form 197 rate mismatches).
export const nonResidentVendorNames = [
  'Accenture Ireland Ltd', 'SAP SE Germany', 'Microsoft Corporation (USA)',
  'Cognizant Technology Solutions (US)', 'Nomura Holdings Japan',
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

function generatePan() {
  return `AAAC${String.fromCharCode(65 + Math.floor(rand() * 26))}${1000 + Math.floor(rand() * 9000)}${String.fromCharCode(65 + Math.floor(rand() * 26))}`
}

// A handful of vendors are reserved as always having a missing/malformed
// PAN, so the PAN-format rule scenarios (PAN_MISSING_*, PAN_CORRECT) always
// pick a vendor whose PAN genuinely justifies that narrative — rather than
// firing for a vendor whose PAN is otherwise fine elsewhere in the data.
const PAN_ISSUE_VENDORS = vendorNames.slice(0, 3)

// PAN validity/verification is a per-VENDOR fact, computed once here and
// looked up by every issue for that vendor — not re-rolled per issue. This
// is also the seed for the `pan` redux slice, which is what "Verify PAN"
// actually mutates at runtime.
export const vendorDirectory = Object.fromEntries(
  [...vendorNames, ...nonResidentVendorNames].map((name, i) => {
    const pan = PAN_ISSUE_VENDORS.includes(name)
      ? (i % 2 === 0 ? '' : 'AAAC123XQ') // missing, or malformed (wrong digit/letter layout)
      : generatePan()
    const verification = simulatePanVerification(pan, rand)
    return [name, {
      vendorId: `VND-${1000 + i}`,
      pan: verification.pan,
      panStatus: verification.status,
      panAadhaarLinked: verification.aadhaarLinked,
      panIsMocked: verification.isMocked,
      panCheckedAt: new Date(2026, Math.floor(rand() * 5), 1 + Math.floor(rand() * 28)).toISOString(),
    }]
  })
)

export const issues = Array.from({ length: 48 }, (_, i) => {
  const scenario = pickWeightedScenario(rand)
  const gen = scenario.generate({ rand, randomFrom, vendorNames, nonResidentVendorNames, panIssueVendors: PAN_ISSUE_VENDORS, sections })

  const expectedRate = gen.expectedRateOverride ?? [1, 2, 5, 10, 0.1][Math.floor(rand() * 5)]
  const appliedRate = gen.appliedRateOverride ?? (rand() > 0.5 ? expectedRate : Math.max(0, expectedRate - (1 + Math.floor(rand() * 3))))
  const baseAmount = Math.floor(50000 + rand() * 4500000)
  const tdsAmount = gen.tdsAmountOverride ?? Math.round((baseAmount * appliedRate) / 100)
  const source = rand() > 0.35 ? 'GL' : 'PO'
  const statusPool = ['open', 'in_review', 'resolved', 'rejected']

  const caseObj = { vendor: gen.vendor, section: gen.section, expectedRate, appliedRate, baseAmount, tdsAmount, extra: gen.extra }
  const issueDetail = scenario.buildMessage(caseObj)
  const recommendedAction = scenario.buildAction(caseObj)

  const vendorInfo = vendorDirectory[gen.vendor]

  return {
    id: `ISS-${String(2400 + i).padStart(5, '0')}`,
    docNo: source === 'GL' ? String(6000000000 + Math.floor(rand() * 100)) : 'N/A',
    vendor: gen.vendor,
    vendorId: vendorInfo.vendorId,
    vendorPan: vendorInfo.pan || '—',
    section: gen.section,
    source,
    transactionAmount: baseAmount,
    baseAmount,
    tdsAmount,
    expectedRate,
    appliedRate,
    taxImpact: Math.round((baseAmount * (expectedRate - appliedRate)) / 100),
    issueType: scenario.id,
    issueTypeLabel: scenario.label,
    category: scenario.category,
    isViolation: scenario.isViolation,
    severity: scenario.severity,
    status: randomFrom(statusPool),
    date: new Date(2026, Math.floor(rand() * 5), 1 + Math.floor(rand() * 28)).toISOString(),
    description: issueDetail,
    suggestedCorrection: recommendedAction,
    issueDetail,
    recommendedAction,
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
    pan: vendorDirectory[name].pan || '—',
    section: randomFrom(sections),
    threshold,
    currentAmount,
    status,
    progress: Math.min(progress, 1.3) * 100,
    issueCount: Math.floor(rand() * 6),
  }
})

// GL Correction Audit Trail — derived from actually-resolved issues (the
// same "Corrected" issues shown on the Issues page), not a separate
// disconnected mock. Every resolved, GL-sourced issue where the correct
// rate exceeds what was applied implies a real three-posting GL trail:
// the original (wrong) entry, a reversal of it, and a correction entry at
// the right rate — which is exactly what needs to be deposited as a
// shortfall.
export const glCorrections = issues
  .filter((issue) => issue.status === 'resolved' && issue.source === 'GL')
  .map((issue, i) => {
    const wrongTds = issue.tdsAmount
    const correctTds = Math.round((issue.baseAmount * issue.expectedRate) / 100)
    const originalDate = new Date(issue.date)
    const correctionDate = new Date(originalDate)
    correctionDate.setDate(correctionDate.getDate() + 30 + Math.floor(rand() * 150))
    return {
      id: issue.id,
      vendor: issue.vendor,
      section: issue.section,
      originalDoc: issue.docNo,
      reversalDoc: String(6100000000 + i),
      correctionDoc: String(6200000000 + i),
      originalDate: originalDate.toISOString(),
      correctionDate: correctionDate.toISOString(),
      baseAmount: issue.baseAmount,
      wrongTds,
      correctTds,
      shortfall: correctTds - wrongTds,
    }
  })
  .filter((c) => c.shortfall > 0)

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
