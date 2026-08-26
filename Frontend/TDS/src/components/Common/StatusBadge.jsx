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
  if (status === 'pan_issue') return 'danger'
  if (status === 'near')     return 'warning'
  if (status === 'unclassified') return 'neutral'
  return 'success'
}

export function validationRowStatusToTone(status) {
  if (status === 'passed')       return 'success'
  if (status === 'issue')        return 'danger'
  if (status === 'insufficient') return 'warning'
  return 'neutral'
}

export function correctionStatusToTone(status) {
  if (status === 'pending')  return 'warning'
  if (status === 'approved' || status === 'applied') return 'success'
  if (status === 'rejected') return 'danger'
  return 'neutral'
}

export function panStatusToTone(status) {
  if (status === 'Active')   return 'success'
  if (status === 'Inactive') return 'warning'
  if (status === 'Not verified') return 'neutral'
  return 'danger' // 'Deactivated' / 'Invalid Format'
}

export default function StatusBadge({ label, tone = 'neutral', className = '' }) {
  if (!label) return null
  return (
    <span className={`status-badge status-badge--${tone} ${className}`}>
      {label}
    </span>
  )
}
