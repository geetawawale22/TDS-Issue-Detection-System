import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Building2, Users, ShieldCheck, Database, RefreshCw, Bell, History, Plus, X, Pencil, Search, RotateCcw, Trash2 } from 'lucide-react'
import StatusBadge from '@/components/Common/StatusBadge'
import { useAuth } from '@/context/AuthContext'
import adminService from '@/services/adminService'
import { initials, capitalize, isValidEmail } from '@/utils/utils'
import { MESSAGES } from '@/utils/messages'
import '@/components/Common/Common.css'
import './Settings.css'

const ALL_TABS = [
  { id: 'organization', label: 'Organization', icon: Building2 },
  { id: 'users',        label: 'Users',        icon: Users,       adminOnly: true },
  { id: 'roles',        label: 'Roles',        icon: ShieldCheck, adminOnly: true },
  { id: 'gcp',          label: 'GCP Config',   icon: Database },
  { id: 'sync',         label: 'Sync',         icon: RefreshCw },
  { id: 'notifications',label: 'Notifications',icon: Bell },
  { id: 'audit',        label: 'Audit Logs',   icon: History },
]

const ROLE_DESCRIPTIONS = {
  admin:      'Full access — manage users, assign company-code access, and see every module.',
  accountant: 'Can view dashboards, issues, and reports only for the company codes they\u2019ve been assigned.',
}

const auditLogs = [
  { actor: 'Anita Rao',   action: 'Approved correction COR-03112',           time: '12 min ago' },
  { actor: 'Karthik Iyer',action: 'Rejected correction COR-03098',           time: '1 hour ago' },
  { actor: 'System',      action: 'Sync completed — 1,204 new transactions', time: '3 hours ago' },
  { actor: 'Priya Menon', action: 'Generated Monthly Compliance Report',      time: '6 hours ago' },
  { actor: 'Suresh Nair', action: 'Logged in from new device',               time: '1 day ago'   },
]

function Toggle({ defaultChecked }) {
  const [on, setOn] = useState(defaultChecked ?? false)
  return (
    <button
      className={`settings-toggle ${on ? 'on' : ''}`}
      onClick={() => setOn(!on)}
      aria-checked={on}
      role="switch"
    >
      <span className="settings-toggle-thumb" />
    </button>
  )
}

function ToggleRow({ label, desc, defaultChecked }) {
  return (
    <div className="settings-toggle-row">
      <div>
        <div className="settings-toggle-label">{label}</div>
        <div className="settings-toggle-desc">{desc}</div>
      </div>
      <Toggle defaultChecked={defaultChecked} />
    </div>
  )
}

export default function Settings() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const TABS = ALL_TABS.filter((t) => !t.adminOnly || isAdmin)

  const [activeTab, setActiveTab] = useState(isAdmin ? 'organization' : 'organization')
  const [syncFreq, setSyncFreq] = useState('hourly')

  // --- Real backend-driven user management state ---
  const [users, setUsers] = useState([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [usersError, setUsersError] = useState(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [busyUserId, setBusyUserId] = useState(null)
  const [userSearch, setUserSearch] = useState('')
  const [userStatusFilter, setUserStatusFilter] = useState('all')

  const filteredUsers = users.filter((u) => {
    const q = userSearch.trim().toLowerCase()
    if (q && !u.full_name.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false
    if (userStatusFilter === 'active' && !u.is_active) return false
    if (userStatusFilter === 'deactivated' && u.is_active) return false
    return true
  })

  async function loadUsers() {
    if (!isAdmin) return
    setUsersLoading(true)
    setUsersError(null)
    try {
      const data = await adminService.listUsers()
      setUsers(data)
    } catch (err) {
      setUsersError(err.message)
    } finally {
      setUsersLoading(false)
    }
  }

  useEffect(() => {
    if (activeTab === 'users' || activeTab === 'roles') loadUsers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  async function handleCreateUser({ company_codes, ...payload }) {
    try {
      const created = await adminService.createUser(payload)

      // Company codes aren't part of user creation itself — they're granted
      // via the existing assign-company-code endpoint right after. Admins
      // implicitly have access to every code, so nothing to assign there.
      if (payload.role !== 'admin' && company_codes?.length) {
        const results = await Promise.allSettled(
          company_codes.map((code) => adminService.assignCompanyCode(created.id, code))
        )
        const failed = results.filter((r) => r.status === 'rejected').length
        if (failed > 0) {
          toast.error(`User created, but ${failed} of ${company_codes.length} company code(s) could not be assigned.`)
        }
      }

      if (created.invite_email_sent === false) {
        toast.error(MESSAGES.INVITE_EMAIL_FAILED)
      } else {
        toast.success(MESSAGES.USER_CREATED)
      }
      setShowCreateModal(false)
      loadUsers()
      return true
    } catch (err) {
      toast.error(err.message || MESSAGES.UNEXPECTED_ERROR)
      return false
    }
  }

  async function handleToggleActive(u) {
    setBusyUserId(u.id)
    try {
      if (u.is_active) {
        await adminService.deactivateUser(u.id)
      } else {
        await adminService.activateUser(u.id)
      }
      toast.success(MESSAGES.ACTIVATION_UPDATED(u.full_name, !u.is_active))
      loadUsers()
    } catch (err) {
      toast.error(err.message || MESSAGES.UNEXPECTED_ERROR)
    } finally {
      setBusyUserId(null)
    }
  }

  async function handleDeleteUser(u) {
    if (!window.confirm(`Delete ${u.full_name}? This permanently removes their account and cannot be undone.`)) return
    setBusyUserId(u.id)
    try {
      await adminService.deleteUser(u.id)
      toast.success(MESSAGES.USER_DELETED(u.full_name))
      loadUsers()
    } catch (err) {
      toast.error(err.message || MESSAGES.UNEXPECTED_ERROR)
    } finally {
      setBusyUserId(null)
    }
  }

  async function handleUpdateUser(userId, payload) {
    try {
      await adminService.updateUser(userId, payload)
      toast.success(MESSAGES.USER_UPDATED)
      setEditingUser(null)
      loadUsers()
      return true
    } catch (err) {
      toast.error(err.message || MESSAGES.UNEXPECTED_ERROR)
      return false
    }
  }

  async function handleToggleCompanyCode(u, code) {
    setBusyUserId(u.id)
    try {
      if (u.company_codes.includes(code)) {
        await adminService.revokeCompanyCode(u.id, code)
      } else {
        await adminService.assignCompanyCode(u.id, code)
      }
      toast.success(MESSAGES.COMPANY_CODE_UPDATED)
      loadUsers()
    } catch (err) {
      toast.error(err.message || MESSAGES.UNEXPECTED_ERROR)
    } finally {
      setBusyUserId(null)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">Settings</span>
          </div>
          <h1 className="page-title">Settings</h1>
        </div>
      </div>

      {/* Tabs */}
      <div className="settings-tabs">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`settings-tab ${activeTab === id ? 'active' : ''}`}
            onClick={() => setActiveTab(id)}
          >
            <Icon size={13} />{label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="settings-content">
        {activeTab === 'organization' && (
          <div className="settings-card" style={{ maxWidth: 480 }}>
            <h3 className="settings-card-title">Organization Settings</h3>
            {[
              { label: 'Organization name', value: 'Meridian Holdings Pvt Ltd' },
              { label: 'PAN',               value: 'AAACM1234A' },
              { label: 'TAN',               value: 'MUMM12345A' },
            ].map(({ label, value }) => (
              <div key={label} className="settings-field-row">
                <label className="settings-field-label">{label}</label>
                <input className="settings-input" defaultValue={value} />
              </div>
            ))}
            <div className="settings-field-row">
              <label className="settings-field-label">Financial year</label>
              <select className="filter-select">
                <option value="2025-26">FY 2025-26</option>
                <option value="2024-25">FY 2024-25</option>
              </select>
            </div>
            <div style={{ marginTop: 16 }}>
              <button className="btn btn-primary">Save Changes</button>
            </div>
          </div>
        )}

        {activeTab === 'users' && isAdmin && (
          <div className="table-card" style={{ maxWidth: 720 }}>
            <div className="table-card-header">
              <div className="table-card-title">User Management</div>
              <button className="btn btn-primary btn-sm" onClick={() => setShowCreateModal(true)}>
                <Plus size={12} />Add User
              </button>
            </div>

            <div className="filter-bar" style={{ boxShadow: 'none', margin: '0 16px 10px' }}>
              <div className="filter-bar-top">
                <div className="filter-bar-label"><Search size={13} />Search</div>
                <input
                  className="filter-input"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Search name or email…"
                />
              </div>
              <div className="filter-bar-controls">
                <select
                  className="filter-select"
                  value={userStatusFilter}
                  onChange={(e) => setUserStatusFilter(e.target.value)}
                >
                  <option value="all">All Statuses</option>
                  <option value="active">Active</option>
                  <option value="deactivated">Deactivated</option>
                </select>
                {(userSearch || userStatusFilter !== 'all') && (
                  <button
                    className="filter-reset-btn"
                    onClick={() => { setUserSearch(''); setUserStatusFilter('all') }}
                  >
                    <RotateCcw size={12} />Reset
                  </button>
                )}
              </div>
            </div>

            {usersLoading && <div style={{ padding: 16, fontSize: 12.5, color: 'var(--color-text-muted)' }}>Loading users…</div>}
            {usersError && <div style={{ padding: 16, fontSize: 12.5, color: 'var(--color-danger)' }}>{usersError}</div>}

            {!usersLoading && !usersError && filteredUsers.length === 0 && (
              <div style={{ padding: 16, fontSize: 12.5, color: 'var(--color-text-muted)' }}>No users match your search or filter.</div>
            )}

            {!usersLoading && !usersError && filteredUsers.map((u) => (
              <div key={u.id} className="settings-user-row" style={{ flexWrap: 'wrap', gap: 10 }}>
                <div className="settings-user-avatar">{initials(u.full_name)}</div>
                <div className="settings-user-info">
                  <div className="settings-user-name">{u.full_name}</div>
                  <div className="settings-user-email">{u.email}</div>
                </div>
                <span className="settings-user-role">{capitalize(u.role)}</span>

                {/* Company code chips — click to grant/revoke directly, admins implicitly have all */}
                <div className="settings-user-codes" title={u.role === 'admin' ? 'Admins have access to all company codes' : undefined}>
                  {adminService.VALID_COMPANY_CODES.map((code) => {
                    const has = u.role === 'admin' || u.company_codes.includes(code)
                    return (
                      <button
                        key={code}
                        type="button"
                        disabled={u.role === 'admin' || busyUserId === u.id}
                        onClick={() => handleToggleCompanyCode(u, code)}
                        title={u.role === 'admin' ? 'Admins have access to all company codes' : has ? `Revoke ${code}` : `Grant ${code}`}
                        className={`company-code-badge company-code-badge--toggle ${has ? 'is-granted' : ''}`}
                      >
                        {code}
                      </button>
                    )
                  })}
                </div>

                <StatusBadge label={u.is_active ? 'Active' : 'Deactivated'} tone={u.is_active ? 'success' : 'warning'} />
                <button
                  className="btn btn-icon btn-sm"
                  title="Edit user"
                  aria-label={`Edit ${u.full_name}`}
                  disabled={busyUserId === u.id}
                  onClick={() => setEditingUser(u)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="btn btn-outline btn-sm"
                  disabled={busyUserId === u.id}
                  onClick={() => handleToggleActive(u)}
                >
                  {u.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  className="btn btn-icon btn-sm"
                  title="Delete user"
                  aria-label={`Delete ${u.full_name}`}
                  disabled={busyUserId === u.id}
                  onClick={() => handleDeleteUser(u)}
                  style={{ color: 'var(--color-danger)' }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'roles' && isAdmin && (
          <div className="settings-roles-grid">
            {['admin', 'accountant'].map((roleId) => {
              const count = users.filter((u) => u.role === roleId).length
              return (
                <div key={roleId} className="settings-card">
                  <h4 className="settings-card-title" style={{ fontSize: 13 }}>{capitalize(roleId)}</h4>
                  <p style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.6, flex: 1 }}>
                    {ROLE_DESCRIPTIONS[roleId]}
                  </p>
                  <div className="settings-role-footer">
                    <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{count} user{count === 1 ? '' : 's'}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {activeTab === 'gcp' && (
          <div className="settings-card" style={{ maxWidth: 480 }}>
            <h3 className="settings-card-title">GCP Configuration</h3>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>Connection details for your Google Cloud Platform data source.</p>
            <div className="settings-gcp-status">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Database size={15} style={{ color: 'var(--color-success)' }} />
                <span style={{ fontSize: 12.5, fontWeight: 500 }}>Connection Active</span>
              </div>
              <StatusBadge label="Connected" tone="success" />
            </div>
            {[
              { label: 'Project ID',       value: 'finance-prod',                                    disabled: false },
              { label: 'Dataset',          value: 'finance-prod.tds.transactions',                   disabled: false },
              { label: 'Service account',  value: 'tds-sync@finance-prod.iam.gserviceaccount.com',   disabled: true  },
            ].map(({ label, value, disabled }) => (
              <div key={label} className="settings-field-row">
                <label className="settings-field-label">{label}</label>
                <input className="settings-input" defaultValue={value} disabled={disabled} />
              </div>
            ))}
            <div style={{ marginTop: 16 }}>
              <button className="btn btn-outline">Test Connection</button>
            </div>
          </div>
        )}

        {activeTab === 'sync' && (
          <div className="settings-card" style={{ maxWidth: 480 }}>
            <h3 className="settings-card-title">Sync Settings</h3>
            <div className="settings-field-row">
              <label className="settings-field-label">Sync frequency</label>
              <select className="filter-select" value={syncFreq} onChange={(e) => setSyncFreq(e.target.value)}>
                <option value="realtime">Real-time</option>
                <option value="hourly">Every hour</option>
                <option value="daily">Daily</option>
                <option value="manual">Manual only</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <ToggleRow label="Auto-retry failed syncs" desc="Retry automatically up to 3 times on failure" defaultChecked />
              <ToggleRow label="Notify on sync failure" desc="Send an alert to admins if a sync fails" defaultChecked />
            </div>
            <div style={{ marginTop: 16 }}>
              <button className="btn btn-primary">Save Changes</button>
            </div>
          </div>
        )}

        {activeTab === 'notifications' && (
          <div className="settings-card" style={{ maxWidth: 480 }}>
            <h3 className="settings-card-title">Notification Preferences</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <ToggleRow label="High severity issues"        desc="Notify immediately when a high severity issue is found"  defaultChecked />
              <ToggleRow label="Threshold breaches"          desc="Notify when a vendor exceeds their statutory threshold"   defaultChecked />
              <ToggleRow label="Correction approvals needed" desc="Notify reviewers when corrections are pending"           defaultChecked />
              <ToggleRow label="Weekly summary digest"       desc="A weekly email summarising compliance health"            defaultChecked />
            </div>
          </div>
        )}

        {activeTab === 'audit' && (
          <div className="table-card" style={{ maxWidth: 640 }}>
            <div className="table-card-header">
              <div className="table-card-title">Audit Logs</div>
            </div>
            {auditLogs.map((log, i) => (
              <div key={i} className="settings-audit-row">
                <div className="settings-audit-icon">
                  <History size={14} style={{ color: 'var(--color-primary)' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5 }}>
                    <strong>{log.actor}</strong>
                    <span style={{ color: 'var(--color-text-muted)' }}> — {log.action}</span>
                  </span>
                </div>
                <span className="font-mono" style={{ fontSize: 11.5, color: 'var(--color-text-muted)', flexShrink: 0 }}>{log.time}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreateModal && (
        <CreateUserModal onClose={() => setShowCreateModal(false)} onSubmit={handleCreateUser} />
      )}

      {editingUser && (
        <EditUserModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSubmit={(payload) => handleUpdateUser(editingUser.id, payload)}
        />
      )}
    </div>
  )
}

function validateNewUser(values) {
  const errors = {}
  if (!values.full_name.trim()) errors.full_name = 'Full name is required.'
  if (!values.username.trim()) errors.username = 'Username is required.'
  else if (/\s/.test(values.username)) errors.username = 'Username cannot contain spaces.'
  if (!values.email.trim()) errors.email = 'Email is required.'
  else if (!isValidEmail(values.email)) errors.email = 'Enter a valid email address.'
  if (values.role !== 'admin' && values.company_codes.length === 0) {
    errors.company_codes = 'Select at least one company code.'
  }
  return errors
}

function CompanyCodeCheckboxes({ selected, onToggle, disabled }) {
  return (
    <div className="company-code-options">
      {adminService.VALID_COMPANY_CODES.map((code) => (
        <label key={code} className="company-code-option">
          <input
            type="checkbox"
            checked={disabled || selected.includes(code)}
            disabled={disabled}
            onChange={() => onToggle(code)}
          />
          {code}
        </label>
      ))}
    </div>
  )
}

function CreateUserModal({ onClose, onSubmit }) {
  const [values, setValues] = useState({ full_name: '', username: '', email: '', role: 'accountant', company_codes: [] })
  const [errors, setErrors] = useState({})
  const [touched, setTouched] = useState({})
  const [submitting, setSubmitting] = useState(false)

  function handleChange(field, value) {
    const next = { ...values, [field]: value }
    setValues(next)
    if (touched[field]) setErrors((e) => ({ ...e, [field]: validateNewUser(next)[field] }))
  }

  function toggleCompanyCode(code) {
    const next = {
      ...values,
      company_codes: values.company_codes.includes(code)
        ? values.company_codes.filter((c) => c !== code)
        : [...values.company_codes, code],
    }
    setValues(next)
    if (touched.company_codes) setErrors((e) => ({ ...e, company_codes: validateNewUser(next).company_codes }))
  }

  function handleBlur(field) {
    setTouched((t) => ({ ...t, [field]: true }))
    setErrors(validateNewUser(values))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setTouched({ full_name: true, username: true, email: true, company_codes: true })
    const errs = validateNewUser(values)
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      toast.error(MESSAGES.VALIDATION_ERROR)
      return
    }
    setSubmitting(true)
    const ok = await onSubmit(values)
    setSubmitting(false)
    if (!ok) return
  }

  return (
    <div className="modal-overlay">
      <div className="settings-card modal-card" style={{ position: 'relative' }}>
        <button
          onClick={onClose}
          style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <X size={16} />
        </button>
        <h3 className="settings-card-title">Add User</h3>
        <form onSubmit={handleSubmit} noValidate>
          <div className="settings-field-row">
            <label className="settings-field-label">Full name</label>
            <input
              className={`settings-input ${errors.full_name ? 'error' : ''}`}
              value={values.full_name}
              onChange={(e) => handleChange('full_name', e.target.value)}
              onBlur={() => handleBlur('full_name')}
            />
            {errors.full_name && <span className="form-error">{errors.full_name}</span>}
          </div>
          <div className="settings-field-row">
            <label className="settings-field-label">Username</label>
            <input
              className={`settings-input ${errors.username ? 'error' : ''}`}
              value={values.username}
              onChange={(e) => handleChange('username', e.target.value)}
              onBlur={() => handleBlur('username')}
            />
            {errors.username && <span className="form-error">{errors.username}</span>}
          </div>
          <div className="settings-field-row">
            <label className="settings-field-label">Email</label>
            <input
              type="email" className={`settings-input ${errors.email ? 'error' : ''}`}
              value={values.email}
              onChange={(e) => handleChange('email', e.target.value)}
              onBlur={() => handleBlur('email')}
            />
            {errors.email && <span className="form-error">{errors.email}</span>}
          </div>
          <div className="settings-field-row">
            <label className="settings-field-label">Role</label>
            <select
              className="filter-select"
              value={values.role}
              onChange={(e) => handleChange('role', e.target.value)}
            >
              <option value="accountant">Accountant</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="settings-field-row">
            <label className="settings-field-label">Company code{values.role === 'admin' ? '' : ' *'}</label>
            <div style={{ flex: 1 }}>
              {values.role === 'admin' ? (
                <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>Admins have access to all company codes.</span>
              ) : (
                <>
                  <CompanyCodeCheckboxes selected={values.company_codes} onToggle={toggleCompanyCode} />
                  {errors.company_codes && <span className="form-error">{errors.company_codes}</span>}
                </>
              )}
            </div>
          </div>
          <div className="modal-actions">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create User'}
            </button>
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function validateEditUser(values) {
  const errors = {}
  if (!values.full_name.trim()) errors.full_name = 'Full name is required.'
  if (!values.email.trim()) errors.email = 'Email is required.'
  else if (!isValidEmail(values.email)) errors.email = 'Enter a valid email address.'
  return errors
}

function EditUserModal({ user: u, onClose, onSubmit }) {
  const [values, setValues] = useState({ full_name: u.full_name, email: u.email, role: u.role })
  const [errors, setErrors] = useState({})
  const [touched, setTouched] = useState({})
  const [submitting, setSubmitting] = useState(false)

  function handleChange(field, value) {
    const next = { ...values, [field]: value }
    setValues(next)
    if (touched[field]) setErrors((e) => ({ ...e, [field]: validateEditUser(next)[field] }))
  }

  function handleBlur(field) {
    setTouched((t) => ({ ...t, [field]: true }))
    setErrors(validateEditUser(values))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setTouched({ full_name: true, email: true })
    const errs = validateEditUser(values)
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      toast.error(MESSAGES.VALIDATION_ERROR)
      return
    }
    setSubmitting(true)
    const ok = await onSubmit(values)
    setSubmitting(false)
    if (!ok) return
  }

  return (
    <div className="modal-overlay">
      <div className="settings-card modal-card" style={{ position: 'relative' }}>
        <button
          onClick={onClose}
          style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <X size={16} />
        </button>
        <h3 className="settings-card-title">Edit User</h3>
        <form onSubmit={handleSubmit} noValidate>
          <div className="settings-field-row">
            <label className="settings-field-label">Full name</label>
            <input
              className={`settings-input ${errors.full_name ? 'error' : ''}`}
              value={values.full_name}
              onChange={(e) => handleChange('full_name', e.target.value)}
              onBlur={() => handleBlur('full_name')}
            />
            {errors.full_name && <span className="form-error">{errors.full_name}</span>}
          </div>
          <div className="settings-field-row">
            <label className="settings-field-label">Email</label>
            <input
              type="email" className={`settings-input ${errors.email ? 'error' : ''}`}
              value={values.email}
              onChange={(e) => handleChange('email', e.target.value)}
              onBlur={() => handleBlur('email')}
            />
            {errors.email && <span className="form-error">{errors.email}</span>}
          </div>
          <div className="settings-field-row">
            <label className="settings-field-label">Role</label>
            <select
              className="filter-select"
              value={values.role}
              onChange={(e) => handleChange('role', e.target.value)}
            >
              <option value="accountant">Accountant</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
            Company code access and active status are managed from the user row directly.
          </p>
          <div className="modal-actions">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save Changes'}
            </button>
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}
