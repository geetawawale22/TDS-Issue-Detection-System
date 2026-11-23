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
