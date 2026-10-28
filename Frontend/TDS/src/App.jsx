import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Provider } from 'react-redux'
import { Toaster } from 'react-hot-toast'
import { store } from '@/redux/store'

import { AuthProvider } from '@/context/AuthContext'
import { ProtectedRoute } from '@/routes/ProtectedRoute'
import AppLayout from '@/components/Common/AppLayout'
import PageLoader from '@/components/Common/PageLoader'

const Login = lazy(() => import('@/pages/Login/Login'))
const ForgotPassword = lazy(() => import('@/pages/ForgotPassword/ForgotPassword'))
const ResetPassword = lazy(() => import('@/pages/ResetPassword/ResetPassword'))
const SetPassword = lazy(() => import('@/pages/SetPassword/SetPassword'))

const Dashboard = lazy(() => import('@/pages/Dashboard/Dashboard'))
const ThresholdMonitoring = lazy(() => import('@/pages/ThresholdMonitoring/ThresholdMonitoring'))
const CorrectionCenter = lazy(() => import('@/pages/CorrectionCenter/CorrectionCenter'))
const Reports = lazy(() => import('@/pages/Reports/Reports'))
const LDCCompliance = lazy(() => import('@/pages/LDCCompliance/LDCCompliance'))
const PanVerification = lazy(() => import('@/pages/PanVerification/PanVerification'))
const TDSCaseBuilder = lazy(() => import('@/pages/TDSCaseBuilder/TDSCaseBuilder'))
const Settings = lazy(() => import('@/pages/Settings/Settings'))

function App() {
  return (
    <Provider store={store}>
      <BrowserRouter>
        <AuthProvider>
          <Toaster
            position="top-right"
            gutter={8}
            toastOptions={{
              duration: 4000,
              style: {
                fontSize: '13px',
                fontFamily: 'Inter, system-ui, sans-serif',
                borderRadius: '10px',
                border: '1px solid #E5E7EB',
                boxShadow: '0 4px 12px -2px rgba(17,24,39,0.10)',
                padding: '10px 14px',
                maxWidth: '360px',
              },
              success: { iconTheme: { primary: '#10B981', secondary: '#fff' } },
              error: { iconTheme: { primary: '#EF4444', secondary: '#fff' }, duration: 6000 },
            }}
          />
          <Suspense fallback={<PageLoader fullScreen />}>
            <Routes>
              <Route path="/" element={<Navigate to="/login" replace />} />
              <Route path="/login" element={<Login />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password/:token" element={<ResetPassword />} />
              <Route path="/set-password/:token" element={<SetPassword />} />

              <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/issues" element={<TDSCaseBuilder />} />
                <Route path="/threshold-monitoring" element={<ThresholdMonitoring />} />
                <Route path="/correction-center" element={<CorrectionCenter />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/ldc-compliance" element={<LDCCompliance />} />
                <Route path="/pan-verification" element={<PanVerification />} />
                <Route path="/tds-case-builder" element={<Navigate to="/issues" replace />} />
                <Route path="/settings" element={<Settings />} />
              </Route>

              <Route path="*" element={<Navigate to="/login" replace />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </Provider>
  )
}

export default App
