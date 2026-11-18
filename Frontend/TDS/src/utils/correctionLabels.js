// Labels shared by Correction Center, the issue drawer and the Match SAP Rows modal.

export const CORRECTION_METHOD_LABELS = {
  DIFFERENCE_ONLY: 'Difference Only',
  FULL_REVERSAL: 'Full Reversal',
}

export const CORRECTION_STATUS_LABELS = {
  matched_in_sap: 'Awaiting Approval',
  approved: 'Approved',
  rejected: 'Rejected',
  undone: 'Undone',
}

export const CORRECTION_ROLE_LABELS = {
  REVERSAL: 'Reversal',
  FRESH_DEDUCTION: 'Fresh Deduction',
  ADDITIONAL_DEDUCTION: 'Additional Deduction',
}

// What each role does to the TDS on the issue: a reversal takes TDS back,
// the other two add TDS. TDS on uploaded rows is always positive.
export const CORRECTION_ROLE_SIGN = {
  REVERSAL: -1,
  FRESH_DEDUCTION: 1,
  ADDITIONAL_DEDUCTION: 1,
}

/** Roles offered for a method: Difference Only adds the gap; Full Reversal reverses and deducts again. */
export const CORRECTION_ROLES_BY_METHOD = {
  DIFFERENCE_ONLY: ['ADDITIONAL_DEDUCTION', 'REVERSAL'],
  FULL_REVERSAL: ['REVERSAL', 'FRESH_DEDUCTION'],
}

// A difference up to ₹1 counts as reconciled (rounding in SAP); same as the backend.
export const RECONCILE_TOLERANCE = 1

export function correctionStatusTone(status) {
  if (status === 'approved') return 'success'
  if (status === 'matched_in_sap') return 'warning'
  if (status === 'rejected') return 'danger'
  return 'neutral'
}

export function correctionEffect(role, tdsAmount) {
  return (CORRECTION_ROLE_SIGN[role] || 0) * Math.abs(Number(tdsAmount) || 0)
}

/** TDS the issue should carry: base × expected rate, else applied + tax impact. */
export function expectedTdsForIssue(issue) {
  const applied = Math.abs(Number(issue?.tdsAmount) || 0)
  const base = issue?.baseAmount
  const rate = issue?.expectedRate
  if (base != null && base !== '' && rate != null && rate !== '' && Number.isFinite(Number(base)) && Number.isFinite(Number(rate))) {
    return Number((Math.abs(Number(base)) * Number(rate) / 100).toFixed(2))
  }
  return Number((applied + Math.abs(Number(issue?.taxImpact) || 0)).toFixed(2))
}
