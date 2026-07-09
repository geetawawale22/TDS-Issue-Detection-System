import '@/components/Common/Common.css'
import './IssueReview.css'

export default function IssueReview() {
  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">Issue Review</span>
          </div>
          <h1 className="page-title">Issue Review</h1>
        </div>
      </div>
      <div className="empty-state">
        <div className="empty-state-title">Issue Review</div>
        <div className="empty-state-desc">Select an issue from the Issues page to review it here.</div>
      </div>
    </div>
  )
}
