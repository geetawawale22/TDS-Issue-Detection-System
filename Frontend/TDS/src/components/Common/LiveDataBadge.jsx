import { useSelector } from 'react-redux'
import { selectActiveIssues } from '@/redux/slices/issuesSlice'

/** Compact pill shown on page headers when SAP upload results are active. */
export default function LiveDataBadge() {
  const dataSource = useSelector((s) => s.issues.dataSource)
  const meta = useSelector((s) => s.issues.uploadMeta)
  const activeIssues = useSelector(selectActiveIssues)

  if (dataSource !== 'upload' || !meta) return null

  return (
    <span className="live-data-badge" title={meta.fileName || 'SAP upload'}>
      Live SAP · {activeIssues.length.toLocaleString()} issues
    </span>
  )
}
