import { useEffect, useState } from 'react'
import { useSelector } from 'react-redux'
import { subscribe } from '@/services/loaderBus'
import './PageLoader.css'

// Spinner used as the Suspense fallback while a page's code is loading.
// `fullScreen` centres it in the viewport (used outside the app shell).
export default function PageLoader({ label = 'Loading…', fullScreen = false }) {
  return (
    <div className={`page-loader ${fullScreen ? 'page-loader--fullscreen' : ''}`} role="status" aria-live="polite">
      <span className="page-loader-spinner" />
      <span className="page-loader-label">{label}</span>
    </div>
  )
}

// Overlay shown over the page area while any API request is in flight, or
// while an SAP upload is being sent and analysed (uploads are excluded from
// the request counter, so their state comes from the issues slice).
// A short delay avoids flashing the spinner for fast responses.
const SHOW_DELAY_MS = 200

export function GlobalPageLoader() {
  const [pending, setPending] = useState(0)
  const [requestVisible, setRequestVisible] = useState(false)
  const uploadStatus = useSelector((s) => s.issues.uploadStatus)
  const uploadProgress = useSelector((s) => s.issues.uploadProgress)

  useEffect(() => subscribe(setPending), [])

  useEffect(() => {
    if (pending === 0) {
      setRequestVisible(false)
      return undefined
    }
    const timer = setTimeout(() => setRequestVisible(true), SHOW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [pending > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  let label = null
  if (uploadStatus === 'processing') label = 'Analysing file…'
  else if (uploadStatus === 'uploading') label = `Uploading ${uploadProgress}%`
  else if (requestVisible) label = 'Loading…'

  if (!label) return null

  return (
    <div className="page-loader-overlay">
      <PageLoader label={label} />
    </div>
  )
}
