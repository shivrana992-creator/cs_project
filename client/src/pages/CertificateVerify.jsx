import { useCallback, useEffect, useRef, useState } from 'react'
import client from '../api/client'

export default function CertificateVerify({ certificateId }) {
  const [id, setId] = useState(certificateId || '')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const request = useRef(null)

  const verify = useCallback(async value => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setResult(null)
    setError('')
    const trimmedId = value.trim()
    if (!trimmedId) {
      setLoading(false)
      setError('Enter a certificate ID.')
      return
    }
    setLoading(true)
    try {
      const { data } = await client.get(`/certificates/verify/${encodeURIComponent(trimmedId)}`, { signal: controller.signal })
      if (!controller.signal.aborted) setResult(data)
    } catch (err) {
      if (!controller.signal.aborted) setError(err.response?.data?.error || 'Certificate could not be verified. Please try again.')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let linkedId = certificateId || ''
    try { linkedId = decodeURIComponent(linkedId) } catch { /* Invalid escapes are sent as an unknown ID. */ }
    setId(linkedId)
    setResult(null)
    setError('')
    setLoading(false)
    if (linkedId) verify(linkedId)
    return () => request.current?.abort()
  }, [certificateId, verify])

  const submit = e => { e.preventDefault(); verify(id) }
  const editId = e => { setId(e.target.value); setResult(null); setError('') }
  return <main className="app-main">
    <header className="page-heading"><p className="eyebrow">Public verification</p><h1>Verify a certificate</h1><p>Enter the certificate ID printed on a SymposiHub PDF or open its QR-code link.</p></header>
    <form className="card verify-form" onSubmit={submit}>
      <input className="form-input" required aria-label="Certificate ID" placeholder="Certificate UUID" value={id} onChange={editId} disabled={loading}/>
      <button className="btn btn-primary" disabled={loading}>{loading ? 'Verifying…' : 'Verify certificate'}</button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    {result && <section className={`card verification ${result.valid ? 'valid' : 'invalid'}`} aria-live="polite">
      <h2>{result.valid ? 'Certificate is valid' : 'Certificate is not valid'}</h2>
      {result.revoked && <p>This certificate has been revoked. {result.revocation_reason}</p>}
      {result.certificate && <>
        <p><b>Participant:</b> {result.certificate.participant_name}</p>
        <p><b>Symposium:</b> {result.certificate.symposium_title}</p>
        <p><b>Dates:</b> {result.certificate.event_dates}</p>
        <p><b>Issued:</b> {new Date(result.certificate.issue_date).toLocaleDateString()}</p>
        <p>Record integrity: {result.certificate.hash_verified ? 'Verified' : 'Could not be verified'}</p>
      </>}
    </section>}
  </main>
}
