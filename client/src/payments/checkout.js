let loadingScript

function loadCheckout() {
  if (window.Razorpay) return Promise.resolve()
  if (!loadingScript) loadingScript = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.onload = resolve
    script.onerror = () => { loadingScript = null; reject(new Error('Could not load payment checkout.')) }
    document.head.appendChild(script)
  })
  return loadingScript
}

export async function openCheckout(order, user) {
  await loadCheckout()
  return new Promise((resolve, reject) => {
    const checkout = new window.Razorpay({
      key: order.key_id,
      amount: order.amount,
      currency: order.currency,
      name: order.name,
      description: order.description,
      order_id: order.order_id,
      prefill: { name: user.name, email: user.email },
      handler: resolve,
      modal: { ondismiss: () => reject(new Error('Payment window closed.')) },
    })
    checkout.on('payment.failed', response => reject(new Error(response.error?.description || 'Payment failed.')))
    checkout.open()
  })
}
