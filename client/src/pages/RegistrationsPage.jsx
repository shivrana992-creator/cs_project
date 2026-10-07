import { CalendarDays, CreditCard, MapPin } from 'lucide-react'

export default function RegistrationsPage({ regs, pay, cancel, register, checkRefund, paymentMode }) {
  return <main className="app-main">
    <header className="page-heading"><p className="eyebrow">SymposiHub</p><h1>My registrations</h1><p>{paymentMode === 'razorpay' ? 'Track your symposium and payment status.' : 'Track your symposium and payment status. Demo payments do not charge real money.'}</p></header>
    {regs.length ? <div className="list">{regs.map(reg => <article className="record card" key={reg.id}>
      <div><h3>{reg.symposium_title}</h3><p><CalendarDays size={15}/>{new Date(reg.start_date).toLocaleDateString('en-IN')} · <MapPin size={15}/>{reg.location}</p></div>
      <div className="record-status"><span className="badge">{reg.status.replaceAll('_', ' ')}</span><span className="badge">{reg.payment_status.replaceAll('_', ' ')}</span>{reg.refund_status && reg.refund_status !== 'demo' && <span className="badge">Refund {reg.refund_status}</span>}</div>
      <div className="row-actions">
        {reg.checkin_token && ['confirmed', 'attended', 'certificate_issued'].includes(reg.status) && <img width="80" height="80" alt="Your event check-in QR code" src={`/api/attendance/qr/${reg.id}`}/>}
        {reg.payment_status === 'pending' && reg.status === 'registered' && <button className="btn btn-primary btn-sm" onClick={() => pay(reg.id)}><CreditCard size={15}/> Pay ₹{reg.fee}</button>}
        {['registered', 'pending_payment', 'confirmed'].includes(reg.status) && <button className="btn btn-ghost btn-sm" onClick={() => cancel(reg.id)}>Cancel</button>}
        {reg.status === 'cancelled' && <button className="btn btn-primary btn-sm" onClick={() => register(reg.symposium_id)}>Register again</button>}
        {reg.refund_reference && !['processed', 'failed'].includes(reg.refund_status) && <button className="btn btn-ghost btn-sm" onClick={() => checkRefund(reg.id)}>Check refund status</button>}
      </div>
    </article>)}</div> : <div className="empty-state">You have not registered for any symposiums yet.</div>}
  </main>
}
