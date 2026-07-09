import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Provider } from 'react-redux'
import { Toaster } from 'react-hot-toast'
import { store } from '@/redux/store'

import { AuthProvider } from '@/context/AuthContext'
import { ProtectedRoute } from '@/routes/ProtectedRoute'
import AppLayout from '@/components/Common/AppLayout'

import Login from '@/pages/Login/Login'
import ForgotPassword from '@/pages/ForgotPassword/ForgotPassword'
import ResetPassword from '@/pages/ResetPassword/ResetPassword'

import Dashboard from '@/pages/Dashboard/Dashboard'
import Issues from '@/pages/Issues/Issues'
import ThresholdMonitoring from '@/pages/ThresholdMonitoring/ThresholdMonitoring'
import CorrectionCenter from '@/pages/CorrectionCenter/CorrectionCenter'
import Reports from '@/pages/Reports/Reports'
import Settings from '@/pages/Settings/Settings'

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
          <Routes>
            <Route path="/" element={<Navigate to="/login" replace />} />
            <Route path="/login" element={<Login />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password/:token" element={<ResetPassword />} />

            <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/issues" element={<Issues />} />
              <Route path="/threshold-monitoring" element={<ThresholdMonitoring />} />
              <Route path="/correction-center" element={<CorrectionCenter />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/settings" element={<Settings />} />
            </Route>

            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </Provider>
  )
}

export default App
