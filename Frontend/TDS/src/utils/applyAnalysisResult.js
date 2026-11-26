import toast from 'react-hot-toast'
import { uploadSucceeded } from '@/redux/slices/issuesSlice'
import { setDataSourceLabel, setLastSyncTime, setSyncStatus, setFinancialYear } from '@/redux/slices/appSlice'
import { seedPansFromIssues } from '@/redux/slices/panSlice'
import { dominantFinancialYear } from '@/utils/utils'

/**
 * Load a TDS analysis result (Excel upload or SAP data API) into the app so
 * every page shows it, and toast a summary.
 */
export function applyAnalysisResult(dispatch, result, sourceLabel) {
  dispatch(uploadSucceeded(result))
  dispatch(seedPansFromIssues(result.issues || []))
  // Show the FY the data belongs to, so its rows aren't hidden by an FY selected earlier.
  // A large SAP pull sends no rows, only its FY (result.financialYear).
  const financialYear = dominantFinancialYear(result.validationRows || []) || result.financialYear
  if (financialYear) dispatch(setFinancialYear(financialYear))
  dispatch(setSyncStatus('synced'))
  dispatch(setLastSyncTime('Just now'))
  dispatch(setDataSourceLabel(sourceLabel))

  const stats = result.stats || {}
  const tracking = result.tracking
  const trackingText = tracking && !tracking.error
    ? ` · ${tracking.newIssues.toLocaleString()} new · ${tracking.resolvedIssues.toLocaleString()} resolved since last run`
    : ''
  // "Issues found" counts every issue the rules raised, including ones a
  // correction already resolved (now or in an earlier run), so say how many
  // of them are still open.
  const found = Number(stats.issuesFound) || 0
  const open = stats.openIssues ?? found
  const alreadyCorrected = Math.max(0, found - open)
  const foundText = alreadyCorrected > 0
    ? `${found.toLocaleString()} issues found (${open.toLocaleString()} open, ${alreadyCorrected.toLocaleString()} already corrected)`
    : `${found.toLocaleString()} issues found`
  toast.success(
    `Processed ${stats.transactionsBuilt?.toLocaleString?.() ?? stats.transactionsBuilt} transactions · ${foundText}${trackingText}`,
    { duration: 5000 },
  )
  if (tracking?.error) toast.error(tracking.error)
  // The analysis still loads, but Document / GL Ledger won't have this run's lines.
  if (tracking?.ledgerError) toast.error(`${tracking.ledgerError} Document Ledger and GL Ledger won't show it; the backend console has the reason.`, { duration: 10000 })
}
