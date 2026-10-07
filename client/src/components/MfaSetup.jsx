import { useState } from 'react'
import client from '../api/client'

export default function MfaSetup({ onEnabled }) {
  const [setup, setSetup] = useState(null)
  const [code, setCode] = useState('')
  const [backup, setBackup] = useState([])
  const [error, setError] = useState('')
  const start = async () => {
    try { setError(''); setSetup((await client.post('/auth/mfa/setup')).data) }
    catch (err) { setError(err.response?.data?.error || 'Could not start MFA setup.') }
  }
  const verify = async event => {
    event.preventDefault()
    try {
      setError('')
      setBackup((await client.post('/auth/mfa/verify-setup', { code })).data.backup_codes)
    } catch (err) { setError(err.response?.data?.error || 'Invalid code.') }
  }
  return <section className="card event-form">
    <h2>Multi-factor authentication</h2>
    {!setup ? <button type="button" className="btn btn-ghost" onClick={start}>Set up authenticator app</button>
      : !backup.length ? <form className="event-form" onSubmit={verify}>
        <img src={setup.qr_code} alt="Scan with an authenticator app" className="mfa-qr"/>
        <label>Authenticator code<input className="form-input" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={event => setCode(event.target.value)}/></label>
        <button className="btn btn-primary">Enable MFA</button>
      </form> : <><p>Save these one-time backup codes somewhere safe. They will not be shown again.</p><code className="backup-codes">{backup.join('  ')}</code><button type="button" className="btn btn-primary" onClick={onEnabled}>I've saved the codes</button></>}
    {error && <p className="form-error">{error}</p>}
  </section>
}
