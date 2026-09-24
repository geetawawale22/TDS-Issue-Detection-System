import { useSelector } from 'react-redux'
import { selectIssuesBySection } from '@/redux/slices/issuesSlice'
import './Charts.css'

const BAR_DARK = [122, 14, 31]
const BAR_LIGHT = [251, 213, 218]

function barColor(ratio) {
  const [r, g, b] = BAR_DARK.map((c, i) => Math.round(c + (BAR_LIGHT[i] - c) * (1 - ratio)))
  return `rgb(${r}, ${g}, ${b})`
}

export default function SectionComplianceChart({ onSectionClick }) {
  const data = useSelector(selectIssuesBySection)
  const max = Math.max(...data.map((d) => d.count), 1)

  if (data.length === 0) {
    return <div className="section-compliance-empty">No section data available</div>
  }

  return (
    <div className="section-compliance-list">
      {data.map((row) => {
        const ratio = row.count / max
        return (
          <button
            key={row.section}
            className="section-compliance-row section-compliance-row-clickable"
            type="button"
            onClick={() => onSectionClick?.(row)}
          >
            <span className="section-compliance-label font-mono" title={row.section}>{row.section}</span>
            <div className="section-compliance-track">
              <div
                className="section-compliance-bar"
                style={{ width: `${Math.max(ratio * 100, 4)}%`, background: barColor(ratio) }}
              />
            </div>
            <span className="section-compliance-count font-mono">{row.count}</span>
          </button>
        )
      })}
    </div>
  )
}
