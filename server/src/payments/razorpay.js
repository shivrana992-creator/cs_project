'use strict';
const { createHmac, timingSafeEqual } = require('node:crypto');

if (process.env.NODE_ENV === 'production' && process.env.PAYMENT_MODE === 'razorpay' && (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || !process.env.RAZORPAY_WEBHOOK_SECRET)) {
  throw new Error('Razorpay credentials and webhook secret must be configured in production.');
}

function configured() {
  return process.env.PAYMENT_MODE === 'razorpay';
}

function credentials() {
  const { RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: keySecret } = process.env;
  if (!keyId || !keySecret) throw new Error('Razorpay credentials are not configured.');
  return { keyId, keySecret };
}

function amountPaise(rupees) {
  const raw = Number(rupees) * 100;
  const amount = Math.round(raw);
  if (!Number.isSafeInteger(amount) || amount <= 0 || Math.abs(raw - amount) > 0.000001) throw new Error('Fee must have no more than two decimal places.');
  return amount;
}

async function request(path, method = 'GET', body) {
  const { keyId, keySecret } = credentials();
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Payment provider returned ${response.status}.`);
  return response.json();
}

function verifyCheckoutSignature(orderId, paymentId, signature) {
  if (!/^order_[a-zA-Z0-9]+$/.test(orderId || '') || !/^pay_[a-zA-Z0-9]+$/.test(paymentId || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  const { keySecret } = credentials();
  const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

module.exports = { configured, credentials, amountPaise, request, verifyCheckoutSignature, verifyWebhookSignature };
