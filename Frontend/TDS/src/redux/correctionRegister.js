import toast from 'react-hot-toast'
import correctionsService from '@/services/correctionsService'
import {
  clearLegacyCorrectionGroups,
  readLegacyCorrectionGroups,
  setCorrectionGroups,
} from '@/redux/slices/issuesSlice'

let legacyImport = null

/** Move a register the old UI left in this browser into the backend (once). */
async function importLegacyRegister() {
  const legacy = readLegacyCorrectionGroups()
  if (!legacy.length) return
  // Several callers may load at once; import only one time.
  legacyImport = legacyImport || correctionsService.importLegacy(legacy)
    .then((result) => {
      clearLegacyCorrectionGroups()
      if (result?.imported) {
        toast.success(`Moved ${result.imported} correction${result.imported === 1 ? '' : 's'} from this browser to the shared register`)
      }
    })
    .catch(() => {
      // Kept in the browser; tried again next time.
    })
    .finally(() => { legacyImport = null })
  await legacyImport
}

/** Load the correction register from the backend into the store. */
export async function loadCorrectionRegister(dispatch, { background = true } = {}) {
  await importLegacyRegister()
  const data = await correctionsService.list({ background })
  dispatch(setCorrectionGroups(data.items || []))
  return data
}
