import { Outlet } from 'react-router-dom'
import { useSelector } from 'react-redux'
import Sidebar from '@/components/Sidebar/Sidebar'
import Navbar from '@/components/Navbar/Navbar'
import './AppLayout.css'

export default function AppLayout() {
  const collapsed = useSelector((s) => s.app.sidebarCollapsed)

  return (
    <div className="app-shell">
      <aside className={`sidebar-column ${collapsed ? 'collapsed' : ''}`}>
        <Sidebar />
      </aside>
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
