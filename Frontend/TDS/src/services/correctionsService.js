import api from './api'

/** Manual correction register (Match SAP Rows), saved in the backend. */
const correctionsService = {
  /** Every correction group the user may see, newest first. */
  async list({ background = false } = {}) {
    const { data } = await api.get('/corrections', { skipGlobalLoader: background })
    return data
  },

  /** Save matched SAP rows for one issue; the issue is resolved in the issue history too. */
  async create({ issue, method, remarks, entries }) {
    const { data } = await api.post('/corrections', { issue, method, remarks, entries })
    return data
  },

  async undo(groupId, note) {
    const { data } = await api.post(`/corrections/${groupId}/undo`, { note })
    return data
  },

  async approve(groupId, note) {
    const { data } = await api.post(`/corrections/${groupId}/approve`, { note })
    return data
  },

  async reject(groupId, note) {
    const { data } = await api.post(`/corrections/${groupId}/reject`, { note })
    return data
  },

  /** One-time move of the register the old UI kept in this browser. */
  async importLegacy(groups) {
    const { data } = await api.post('/corrections/import-legacy', { groups }, { skipGlobalLoader: true })
    return data
  },
}

export default correctionsService
