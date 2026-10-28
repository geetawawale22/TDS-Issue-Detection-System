// Filter values in the issues slice are either 'all', a single value (older
// callers that dispatch a plain string) or an array of selected values from a
// multi-select dropdown. These helpers treat all three shapes the same way.

/** The selected values, or null when the filter is not restricting anything. */
export function selectedValues(filter) {
  if (filter == null || filter === 'all') return null
  const values = Array.isArray(filter) ? filter : [filter]
  return values.length ? values : null
}

/** True when the filter is off, or `value` is one of the selected values. */
export function filterIncludes(filter, value) {
  const values = selectedValues(filter)
  return !values || values.includes(value)
}

/** True when the filter is off, or `test` passes for at least one selected value. */
export function filterMatchesAny(filter, test) {
  const values = selectedValues(filter)
  return !values || values.some(test)
}
