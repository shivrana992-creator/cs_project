import { useEffect, useState } from 'react'
import api from '../api/client'

export default function AccountTokenPage({ action, token }) {
  const [state, setState] = useState({ loading: action === 'verify-email', message: '', error: '' })
  const [password, setPassword] = useState('')
  useEffect(() => {
    if (action !== 'verify-email') return
    let active = true
    api.post('/auth/verify-email', { token }).then(() => {
      if (active) setState({ loading: false, message: 'Email verified. You can now sign in.', error: '' })
    }).catch(error => {
      if (active) setState({ loading: false, message: '', error: error.response?.data?.error || 'Verification failed.' })
    })
    return () => { active = false }
  }, [action, token])
  const reset = async event => {
    event.preventDefault()
    setState({ loading: true, message: '', error: '' })
    try {
      await api.post('/auth/reset-password', { token, password })
      setPassword('')
      setState({ loading: false, message: 'Password reset. You can now sign in.', error: '' })
    } catch (error) { setState({ loading: false, message: '', error: error.response?.data?.error || 'Password reset failed.' }) }
  }
  return <main className="app-main">
    <header className="page-heading"><p className="eyebrow">Account security</p><h1>{action === 'verify-email' ? 'Verify email' : 'Reset password'}</h1></header>
    {state.loading && <p>Processing…</p>}
    {state.message && <p role="status">{state.message}</p>}
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    {action === 'reset-password' && !state.message && <form className="card event-form" onSubmit={reset}>
      <label>New password<input className="form-input" type="password" minLength="8" autoComplete="new-password" required value={password} onChange={event => setPassword(event.target.value)}/></label>
      <small>Use 8+ characters with an uppercase letter, number, and special character.</small>
      <button className="btn btn-primary" disabled={state.loading}>Reset password</button>
    </form>}
  </main>
}
