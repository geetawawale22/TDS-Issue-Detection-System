import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { User, LogOut } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { initials, capitalize } from '@/utils/utils'
import ProfileModal from './ProfileModal'
import '@/components/Common/Common.css'
import './ProfileMenu.css'

function companyCodeLabel(user) {
  if (!user) return '—'
  if (user.role === 'admin') return 'All Company Codes'
  if (user.companyCodes?.length) return user.companyCodes.join(', ')
  return 'Not assigned'
}

export default function ProfileMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="profile-menu" ref={rootRef}>
      <button
        type="button"
        className="navbar-user-avatar"
        title={user?.name}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {initials(user?.name ?? 'U')}
      </button>

      <div className={`profile-menu-dropdown ${open ? 'is-open' : ''}`} role="menu" aria-hidden={!open}>
        <div className="profile-menu-header">
          <div className="profile-menu-header-avatar">{initials(user?.name ?? 'U')}</div>
          <div className="profile-menu-header-info">
            <div className="profile-menu-header-name">{user?.name}</div>
            <div className="profile-menu-header-role">{capitalize(user?.role)}</div>
            <div className="profile-menu-header-company">Company Code: {companyCodeLabel(user)}</div>
          </div>
        </div>

        <div className="profile-menu-divider" />

        <button
          type="button"
          role="menuitem"
          tabIndex={open ? 0 : -1}
          className="profile-menu-item"
          onClick={() => { setOpen(false); setShowProfile(true) }}
        >
          <User size={14} />My Profile
        </button>
        <button
          type="button"
          role="menuitem"
          tabIndex={open ? 0 : -1}
          className="profile-menu-item profile-menu-item--danger"
          onClick={() => { setOpen(false); setShowLogoutConfirm(true) }}
        >
          <LogOut size={14} />Logout
        </button>
      </div>

      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}

      {showLogoutConfirm && createPortal(
        <div className="modal-overlay">
          <div className="settings-card modal-card" style={{ width: 'min(340px, 100%)' }}>
            <h3 className="settings-card-title">Logout</h3>
            <p style={{ fontSize: 12.5, color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
              Are you sure you want to logout?
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setShowLogoutConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={() => { setShowLogoutConfirm(false); logout() }}>
                Logout
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
