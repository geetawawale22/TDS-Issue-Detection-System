import { useCallback, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  Upload, FileSpreadsheet, Download, X, Loader2,
  CheckCircle2, AlertCircle, FileUp, ChevronDown, ChevronUp,
} from 'lucide-react'
import toast from 'react-hot-toast'
import issuesService from '@/services/issuesService'
import {
  uploadStarted, uploadProgress, uploadSucceeded, uploadFailed, clearUpload,
} from '@/redux/slices/issuesSlice'
import { setDataSourceLabel, setLastSyncTime, setSyncStatus } from '@/redux/slices/appSlice'
import { seedPansFromIssues } from '@/redux/slices/panSlice'
import './SapUploadPanel.css'

const COMPANY_CODES = [
  { value: '', label: 'All company codes' },
  { value: '1001', label: '1001' },
  { value: '1079', label: '1079' },
  { value: '1081', label: '1081' },
]

const ACCEPTED = '.csv,.xlsx,.xls,.xlsm'

function formatBytes(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export default function SapUploadPanel() {
  const dispatch = useDispatch()
  const inputRef = useRef(null)
  const {
    dataSource, uploadStatus, uploadProgress: progress,
    uploadError, uploadMeta,
  } = useSelector((s) => s.issues)

  const [companyCode, setCompanyCode] = useState('')
  const [includeInfo, setIncludeInfo] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [selectedFile, setSelectedFile] = useState(null)
  // Collapsed by default so the issues table is visible without scrolling past
  // the upload form on every visit — only auto-open when there's something
  // upload-related the user actually needs to see.
  const [open, setOpen] = useState(() => dataSource === 'upload' || uploadStatus !== 'idle')

  const busy = uploadStatus === 'uploading' || uploadStatus === 'processing'

  const pickFile = useCallback((file) => {
    if (!file) return
    const name = file.name.toLowerCase()
    if (!(/\.(csv|xlsx|xls|xlsm)$/.test(name))) {
      toast.error('Please upload a CSV or Excel (.xlsx) file')
      return
    }
    setSelectedFile(file)
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    pickFile(file)
  }, [pickFile])

  async function handleDownloadTemplate(e) {
    e?.preventDefault?.()
    e?.stopPropagation?.()
    try {
      await issuesService.downloadTemplate()
      toast.success('Template downloaded')
    } catch (err) {
      toast.error(err.message || 'Could not download template')
    }
  }

  async function handleRun() {
    if (!selectedFile) {
      toast.error('Choose a SAP CSV or Excel file first')
      return
    }
    dispatch(uploadStarted())
    try {
      const result = await issuesService.uploadSapFile(selectedFile, {
        companyCode,
        includeInformational: includeInfo,
        onProgress: (pct) => dispatch(uploadProgress(pct)),
      })
      dispatch(uploadSucceeded(result))
      dispatch(seedPansFromIssues(result.issues || []))
      dispatch(setSyncStatus('synced'))
      dispatch(setLastSyncTime('Just now'))
      dispatch(setDataSourceLabel(
        result.fileName
          ? `SAP upload — ${result.fileName}`
          : 'SAP upload — live extract',
      ))
      const stats = result.stats || {}
      toast.success(
        `Processed ${stats.transactionsBuilt?.toLocaleString?.() ?? stats.transactionsBuilt} transactions · ${stats.issuesFound?.toLocaleString?.() ?? stats.issuesFound} issues found`,
        { duration: 5000 },
      )
    } catch (err) {
      dispatch(uploadFailed(err.message || 'Upload failed'))
      toast.error(err.message || 'Upload failed')
    }
  }

  function handleClear() {
    dispatch(clearUpload())
    dispatch(setDataSourceLabel('GCP BigQuery — finance-prod'))
    dispatch(setLastSyncTime('8 minutes ago'))
    setSelectedFile(null)
    if (inputRef.current) inputRef.current.value = ''
    toast('Showing sample demo data')
  }

  const stats = uploadMeta?.stats
  const showSampleHint = dataSource === 'sample' && uploadStatus === 'idle' && !uploadError

  return (
    <section className="sap-upload">
      <header className={`sap-upload-header ${open ? '' : 'sap-upload-header--collapsed'}`}>
        <div className="sap-upload-heading">
          <h2 className="sap-upload-title">SAP data analysis</h2>
          <p className="sap-upload-sub">
            {open
              ? 'Upload a CSV or Excel extract. TDS rules run on every transaction; exceptions appear in the table below.'
              : 'Upload a SAP extract to run TDS rules on it, or keep browsing the sample data below.'}
          </p>
        </div>
        <div className="sap-upload-header-actions">
          {open && (
            <button type="button" className="btn btn-outline btn-sm" onClick={handleDownloadTemplate}>
              <Download size={13} />
              Download template
            </button>
          )}
          <button
            type="button"
            className="sap-upload-toggle"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? 'Collapse' : 'Upload file'}
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </header>

      {open && (
      <>
      <div className="sap-upload-body">
        <div
          className={`sap-dropzone ${dragOver ? 'is-dragover' : ''} ${selectedFile ? 'has-file' : ''} ${busy ? 'is-busy' : ''}`}
          onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={busy ? undefined : handleDrop}
          onClick={() => !busy && !selectedFile && inputRef.current?.click()}
          role="button"
          tabIndex={busy ? -1 : 0}
          onKeyDown={(e) => {
            if (busy || selectedFile) return
            if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
            hidden
            disabled={busy}
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
          {selectedFile ? (
            <div className="sap-file-chip">
              <span className="sap-file-icon"><FileSpreadsheet size={18} /></span>
              <div className="sap-file-meta">
                <div className="sap-file-name" title={selectedFile.name}>{selectedFile.name}</div>
                <div className="sap-file-size">{formatBytes(selectedFile.size)} · ready to analyse</div>
              </div>
              {!busy && (
                <button
                  type="button"
                  className="sap-file-clear"
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedFile(null)
                    if (inputRef.current) inputRef.current.value = ''
                  }}
                  aria-label="Remove file"
                >
                  <X size={14} />
                </button>
              )}
              {!busy && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    inputRef.current?.click()
                  }}
                >
                  Change
                </button>
              )}
            </div>
          ) : (
            <div className="sap-dropzone-empty">
              <span className="sap-dropzone-icon"><FileUp size={18} /></span>
              <div className="sap-dropzone-copy">
                <strong>Drop file here, or browse</strong>
                <span>CSV or Excel · up to 25 MB</span>
              </div>
            </div>
          )}
        </div>

        <div className="sap-upload-sidebar">
          <label className="sap-field">
            <span className="sap-field-label">Company code</span>
            <select
              className="filter-select"
              value={companyCode}
              disabled={busy}
              onChange={(e) => setCompanyCode(e.target.value)}
            >
              {COMPANY_CODES.map((c) => (
                <option key={c.value || 'all'} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>

          <label className="sap-check">
            <input
              type="checkbox"
              checked={includeInfo}
              disabled={busy}
              onChange={(e) => setIncludeInfo(e.target.checked)}
            />
            <span>Include informational (low-severity) items</span>
          </label>

          <div className="sap-upload-actions">
            {dataSource === 'upload' && (
              <button type="button" className="btn btn-outline" disabled={busy} onClick={handleClear}>
                Sample data
              </button>
            )}
            <button
              type="button"
              className={`btn ${selectedFile && !busy ? 'btn-primary' : 'btn-outline'}`}
              disabled={busy || !selectedFile}
              onClick={handleRun}
            >
              {busy ? (
                <>
                  <Loader2 size={14} className="spin" />
                  {uploadStatus === 'processing' ? 'Analysing…' : `Uploading ${progress}%`}
                </>
              ) : (
                <>
                  <Upload size={14} />
                  Analyse file
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {busy && (
        <div className="sap-progress">
          <div
            className="sap-progress-track"
            role="progressbar"
            aria-valuenow={uploadStatus === 'processing' ? 92 : progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="sap-progress-bar"
              style={{ width: `${Math.max(progress, uploadStatus === 'processing' ? 92 : 8)}%` }}
            />
          </div>
          <p className="sap-progress-label">
            {uploadStatus === 'processing'
              ? 'Evaluating TDS rules across transactions…'
              : `Uploading file… ${progress}%`}
          </p>
        </div>
      )}

      {uploadStatus === 'error' && uploadError && (
        <div className="sap-banner sap-banner--error" role="alert">
          <AlertCircle size={15} />
          <div className="sap-banner-body">
            <p>{uploadError}</p>
            {/template|column/i.test(uploadError) && (
              <button type="button" className="sap-banner-link" onClick={handleDownloadTemplate}>
                Download the expected column template
              </button>
            )}
          </div>
        </div>
      )}

      {dataSource === 'upload' && stats && (
        <div className="sap-results">
          <div className="sap-results-label">
            <CheckCircle2 size={14} />
            <span>
              Results from <strong>{uploadMeta.fileName}</strong>
              {uploadMeta.companyCode ? ` · Company ${uploadMeta.companyCode}` : ''}
            </span>
          </div>
          <div className="sap-stats-grid">
            <div className="sap-stat">
              <div className="sap-stat-value">{stats.rowsRead?.toLocaleString()}</div>
              <div className="sap-stat-label">Rows read</div>
            </div>
            <div className="sap-stat">
              <div className="sap-stat-value">{stats.transactionsBuilt?.toLocaleString()}</div>
              <div className="sap-stat-label">Transactions</div>
            </div>
            <div className="sap-stat">
              <div className="sap-stat-value">{stats.issuesFound?.toLocaleString()}</div>
              <div className="sap-stat-label">Issues found</div>
            </div>
            <div className="sap-stat">
              <div className="sap-stat-value">{stats.high?.toLocaleString()}</div>
              <div className="sap-stat-label">High</div>
            </div>
            <div className="sap-stat">
              <div className="sap-stat-value">{stats.medium?.toLocaleString()}</div>
              <div className="sap-stat-label">Medium</div>
            </div>
            <div className="sap-stat">
              <div className="sap-stat-value">{stats.rowsSkipped?.toLocaleString()}</div>
              <div className="sap-stat-label">Skipped</div>
            </div>
          </div>
          {!!uploadMeta.errors?.length && (
            <div className="sap-banner sap-banner--warn">
              <AlertCircle size={14} />
              <span>{uploadMeta.errors.length} row warning(s) — some lines may need column cleanup.</span>
            </div>
          )}
        </div>
      )}

      {showSampleHint && (
        <p className="sap-hint">
          Showing sample demo data. Upload a SAP extract to replace it with live rule results.
        </p>
      )}
      </>
      )}
    </section>
  )
}
