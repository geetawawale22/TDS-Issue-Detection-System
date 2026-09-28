export function formatCurrency(amount) {
  const value = Number(amount)
  if (!Number.isFinite(value)) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0)
  }

  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

/**
 * Indian FY runs April–March (mirrors backend/rules/tds_rule_engine.py's
 * _get_financial_year) — e.g. any date from 1-Apr-2025 to 31-Mar-2026 is
 * "FY 2025-26". Returns null for an unparseable date so callers can decide
 * how to treat it (the Financial Year filter never excludes a row it can't
 * classify).
 */
export function getFinancialYear(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput)
  if (Number.isNaN(d.getTime())) return null
  const year = d.getMonth() >= 3 /* April = index 3 */ ? d.getFullYear() : d.getFullYear() - 1
  return `FY ${year}-${String(year + 1).slice(-2)}`
}

function parseDateInput(dateInput) {
  if (!dateInput) return null
  if (dateInput instanceof Date) {
    return Number.isNaN(dateInput.getTime()) ? null : dateInput
  }
  const text = String(dateInput).trim()
  const dateOnlyMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch
    const localDate = new Date(Number(year), Number(month) - 1, Number(day))
    return Number.isNaN(localDate.getTime()) ? null : localDate
  }
  const date = new Date(dateInput)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDate(dateInput) {
  const date = parseDateInput(dateInput)
  if (!date) return '—'
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${day}/${month}/${date.getFullYear()}`
}

export function formatDateTime(dateInput) {
  const date = parseDateInput(dateInput)
  if (!date) return '—'
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${formatDate(date)} ${hours}:${minutes}`
}

export function cn(...classes) {
  return classes.filter(Boolean).join(' ')
}

export function initials(name) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0].toUpperCase())
    .join('')
}

export function capitalize(str) {
  if (!str) return ''
  return str.charAt(0).toUpperCase() + str.slice(1)
}

export function formatStatusLabel(value) {
  if (value === 'insufficient') return 'Insufficient Data'
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Returns true only for a well-formed, non-empty email address. */
export function isValidEmail(value) {
  return EMAIL_PATTERN.test((value ?? '').trim())
}

/**
 * Minimum viable password rule shared by every form that sets/resets a
 * password: at least 8 characters, containing at least one letter and one
 * digit. Kept client-side only — the backend does not currently enforce
 * complexity beyond length on account creation.
 */
export function isValidPassword(value) {
  return typeof value === 'string' && value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value)
}
