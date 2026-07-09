import './Common.css'

export default function ProgressBar({ value, showLabel = false }) {
  const clamped = Math.min(Math.max(value, 0), 130)
  const display = Math.min(clamped, 100)
  const tone = clamped >= 100 ? 'danger' : clamped >= 75 ? 'warning' : 'safe'

  return (
    <div className="progress-bar-container">
      <div className="progress-bar-track">
        <div
          className={`progress-bar-fill ${tone}`}
          style={{ width: `${display}%` }}
        />
      </div>
      {showLabel && (
        <span className="progress-bar-label">{clamped.toFixed(0)}%</span>
      )}
    </div>
  )
}
