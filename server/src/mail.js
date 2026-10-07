'use strict';
const nodemailer = require('nodemailer');

if (process.env.NODE_ENV === 'production' && (!process.env.SMTP_HOST || !process.env.SMTP_FROM || !process.env.APP_URL)) {
  throw new Error('SMTP_HOST, SMTP_FROM, and APP_URL must be configured in production.');
}

let transport;
function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  if (!transport) transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    requireTLS: process.env.SMTP_SECURE !== 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

function accountLink(action, token) {
  const url = new URL(process.env.APP_URL || 'http://localhost:5173');
  url.hash = `/${action}/${encodeURIComponent(token)}`;
  return url.href;
}

async function sendAccountEmail(to, purpose, token) {
  const smtp = getTransport();
  if (!smtp) return false;
  const verification = purpose === 'email_verification';
  const link = accountLink(verification ? 'verify-email' : 'reset-password', token);
  await smtp.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: verification ? 'Verify your SymposiHub email' : 'Reset your SymposiHub password',
    text: verification
      ? `Open this link to verify your email address:\n${link}\n\nThis link expires in 24 hours.`
      : `Open this link to reset your password:\n${link}\n\nThis link expires in 30 minutes. If you did not request this, ignore this email.`,
  });
  return true;
}

module.exports = { sendAccountEmail, accountLink };
