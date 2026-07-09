import './Common.css'

export default function Timeline({ stages }) {
  return (
    <div className="timeline">
      {stages.map((item, i) => (
        <div key={i} className={`timeline-item ${item.completed ? 'completed' : ''}`}>
          <div className="timeline-dot">
            {item.completed && <div className="timeline-dot-check" />}
          </div>
          <div className="timeline-content">
            <div className="timeline-stage">{item.stage}</div>
            {item.date && <div className="timeline-date">{item.date}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
