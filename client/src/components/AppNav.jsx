import { useState } from 'react'
import { LogIn, LogOut, Menu, UserRound, X } from 'lucide-react'
import './navigation.css'

export default function AppNav({ user, config, unread, setPage, logout, signIn }) {
  const [open, setOpen] = useState(false)
  const go = page => { setPage(page); setOpen(false) }
  const name = config.site_name || 'SymposiHub'
  return <header className="topbar">
    <button className="brand" onClick={() => go('browse')}><span>SH</span><div>{name}<small>Registration and certificates</small></div></button>
    <button className="menu-toggle" type="button" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? <X size={22}/> : <Menu size={22}/>}</button>
    <nav className={open ? 'nav-open' : ''} aria-label="Main navigation">
      <button onClick={() => go('browse')}>Explore</button>
      <button onClick={() => go('verify')}>Verify</button>
      <button onClick={() => go('docs')}>Documentation</button>
      {user ? <>
        <button onClick={() => go('dashboard')}>Dashboard</button>
        {user.role === 'participant' && <><button onClick={() => go('registrations')}>My registrations</button><button onClick={() => go('certificates')}>My certificates</button></>}
        {user.role !== 'participant' && <button onClick={() => go('manage')}>{user.role === 'coordinator' ? 'Review' : 'Manage'}</button>}
        {user.role === 'admin' && <button onClick={() => go('admin')}>Administration</button>}
        {user.role === 'admin' && <button onClick={() => go('logs')}>Logs</button>}
        <button onClick={() => go('notifications')}>Notifications {unread > 0 && `(${unread})`}</button>
        <button className="profile" onClick={() => go('account')}><UserRound size={17}/>{user.name}</button>
        <button className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); logout() }}><LogOut size={15}/> Sign out</button>
      </> : <button className="btn btn-primary" onClick={() => { setOpen(false); signIn() }}><LogIn size={16}/> Sign in</button>}
    </nav>
  </header>
}
