import { useState } from 'react'
import { useAuth } from '../context/auth-context'

export default function MfaModal({ close, onSuccess }) {
  const { verifyMfa } = useAuth(); const [code,setCode]=useState(''); const [error,setError]=useState('')
  const submit=async e=>{e.preventDefault();try{await verifyMfa(code);onSuccess()}catch(err){setError(err.response?.data?.error||'Invalid verification code.')}}
  return <div className="modal-overlay"><form className="modal auth" onSubmit={submit}><button type="button" className="close" onClick={close}>×</button><p className="eyebrow">Extra security check</p><h2>Verify your sign in</h2><p>Enter the 6-digit code from your authenticator app or a backup code.</p><input className="form-input" autoFocus maxLength="16" autoComplete="one-time-code" required placeholder="Authenticator or backup code" value={code} onChange={e=>setCode(e.target.value)}/>{error&&<p className="form-error">{error}</p>}<button className="btn btn-primary">Verify and continue</button></form></div>
}
