import './Common.css'

export default function ProgressBar({ value, showLabel = false }) {
  const actual = Number.isFinite(Number(value)) ? Math.max(Number(value), 0) : 0
  const display = Math.min(actual, 100)
  const tone = actual >= 100 ? 'danger' : actual >= 75 ? 'warning' : 'safe'

  return (
    <div className="progress-bar-container">
      <div className="progress-bar-track">
        <div
          className={`progress-bar-fill ${tone}`}
          style={{ width: `${display}%` }}
        />
      </div>
      {showLabel && (
        <span className="progress-bar-label">{actual.toFixed(0)}%</span>
      )}
    </div>
  )
}
