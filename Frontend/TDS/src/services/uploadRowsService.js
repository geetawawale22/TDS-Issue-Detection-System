import api from './api'
import { selectedValues } from '@/utils/multiFilter'

// Repeated keys (vendor=a&vendor=b) for the multi-select filters, as FastAPI expects.
const listParams = { paramsSerializer: { indexes: null } }

/** Issues page filter values -> /upload-rows query parameters. */
export function uploadRowParams({ runId, companyCode, financialYear, filters }) {
  return {
    run_id: runId,
    company_code: companyCode || '',
    financial_year: financialYear || '',
    search: filters.searchQuery || '',
    vendor: selectedValues(filters.vendorFilter) || [],
    section: selectedValues(filters.sectionFilter) || [],
    doc_type: selectedValues(filters.docTypeFilter) || [],
    profit_center: selectedValues(filters.profitCenterFilter) || [],
    severity: selectedValues(filters.severityFilter) || [],
    status: selectedValues(filters.statusFilter) || [],
    issue_type: selectedValues(filters.issueTypeFilter) || [],
    date_from: filters.dateFrom || undefined,
    date_to: filters.dateTo || undefined,
  }
}

/**
 * Issues · This Upload for a large SAP pull: its rows are saved on the server
 * (backend/api/upload_rows.py), which works out the Issues page cards and pages the table.
 */
const uploadRowsService = {
  async getSummary(params) {
    const { data } = await api.get('/upload-rows/summary', { params, ...listParams })
    return data
  },

  async getPage(params, { view = 'all', tab = '', page = 1, pageSize = 1000 } = {}) {
    const { data } = await api.get('/upload-rows', {
      params: { ...params, view, tab: tab || '', page, page_size: pageSize },
      ...listParams,
    })
    return data
  },

  /** Every row of a view (for a card's CSV download), fetched page by page. */
  async getAll(params, view) {
    const rows = []
    for (let page = 1; ; page += 1) {
      const data = await this.getPage(params, { view, page, pageSize: 5000 })
      rows.push(...data.items)
      if (rows.length >= data.total || data.items.length === 0) return rows
    }
  },

  async search({ runId, q, excludeDoc = '' }) {
    const { data } = await api.get('/upload-rows/search', { params: { run_id: runId, q, exclude_doc: excludeDoc } })
    return data
  },
}

export default uploadRowsService
