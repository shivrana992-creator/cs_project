# SymposiHub

SymposiHub is a role-based Symposium Registration and Certificate Management System. It provides event discovery, participant registration, demo payments and refunds, QR check-in, attendance tracking, CSV reports, PDF certificates with public SHA-256 verification and revocation, account verification and password recovery, notifications, MFA, and audit logging.

## Requirements

- Node.js 20 or newer
- npm 10 or newer

## Run locally

```powershell
npm install
npm run seed
npm run dev
```

Visit `http://localhost:5173`. See [QUICKSTART.md](QUICKSTART.md) for demo accounts and operating notes.

## Scripts

- `npm run dev` starts frontend and backend together.
- `npm run seed` creates demo data.
- `npm run build` validates the production frontend build.
- `npm start` starts the backend only.

## Security note

The bundled payment and refund actions are demos: they do not charge or return real money. Email verification and password recovery use visible one-time tokens in local development because no mail provider is configured. Set up a mail provider and payment provider before using those workflows beyond a classroom demo. For deployment, configure a strong `JWT_SECRET`, HTTPS, secure environment variables, and database backups. In production, the server refuses to start without `JWT_SECRET`.
