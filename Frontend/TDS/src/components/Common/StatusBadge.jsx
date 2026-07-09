import './Common.css'

export function severityToTone(severity) {
  if (severity === 'high')   return 'danger'
  if (severity === 'medium') return 'warning'
  return 'success'
}

export function issueStatusToTone(status) {
  if (status === 'open')      return 'danger'
  if (status === 'in_review') return 'warning'
  if (status === 'resolved')  return 'success'
  return 'neutral'
}

export function thresholdStatusToTone(status) {
  if (status === 'exceeded') return 'danger'
  if (status === 'near')     return 'warning'
  return 'success'
}

export function correctionStatusToTone(status) {
  if (status === 'pending')  return 'warning'
  if (status === 'approved' || status === 'applied') return 'success'
  if (status === 'rejected') return 'danger'
  return 'neutral'
}

export default function StatusBadge({ label, tone = 'neutral', className = '' }) {
  return (
    <span className={`status-badge status-badge--${tone} ${className}`}>
      {label}
    </span>
  )
}
