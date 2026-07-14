import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDispatch } from 'react-redux'
import toast from 'react-hot-toast'
import { X } from 'lucide-react'
import StatusBadge from '@/components/Common/StatusBadge'
import authService, { updateStoredUser } from '@/services/authService'
import { updateUser } from '@/redux/slices/authSlice'
import { capitalize, formatDate } from '@/utils/utils'
import { MESSAGES } from '@/utils/messages'

function companyCodeDisplay(profile) {
  if (!profile) return '—'
  if (profile.role === 'admin') return 'All Company Codes'
  if (profile.company_codes?.length) return profile.company_codes.join(', ')
  return 'Not assigned'
}

export default function ProfileModal({ onClose }) {
  const dispatch = useDispatch()
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [fullName, setFullName] = useState('')
  const [fullNameError, setFullNameError] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        const data = await authService.getMe()
        if (cancelled) return
        setProfile(data)
        setFullName(data.full_name)
      } catch (err) {
        if (!cancelled) setLoadError(err.message || MESSAGES.UNEXPECTED_ERROR)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  function validateFullName(value) {
    return value.trim() ? null : 'Full name is required.'
  }

  async function handleSave(e) {
    e.preventDefault()
    const err = validateFullName(fullName)
    setFullNameError(err)
    if (err) {
      toast.error(MESSAGES.VALIDATION_ERROR)
      return
    }
    setSaving(true)
    try {
      const updated = await authService.updateProfile({ full_name: fullName.trim() })
      setProfile(updated)
      dispatch(updateUser({ name: updated.full_name }))
      updateStoredUser({ name: updated.full_name })
      toast.success(MESSAGES.PROFILE_UPDATED)
      onClose()
    } catch (err) {
      toast.error(err.message || MESSAGES.UNEXPECTED_ERROR)
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="modal-overlay">
      <div className="settings-card modal-card" style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <X size={16} />
        </button>
        <h3 className="settings-card-title">My Profile</h3>

        {loading && <div style={{ padding: '12px 0', fontSize: 12.5, color: 'var(--color-text-muted)' }}>Loading profile…</div>}
        {loadError && <div style={{ padding: '12px 0', fontSize: 12.5, color: 'var(--color-danger)' }}>{loadError}</div>}

        {!loading && !loadError && profile && (
          <form onSubmit={handleSave} noValidate>
            <div className="settings-field-row">
              <label className="settings-field-label">Full name</label>
              <input
                className={`settings-input ${fullNameError ? 'error' : ''}`}
                value={fullName}
                onChange={(e) => { setFullName(e.target.value); setFullNameError(null) }}
                onBlur={() => setFullNameError(validateFullName(fullName))}
              />
              {fullNameError && <span className="form-error">{fullNameError}</span>}
            </div>

            <div className="settings-field-row">
              <label className="settings-field-label">Username</label>
              <input className="settings-input" value={profile.email.split('@')[0]} disabled />
            </div>

            <div className="settings-field-row">
              <label className="settings-field-label">Email address</label>
              <input className="settings-input" value={profile.email} disabled />
            </div>

            <div className="settings-field-row">
              <label className="settings-field-label">Role</label>
              <input className="settings-input" value={capitalize(profile.role)} disabled />
            </div>

            <div className="settings-field-row">
              <label className="settings-field-label">Company code</label>
              <input className="settings-input" value={companyCodeDisplay(profile)} disabled />
            </div>

            <div className="settings-field-row">
              <label className="settings-field-label">Account status</label>
              <div style={{ flex: 1 }}>
                <StatusBadge label={profile.is_active ? 'Active' : 'Deactivated'} tone={profile.is_active ? 'success' : 'warning'} />
              </div>
            </div>

            {profile.created_at && (
              <div className="settings-field-row">
                <label className="settings-field-label">Created</label>
                <input className="settings-input" value={formatDate(profile.created_at)} disabled />
              </div>
            )}

            <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
              Only your full name can be edited here. Role, company code access, and account status are managed by an administrator.
            </p>

            <div className="modal-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body
  )
}
