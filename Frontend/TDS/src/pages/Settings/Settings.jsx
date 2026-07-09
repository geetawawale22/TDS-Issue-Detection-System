import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Building2, Users, ShieldCheck, Database, RefreshCw, Bell, History, Plus, X } from 'lucide-react'
import StatusBadge from '@/components/Common/StatusBadge'
import { useAuth } from '@/context/AuthContext'
import adminService from '@/services/adminService'
import { initials, capitalize } from '@/utils/utils'
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
  const [busyUserId, setBusyUserId] = useState(null)

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

  async function handleCreateUser(payload) {
    try {
      await adminService.createUser(payload)
      toast.success(`${payload.full_name} was added.`)
      setShowCreateModal(false)
      loadUsers()
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function handleToggleActive(u) {
    setBusyUserId(u.id)
    try {
      if (u.is_active) {
        await adminService.deactivateUser(u.id)
        toast.success(`${u.full_name} deactivated.`)
      } else {
        await adminService.activateUser(u.id)
        toast.success(`${u.full_name} activated.`)
      }
      loadUsers()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusyUserId(null)
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
      loadUsers()
    } catch (err) {
      toast.error(err.message)
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

            {usersLoading && <div style={{ padding: 16, fontSize: 12.5, color: 'var(--color-text-muted)' }}>Loading users…</div>}
            {usersError && <div style={{ padding: 16, fontSize: 12.5, color: 'var(--color-danger)' }}>{usersError}</div>}

            {!usersLoading && !usersError && users.map((u) => (
              <div key={u.id} className="settings-user-row" style={{ flexWrap: 'wrap', gap: 10 }}>
                <div className="settings-user-avatar">{initials(u.full_name)}</div>
                <div className="settings-user-info">
                  <div className="settings-user-name">{u.full_name}</div>
                  <div className="settings-user-email">{u.email}</div>
                </div>
                <span className="settings-user-role">{capitalize(u.role)}</span>

                {/* Company code chips — click to grant/revoke, admins implicitly have all */}
                <div style={{ display: 'flex', gap: 4 }}>
                  {adminService.VALID_COMPANY_CODES.map((code) => {
                    const has = u.role === 'admin' || u.company_codes.includes(code)
                    return (
                      <button
                        key={code}
                        disabled={u.role === 'admin' || busyUserId === u.id}
                        onClick={() => handleToggleCompanyCode(u, code)}
                        title={u.role === 'admin' ? 'Admins have access to all company codes' : has ? `Revoke ${code}` : `Grant ${code}`}
                        style={{
                          fontSize: 10.5, fontFamily: 'monospace', padding: '2px 6px', borderRadius: 5,
                          border: '1px solid var(--color-border)', cursor: u.role === 'admin' ? 'default' : 'pointer',
                          background: has ? 'var(--color-primary)' : 'transparent',
                          color: has ? '#fff' : 'var(--color-text-muted)',
                          opacity: busyUserId === u.id ? 0.5 : 1,
                        }}
                      >
                        {code}
                      </button>
                    )
                  })}
                </div>

                <StatusBadge label={u.is_active ? 'Active' : 'Deactivated'} tone={u.is_active ? 'success' : 'warning'} />
                <button
                  className="btn btn-outline btn-sm"
                  disabled={busyUserId === u.id}
                  onClick={() => handleToggleActive(u)}
                >
                  {u.is_active ? 'Deactivate' : 'Activate'}
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
    </div>
  )
}

function CreateUserModal({ onClose, onSubmit }) {
  const [values, setValues] = useState({ full_name: '', email: '', password: '', role: 'accountant' })
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    await onSubmit(values)
    setSubmitting(false)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
    }}>
      <div className="settings-card" style={{ width: 380, position: 'relative' }}>
        <button
          onClick={onClose}
          style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <X size={16} />
        </button>
        <h3 className="settings-card-title">Add User</h3>
        <form onSubmit={handleSubmit}>
          <div className="settings-field-row">
            <label className="settings-field-label">Full name</label>
            <input
              className="settings-input" required
              value={values.full_name}
              onChange={(e) => setValues((v) => ({ ...v, full_name: e.target.value }))}
            />
          </div>
          <div className="settings-field-row">
            <label className="settings-field-label">Email</label>
            <input
              type="email" className="settings-input" required
              value={values.email}
              onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
            />
          </div>
          <div className="settings-field-row">
            <label className="settings-field-label">Temporary password</label>
            <input
              type="password" className="settings-input" required minLength={8}
              value={values.password}
              onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
            />
          </div>
          <div className="settings-field-row">
            <label className="settings-field-label">Role</label>
            <select
              className="filter-select"
              value={values.role}
              onChange={(e) => setValues((v) => ({ ...v, role: e.target.value }))}
            >
              <option value="accountant">Accountant</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
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
