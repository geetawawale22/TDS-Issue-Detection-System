const SECTION_ALIAS_PAIRS = [
  ['194C', '393(1)6(i)'],
  ['194H', '393(1)1(ii)'],
  ['194I', '393(1)2(ii)'],
  ['194J', '393(1)6(iii)(a)'],
  ['194J', '393(1)6(iii)(b)'],
  ['194Q', '393(1)8(ii)'],
  ['194R', '393(1)8(iv)'],
]

function normalizeSection(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
}

const SECTION_ALIAS_MAP = SECTION_ALIAS_PAIRS.reduce((map, [legacy, current]) => {
  const legacyKey = normalizeSection(legacy)
  const currentKey = normalizeSection(current)
  if (!map.has(legacyKey)) map.set(legacyKey, new Set())
  if (!map.has(currentKey)) map.set(currentKey, new Set())
  map.get(legacyKey).add(currentKey)
  map.get(currentKey).add(legacyKey)
  return map
}, new Map())

export function sectionAliases(value) {
  const parts = String(value ?? '')
    .split(/[,/]/)
    .map(normalizeSection)
    .filter(Boolean)

  const aliases = new Set()
  for (const part of parts) {
    aliases.add(part)
    const mapped = SECTION_ALIAS_MAP.get(part)
    if (mapped) mapped.forEach((alias) => aliases.add(alias))
  }
  return aliases
}

export function sectionMatches(selectedSection, values) {
  const selectedAliases = sectionAliases(selectedSection)
  if (!selectedAliases.size) return true

  return values.some((value) => {
    const valueAliases = sectionAliases(value)
    for (const alias of valueAliases) {
      if (selectedAliases.has(alias)) return true
    }
    return false
  })
}
