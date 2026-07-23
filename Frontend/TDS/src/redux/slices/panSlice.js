import { createSlice } from '@reduxjs/toolkit'
import { vendorDirectory } from '@/data/mockData'

// Keyed by vendorId, not by issue — PAN validity is a vendor-level fact.
// Seeded from mockData's vendorDirectory (the mock "last known DB result"),
// and mutated in place when a user clicks "Verify PAN" (see IssueDrawer).
const initialState = Object.fromEntries(
  Object.values(vendorDirectory).map((v) => [v.vendorId, {
    pan: v.pan,
    status: v.panStatus,
    aadhaarLinked: v.panAadhaarLinked,
    checkedAt: v.panCheckedAt,
    isMocked: v.panIsMocked,
    verifying: false,
  }])
)

const panSlice = createSlice({
  name: 'pan',
  initialState,
  reducers: {
    startVerifyPan: (state, action) => {
      const entry = state[action.payload]
      if (entry) entry.verifying = true
    },
    finishVerifyPan: (state, action) => {
      const { vendorId, result } = action.payload
      state[vendorId] = { ...result, verifying: false }
    },
  },
})

export const { startVerifyPan, finishVerifyPan } = panSlice.actions
export default panSlice.reducer
