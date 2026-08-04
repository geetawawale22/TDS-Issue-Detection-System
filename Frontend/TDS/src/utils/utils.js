export function formatCurrency(amount) {
  const value = Number(amount)
  if (!Number.isFinite(value)) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(0)
  }

  // Show the figure exactly as recorded (e.g. in an uploaded SAP/Excel
  // extract) rather than forcing 2 decimal places — capping at 2 would
  // silently round away a 3rd/4th decimal digit some source rows carry.
  // Capped at 4 so genuine floating-point noise from later math (sums,
  // rate * base computations) can't produce a long garbage tail.
  const decimalDigits = Math.min((value.toString().split('.')[1] || '').length, 4)
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: decimalDigits,
    maximumFractionDigits: decimalDigits,
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
