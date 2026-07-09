import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Eye, EyeOff, AlertCircle, ShieldCheck } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import './Login.css'

function validate(values) {
  const errors = {}
  if (!values.email.trim()) errors.email = 'Email is required.'
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Enter a valid email address.'
  if (!values.password) errors.password = 'Password is required.'
  return errors
}

export default function Login() {
  const { login, isLoading, error: authError } = useAuth()
  const location = useLocation()
  const sessionExpired = new URLSearchParams(location.search).get('reason') === 'session_expired'

  const [values, setValues] = useState({ email: '', password: '', rememberMe: true })
  const [errors, setErrors] = useState({})
  const [touched, setTouched] = useState({})
  const [showPw, setShowPw] = useState(false)

  function handleChange(field, value) {
    setValues((v) => ({ ...v, [field]: value }))
    if (touched[field]) {
      const errs = validate({ ...values, [field]: value })
      setErrors((e) => ({ ...e, [field]: errs[field] }))
    }
  }

  function handleBlur(field) {
    setTouched((t) => ({ ...t, [field]: true }))
    const errs = validate(values)
    setErrors((e) => ({ ...e, [field]: errs[field] }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setTouched({ email: true, password: true })
    const errs = validate(values)
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    await login(values)
  }

  return (
    <div className="auth-page">
      <div className="auth-side-panel">
        <div className="auth-brand">
          <div className="auth-brand-icon">
            <ShieldCheck size={28} strokeWidth={2.3} color="#fff" />
          </div>
          <h2 className="auth-brand-name">TDS Intelligence</h2>
          <p className="auth-brand-sub">Compliance Platform</p>
        </div>
        <div className="auth-features">
          {['Automated TDS deduction detection', 'Real-time threshold monitoring', 'Correction workflow management', 'Audit-ready compliance reports'].map((f) => (
            <div key={f} className="auth-feature-item">
              <div className="auth-feature-dot" />
              <span>{f}</span>
            </div>
          ))}
        </div>
        <div className="auth-tagline">
          "Compliance made simple,<br />accuracy made certain."
        </div>
      </div>

      <div className="auth-form-panel">
        <div className="auth-form-box">
          <h1 className="auth-form-title">Sign in</h1>
          <p className="auth-form-sub">Welcome back — sign in to your compliance workspace.</p>

          {sessionExpired && (
            <div className="auth-alert auth-alert--warning">
              <AlertCircle size={15} />
              <span>Your session expired. Please sign in again.</span>
            </div>
          )}

          {authError && !sessionExpired && (
            <div className="auth-alert auth-alert--error">
              <AlertCircle size={15} />
              <span>{authError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="auth-form">
            <div className="form-field">
              <label className="form-label">Work email</label>
              <input
                type="email"
                className={`form-input ${errors.email ? 'error' : ''}`}
                placeholder="you@company.com"
                value={values.email}
                onChange={(e) => handleChange('email', e.target.value)}
                onBlur={() => handleBlur('email')}
                autoComplete="email"
                autoFocus
              />
              {errors.email && <span className="form-error">{errors.email}</span>}
            </div>

            <div className="form-field">
              <div className="form-label-row">
                <label className="form-label">Password</label>
                <Link to="/forgot-password" className="form-link">Forgot password?</Link>
              </div>
              <div className="form-pw-wrapper">
                <input
                  type={showPw ? 'text' : 'password'}
                  className={`form-input form-input--pw ${errors.password ? 'error' : ''}`}
                  placeholder="••••••••••••"
                  value={values.password}
                  onChange={(e) => handleChange('password', e.target.value)}
                  onBlur={() => handleBlur('password')}
                  autoComplete="current-password"
                />
                <button type="button" className="form-pw-toggle" onClick={() => setShowPw(!showPw)}>
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {errors.password && <span className="form-error">{errors.password}</span>}
            </div>

            <label className="form-checkbox-label">
              <input
                type="checkbox"
                checked={values.rememberMe}
                onChange={(e) => handleChange('rememberMe', e.target.checked)}
                className="form-checkbox"
              />
              <span>Remember me for 30 days</span>
            </label>

            <button type="submit" className="auth-submit-btn" disabled={isLoading}>
              {isLoading ? <span className="auth-spinner" /> : null}
              {isLoading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          <div className="auth-divider"><span>or</span></div>

          <button type="button" className="auth-google-btn">
            <svg className="auth-google-icon" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google Workspace
          </button>

          <p className="auth-footer-text">
            Don't have an account? Contact your administrator to get one created.
          </p>
        </div>
      </div>
    </div>
  )
}
