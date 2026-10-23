import api from './api'

export async function fetchPanVerificationConfig() {
  const response = await api.get('/pan/config')
  return response.data
}

export async function fetchPanStatuses(pans) {
  const response = await api.post('/pan/statuses', { pans })
  return response.data
}

export async function verifyPans(pans, { force = false } = {}) {
  const response = await api.post('/pan/verify', { pans, force })
  return response.data
}

export async function overridePanStatus(pan, status) {
  const response = await api.put(`/pan/${encodeURIComponent(pan)}/status`, { status })
  return response.data
}
