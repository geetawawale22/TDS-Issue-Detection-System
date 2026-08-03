// Mirrors backend/rules/tds_rule_engine.py exactly: one entry per distinct
// (category, severity) outcome across the 10 check functions + the
// cross-transaction threshold check. `category` is the literal string a
// real API would return in TDSIssue.to_dict().category — keep it in sync
// with the backend if that file changes. `id`/`label`/`group` are frontend
// concerns only, for a readable, groupable Issue Type filter.
export const RULE_SCENARIOS = [
  // ---- GL-based exclusion (check_tds_not_applicable) ----
  {
    id: 'GL_EXCLUSION_VIOLATION',
    label: 'TDS Deducted on Excluded GL Account',
    group: 'GL Exclusion',
    category: 'TDS Not Applicable — Violation',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => ({
      vendor: randomFrom(vendorNames),
      section: randomFrom(sections),
      extra: { glAccount: `${400000 + Math.floor(rand() * 9999)}`, glReason: 'Employee reimbursement — not vendor payment' },
    }),
    buildMessage: ({ tdsAmount, extra }) =>
      `GL account ${extra.glAccount} is excluded (${extra.glReason}), but TDS of ₹${tdsAmount.toLocaleString('en-IN')} was deducted anyway.`,
    buildAction: () => `Reverse the TDS deducted on this excluded GL account and adjust the vendor credit.`,
  },
  {
    id: 'GL_EXCLUSION_CLEAN',
    label: 'GL Exclusion — Correctly Handled',
    group: 'GL Exclusion',
    category: 'TDS Not Applicable',
    severity: 'low',
    isViolation: false,
    generate: ({ rand, randomFrom, vendorNames, sections }) => ({
      vendor: randomFrom(vendorNames),
      section: randomFrom(sections),
      tdsAmountOverride: 0,
      extra: { glReason: 'Employee reimbursement — not vendor payment' },
    }),
    buildMessage: ({ extra }) => `Correctly not applicable — ${extra.glReason}.`,
    buildAction: () => `No action required — GL exclusion correctly applied.`,
  },

  // ---- PAN validity / Section 206AA (check_pan_validity) ----
  {
    id: 'PAN_MISSING_NOT_DEDUCTED',
    label: 'PAN Missing/Invalid — TDS Not Deducted',
    group: 'PAN Validation (206AA)',
    category: 'PAN Missing/Invalid — TDS Not Deducted',
    severity: 'high',
    isViolation: true,
    generate: ({ randomFrom, panIssueVendors, sections }) => ({
      vendor: randomFrom(panIssueVendors),
      section: randomFrom(sections),
      appliedRateOverride: 0,
      tdsAmountOverride: 0,
      extra: { reason: 'missing', requiredRate: 20 },
    }),
    buildMessage: ({ extra }) =>
      `Vendor PAN is ${extra.reason}. Section 206AA requires ${extra.requiredRate}% TDS, but nothing was deducted.`,
    buildAction: () => `Obtain a valid PAN from the vendor and deduct TDS at the Section 206AA rate immediately.`,
  },
  {
    id: 'PAN_MISSING_SHORT',
    label: 'PAN Missing/Invalid — Short Deduction',
    group: 'PAN Validation (206AA)',
    category: 'PAN Missing/Invalid — Short TDS Deducted',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, panIssueVendors, sections }) => {
      const requiredRate = 20
      const appliedRate = [1, 2, 5][Math.floor(rand() * 3)]
      return { vendor: randomFrom(panIssueVendors), section: randomFrom(sections), appliedRateOverride: appliedRate, extra: { reason: 'invalid format', requiredRate, appliedRate } }
    },
    buildMessage: ({ extra }) =>
      `Vendor PAN is ${extra.reason}. Section 206AA requires ${extra.requiredRate}% TDS, but only ${extra.appliedRate}% was deducted.`,
    buildAction: () => `Recompute and deduct the shortfall at the Section 206AA rate; correct the vendor PAN on record.`,
  },
  {
    id: 'PAN_CORRECT',
    label: 'PAN Missing/Invalid — Correctly Handled',
    group: 'PAN Validation (206AA)',
    category: 'PAN Missing/Invalid — Correctly Handled',
    severity: 'low',
    isViolation: false,
    generate: ({ randomFrom, panIssueVendors, sections }) => ({
      vendor: randomFrom(panIssueVendors), section: randomFrom(sections), appliedRateOverride: 20,
      extra: { reason: 'missing', requiredRate: 20 },
    }),
    buildMessage: ({ extra }) => `Vendor PAN is ${extra.reason}, and the required ${extra.requiredRate}% TDS was correctly applied.`,
    buildAction: () => `No action required — Section 206AA rate correctly applied.`,
  },

  // ---- Rate mismatch on the same section (check_short_excess_tds) ----
  {
    id: 'SHORT_TDS',
    label: 'Short TDS Deducted',
    group: 'Rate Mismatch',
    category: 'Short TDS Deducted',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => {
      const expectedRate = [1, 2, 5, 10][Math.floor(rand() * 4)]
      const appliedRate = Math.max(0, expectedRate - (1 + Math.floor(rand() * 3)))
      return { vendor: randomFrom(vendorNames), section: randomFrom(sections), expectedRateOverride: expectedRate, appliedRateOverride: appliedRate, extra: {} }
    },
    buildMessage: ({ appliedRate, expectedRate, section }) =>
      `TDS deducted at ${appliedRate}%, but correct rate is ${expectedRate}% for section ${section}.`,
    buildAction: ({ expectedRate }) => `Recompute the deduction at ${expectedRate}% and file a correction statement for the affected quarter.`,
  },
  {
    id: 'EXCESS_TDS',
    label: 'Excess TDS Deducted',
    group: 'Rate Mismatch',
    category: 'Excess TDS Deducted',
    severity: 'medium',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => {
      const expectedRate = [1, 2, 5][Math.floor(rand() * 3)]
      const appliedRate = expectedRate + (1 + Math.floor(rand() * 3))
      return { vendor: randomFrom(vendorNames), section: randomFrom(sections), expectedRateOverride: expectedRate, appliedRateOverride: appliedRate, extra: {} }
    },
    buildMessage: ({ appliedRate, expectedRate, section }) =>
      `TDS deducted at ${appliedRate}%, but correct rate is ${expectedRate}% for section ${section}.`,
    buildAction: () => `Refund/adjust the excess TDS deducted and correct the vendor's next statement.`,
  },
  {
    id: 'SHORT_EXCESS_194J',
    label: '194J Rate Mismatch (Not 2% or 10%)',
    group: 'Rate Mismatch',
    category: 'Short/Excess TDS Deducted',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames }) => {
      const badRate = [1, 5, 7, 15][Math.floor(rand() * 4)]
      return { vendor: randomFrom(vendorNames), section: '194J', appliedRateOverride: badRate, extra: {} }
    },
    buildMessage: ({ appliedRate }) =>
      `TDS deducted at ${appliedRate}% under Section 194J, but valid rates are 2% (technical) or 10% (professional).`,
    buildAction: () => `Confirm whether this payment is technical (2%) or professional (10%) services and correct the deduction rate.`,
  },
  {
    // The backend's check_amount_consistency reports both directions under
    // one generic category ("Short/Excess TDS Deducted — Amount Mismatch")
    // since it's a ₹-math cross-check, not a rate lookup. That's fine for
    // live data (getDisplayIssueType resolves it per-row from the numbers),
    // but a filter option needs one fixed value per direction — so mock
    // data generates the two directions as genuinely distinct scenarios,
    // each carrying the SAME resolved category string getDisplayIssueType
    // would compute for a live row like this, so mock and live filter
    // identically instead of the dropdown only ever offering the vague
    // combined option.
    id: 'AMOUNT_MISMATCH_SHORT',
    label: 'Amount Mismatch — Short',
    group: 'Rate Mismatch',
    category: 'Short TDS Deducted — Amount Mismatch',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => {
      const expectedRate = [1, 2, 5, 10][Math.floor(rand() * 4)]
      const baseAmount = Math.round(50000 + rand() * 500000)
      const expectedAmount = Math.round(baseAmount * expectedRate / 100)
      const actualAmount = Math.round(expectedAmount * (0.7 + rand() * 0.2)) // always short
      const impliedRate = (actualAmount / baseAmount) * 100
      return {
        vendor: randomFrom(vendorNames), section: randomFrom(sections),
        expectedRateOverride: expectedRate, appliedRateOverride: expectedRate, tdsAmountOverride: actualAmount,
        extra: { baseAmount, expectedAmount, actualAmount, impliedRate },
      }
    },
    buildMessage: ({ appliedRate, extra }) =>
      `Stated rate is ${appliedRate}%, which should give ₹${extra.expectedAmount.toLocaleString('en-IN')} on a base of ₹${extra.baseAmount.toLocaleString('en-IN')}, but only ₹${extra.actualAmount.toLocaleString('en-IN')} was actually deducted (implied rate: ${extra.impliedRate.toFixed(4)}%).`,
    buildAction: () => `Recheck the deduction calculation — the recorded amount is short of what the stated rate implies.`,
  },
  {
    id: 'AMOUNT_MISMATCH_EXCESS',
    label: 'Amount Mismatch — Excess',
    group: 'Rate Mismatch',
    category: 'Excess TDS Deducted — Amount Mismatch',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => {
      const expectedRate = [1, 2, 5, 10][Math.floor(rand() * 4)]
      const baseAmount = Math.round(50000 + rand() * 500000)
      const expectedAmount = Math.round(baseAmount * expectedRate / 100)
      const actualAmount = Math.round(expectedAmount * (1.1 + rand() * 0.2)) // always excess
      const impliedRate = (actualAmount / baseAmount) * 100
      return {
        vendor: randomFrom(vendorNames), section: randomFrom(sections),
        expectedRateOverride: expectedRate, appliedRateOverride: expectedRate, tdsAmountOverride: actualAmount,
        extra: { baseAmount, expectedAmount, actualAmount, impliedRate },
      }
    },
    buildMessage: ({ appliedRate, extra }) =>
      `Stated rate is ${appliedRate}%, which should give ₹${extra.expectedAmount.toLocaleString('en-IN')} on a base of ₹${extra.baseAmount.toLocaleString('en-IN')}, but ₹${extra.actualAmount.toLocaleString('en-IN')} was actually deducted (implied rate: ${extra.impliedRate.toFixed(4)}%).`,
    buildAction: () => `Recheck the deduction calculation — the recorded amount exceeds what the stated rate implies.`,
  },
  {
    id: 'EXCESS_EXCEEDS_INVOICE',
    label: 'TDS Exceeds Full Invoice Amount',
    group: 'Rate Mismatch',
    category: 'Excess TDS Deducted — Exceeds Invoice Amount',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => {
      const billAmount = Math.round(20000 + rand() * 80000)
      const tdsAmount = Math.round(billAmount * (1.1 + rand() * 0.3))
      return { vendor: randomFrom(vendorNames), section: randomFrom(sections), tdsAmountOverride: tdsAmount, extra: { billAmount, tdsAmount } }
    },
    buildMessage: ({ extra }) =>
      `TDS deducted (₹${extra.tdsAmount.toLocaleString('en-IN')}) exceeds the full invoice/bill amount (₹${extra.billAmount.toLocaleString('en-IN')}). This is not structurally possible and indicates a data or entry error.`,
    buildAction: () => `Investigate this entry immediately — check for a decimal-place error, duplicated rate application, or wrong base amount.`,
  },

  // ---- Section mismatch (check_wrong_section_by_hsn, check_residential_status) ----
  {
    id: 'WRONG_SECTION_HSN',
    label: 'Wrong Section (Goods vs Services)',
    group: 'Section Mismatch',
    category: 'Wrong Section Applied',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames }) => {
      const isService = rand() > 0.5
      const hsn = isService ? `99${Math.floor(1000 + rand() * 8999)}` : `${Math.floor(1000 + rand() * 8999)}`
      const correctSection = isService ? '194J' : '194Q'
      const wrongSection = isService ? '194Q' : '194J'
      return { vendor: randomFrom(vendorNames), section: wrongSection, extra: { hsn, isService, correctSection } }
    },
    buildMessage: ({ section, extra }) =>
      `HSN/SAC code ${extra.hsn} indicates ${extra.isService ? 'Services' : 'Goods'} (should be Section ${extra.correctSection}), but Section ${section} was applied instead.`,
    buildAction: ({ extra }) => `Update the section to ${extra.correctSection} to match the HSN/SAC classification and correct the deduction.`,
  },
  {
    id: 'WRONG_SECTION_NON_RESIDENT',
    label: 'Wrong Section (Non-Resident)',
    group: 'Section Mismatch',
    category: 'Wrong Section Applied — Non-Resident',
    severity: 'high',
    isViolation: true,
    generate: ({ randomFrom, nonResidentVendorNames }) => ({
      vendor: randomFrom(nonResidentVendorNames), section: randomFrom(['194C', '194J']), extra: {},
    }),
    buildMessage: ({ section }) => `Vendor is a non-resident — Section 195 (or applicable 196x) should apply, but Section ${section} was used.`,
    buildAction: () => `Non-resident payments must use Section 195 or applicable 196x sections. Update section in ERP.`,
  },
  {
    id: 'WRONG_SECTION_RESIDENT',
    label: 'Wrong Section (Resident Misclassified)',
    group: 'Section Mismatch',
    category: 'Wrong Section Applied — Resident',
    severity: 'high',
    isViolation: true,
    generate: ({ randomFrom, vendorNames }) => ({
      vendor: randomFrom(vendorNames), section: randomFrom(['195', '196C']), extra: {},
    }),
    buildMessage: ({ section }) => `Vendor is a resident — Section ${section} applies to non-residents only.`,
    buildAction: () => `Reclassify under the correct resident section (e.g. 194C/194J/194Q) based on nature of payment.`,
  },

  // ---- Lower Deduction Certificate / Form 197 (check_lower_deduction_cert) ----
  {
    id: 'LDC_NOT_YET_VALID',
    label: 'LDC Not Yet Valid',
    group: 'Lower Deduction Certificate (Form 197)',
    category: 'LDC Not Yet Valid',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => ({
      vendor: randomFrom(vendorNames), section: randomFrom(sections),
      extra: { ldcNumber: `LDC${100000 + Math.floor(rand() * 900000)}`, exemptFrom: '01-Sep-2026' },
    }),
    buildMessage: ({ extra }) => `LDC certificate ${extra.ldcNumber} is not valid until ${extra.exemptFrom}, but the transaction has already been posted.`,
    buildAction: () => `Apply the normal TDS rate until the certificate's validity window begins; do not honor the LDC rate early.`,
  },
  {
    id: 'LDC_EXPIRED',
    label: 'LDC Expired',
    group: 'Lower Deduction Certificate (Form 197)',
    category: 'LDC Expired',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => ({
      vendor: randomFrom(vendorNames), section: randomFrom(sections),
      extra: { ldcNumber: `LDC${100000 + Math.floor(rand() * 900000)}`, exemptTo: '31-Mar-2026' },
    }),
    buildMessage: ({ extra }) => `LDC certificate ${extra.ldcNumber} expired on ${extra.exemptTo}. Normal TDS rules should apply.`,
    buildAction: () => `Deduct at the normal section rate going forward and request a renewed certificate from the vendor.`,
  },
  {
    id: 'LDC_MISMATCH',
    label: 'LDC Rate Mismatch',
    group: 'Lower Deduction Certificate (Form 197)',
    category: 'TDS Deducted as per LDC — Mismatch',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => {
      const exemptionPercent = [50, 75, 90][Math.floor(rand() * 3)]
      const expectedTds = Math.round(5000 + rand() * 40000)
      const actualTds = Math.round(expectedTds * (1 + (rand() > 0.5 ? 1 : -1) * 0.3))
      return { vendor: randomFrom(vendorNames), section: randomFrom(sections), tdsAmountOverride: actualTds, extra: { ldcNumber: `LDC${100000 + Math.floor(rand() * 900000)}`, exemptionPercent, expectedTds, actualTds } }
    },
    buildMessage: ({ extra }) =>
      `LDC certificate ${extra.ldcNumber} allows ${extra.exemptionPercent}% exemption. Expected TDS ~₹${extra.expectedTds.toLocaleString('en-IN')}, but ₹${extra.actualTds.toLocaleString('en-IN')} was deducted.`,
    buildAction: () => `Recompute TDS using the certified exemption percentage and correct the deducted amount.`,
  },
  {
    id: 'LDC_CORRECT',
    label: 'LDC — Correctly Applied',
    group: 'Lower Deduction Certificate (Form 197)',
    category: 'TDS Deducted as per LDC',
    severity: 'low',
    isViolation: false,
    generate: ({ rand, randomFrom, vendorNames, sections }) => ({
      vendor: randomFrom(vendorNames), section: randomFrom(sections),
      extra: { ldcNumber: `LDC${100000 + Math.floor(rand() * 900000)}`, exemptionPercent: [50, 75, 90][Math.floor(rand() * 3)] },
    }),
    buildMessage: ({ extra }) => `Correctly applied LDC certificate ${extra.ldcNumber} (${extra.exemptionPercent}% exemption).`,
    buildAction: () => `No action required — LDC correctly applied.`,
  },

  // ---- Deduction timing (check_timing) ----
  {
    id: 'MISSED_ADVANCE',
    label: 'Missed TDS (Advance Payment)',
    group: 'Deduction Timing',
    category: 'TDS Not Deducted — Advance Payment',
    severity: 'high',
    isViolation: true,
    generate: ({ randomFrom, vendorNames, sections }) => ({
      vendor: randomFrom(vendorNames), section: randomFrom(sections), appliedRateOverride: 0, tdsAmountOverride: 0, extra: {},
    }),
    buildMessage: () => `TDS not deducted on advance payment. TDS is due at the time of payment (whichever is earlier: credit or payment).`,
    buildAction: () => `Deduct TDS on the advance payment and adjust against the final invoice to avoid duplicate deduction.`,
  },
  {
    id: 'MISSED_PROVISION',
    label: 'Missed TDS (Provision Entry)',
    group: 'Deduction Timing',
    category: 'TDS Not Deducted — Provision Entry',
    severity: 'high',
    isViolation: true,
    generate: ({ randomFrom, vendorNames, sections }) => ({
      vendor: randomFrom(vendorNames), section: randomFrom(sections), appliedRateOverride: 0, tdsAmountOverride: 0, extra: {},
    }),
    buildMessage: () => `TDS not deducted on year-end provision entry. TDS is due at the time of credit to the payee's account.`,
    buildAction: () => `Deduct TDS on the provision entry before year-end closing and reverse/adjust on invoice booking.`,
  },

  // ---- Non-filer (check_206ab_non_filer) ----
  {
    id: 'NON_FILER_206AB',
    label: 'Non-Filer Higher Rate (206AB)',
    group: 'Non-Filer (206AB)',
    category: 'Short TDS Deducted — Non-Filer (206AB)',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => {
      const sectionRate = [1, 2, 5][Math.floor(rand() * 3)]
      const requiredRate = Math.max(sectionRate * 2, 5)
      const appliedRate = sectionRate
      return { vendor: randomFrom(vendorNames), section: randomFrom(sections), appliedRateOverride: appliedRate, extra: { requiredRate, appliedRate } }
    },
    buildMessage: ({ extra }) =>
      `Vendor is a non-filer (Section 206AB) — TDS must be ${extra.requiredRate}% (higher of 2x section rate or 5%), but only ${extra.appliedRate}% was deducted.`,
    buildAction: ({ extra }) => `Deduct TDS at ${extra.requiredRate}% as required under Section 206AB for non-filers.`,
  },

  // ---- Form 15G/15H (check_form_15g_15h) ----
  {
    id: 'FORM_15G_VIOLATION',
    label: 'Wrongful TDS (Form 15G/15H)',
    group: 'Form 15G/15H',
    category: 'TDS Not Applicable — Violation (Form 15G/15H)',
    severity: 'medium',
    isViolation: true,
    generate: ({ randomFrom, vendorNames, sections }) => ({
      vendor: randomFrom(vendorNames), section: randomFrom(sections), extra: {},
    }),
    buildMessage: ({ tdsAmount }) => `Form 15G/15H is on file — TDS deduction is not required, but ₹${tdsAmount.toLocaleString('en-IN')} was deducted anyway.`,
    buildAction: () => `Honor the Form 15G/15H declaration on file and refund the wrongly deducted TDS.`,
  },
  {
    id: 'FORM_15G_CLEAN',
    label: 'Form 15G/15H — Correctly Handled',
    group: 'Form 15G/15H',
    category: 'TDS Not Applicable',
    severity: 'low',
    isViolation: false,
    generate: ({ randomFrom, vendorNames, sections }) => ({
      vendor: randomFrom(vendorNames), section: randomFrom(sections), tdsAmountOverride: 0, extra: {},
    }),
    buildMessage: () => `Correctly not applicable — valid Form 15G/15H on file.`,
    buildAction: () => `No action required — Form 15G/15H correctly honored.`,
  },

  // ---- Transporter exemption 194C(6) (check_transporter_exemption) ----
  {
    id: 'TRANSPORTER_VIOLATION',
    label: 'Unnecessary TDS (Transporter)',
    group: 'Transporter Exemption (194C)',
    category: 'TDS Not Applicable — Violation (Transporter Exemption)',
    severity: 'medium',
    isViolation: true,
    generate: ({ randomFrom, vendorNames }) => ({
      vendor: randomFrom(vendorNames), section: '194C', extra: {},
    }),
    buildMessage: ({ tdsAmount }) => `Vendor is a registered transporter with valid PAN — Section 194C exemption applies, but ₹${tdsAmount.toLocaleString('en-IN')} TDS was deducted anyway.`,
    buildAction: () => `Refund/adjust the wrongly deducted TDS and mark the vendor as exempt under Section 194C(6) going forward.`,
  },
  {
    id: 'TRANSPORTER_CLEAN',
    label: 'Transporter Exemption — Correctly Handled',
    group: 'Transporter Exemption (194C)',
    category: 'TDS Not Applicable',
    severity: 'low',
    isViolation: false,
    generate: ({ randomFrom, vendorNames }) => ({
      vendor: randomFrom(vendorNames), section: '194C', tdsAmountOverride: 0, extra: {},
    }),
    buildMessage: () => `Correctly not applicable — registered transporter exemption (194C) with valid PAN.`,
    buildAction: () => `No action required — transporter exemption correctly applied.`,
  },

  // ---- Threshold monitoring (check_threshold_breach, cross-transaction) ----
  {
    id: 'THRESHOLD_CROSSED',
    label: 'Missed TDS (Threshold Crossed)',
    group: 'Threshold Monitoring',
    category: 'TDS Not Deducted — Threshold Crossed',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => {
      const cumulative = Math.round(60000 + rand() * 900000)
      const threshold = Math.round(cumulative * 0.85)
      return { vendor: randomFrom(vendorNames), section: randomFrom(sections), appliedRateOverride: 0, tdsAmountOverride: 0, extra: { cumulative, threshold } }
    },
    buildMessage: ({ extra }) =>
      `Cumulative payments ₹${extra.cumulative.toLocaleString('en-IN')} crossed the threshold of ₹${extra.threshold.toLocaleString('en-IN')} this financial year, but no TDS was deducted across the linked transactions.`,
    buildAction: () => `Deduct TDS on the full cumulative amount now that the threshold has been crossed, and file a correction for prior transactions.`,
  },
  {
    id: 'THRESHOLD_SHORT',
    label: 'Threshold Crossed — Short Deducted',
    group: 'Threshold Monitoring',
    category: 'TDS Short Deducted — Threshold Crossed',
    severity: 'high',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => {
      const cumulative = Math.round(60000 + rand() * 900000)
      const threshold = Math.round(cumulative * 0.85)
      const required = Math.round(cumulative * 0.02)
      const deducted = Math.round(required * (0.3 + rand() * 0.4))
      return { vendor: randomFrom(vendorNames), section: randomFrom(sections), tdsAmountOverride: deducted, extra: { cumulative, threshold, required, deducted } }
    },
    buildMessage: ({ extra }) =>
      `Cumulative payments ₹${extra.cumulative.toLocaleString('en-IN')} crossed the threshold of ₹${extra.threshold.toLocaleString('en-IN')} this financial year, requiring approx. ₹${extra.required.toLocaleString('en-IN')} TDS in total, but only ₹${extra.deducted.toLocaleString('en-IN')} was deducted across the linked transactions.`,
    buildAction: () => `Deduct the remaining shortfall now that the threshold has been crossed, and file a correction for prior transactions.`,
  },
  {
    id: 'PREMATURE_DEDUCTION',
    label: 'Premature TDS Deduction',
    group: 'Threshold Monitoring',
    category: 'TDS Not Applicable — Premature Deduction',
    severity: 'medium',
    isViolation: true,
    generate: ({ rand, randomFrom, vendorNames, sections }) => {
      const threshold = Math.round(200000 + rand() * 300000)
      const cumulative = Math.round(threshold * (0.4 + rand() * 0.3))
      return { vendor: randomFrom(vendorNames), section: randomFrom(sections), extra: { cumulative, threshold } }
    },
    buildMessage: ({ extra, tdsAmount }) =>
      `Cumulative payments ₹${extra.cumulative.toLocaleString('en-IN')} have NOT crossed the threshold of ₹${extra.threshold.toLocaleString('en-IN')}, but TDS of ₹${tdsAmount.toLocaleString('en-IN')} was deducted anyway.`,
    buildAction: () => `Reverse the premature deduction and re-trigger TDS only after the vendor's cumulative payments cross the threshold.`,
  },
]

export function getScenario(id) {
  return RULE_SCENARIOS.find((s) => s.id === id)
}

/**
 * The backend's amount-consistency check reports both directions under one
 * generic category ("Short/Excess TDS Deducted — Amount Mismatch") because
 * it's a cross-check on the ₹ math, not a rate comparison — but the issue
 * already carries baseAmount/appliedRate/tdsAmount, which is enough to work
 * out which direction actually happened (e.g. tdsAmount of ₹0 is
 * unambiguously "Short", not "Short/Excess"). Computed here purely for
 * display — filtering still matches on the raw category from the backend.
 */
const AMOUNT_MISMATCH_CATEGORY = 'Short/Excess TDS Deducted — Amount Mismatch'

export function getDisplayIssueType(issue) {
  // `category` first, not `issueTypeLabel`: this value doubles as the Issue
  // Type filter's matching key (see Issues.jsx), and the filter dropdown's
  // option values come from `groupedScenarioOptions()`, which is keyed on
  // `category`. Sample-data scenarios' `issueTypeLabel` is a separate,
  // differently-worded frontend label (e.g. "Amount Mismatch — Short" vs.
  // category "Short TDS Deducted — Amount Mismatch") — preferring it here
  // would make mock-data rows silently fail to match their own filter option.
  const fallback = issue.category || issue.issueTypeLabel

  if (issue.category !== AMOUNT_MISMATCH_CATEGORY) return fallback

  const base = issue.baseAmount
  const rate = issue.appliedRate
  if (base == null || rate == null || issue.tdsAmount == null) return fallback

  const impliedAmount = base * (rate / 100)
  const diff = issue.tdsAmount - impliedAmount
  if (Math.abs(diff) <= 2) return fallback // within rounding tolerance — direction isn't meaningful

  return diff < 0
    ? 'Short TDS Deducted — Amount Mismatch'
    : 'Excess TDS Deducted — Amount Mismatch'
}

/**
 * Live-uploaded issues all carry the same flat backend string as
 * `recommendedAction` ("Review the transaction and correct the TDS entry
 * where required.") regardless of category — the backend doesn't have a
 * per-category recommendation table for the live-upload path. Sample data
 * already gets specific guidance per scenario (see each RULE_SCENARIOS'
 * buildAction), so live data looked noticeably less finished by comparison.
 * This is the same per-category guidance, keyed by the resolved category
 * string (see getDisplayIssueType) so it works for both data sources
 * without needing the backend to change.
 */
const CATEGORY_ACTIONS = {
  'TDS Not Applicable — Violation': 'Reverse the TDS deducted on this excluded GL account and adjust the vendor credit.',
  'TDS Not Applicable': 'No action required — GL exclusion / exemption correctly applied.',
  'PAN Missing/Invalid — TDS Not Deducted': 'Obtain a valid PAN from the vendor and deduct TDS at the Section 206AA rate immediately.',
  'PAN Missing/Invalid — Short TDS Deducted': 'Recompute and deduct the shortfall at the Section 206AA rate; correct the vendor PAN on record.',
  'PAN Missing/Invalid — Correctly Handled': 'No action required — Section 206AA rate correctly applied.',
  'Short TDS Deducted': 'Recompute the deduction at the correct rate and file a correction statement for the affected quarter.',
  'Excess TDS Deducted': "Refund/adjust the excess TDS deducted and correct the vendor's next statement.",
  'Short/Excess TDS Deducted': 'Confirm whether this payment is technical (2%) or professional (10%) services and correct the deduction rate.',
  'Short TDS Deducted — Amount Mismatch': 'Recheck the deduction calculation — the recorded amount is short of what the stated rate implies.',
  'Excess TDS Deducted — Amount Mismatch': 'Recheck the deduction calculation — the recorded amount exceeds what the stated rate implies.',
  'Excess TDS Deducted — Exceeds Invoice Amount': 'Investigate this entry immediately — check for a decimal-place error, duplicated rate application, or wrong base amount.',
  'Wrong Section Applied': 'Update the section to match the HSN/SAC classification and correct the deduction.',
  'Wrong Section Applied — Non-Resident': 'Non-resident payments must use Section 195 or applicable 196x sections. Update section in ERP.',
  'Wrong Section Applied — Resident': 'Reclassify under the correct resident section (e.g. 194C/194J/194Q) based on nature of payment.',
  'LDC Not Yet Valid': "Apply the normal TDS rate until the certificate's validity window begins; do not honor the LDC rate early.",
  'LDC Expired': 'Deduct at the normal section rate going forward and request a renewed certificate from the vendor.',
  'TDS Deducted as per LDC — Mismatch': 'Recompute TDS using the certified exemption percentage and correct the deducted amount.',
  'TDS Deducted as per LDC': 'No action required — LDC correctly applied.',
  'TDS Not Deducted — Advance Payment': 'Deduct TDS on the advance payment and adjust against the final invoice to avoid duplicate deduction.',
  'TDS Not Deducted — Provision Entry': 'Deduct TDS on the provision entry before year-end closing and reverse/adjust on invoice booking.',
  'Short TDS Deducted — Non-Filer (206AB)': 'Deduct TDS at the higher Section 206AB rate required for non-filers.',
  'TDS Not Applicable — Violation (Form 15G/15H)': 'Honor the Form 15G/15H declaration on file and refund the wrongly deducted TDS.',
  'TDS Not Applicable — Violation (Transporter Exemption)': 'Refund/adjust the wrongly deducted TDS and mark the vendor as exempt under Section 194C(6).',
  'TDS Not Deducted — Threshold Crossed': 'Deduct TDS on the full cumulative amount now that the threshold has been crossed, and file a correction for prior transactions.',
  'TDS Short Deducted — Threshold Crossed': 'Deduct the remaining shortfall now that the threshold has been crossed, and file a correction for prior transactions.',
  'TDS Not Applicable — Premature Deduction': "Reverse the premature deduction and re-trigger TDS only after the vendor's cumulative payments cross the threshold.",
}

export function getRecommendedAction(issue) {
  return CATEGORY_ACTIONS[getDisplayIssueType(issue)] || issue.recommendedAction
}

/**
 * Groups scenarios by their rule area, in first-seen order — used to render
 * <optgroup> in the Issue Type filter. Option values are the rule engine's
 * `category` string (not the frontend-only `id`) so filtering works against
 * whatever the backend actually returns — including for live uploaded data,
 * where the only reliable classifier on the wire is `category`, not a
 * frontend-coined id the backend may or may not know about.
 *
 * A few scenarios intentionally share one category (e.g. GL/Form 15G/
 * Transporter "correctly handled" cases are all just "TDS Not Applicable"
 * on the wire — the backend can't tell them apart either), so this dedupes
 * by category and keeps only the first-seen label to avoid confusing
 * duplicate-looking options that would filter identically.
 */
export function groupedScenarioOptions() {
  const groups = []
  const byGroup = new Map()
  const seenCategories = new Set()
  for (const s of RULE_SCENARIOS) {
    if (seenCategories.has(s.category)) continue
    seenCategories.add(s.category)
    if (!byGroup.has(s.group)) {
      const entry = { group: s.group, options: [] }
      byGroup.set(s.group, entry)
      groups.push(entry)
    }
    byGroup.get(s.group).options.push([s.category, s.label])
  }
  return groups
}

/** 85% violations / 15% correctly-handled confirmations — an Issue Review feed should mostly surface exceptions. */
export function pickWeightedScenario(rand) {
  const violations = RULE_SCENARIOS.filter((s) => s.isViolation)
  const clean = RULE_SCENARIOS.filter((s) => !s.isViolation)
  const pool = rand() < 0.85 ? violations : clean
  return pool[Math.floor(rand() * pool.length)]
}

const PAN_FORMAT_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/

/**
 * Simulates PANVerificationService.verify_pan() — mock mode, since Mahindra
 * hasn't provided government PAN API credentials yet (see
 * backend/services/pan_verification_service.py). PAN validity is a
 * per-vendor fact (see mockData.js's vendorDirectory), not a per-issue
 * one, so this is keyed purely on the PAN string itself:
 *   - a malformed/missing PAN always comes back "Invalid Format" — that's
 *     a pure format check (_is_valid_pan_format), not a government lookup,
 *     so re-verifying a bad PAN can't "fix" it.
 *   - a well-formed PAN gets a live Active/Inactive draw from `randFn`,
 *     which is what a real re-check against the government DB would do.
 * `randFn` defaults to Math.random for live "Verify PAN" clicks; mockData.js
 * passes its seeded `rand` at build time so the initial directory is
 * reproducible.
 */
export function simulatePanVerification(pan, randFn = Math.random) {
  const isValidFormat = PAN_FORMAT_REGEX.test(pan || '')
  if (!isValidFormat) {
    return { pan: pan || '', status: 'Invalid Format', isValidFormat: false, aadhaarLinked: null, isMocked: true }
  }
  const status = randFn() > 0.92 ? 'Inactive' : 'Active'
  return { pan, status, isValidFormat: true, aadhaarLinked: status === 'Active' ? randFn() > 0.2 : null, isMocked: true }
}
