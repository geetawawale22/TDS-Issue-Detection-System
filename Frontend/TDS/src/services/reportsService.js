import api from './api'

/** Reports built on the server from saved data (every run), not one uploaded file. */
const reportsService = {
  /** TDS Category Report rows: every saved SAP line in the Company / FY scope, as it stands now. */
  async getCategoryRows({ companyCode = '', financialYear = '' } = {}) {
    const { data } = await api.get('/reports/category', {
      params: { company_code: companyCode, financial_year: financialYear },
    })
    return data
  },

  /** Every saved issue (open and resolved, all runs) in the Company / FY scope. */
  async getIssueStatusRows({ companyCode = '', financialYear = '' } = {}) {
    const { data } = await api.get('/reports/issue-status', {
      params: { company_code: companyCode, financial_year: financialYear },
    })
    return data
  },
}

export default reportsService
