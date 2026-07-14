import { Bell, Search, CalendarDays, Database, RefreshCw, Building2, ShieldCheck, Menu } from 'lucide-react'
import { useSelector, useDispatch } from 'react-redux'
import { useAuth } from '@/context/AuthContext'
import { setSelectedCompanyCode, toggleSidebar } from '@/redux/slices/appSlice'
import { capitalize } from '@/utils/utils'
import ProfileMenu from './ProfileMenu'
import './Navbar.css'

export default function Navbar() {
  const dispatch = useDispatch()
  const { financialYear, lastSyncTime, dataSource, syncStatus, availableCompanyCodes, selectedCompanyCode } = useSelector((s) => s.app)
  const { user } = useAuth()

  return (
    <div className="navbar">
      <button className="navbar-icon-btn navbar-menu-btn" title="Menu" onClick={() => dispatch(toggleSidebar())}>
        <Menu size={16} />
      </button>

      {/* Left: meta info */}
      <div className="navbar-meta">
        {user?.role && (
          <>
            <div className="navbar-meta-item">
              <ShieldCheck size={13} className="navbar-meta-icon" />
              <span className="navbar-meta-label">Role</span>
              <span className="navbar-meta-value">{capitalize(user.role)}</span>
            </div>
            <div className="navbar-meta-divider" />
          </>
        )}
        {availableCompanyCodes.length > 0 && (
          <>
            <div className="navbar-meta-item">
              <Building2 size={13} className="navbar-meta-icon" />
              <span className="navbar-meta-label">Company</span>
              {availableCompanyCodes.length > 1 ? (
                <select
                  value={selectedCompanyCode ?? ''}
                  onChange={(e) => dispatch(setSelectedCompanyCode(e.target.value))}
                  style={{
                    fontSize: 12, fontWeight: 600, border: 'none', background: 'transparent',
                    cursor: 'pointer', color: 'var(--color-text)',
                  }}
                >
                  {availableCompanyCodes.map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </select>
              ) : (
                <span className="navbar-meta-value">{selectedCompanyCode}</span>
              )}
            </div>
            <div className="navbar-meta-divider" />
          </>
        )}
        <div className="navbar-meta-item">
          <CalendarDays size={13} className="navbar-meta-icon" />
          <span className="navbar-meta-label">FY</span>
          <span className="navbar-meta-value">{financialYear}</span>
        </div>
        <div className="navbar-meta-divider" />
        <div className="navbar-meta-item">
          <Database size={13} className="navbar-meta-icon" />
          <span className="navbar-meta-value">{dataSource.split('—')[0].trim()}</span>
        </div>
        <div className="navbar-meta-divider" />
        <div className="navbar-meta-item">
          <div className={`navbar-sync-dot ${syncStatus}`} />
          <span className="navbar-meta-value">Synced {lastSyncTime}</span>
        </div>
      </div>

      {/* Right: actions */}
      <div className="navbar-actions">
        <button className="navbar-icon-btn" title="Search">
          <Search size={15} />
        </button>
        <button className="navbar-icon-btn" title="Refresh">
          <RefreshCw size={15} />
        </button>
        <button className="navbar-icon-btn navbar-bell-btn" title="Notifications">
          <Bell size={15} />
          <span className="navbar-badge">3</span>
        </button>
        <ProfileMenu />
      </div>
    </div>
  )
}
