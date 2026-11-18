import { useSelector } from 'react-redux'
import { selectActiveIssues, selectDashboardSourceIssues } from '@/redux/slices/issuesSlice'

/**
 * Compact pill shown on page headers when SAP upload results are active.
 * Once saved issues are loaded it counts open issues across every run;
 * otherwise the latest upload's issues.
 */
export default function LiveDataBadge() {
  const dataSource = useSelector((s) => s.issues.dataSource)
  const meta = useSelector((s) => s.issues.uploadMeta)
  const hasTracked = useSelector((s) => Boolean(s.issues.trackedIssues))
  const activeIssues = useSelector(selectActiveIssues)
  const sourceIssues = useSelector(selectDashboardSourceIssues)

  if (hasTracked) {
    const open = sourceIssues.filter((issue) => issue.status !== 'resolved').length
    return (
      <span className="live-data-badge" title="Open issues saved across every run">
        Live SAP · {open.toLocaleString()} open issues
      </span>
    )
  }

  if (dataSource !== 'upload' || !meta) return null

  return (
    <span className="live-data-badge" title={meta.fileName || 'SAP upload'}>
      Live SAP · {activeIssues.length.toLocaleString()} issues
    </span>
  )
}
