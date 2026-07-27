import { useSelector } from 'react-redux'

/** Compact pill shown on page headers when SAP upload results are active. */
export default function LiveDataBadge() {
  const dataSource = useSelector((s) => s.issues.dataSource)
  const meta = useSelector((s) => s.issues.uploadMeta)

  if (dataSource !== 'upload' || !meta) return null

  return (
    <span className="live-data-badge" title={meta.fileName || 'SAP upload'}>
      Live SAP · {meta.stats?.issuesFound?.toLocaleString?.() ?? meta.stats?.issuesFound ?? '—'} issues
    </span>
  )
}
