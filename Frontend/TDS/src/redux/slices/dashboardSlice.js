import { createSlice } from '@reduxjs/toolkit'

const initialState = {
  activeTab:    'overview',
  dateRange:    'this_quarter',
  isRefreshing: false,
}

const dashboardSlice = createSlice({
  name: 'dashboard',
  initialState,
  reducers: {
    setActiveTab:    (state, action) => { state.activeTab    = action.payload },
    setDateRange:    (state, action) => { state.dateRange    = action.payload },
    setIsRefreshing: (state, action) => { state.isRefreshing = action.payload },
  },
})

export const { setActiveTab, setDateRange, setIsRefreshing } = dashboardSlice.actions
export default dashboardSlice.reducer
