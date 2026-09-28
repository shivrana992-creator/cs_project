import { useEffect } from 'react'
import { useAuth } from '../context/AuthContext'

export default function InactivityTimeout() {
  const { user, idleWarning, logout } = useAuth()
  useEffect(() => { if (!idleWarning) return; const id = setTimeout(() => logout(), 2 * 60 * 1000); return () => clearTimeout(id) }, [idleWarning, logout])
  if (!user || !idleWarning) return null
  return <div className="idle-warning">Your session will end soon because of inactivity. Move the mouse or press a key to continue.</div>
}
