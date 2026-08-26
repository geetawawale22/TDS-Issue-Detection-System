import api from './api'

const issuesService = {
  /**
   * Upload a SAP CSV/XLSX extract. Runs backend rule engine and returns
   * UI-shaped issues + stats for the Issues page demo.
   */
  async uploadSapFile(file, { companyCode = '', includeInformational = true, onProgress } = {}) {
    const formData = new FormData()
    formData.append('file', file)
    if (companyCode) formData.append('company_code', companyCode)
    formData.append('include_informational', includeInformational ? 'true' : 'false')

    const { data } = await api.post('/issues/upload', formData, {
      // Let the browser set multipart boundary — do not force JSON.
      headers: { 'Content-Type': 'multipart/form-data' },
      transformRequest: [(body, headers) => {
        if (body instanceof FormData) {
          delete headers['Content-Type']
        }
        return body
      }],
      timeout: 5 * 60 * 1000,
      onUploadProgress: (event) => {
        if (!onProgress || !event.total) return
        onProgress(Math.round((event.loaded / event.total) * 100))
      },
    })
    return data
  },

  async downloadTemplate() {
    const { data } = await api.get('/issues/template', { responseType: 'blob' })
    const url = window.URL.createObjectURL(new Blob([data], { type: 'text/csv' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'tds_sap_upload_template.csv'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.URL.revokeObjectURL(url)
  },
}

export default issuesService
