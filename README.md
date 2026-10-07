# SymposiHub

SymposiHub is a role-based symposium registration and certificate app. It supports event discovery, registration, QR check-in, attendance, CSV reports, email verification, password recovery, MFA, and public certificate verification. Local development uses simulated payments. An optional Razorpay checkout and SMTP delivery path are available for deployment.

## Requirements

- Node.js 24 or newer
- npm 10 or newer

## Run locally

```powershell
npm install
npm run seed
npm run dev
```

Open `http://localhost:5173`. `npm install` installs the root, client, and server workspaces. See [QUICKSTART.md](QUICKSTART.md) for demo accounts.

## Check the project

```powershell
npm test
npm run lint
npm run build
```

On Windows PowerShell systems that block `npm.ps1`, use `npm.cmd` in these commands.

## Deploy

Build the client with `npm run build`, then start the server with `npm start`. The server serves `client/dist` and the API from the same origin. Copy `.env.example` to `.env` and provide real values for:

- `NODE_ENV=production`, `APP_URL` (the public HTTPS URL), and a long `JWT_SECRET`.
- A private `DB_PATH` outside the source checkout with a backup plan.
- A long `CERTIFICATE_SIGNING_KEY`. Keep this key backed up; losing it makes newly signed certificates unverifiable. Existing SHA-256 certificates remain supported as legacy records.
- `SMTP_HOST`, `SMTP_FROM`, and, when required by the mail provider, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT`, and `SMTP_SECURE`.
- For real payments, `PAYMENT_MODE=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`. Configure the `payment.captured`, `refund.processed`, and `refund.failed` events at `https://your-domain/api/payments/webhook`. Test with Razorpay test keys before using live keys. Enable automatic payment capture in Razorpay.

Only the Razorpay key ID reaches the browser. Payment confirmation checks the checkout signature and fetches the captured payment from Razorpay. Cancellation requests a refund and records its status. A signed webhook updates payment and refund state if the browser closes or the status changes later. Verify your payment and refund policy before accepting real money.

Local development without SMTP returns one-time verification and reset tokens in the API response. In production the server requires SMTP configuration and sends links by email. Local demo payments and refunds do not transfer money.

The database and pnpm store are excluded from version control. If they were committed in an earlier version, removing them now does not erase those historical commits; rotate any exposed credentials and purge history if that is relevant to your deployment.
