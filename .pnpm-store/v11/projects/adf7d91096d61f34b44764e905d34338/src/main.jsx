import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { legacyVerificationUrl } from './navigation'

const legacyUrl = legacyVerificationUrl(window.location.href)
if (legacyUrl) window.history.replaceState(window.history.state, '', legacyUrl)

createRoot(document.getElementById('root')).render(
  <StrictMode><HashRouter><AuthProvider><App /></AuthProvider></HashRouter></StrictMode>,
)
