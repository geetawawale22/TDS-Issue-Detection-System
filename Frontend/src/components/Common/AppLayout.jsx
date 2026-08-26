import { useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import Sidebar from '@/components/Sidebar/Sidebar'
import Navbar from '@/components/Navbar/Navbar'
import { toggleSidebar, setSidebarCollapsed } from '@/redux/slices/appSlice'
import './AppLayout.css'

const MOBILE_BREAKPOINT = 768

export default function AppLayout() {
  const dispatch = useDispatch()
  const collapsed = useSelector((s) => s.app.sidebarCollapsed)
  const wasMobileRef = useRef(typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT)

  // The sidebar's collapsed/open default is only computed once, at initial
  // load (see appSlice's initialSidebarCollapsed). Without this, resizing
  // the window or rotating a tablet after load leaves the sidebar stuck in
  // whatever state it started in — e.g. wide-open and overlapping content
  // if it started as a desktop tab that got narrowed.
  useEffect(() => {
    function handleResize() {
      const isMobile = window.innerWidth <= MOBILE_BREAKPOINT
      if (isMobile !== wasMobileRef.current) {
        wasMobileRef.current = isMobile
        dispatch(setSidebarCollapsed(isMobile))
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [dispatch])

  return (
    <div className="app-shell">
      <aside className={`sidebar-column ${collapsed ? 'collapsed' : ''}`}>
        <Sidebar />
      </aside>
      {/* Mobile-only backdrop: tapping outside the open drawer closes it. Hidden via CSS above 768px. */}
      {!collapsed && (
        <div className="sidebar-backdrop" onClick={() => dispatch(toggleSidebar())} />
      )}
      <div className="main-column">
        <header className="top-header">
          <Navbar />
        </header>
        <main className="page-scroll-area">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
