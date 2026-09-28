import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import client from '../api/client'
import { useNavigate } from 'react-router-dom'

const AuthContext = createContext(null)
const DEMO_ACCOUNTS = {
  admin: ['admin@symposium.edu', 'Admin@123'], organizer: ['organizer@symposium.edu', 'Organizer@123'],
  coordinator: ['coordinator@symposium.edu', 'Coordinator@123'], participant: ['student@symposium.edu', 'Student@123'],
}
export function AuthProvider({ children }) {
  const navigate = useNavigate()
  // Keep logout stable so navigating does not repeat the session lookup.
  const navigateRef = useRef(navigate)
  useEffect(() => { navigateRef.current = navigate }, [navigate])
  const [user, setUser] = useState(null), [loading, setLoading] = useState(true), [mfaChallenge, setMfaChallenge] = useState(null), [idleWarning, setIdleWarning] = useState(false)
  const lastActivity = useRef(Date.now())
  const logout = useCallback(async () => { try { await client.post('/auth/logout') } catch {} setUser(null); setMfaChallenge(null); setIdleWarning(false); navigateRef.current('/', { replace: true }) }, [])
  const login = useCallback(async credentials => { const { data } = await client.post('/auth/login', credentials); if (data.mfa_required) { setMfaChallenge(data); return { mfaRequired: true, data } } setUser(data.user); return { data } }, [])
  const verifyMfa = useCallback(async code => { const { data } = await client.post('/auth/mfa/verify-login', { code, mfa_token: mfaChallenge.mfa_token }); setUser(data.user); setMfaChallenge(null); return data }, [mfaChallenge])
  const demoLogin = role => login({ email: DEMO_ACCOUNTS[role][0], password: DEMO_ACCOUNTS[role][1] })
  useEffect(() => { client.get('/auth/me').then(({data})=>setUser(data.user)).catch(()=>{}).finally(()=>setLoading(false)); const expired=()=>logout(); window.addEventListener('symposihub:session-expired', expired); return()=>window.removeEventListener('symposihub:session-expired', expired) }, [logout])
  useEffect(() => { if (!user) return; const touch=()=>{lastActivity.current=Date.now();setIdleWarning(false)}; ['click','keydown','mousemove','scroll','touchstart'].forEach(x=>window.addEventListener(x,touch)); const timer=setInterval(()=>{const idle=Date.now()-lastActivity.current; if(idle>=30*60*1000) logout(); else if(idle>=28*60*1000) setIdleWarning(true)},15000); return()=>{clearInterval(timer);['click','keydown','mousemove','scroll','touchstart'].forEach(x=>window.removeEventListener(x,touch))} },[user,logout])
  return <AuthContext.Provider value={useMemo(()=>({user,loading,login,logout,verifyMfa,mfaChallenge,demoLogin,idleWarning}),[user,loading,login,logout,verifyMfa,mfaChallenge,idleWarning])}>{children}</AuthContext.Provider>
}
export const useAuth=()=>useContext(AuthContext)
