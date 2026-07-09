import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Eye, EyeOff, AlertCircle, ShieldCheck, ArrowLeft } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import '../Login/Login.css'
import '../ForgotPassword/ForgotPassword.css'

function validate(values) {
  const errors = {}
  if (!values.password) errors.password = 'Password is required.'
  else if (values.password.length < 8) errors.password = 'Password must be at least 8 characters.'
  if (!values.confirm) errors.confirm = 'Please confirm your password.'
  else if (values.password !== values.confirm) errors.confirm = 'Passwords do not match.'
  return errors
}

export default function ResetPassword() {
  const { token } = useParams()
  const { resetPassword, isLoading, error: authError } = useAuth()
  const [values, setValues] = useState({ password: '', confirm: '' })
  const [errors, setErrors] = useState({})
  const [showPw, setShowPw] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    const errs = validate(values)
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    await resetPassword({ token, password: values.password })
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
      </div>
      <div className="auth-form-panel">
        <div className="auth-form-box">
          <Link to="/login" className="fp-back-link">
            <ArrowLeft size={14} /> Back to sign in
          </Link>
          <h1 className="auth-form-title">Set new password</h1>
          <p className="auth-form-sub">Enter a new password for your account.</p>
          {authError && (
            <div className="auth-alert auth-alert--error">
              <AlertCircle size={15} /><span>{authError}</span>
            </div>
          )}
          <form onSubmit={handleSubmit} noValidate className="auth-form">
            <div className="form-field">
              <label className="form-label">New password</label>
              <div className="form-pw-wrapper">
                <input type={showPw ? 'text' : 'password'} className={`form-input form-input--pw ${errors.password ? 'error' : ''}`}
                  placeholder="Min. 8 characters" value={values.password}
                  onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))} autoFocus autoComplete="new-password" />
                <button type="button" className="form-pw-toggle" onClick={() => setShowPw(!showPw)}>
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {errors.password && <span className="form-error">{errors.password}</span>}
            </div>
            <div className="form-field">
              <label className="form-label">Confirm password</label>
              <input type="password" className={`form-input ${errors.confirm ? 'error' : ''}`}
                placeholder="Re-enter password" value={values.confirm}
                onChange={(e) => setValues((v) => ({ ...v, confirm: e.target.value }))} autoComplete="new-password" />
              {errors.confirm && <span className="form-error">{errors.confirm}</span>}
            </div>
            <button type="submit" className="auth-submit-btn" disabled={isLoading}>
              {isLoading ? <span className="auth-spinner" /> : null}
              {isLoading ? 'Resetting…' : 'Reset Password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
