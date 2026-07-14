import api from './api'

const VALID_COMPANY_CODES = ['1001', '1079', '1081']

const adminService = {
  VALID_COMPANY_CODES,

  async listUsers() {
    const { data } = await api.get('/admin/users')
    return data
  },

  async getUser(userId) {
    const { data } = await api.get(`/admin/users/${userId}`)
    return data
  },

  /** payload: { full_name, username, email, role } — role is 'admin' | 'accountant'. No password: user sets it via the invite link emailed after creation. */
  async createUser(payload) {
    const { data } = await api.post('/admin/users', payload)
    return data
  },

  /** payload: partial { full_name, email, role } — only provided fields are updated */
  async updateUser(userId, payload) {
    const { data } = await api.patch(`/admin/users/${userId}`, payload)
    return data
  },

  async assignCompanyCode(userId, companyCode) {
    const { data } = await api.post('/admin/users/assign-company-code', {
      user_id: userId,
      company_code: companyCode,
    })
    return data
  },

  async revokeCompanyCode(userId, companyCode) {
    const { data } = await api.delete(`/admin/users/${userId}/company-code/${companyCode}`)
    return data
  },

  async activateUser(userId) {
    const { data } = await api.patch(`/admin/users/${userId}/activate`)
    return data
  },

  async deleteUser(userId) {
    const { data } = await api.delete(`/admin/users/${userId}`)
    return data
  },

  async deactivateUser(userId) {
    const { data } = await api.patch(`/admin/users/${userId}/deactivate`)
    return data
  },
}

export default adminService
