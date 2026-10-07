import { useState } from 'react'
import { UserRound } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../api/client'
import MfaSetup from '../components/MfaSetup'
import './account.css'

export default function AccountPage({ user, refreshUser }) {
  const [passwords, setPasswords] = useState({ current_password: '', new_password: '' })
  const [disablePassword, setDisablePassword] = useState('')
  const changePassword = async event => {
    event.preventDefault()
    try {
      await api.post('/auth/change-password', passwords)
      setPasswords({ current_password: '', new_password: '' })
      toast.success('Password changed.')
    } catch (error) { toast.error(error.response?.data?.error || 'Password change failed.') }
  }
  const disableMfa = async event => {
    event.preventDefault()
    try {
      await api.post('/auth/mfa/disable', { password: disablePassword })
      setDisablePassword('')
      await refreshUser()
      toast.success('MFA disabled.')
    } catch (error) { toast.error(error.response?.data?.error || 'Could not disable MFA.') }
  }
  return <main className="app-main">
    <header className="page-heading"><p className="eyebrow">SymposiHub</p><h1>Account</h1><p>Manage your access and security.</p></header>
    <div className="account-grid">
      <section className="card account"><UserRound size={40}/><h2>{user.name}</h2><p>{user.email}</p><p>{user.role}</p><p>{user.mfa_enabled ? 'Multi-factor authentication is enabled.' : 'Multi-factor authentication is not enabled.'}</p></section>
      <form className="card event-form" onSubmit={changePassword}>
        <h2>Change password</h2>
        <label>Current password<input className="form-input" type="password" autoComplete="current-password" required value={passwords.current_password} onChange={event => setPasswords({ ...passwords, current_password: event.target.value })}/></label>
        <label>New password<input className="form-input" type="password" autoComplete="new-password" minLength="8" required value={passwords.new_password} onChange={event => setPasswords({ ...passwords, new_password: event.target.value })}/></label>
        <small>Use 8+ characters with an uppercase letter, number, and special character.</small>
        <button className="btn btn-primary">Change password</button>
      </form>
      {user.mfa_enabled ? <form className="card event-form" onSubmit={disableMfa}>
        <h2>Disable MFA</h2><p>Enter your password to turn off authenticator verification.</p>
        <input className="form-input" type="password" autoComplete="current-password" required value={disablePassword} onChange={event => setDisablePassword(event.target.value)}/>
        <button className="btn btn-danger">Disable MFA</button>
      </form> : <MfaSetup onEnabled={refreshUser}/>}
    </div>
  </main>
}
