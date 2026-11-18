// Which issue / SAP row a correction group belongs to.
//
// A SAP document number is unique only within company code + fiscal year, and
// one document has several line items, so all four parts are compared. A part
// missing on either side (older data) does not block a match.

const EMPTY_VALUES = new Set(['', '—', '-', 'null', 'undefined'])

function clean(value) {
  const text = value == null ? '' : String(value).trim()
  return EMPTY_VALUES.has(text) ? '' : text
}

/** "0003190025638" and "3190025638" are the same SAP number. */
export function stripLeadingZeros(value) {
  return clean(value).replace(/^0+(?=\d)/, '')
}

function samePart(a, b, normalise = clean) {
  const left = normalise(a)
  const right = normalise(b)
  return !left || !right || left === right
}

/** Same SAP document line: doc no. must match; company, FY and line match when both sides have them. */
export function sameDocumentLine(a, b) {
  const docA = stripLeadingZeros(a?.docNo)
  if (!docA || docA !== stripLeadingZeros(b?.docNo)) return false
  return samePart(a.companyCode, b.companyCode)
    && samePart(a.fiscalYear, b.fiscalYear)
    && samePart(a.lineItem, b.lineItem, stripLeadingZeros)
}

/** matched_in_sap (awaiting approval) and approved groups resolve their issue. */
export function isActiveCorrection(group) {
  return group?.status === 'matched_in_sap' || group?.status === 'approved'
}

export function groupOriginalLine(group) {
  return {
    companyCode: group.companyCode,
    fiscalYear: group.fiscalYear,
    docNo: group.originalDocumentNumber,
    lineItem: group.originalLineItem,
  }
}

/** The issue a group corrects: same issue key when both have one, else same document line. */
export function groupMatchesIssue(group, issue) {
  if (!group || !issue) return false
  if (group.issueKey && issue.issueKey) return group.issueKey === issue.issueKey
  return sameDocumentLine(groupOriginalLine(group), issue)
}

/** Index groups by original doc no. and by correction doc no., for fast lookups over a large upload. */
export function indexCorrectionGroups(groups = []) {
  const byOriginal = new Map()
  const byCorrection = new Map()
  for (const group of groups) {
    const original = stripLeadingZeros(group.originalDocumentNumber)
    if (original) byOriginal.set(original, [...(byOriginal.get(original) || []), group])
    for (const entry of group.entries || []) {
      const doc = stripLeadingZeros(entry.correctionDocumentNumber || entry.docNo)
      if (doc) byCorrection.set(doc, [...(byCorrection.get(doc) || []), { group, entry }])
    }
  }
  return { byOriginal, byCorrection }
}

/** Group whose original is this issue, or whose SAP rows include this issue's line. */
export function findCorrectionForIssue(index, issue) {
  const doc = stripLeadingZeros(issue?.docNo)
  if (!doc) return null
  const original = (index.byOriginal.get(doc) || []).find((group) => groupMatchesIssue(group, issue))
  if (original) return { group: original, isCorrectionRow: false }
  const hit = (index.byCorrection.get(doc) || []).find(({ entry }) => sameDocumentLine(entry, issue))
  return hit ? { group: hit.group, isCorrectionRow: true } : null
}
