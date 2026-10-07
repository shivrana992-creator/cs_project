import { useEffect, useState } from 'react'
import api from '../api/client'
import './logs.css'

const categories = [
  ['login', 'Sign-ins'],
  ['registration', 'Registrations'],
  ['attendance', 'Attendance'],
  ['certificate', 'Certificates'],
  ['activity', 'Activity'],
  ['audit', 'Audit'],
]

const pageSize = 25

export default function LogsPage() {
  const [category, setCategory] = useState('audit')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState({ logs: [], total: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    api.get(`/admin/logs/${category}`, { params: { page, limit: pageSize }, signal: controller.signal })
      .then(({ data }) => setResult(data))
      .catch(err => { if (!controller.signal.aborted) setError(err.response?.data?.error || 'Could not load logs.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [category, page])

  const changeCategory = event => { setCategory(event.target.value); setPage(1); setLoading(true); setError(''); setResult({ logs: [], total: 0 }) }
  const changePage = nextPage => { setPage(nextPage); setLoading(true); setError(''); setResult({ logs: [], total: 0 }) }
  return <main className="app-main">
    <header className="page-heading"><p className="eyebrow">System administration</p><h1>System logs</h1><p>Review recorded access and event activity.</p></header>
    <section className="card logs-panel">
      <label>Log type<select className="form-input" value={category} onChange={changeCategory}>{categories.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      {loading ? <p role="status">Loading logs…</p> : result.logs.length ? <div className="table-container">
        <table><thead><tr><th>Time</th><th>Action</th><th>Account</th><th>Record</th></tr></thead><tbody>
          {result.logs.map(row => <tr key={`${category}-${row.id}`}>
            <td>{row.created_at || '—'}</td><td>{row.action}</td>
            <td>{row.email || row.actor_email || row.actor_id || row.user_id || '—'}</td>
            <td><details><summary>View details</summary><pre>{JSON.stringify(row, null, 2)}</pre></details></td>
          </tr>)}
        </tbody></table>
      </div> : !error && <p>No records in this log.</p>}
      {!loading && !error && result.total > pageSize && <div className="logs-pagination">
        <button className="btn btn-ghost btn-sm" disabled={page === 1} onClick={() => changePage(page - 1)}>Previous</button>
        <span>Page {page} of {Math.ceil(result.total / pageSize)}</span>
        <button className="btn btn-ghost btn-sm" disabled={page * pageSize >= result.total} onClick={() => changePage(page + 1)}>Next</button>
      </div>}
    </section>
  </main>
}
