# SymposiHub Quick Start

## Install and run

From the project root, run:

```powershell
npm install
npm run seed
npm run dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:3001`.

For a new account, the local demo shows a one-time email-verification token during registration. Password recovery similarly shows a one-time reset token. This substitutes for email delivery during local development; do not use it as production email delivery.

Paid registration, cancellation refunds, and the displayed payment reference are simulated. No real payment is processed. Participants can show their registration QR code at the event; organizers scan it with a QR scanner configured as a keyboard or enter the code in the attendance page.

## Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Administrator | admin@symposium.edu | Admin@123 |
| Organizer | organizer@symposium.edu | Organizer@123 |
| Coordinator | coordinator@symposium.edu | Coordinator@123 |
| Participant | student@symposium.edu | Student@123 |

Use one terminal command only: `npm run dev` from the root. Do not separately start `node src/index.js` while that command is already running.
