import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import client from '../api/client'
import { AuthContext } from './auth-context'

const defaultConfig = { allow_self_registration: true, session_timeout_minutes: 30, site_name: 'SymposiHub', contact_email: '', payment_mode: 'demo' }
const userFields = ['id', 'name', 'email', 'role', 'mfa_enabled', 'is_active', 'created_at']

export function AuthProvider({ children }) {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => { navigateRef.current = navigate }, [navigate])
  const [user, setUser] = useState(null)
  const [config, setConfig] = useState(defaultConfig)
  const [loading, setLoading] = useState(true)
  const [mfaChallenge, setMfaChallenge] = useState(null)
  const mfaChallengeRef = useRef(null)
  const [idleWarning, setIdleWarning] = useState(false)
  const userRef = useRef(null)
  const lastActivity = useRef(0)
  const lastActivityBroadcast = useRef(0)
  const authRevision = useRef(0)
  const channelRef = useRef(null)
  const lastFocusSync = useRef(0)

  const updateMfaChallenge = useCallback(challenge => {
    mfaChallengeRef.current = challenge
    setMfaChallenge(challenge)
  }, [])

  const acceptUser = useCallback(nextUser => {
    const previousUser = userRef.current
    userRef.current = nextUser
    lastActivity.current = Date.now()
    if (!previousUser || userFields.some(field => previousUser[field] !== nextUser[field])) setUser(nextUser)
    if (mfaChallengeRef.current && previousUser?.id !== nextUser.id) updateMfaChallenge(null)
    setIdleWarning(false)
  }, [updateMfaChallenge])

  const clearLocalSession = useCallback(() => {
    authRevision.current += 1
    const wasSignedIn = !!userRef.current
    userRef.current = null
    if (wasSignedIn) setUser(null)
    updateMfaChallenge(null)
    setIdleWarning(false)
    if (wasSignedIn) navigateRef.current('/', { replace: true })
  }, [updateMfaChallenge])

  const notifyOtherTabs = useCallback(() => channelRef.current?.postMessage({ type: 'session-changed' }), [])

  const syncUser = useCallback(async () => {
    const revision = ++authRevision.current
    try {
      const { data } = await client.get('/auth/me')
      if (revision === authRevision.current) acceptUser(data.user)
      return data.user
    } catch (error) {
      if (revision === authRevision.current && [401, 403].includes(error.response?.status)) clearLocalSession()
      return null
    }
  }, [acceptUser, clearLocalSession])

  const logout = useCallback(async () => {
    try {
      await client.post('/auth/logout', { expected_user_id: userRef.current?.id })
    } catch (error) {
      if (error.response?.status === 409) { await syncUser(); return false }
      if (![401, 403].includes(error.response?.status)) return false
      // An expired or disabled session no longer has server access.
    }
    clearLocalSession()
    notifyOtherTabs()
    return true
  }, [clearLocalSession, notifyOtherTabs, syncUser])

  const login = useCallback(async credentials => {
    const { data } = await client.post('/auth/login', credentials)
    if (data.mfa_required) { updateMfaChallenge(data); return { mfaRequired: true, data } }
    authRevision.current += 1
    updateMfaChallenge(null)
    acceptUser(data.user)
    notifyOtherTabs()
    return { data }
  }, [acceptUser, notifyOtherTabs, updateMfaChallenge])

  const verifyMfa = useCallback(async code => {
    const { data } = await client.post('/auth/mfa/verify-login', { code, mfa_token: mfaChallenge.mfa_token })
    authRevision.current += 1
    updateMfaChallenge(null)
    acceptUser(data.user)
    notifyOtherTabs()
    return data
  }, [mfaChallenge, acceptUser, notifyOtherTabs, updateMfaChallenge])

  const cancelMfa = useCallback(() => updateMfaChallenge(null), [updateMfaChallenge])

  const refreshUser = useCallback(async () => {
    const revision = ++authRevision.current
    const { data } = await client.get('/auth/me')
    if (revision === authRevision.current) acceptUser(data.user)
    return data.user
  }, [acceptUser])

  const refreshConfig = useCallback(async () => {
    const { data } = await client.get('/auth/config')
    setConfig(data.config)
    return data.config
  }, [])

  useEffect(() => {
    let active = true
    const revision = authRevision.current
    Promise.allSettled([client.get('/auth/me'), client.get('/auth/config')]).then(([userResult, configResult]) => {
      if (!active) return
      if (userResult.status === 'fulfilled' && revision === authRevision.current) acceptUser(userResult.value.data.user)
      if (configResult.status === 'fulfilled') setConfig(configResult.value.data.config)
      setLoading(false)
    })
    return () => { active = false }
  }, [acceptUser])

  useEffect(() => {
    let channel
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('symposihub-auth')
      channelRef.current = channel
      channel.onmessage = event => {
        if (event.data?.type === 'session-changed') void syncUser()
        if (event.data?.type === 'activity' && userRef.current) {
          lastActivity.current = Math.max(lastActivity.current, event.data.at)
          setIdleWarning(false)
        }
      }
    }
    const onFocus = () => {
      if (mfaChallengeRef.current || Date.now() - lastFocusSync.current < 2000) return
      lastFocusSync.current = Date.now()
      void syncUser()
    }
    const onVisible = () => { if (!document.hidden) onFocus() }
    const onExpired = () => { void syncUser() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('symposihub:session-expired', onExpired)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('symposihub:session-expired', onExpired)
      channel?.close()
      channelRef.current = null
    }
  }, [syncUser])

  useEffect(() => {
    if (!user) return
    const touch = () => {
      const now = Date.now()
      lastActivity.current = now
      setIdleWarning(false)
      if (now - lastActivityBroadcast.current >= 15000) {
        lastActivityBroadcast.current = now
        channelRef.current?.postMessage({ type: 'activity', at: now })
      }
    }
    const events = ['click', 'keydown', 'mousemove', 'scroll', 'touchstart']
    events.forEach(event => window.addEventListener(event, touch))
    const timeout = Number(config.session_timeout_minutes) * 60 * 1000
    const timer = setInterval(() => {
      const idle = Date.now() - lastActivity.current
      if (idle >= timeout) void logout()
      else if (idle >= Math.max(0, timeout - 2 * 60 * 1000)) setIdleWarning(true)
    }, 15000)
    return () => { clearInterval(timer); events.forEach(event => window.removeEventListener(event, touch)) }
  }, [user, config.session_timeout_minutes, logout])

  return <AuthContext.Provider value={{ user, config, loading, login, logout, verifyMfa, cancelMfa, refreshUser, refreshConfig, mfaChallenge, idleWarning }}>
    {children}
  </AuthContext.Provider>
}
