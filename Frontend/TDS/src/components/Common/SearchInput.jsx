import { useRef } from 'react'
import { X } from 'lucide-react'

/**
 * Text search box with a clear (✕) button that appears once something is typed.
 * Esc also clears it. `onChange` receives the new string, not the event.
 * `wrapperClassName` sizes the box in flex/grid toolbars; other props go to the <input>.
 */
export default function SearchInput({ value, onChange, className = '', wrapperClassName = '', ...inputProps }) {
  const inputRef = useRef(null)
  const hasValue = String(value ?? '').length > 0

  function clear() {
    onChange('')
    inputRef.current?.focus()
  }

  return (
    <span className={`search-input ${wrapperClassName}`.trim()}>
      <input
        {...inputProps}
        ref={inputRef}
        type="text"
        className={`filter-input ${className}`.trim()}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && hasValue) {
            event.stopPropagation()
            clear()
          }
          inputProps.onKeyDown?.(event)
        }}
      />
      {hasValue && (
        <button className="search-input-clear" type="button" onClick={clear} aria-label="Clear search" title="Clear search">
          <X size={13} />
        </button>
      )}
    </span>
  )
}
