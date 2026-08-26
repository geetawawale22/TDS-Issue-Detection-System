import { createSlice } from '@reduxjs/toolkit'
import { vendorDirectory } from '@/data/mockData'
import { simulatePanVerification } from '@/data/issueTypes'

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
    /** Seed / refresh PAN entries from uploaded SAP issues (keyed by vendorId). */
    seedPansFromIssues: (state, action) => {
      const issues = action.payload || []
      const seen = new Set()
      for (const issue of issues) {
        const vendorId = issue.vendorId
        if (!vendorId || vendorId === '—' || seen.has(vendorId)) continue
        seen.add(vendorId)
        const pan = issue.vendorPan && issue.vendorPan !== '—' ? issue.vendorPan : ''
        const verification = simulatePanVerification(pan)
        state[vendorId] = {
          pan: verification.pan,
          status: verification.status,
          aadhaarLinked: verification.aadhaarLinked,
          checkedAt: new Date().toISOString(),
          isMocked: true,
          verifying: false,
        }
      }
    },
  },
})

export const { startVerifyPan, finishVerifyPan, seedPansFromIssues } = panSlice.actions
export default panSlice.reducer
