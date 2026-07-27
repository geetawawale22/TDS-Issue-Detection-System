export function formatCurrency(amount) {
  const value = Number(amount)
  if (!Number.isFinite(value)) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(0)
  }

  // Keep exact paise when present (e.g. 45437.78); whole rupees stay without .00
  const hasDecimals = Math.abs(value % 1) > 1e-9
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value)
}

export function formatDate(isoString) {
  return new Date(isoString).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
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
