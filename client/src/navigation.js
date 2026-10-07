const publicPages = new Set(['browse', 'verify', 'verify-email', 'reset-password', 'docs'])
const pageRoles = {
  dashboard: ['participant', 'organizer', 'coordinator', 'admin'],
  notifications: ['participant', 'organizer', 'coordinator', 'admin'],
  account: ['participant', 'organizer', 'coordinator', 'admin'],
  registrations: ['participant'],
  certificates: ['participant'],
  manage: ['organizer', 'coordinator', 'admin'],
  attendance: ['organizer', 'admin'],
  admin: ['admin'],
  logs: ['admin'],
}

export function resolvePage(pathname, user) {
  const [name, id, ...extra] = pathname.split('/').filter(Boolean)
  const page = name || 'browse'
  const symposiumId = page === 'attendance' && /^[1-9]\d*$/.test(id || '') ? id : null
  const accountTokenPage = ['verify-email', 'reset-password'].includes(page)
  const validPath = extra.length === 0 && (page === 'attendance' ? !!symposiumId : accountTokenPage ? !!id : page === 'verify' || !id)
  const allowed = validPath && (publicPages.has(page) || pageRoles[page]?.includes(user?.role))
  return { page, symposiumId, allowed: !!allowed, certificateId: page === 'verify' ? id || null : null, accountToken: accountTokenPage ? id || null : null }
}

export function legacyVerificationUrl(href) {
  const url = new URL(href)
  if (url.hash) return null
  const match = url.pathname.match(/\/verify\/([^/]+)\/?$/)
  if (!match) return null
  url.pathname = url.pathname.slice(0, match.index + 1)
  url.hash = `/verify/${match[1]}`
  return url.href
}
