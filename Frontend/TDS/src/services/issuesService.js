import api from './api'

const issuesService = {
  /**
   * Upload one or more SAP CSV/XLSX extracts. The backend stacks them into a
   * single extract, runs the rule engine and returns UI-shaped issues + stats.
   */
  async uploadSapFile(files, { companyCode = '', includeInformational = true, onProgress } = {}) {
    const formData = new FormData()
    for (const file of (Array.isArray(files) ? files : [files])) formData.append('files', file)
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

  /** One page of saved issues across runs (status: open | resolved | all). */
  // barFilters: optional TDS Analysis filter bar (vendor, section, doc_type, profit_center,
  // severity_in, issue_type, date_from, date_to), sent as repeated keys for FastAPI.
  async getTrackedIssues({ status = 'open', search = '', resolutionType = '', run = '', tds = '', severity = '', partial = false, issueTab = '', page = 1, pageSize = 50, companyCode = '', financialYear = '', barFilters = {} } = {}) {
    const { data } = await api.get('/tracked-issues', {
      params: { ...barFilters, status, search, resolution_type: resolutionType, run, tds, severity, partial, issue_tab: issueTab, page, page_size: pageSize, company_code: companyCode || '', financial_year: financialYear || '' },
      paramsSerializer: { indexes: null },
    })
    return data
  },

  /** Every saved issue (compact), for Dashboard totals and charts across runs. */
  async getAllTrackedIssues() {
    const { data } = await api.get('/tracked-issues/all')
    return data
  },

  /** Issue book across every run (each issue once) plus the latest run's counts, for the selected company / FY. */
  async getTrackedIssueSummary({ companyCode = '', financialYear = '', barFilters = {} } = {}) {
    const { data } = await api.get('/tracked-issues/summary', {
      params: { ...barFilters, company_code: companyCode || '', financial_year: financialYear || '' },
      paramsSerializer: { indexes: null },
    })
    return data
  },

  async getRuleRuns(limit = 20) {
    const { data } = await api.get('/tracked-issues/runs', { params: { limit } })
    return data
  },

  /** Whether a rule run is still saved (false once clear_analysis.py wiped it). */
  async ruleRunExists(runId) {
    const { data } = await api.get(`/tracked-issues/runs/${runId}/exists`, { skipGlobalLoader: true })
    return Boolean(data?.exists)
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

  async uploadCaseSourceFiles(vendorEventsFile, tdsEventsFile) {
    const formData = new FormData()
    formData.append('vendor_events_file', vendorEventsFile)
    formData.append('tds_events_file', tdsEventsFile)

    const { data } = await api.post('/issues/upload-case-sources', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      transformRequest: [(body, headers) => {
        if (body instanceof FormData) {
          delete headers['Content-Type']
        }
        return body
      }],
      timeout: 5 * 60 * 1000,
    })
    return data
  },
}

export default issuesService
