const publicPages = new Set(['browse', 'verify', 'docs'])
const pageRoles = {
  dashboard: ['participant', 'organizer', 'coordinator', 'admin'],
  notifications: ['participant', 'organizer', 'coordinator', 'admin'],
  account: ['participant', 'organizer', 'coordinator', 'admin'],
  registrations: ['participant'],
  certificates: ['participant'],
  manage: ['organizer', 'coordinator', 'admin'],
  attendance: ['organizer', 'admin'],
  admin: ['admin'],
}

export function resolvePage(pathname, user) {
  const [name, id, ...extra] = pathname.split('/').filter(Boolean)
  const page = name || 'browse'
  const symposiumId = page === 'attendance' && /^[1-9]\d*$/.test(id || '') ? id : null
  const validPath = extra.length === 0 && (page === 'attendance' ? !!symposiumId : !id)
  const allowed = validPath && (publicPages.has(page) || pageRoles[page]?.includes(user?.role))
  return { page, symposiumId, allowed: !!allowed }
}
