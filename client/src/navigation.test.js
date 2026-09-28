import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePage } from './navigation.js'

test('public pages remain accessible before and after login', () => {
  for (const user of [null, { role: 'participant' }, { role: 'admin' }]) {
    for (const path of ['/', '/browse', '/verify', '/docs']) {
      assert.equal(resolvePage(path, user).allowed, true, path)
    }
  }
  assert.equal(resolvePage('/', null).page, 'browse')
})

test('private history entries cannot reopen pages after logout', () => {
  for (const path of ['/dashboard', '/notifications', '/account', '/registrations', '/certificates', '/manage', '/attendance/1', '/admin']) {
    assert.equal(resolvePage(path, null).allowed, false, path)
  }
})

test('page access follows the signed-in role', () => {
  const paths = ['/dashboard', '/notifications', '/account', '/registrations', '/certificates', '/manage', '/attendance/1', '/admin']
  const permissions = {
    participant: [true, true, true, true, true, false, false, false],
    organizer: [true, true, true, false, false, true, true, false],
    coordinator: [true, true, true, false, false, true, false, false],
    admin: [true, true, true, false, false, true, true, true],
  }
  for (const [role, expected] of Object.entries(permissions)) {
    assert.deepEqual(paths.map(path => resolvePage(path, { role }).allowed), expected, role)
  }
})

test('attendance URLs preserve the symposium on Forward or reload', () => {
  assert.deepEqual(resolvePage('/attendance/42', { role: 'organizer' }), {
    page: 'attendance', symposiumId: '42', allowed: true,
  })
})

test('unknown and incomplete routes are rejected instead of displaying a blank page', () => {
  for (const path of ['/missing', '/dashboard/extra', '/attendance', '/attendance/0', '/attendance/-1', '/attendance/no-id', '/attendance/1/extra']) {
    assert.equal(resolvePage(path, { role: 'admin' }).allowed, false, path)
  }
})
