import api from './api'

/** Whether the backend has the SAP data API URL and token (never the token itself). */
export async function fetchSapDataConfig() {
  const response = await api.get('/sap-data/config')
  return response.data
}

/** One page of a SAP table through the backend (which holds the bearer token). */
export async function querySapTable({ table, pageNo = 1, pageSize = 100, otherConditions = '' }) {
  const response = await api.post('/sap-data/query', {
    table,
    page_no: pageNo,
    page_size: pageSize,
    other_conditions: otherConditions,
  })
  return response.data
}

// Fetching every page and analysing can take a while on a large month.
const LONG_TIMEOUT = 15 * 60 * 1000

/** Run the TDS analysis on every SAP row matching the filters (same result as an Excel upload). */
export async function analyseSapData({ table, otherConditions = '', companyCode = '', includeInformational = true }) {
  const response = await api.post('/sap-data/analyse', {
    table,
    other_conditions: otherConditions,
    company_code: companyCode,
    include_informational: includeInformational,
  }, { timeout: LONG_TIMEOUT })
  return response.data
}

/** Save every exemption row matching the filters into LDC Master (same as the certificate upload). */
export async function importLdcFromSap({ table, otherConditions = '', companyCode = '' }) {
  const response = await api.post('/sap-data/import-ldc', {
    table,
    other_conditions: otherConditions,
    company_code: companyCode,
  }, { timeout: LONG_TIMEOUT })
  return response.data
}
