import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, ShieldCheck, ArrowLeft } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { isValidEmail } from '@/utils/utils'
import '../Login/Login.css'
import './ForgotPassword.css'

function validate(email) {
  if (!email.trim()) return 'Email is required.'
  if (!isValidEmail(email)) return 'Enter a valid email address.'
  return null
}

export default function ForgotPassword() {
  const { forgotPassword, isLoading, error: authError } = useAuth()
  const [email, setEmail] = useState('')
  const [error, setError] = useState(null)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    const err = validate(email)
    if (err) { setError(err); return }
    setError(null)
    const ok = await forgotPassword({ email })
    if (ok) setSent(true)
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

          {sent ? (
            <div className="fp-success">
              <div className="fp-success-icon">✉</div>
              <h2 className="fp-success-title">Check your inbox</h2>
              <p className="fp-success-desc">If an account exists for <strong>{email}</strong>, a password reset link has been sent.</p>
              <Link to="/login" className="auth-submit-btn" style={{ display: 'flex', marginTop: 20, textDecoration: 'none' }}>
                Return to Sign In
              </Link>
            </div>
          ) : (
            <>
              <h1 className="auth-form-title">Reset password</h1>
              <p className="auth-form-sub">Enter your work email and we'll send you a reset link.</p>

              {authError && (
                <div className="auth-alert auth-alert--error">
                  <AlertCircle size={15} /><span>{authError}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} noValidate className="auth-form">
                <div className="form-field">
                  <label className="form-label">Work email</label>
                  <input type="email" className={`form-input ${error ? 'error' : ''}`} placeholder="you@company.com"
                    value={email} onChange={(e) => { setEmail(e.target.value); setError(null) }} autoFocus autoComplete="email" />
                  {error && <span className="form-error">{error}</span>}
                </div>
                <button type="submit" className="auth-submit-btn" disabled={isLoading}>
                  {isLoading ? <span className="auth-spinner" /> : null}
                  {isLoading ? 'Sending…' : 'Send Reset Link'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
