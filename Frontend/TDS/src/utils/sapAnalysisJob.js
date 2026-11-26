// SAP data API analysis running in the backend (services/sap_analysis_job.py).
// The job id is kept in this browser, so switching pages or refreshing keeps
// following it, and its result is loaded once it finishes, wherever the user is.
import toast from 'react-hot-toast'
import {
  getSapAnalysisJob, getSapAnalysisJobResult, startSapAnalysisJob, stopSapAnalysisJob,
} from '@/services/sapDataService'
import { applyAnalysisResult } from '@/utils/applyAnalysisResult'

const JOB_STORAGE_KEY = 'tds_sap_analysis_job'
const POLL_MS = 3000
export const ACTIVE_STATUSES = new Set(['queued', 'fetching', 'grouping', 'analysing', 'finishing'])

let current = null // latest job status from the backend
let polling = null // job id being polled
let dispatchRef = null
const listeners = new Set()

function readSaved() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(JOB_STORAGE_KEY) || 'null')
    return saved?.jobId ? saved : null
  } catch {
    return null
  }
}

function writeSaved(value) {
  try {
    if (value) window.localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(value))
    else window.localStorage.removeItem(JOB_STORAGE_KEY)
  } catch {
    // Storage blocked: the job is only followed while this page stays open.
  }
}

function emit(job) {
  current = job
  listeners.forEach((listener) => listener(job))
}

/** Calls listener with the job now and on every change; returns unsubscribe. */
export function subscribeSapAnalysisJob(listener) {
  listeners.add(listener)
  listener(current)
  return () => listeners.delete(listener)
}

async function applyFinished(job, label) {
  if (job.hasFullResult) {
    // Small pull: every row, exactly like an Excel upload.
    const result = await getSapAnalysisJobResult(job.jobId)
    applyAnalysisResult(dispatchRef, result, label)
  } else {
    // Large pull: saved on the server; pages read issues and lines from there.
    applyAnalysisResult(dispatchRef, job.summary, label)
  }
}

async function poll(jobId) {
  if (polling === jobId) return
  polling = jobId
  while (polling === jobId) {
    let job
    try {
      job = await getSapAnalysisJob(jobId)
    } catch (err) {
      if (err.status === 404) {
        writeSaved(null)
        emit({ jobId, status: 'failed', error: err.message })
        polling = null
        return
      }
      // Backend busy or briefly unreachable: keep trying.
      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
      continue
    }
    emit(job)
    if (!ACTIVE_STATUSES.has(job.status)) {
      const saved = readSaved()
      writeSaved(null)
      polling = null
      if (job.status === 'done' && saved?.jobId === jobId) {
        try {
          await applyFinished(job, saved.label)
        } catch (err) {
          toast.error(`The analysis finished but its result could not be loaded: ${err.message}`)
        }
      } else if (job.status !== 'done' && saved?.jobId === jobId) {
        toast.error(job.error || 'The SAP analysis did not finish.', { duration: 10000 })
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/** Once at app start: keep following a job started before a refresh / page change. */
export function resumeSapAnalysisJob(dispatch) {
  dispatchRef = dispatch
  const saved = readSaved()
  if (saved) poll(saved.jobId)
}

export async function startSapAnalysis(dispatch, request, label) {
  dispatchRef = dispatch
  const job = await startSapAnalysisJob(request)
  writeSaved({ jobId: job.jobId, label })
  emit(job)
  poll(job.jobId)
  return job
}

export async function stopSapAnalysis(jobId) {
  emit(await stopSapAnalysisJob(jobId))
}
