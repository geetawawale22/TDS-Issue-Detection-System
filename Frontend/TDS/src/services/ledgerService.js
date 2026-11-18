import api from './api'

// Repeated keys (vendor=a&vendor=b) for the multi-select filters, as FastAPI expects.
const listParams = { paramsSerializer: { indexes: null } }

/**
 * Document / GL Ledger over every saved SAP line (all runs, daily feed).
 * Filtering, counting and paging run on the server (backend/api/ledger.py).
 */
const ledgerService = {
  async getGroups({ filters, status = 'all', page = 1, pageSize = 100 }) {
    const { data } = await api.get('/ledger/groups', {
      params: { ...filters, status, page, page_size: pageSize },
      ...listParams,
    })
    return data
  },

  async getGlRows({ filters }) {
    const { data } = await api.get('/ledger/gl', { params: filters, ...listParams })
    return data
  },

  async getGlLines({ glKey, filters }) {
    const { data } = await api.get('/ledger/gl/lines', { params: { ...filters, gl_key: glKey }, ...listParams })
    return data
  },

  async getOptions({ companyCode = '', financialYear = '' } = {}) {
    const { data } = await api.get('/ledger/options', {
      params: { company_code: companyCode, financial_year: financialYear },
    })
    return data
  },
}

export default ledgerService
