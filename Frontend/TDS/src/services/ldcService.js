import api from './api'

export async function uploadLdcCertificates(file) {
  const formData = new FormData()
  formData.append('file', file)
  const response = await api.post('/ldc/upload-certificates', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return response.data
}

export async function uploadVendorMaster(file) {
  const formData = new FormData()
  formData.append('file', file)
  const response = await api.post('/ldc/upload-vendors', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return response.data
}

export async function fetchLdcCertificates() {
  const response = await api.get('/ldc/certificates')
  return response.data
}
