import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePage, legacyVerificationUrl } from './navigation.js'

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
    page: 'attendance', symposiumId: '42', allowed: true, certificateId: null,
  })
})

test('unknown and incomplete routes are rejected instead of displaying a blank page', () => {
  for (const path of ['/missing', '/dashboard/extra', '/attendance', '/attendance/0', '/attendance/-1', '/attendance/no-id', '/attendance/1/extra']) {
    assert.equal(resolvePage(path, { role: 'admin' }).allowed, false, path)
  }
})

test('QR verification routes are public and retain the certificate ID', () => {
  assert.deepEqual(resolvePage('/verify/test-id', null), {
    page: 'verify', symposiumId: null, allowed: true, certificateId: 'test-id',
  })
  assert.equal(resolvePage('/verify/test-id/extra', null).allowed, false)
})

test('old PDF links are converted to hash routes without losing the ID', () => {
  assert.equal(legacyVerificationUrl('http://localhost:5173/verify/test-id'), 'http://localhost:5173/#/verify/test-id')
  assert.equal(legacyVerificationUrl('https://example.org/app/verify/test-id/?source=qr'), 'https://example.org/app/?source=qr#/verify/test-id')
  assert.equal(legacyVerificationUrl('http://localhost:5173/#/verify/test-id'), null)
  assert.equal(legacyVerificationUrl('http://localhost:5173/'), null)
})
