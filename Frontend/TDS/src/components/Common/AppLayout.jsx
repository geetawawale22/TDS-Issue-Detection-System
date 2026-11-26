import { Suspense, useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import Sidebar from '@/components/Sidebar/Sidebar'
import Navbar from '@/components/Navbar/Navbar'
import PageLoader, { GlobalPageLoader } from '@/components/Common/PageLoader'
import {
  toggleSidebar, setSidebarCollapsed, setDataSourceLabel, setLastSyncTime, setSyncStatus,
} from '@/redux/slices/appSlice'
import { clearUpload } from '@/redux/slices/issuesSlice'
import { loadCorrectionRegister } from '@/redux/correctionRegister'
import issuesService from '@/services/issuesService'
import { resumeSapAnalysisJob } from '@/utils/sapAnalysisJob'
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
  // The correction register lives in the backend; load it once after login so
  // TDS Analysis shows which issues are already corrected.
  useEffect(() => {
    loadCorrectionRegister(dispatch).catch(() => {
      // Pages still work without it; Correction Center retries and shows the error.
    })
  }, [dispatch])

  // A SAP data API analysis started before a refresh or page change keeps
  // being followed, and its result loads when it finishes.
  useEffect(() => { resumeSapAnalysisJob(dispatch) }, [dispatch])

  // This browser keeps a copy of the last upload (localStorage / IndexedDB).
  // If its run is no longer in the database (e.g. clear_analysis.py ran),
  // drop the copy so TDS Analysis and the Dashboard don't show stale data.
  const cachedRunId = useSelector((s) => s.issues.uploadMeta?.tracking?.runId ?? null)
  const checkedRunRef = useRef(null)
  useEffect(() => {
    if (!cachedRunId || checkedRunRef.current === cachedRunId) return
    checkedRunRef.current = cachedRunId
    issuesService.ruleRunExists(cachedRunId)
      .then((exists) => {
        if (exists) return
        dispatch(clearUpload())
        dispatch(setDataSourceLabel('No SAP upload loaded'))
        dispatch(setLastSyncTime('Not synced'))
        dispatch(setSyncStatus('idle'))
      })
      .catch(() => {
        // Backend unreachable: keep the copy rather than blank the page.
      })
  }, [cachedRunId, dispatch])

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
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </main>
        <GlobalPageLoader />
      </div>
    </div>
  )
}
