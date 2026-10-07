import { useState } from 'react'

export default function AuthDialog({ mode, setAuthMode, login, signup, forgotPassword, resendVerification, close, config }) {
  const [input, setInput] = useState({ name: '', email: '', password: '' })
  const submit = event => {
    event.preventDefault()
    if (mode === 'login') login(input)
    else signup(input)
  }
  return <div className="modal-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <form className="modal auth" onSubmit={submit} aria-label={mode === 'login' ? 'Sign in' : 'Create account'}>
      <button type="button" className="close" aria-label="Close" onClick={close}>×</button>
      <p className="eyebrow">{config.site_name || 'SymposiHub'}</p>
      <h2>{mode === 'login' ? 'Welcome back' : 'Create an account'}</h2>
      <p>{mode === 'login' ? 'Sign in to manage your symposium journey.' : 'New accounts are created as participant accounts.'}</p>
      {mode === 'register' && <label>Full name<input className="form-input" required autoComplete="name" value={input.name} onChange={event => setInput({ ...input, name: event.target.value })}/></label>}
      <label>Email address<input className="form-input" required type="email" autoComplete="email" value={input.email} onChange={event => setInput({ ...input, email: event.target.value })}/></label>
      <label>Password<input className="form-input" required type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={input.password} onChange={event => setInput({ ...input, password: event.target.value })}/></label>
      {mode === 'register' && <small>Password: 8+ characters with uppercase, number, and special character.</small>}
      <button className="btn btn-primary">{mode === 'login' ? 'Sign in' : 'Create account'}</button>
      {mode === 'login' && <button type="button" className="link-btn" onClick={forgotPassword}>Forgot password?</button>}
      {mode === 'login' && <button type="button" className="link-btn" onClick={resendVerification}>Resend verification email</button>}
      {config.allow_self_registration && <button type="button" className="link-btn" onClick={() => setAuthMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Need an account? Register' : 'Already registered? Sign in'}</button>}
      {mode === 'login' && <small className="demo">Demo: student@symposium.edu / Student@123</small>}
      {config.contact_email && <small>Need help? {config.contact_email}</small>}
    </form>
  </div>
}
