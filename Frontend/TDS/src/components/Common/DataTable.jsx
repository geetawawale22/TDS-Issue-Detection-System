import { Fragment, useState, useMemo, useEffect } from 'react'
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import './Common.css'

export default function DataTable({
  columns,
  data,
  onRowClick,
  pageSize = 10,
  emptyState = null,
  expandedRowKey,
  renderExpandedRow,
  renderPreHeaderCell,
  // Opt-in, not automatic: several tables on a page can each use DataTable
  // (e.g. Issues' own validation-status tabs), and one floating corner
  // button per paginated table would be visual noise / could stack on top
  // of each other. Pass this only on the one table a page treats as its
  // primary list.
  showFloatingPager = false,
}) {
  const [page, setPage] = useState(1)
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState('asc')

  const sorted = useMemo(() => {
    if (!sortKey) return data
    return [...data].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av === bv) return 0
      const cmp = av > bv ? 1 : -1
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [data, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const currentPage = Math.min(page, totalPages)

  // Reset to page 1 when the dataset / filters change
  useEffect(() => {
    setPage(1)
  }, [data])

  const pageData = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  function handleSort(key) {
    if (!key) return
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function getPages() {
    const pages = []
    const delta = 1
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= currentPage - delta && i <= currentPage + delta)) {
        pages.push(i)
      } else if (pages[pages.length - 1] !== '...') {
        pages.push('...')
      }
    }
    return pages
  }

  // Page-number buttons only, reused by both the floating corner widget and
  // the full bottom bar.
  function renderPageButtons() {
    return (
      <>
        <button
          className="table-page-btn"
          disabled={currentPage === 1}
          onClick={() => setPage(currentPage - 1)}
        >
          <ChevronLeft size={13} />
        </button>
        {getPages().map((p, i) => (
          p === '...'
            ? <span key={`ellipsis-${i}`} className="table-page-btn" style={{ border: 'none', cursor: 'default' }}>…</span>
            : <button
                key={`page-${p}`}
                className={`table-page-btn ${currentPage === p ? 'active' : ''}`}
                onClick={() => setPage(p)}
              >{p}</button>
        ))}
        <button
          className="table-page-btn"
          disabled={currentPage === totalPages}
          onClick={() => setPage(currentPage + 1)}
        >
          <ChevronRight size={13} />
        </button>
      </>
    )
  }

  return (
    <div className="data-table-flex">
      <div className="data-table-wrapper">
        <table className="data-table">
          <thead>
            {renderPreHeaderCell && (
              <tr className="data-table-preheader-row">
                {columns.map((col) => (
                  <th key={`preheader-${col.key || col.header}`}>
                    {renderPreHeaderCell(col)}
                  </th>
                ))}
              </tr>
            )}
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key || col.header}
                  onClick={() => col.key && handleSort(col.key)}
                  style={{ cursor: col.key ? 'pointer' : 'default' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {col.header}
                    {col.key && sortKey === col.key && (
                      sortDir === 'asc'
                        ? <ChevronUp size={11} />
                        : <ChevronDown size={11} />
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageData.length === 0 ? (
              <tr>
                <td colSpan={columns.length} style={{ padding: 0 }}>
                  {emptyState ?? <div className="data-table-empty">No data found</div>}
                </td>
              </tr>
            ) : (
              pageData.map((row, i) => {
                const rowKey = row.id ?? i
                const isExpanded = renderExpandedRow && expandedRowKey === rowKey
                return (
                  <Fragment key={rowKey}>
                    <tr
                      onClick={() => onRowClick && onRowClick(row)}
                      style={{ cursor: onRowClick ? 'pointer' : 'default' }}
                    >
                      {columns.map((col) => (
                        <td key={col.key || col.header}>
                          {col.render ? col.render(row, (currentPage - 1) * pageSize + i) : row[col.key]}
                        </td>
                      ))}
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={columns.length} style={{ padding: 0 }}>
                          {renderExpandedRow(row)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Fixed to the bottom-right of the screen (not scroll-position
          dependent) for as long as this table — often 50+ rows tall — is on
          the page, so switching pages never requires scrolling down to
          reach the "real" pagination bar first. Opt-in via
          showFloatingPager (see prop docs above) so it only appears on a
          page's one primary table, not every paginated table at once. */}
      {showFloatingPager && totalPages > 1 && (
        <div className="table-pagination-float">
          <div className="table-pagination-float-inner">
            {renderPageButtons()}
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="table-pagination">
          <span className="table-pagination-info">
            {sorted.length === 0 ? 'No results' : `Showing ${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, sorted.length)} of ${sorted.length}`}
          </span>
          <div className="table-pagination-controls">{renderPageButtons()}</div>
        </div>
      )}
    </div>
  )
}
