import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { selectedValues } from '@/utils/multiFilter'
import './MultiSelectFilter.css'

// Checkbox dropdown used by the TDS Analysis and Reports filters. `value` is 'all' or an
// array of option values; ticking nothing (or "All") goes back to 'all'.
export default function MultiSelectFilter({ allLabel, options, value, disabled = false, disabledTitle, onChange }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef(null)
  const selected = selectedValues(value) || []
  const selectedSet = new Set(selected)
  const labelFor = (optionValue) => options.find(([candidate]) => candidate === optionValue)?.[1] || optionValue
  const buttonLabel = selected.length === 0
    ? allLabel
    : selected.length === 1 ? labelFor(selected[0]) : `${selected.length} selected`

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return undefined
    function handleOutsideClick(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  function toggle(optionValue) {
    const next = selectedSet.has(optionValue)
      ? selected.filter((item) => item !== optionValue)
      : [...selected, optionValue]
    onChange(next.length ? next : 'all')
  }

  return (
    <div className="case-filter-menu" ref={menuRef}>
      <button
        className={`filter-select case-filter-menu-button ${selected.length ? 'has-selection' : ''}`}
        type="button"
        disabled={disabled}
        title={disabled ? disabledTitle : selected.map(labelFor).join(', ') || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
      >
        <span>{buttonLabel}</span>
        <ChevronDown size={14} />
      </button>
      {open && !disabled && (
        <div className="case-filter-menu-list" role="listbox" aria-multiselectable="true">
          <button
            className={`case-filter-menu-option ${selected.length === 0 ? 'is-active' : ''}`}
            type="button"
            role="option"
            aria-selected={selected.length === 0}
            onClick={() => onChange('all')}
          >
            <input type="checkbox" readOnly tabIndex={-1} checked={selected.length === 0} />
            {allLabel}
          </button>
          {options.map(([optionValue, label]) => (
            <button
              className={`case-filter-menu-option ${selectedSet.has(optionValue) ? 'is-active' : ''}`}
              type="button"
              key={optionValue}
              role="option"
              aria-selected={selectedSet.has(optionValue)}
              onClick={() => toggle(optionValue)}
            >
              <input type="checkbox" readOnly tabIndex={-1} checked={selectedSet.has(optionValue)} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
