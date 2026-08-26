import { useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink } from 'react-router-dom'
import {
  LayoutGrid, AlertTriangle, Gauge, GitPullRequestArrow,
  FileBarChart, Settings, ShieldCheck, ChevronsLeft,
} from 'lucide-react'
import { useDispatch, useSelector } from 'react-redux'
import { toggleSidebar } from '@/redux/slices/appSlice'
import './Sidebar.css'

const navItems = [
  { label: 'Dashboard',            path: '/dashboard',             icon: LayoutGrid },
  { label: 'Issues',               path: '/issues',                icon: AlertTriangle },
  { label: 'Threshold Monitoring', path: '/threshold-monitoring',  icon: Gauge },
  { label: 'Correction Center',    path: '/correction-center',     icon: GitPullRequestArrow },
  { label: 'Reports',              path: '/reports',               icon: FileBarChart },
  { label: 'Settings',             path: '/settings',              icon: Settings },
]

export default function Sidebar() {
  const collapsed = useSelector((s) => s.app.sidebarCollapsed)
  const dispatch  = useDispatch()

  // Collapsed nav items only show an icon, so on hover/focus we flyout the
  // label. Rendered via a portal on document.body (position: fixed) rather
  // than an absolutely-positioned child, because .sidebar-nav scrolls
  // vertically (overflow-y: auto), which per the CSS overflow spec forces
  // overflow-x to clip too — an in-place tooltip would be cut off at the
  // sidebar's right edge instead of floating over the page content.
  const [tooltip, setTooltip] = useState(null)

  function showTooltip(e, label) {
    if (!collapsed) return
    const rect = e.currentTarget.getBoundingClientRect()
    setTooltip({ label, top: rect.top + rect.height / 2, left: rect.right + 12 })
  }
  function hideTooltip() {
    setTooltip(null)
  }

  return (
    <div className="sidebar">
      {/* Logo */}
      <div className={`sidebar-logo ${collapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-logo-icon">
          <ShieldCheck size={16} strokeWidth={2.3} color="#fff" />
        </div>
        {!collapsed && (
          <div className="sidebar-logo-text">
            <span className="sidebar-logo-title">TDS Intelligence</span>
            <span className="sidebar-logo-sub">Compliance Platform</span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            aria-label={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              `sidebar-nav-item${isActive ? ' active' : ''}${collapsed ? ' collapsed' : ''}`
            }
            onMouseEnter={(e) => showTooltip(e, item.label)}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e, item.label)}
            onBlur={hideTooltip}
          >
            {({ isActive }) => (
              <>
                {isActive && !collapsed && <span className="sidebar-nav-indicator" />}
                <item.icon size={16} strokeWidth={isActive ? 2.3 : 1.9} />
                {!collapsed && <span className="sidebar-nav-label">{item.label}</span>}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {collapsed && tooltip && createPortal(
        <div className="sidebar-tooltip-portal" style={{ top: tooltip.top, left: tooltip.left }}>
          {tooltip.label}
        </div>,
        document.body,
      )}

      {/* Collapse toggle */}
      <button
        className={`sidebar-collapse-btn ${collapsed ? 'collapsed' : ''}`}
        onClick={() => dispatch(toggleSidebar())}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <ChevronsLeft size={14} className={collapsed ? 'rotated' : ''} />
        {!collapsed && <span>Collapse</span>}
      </button>
    </div>
  )
}
