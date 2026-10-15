ITRentHub Full Working Website (Node.js + SQLite)

WHAT'S INCLUDED
- 52 rental products including home theatre, TV soundbar, home subwoofer, Bluetooth home speakers, wireless home speaker sets, bookshelf and tower speakers.
- Customer registration/login, secure password hashing, session cookie, customer booking history and complaints.
- Owner/Admin and Staff role-based panels. Staff can review bookings and complaints. Admin can create staff accounts, manage product prices/deposits/availability, and deactivate accounts.
- Booking approve/reject/update, complaint status, CSV export, SQLite database.
- Contact: Plot No. 123, Mohan Garden, Dwarka Mor, New Delhi–110059; WhatsApp 8126316906; email ankit.securityl@gmail.com.

REQUIREMENTS
- Node.js 20 or newer and npm.

RUN LOCALLY
1. Extract this ZIP into a folder.
2. Open a terminal in that folder and run: npm install
3. Set environment variables before starting. Linux/macOS example:
   export SESSION_SECRET='use-a-long-random-secret-here'
   export ADMIN_NAME='ITRentHub Owner'
   export ADMIN_EMAIL='your-owner-email@example.com'
   export ADMIN_PASSWORD='Choose-A-Strong-Password-123'
   npm start
   Windows PowerShell example:
   $env:SESSION_SECRET='use-a-long-random-secret-here'
   $env:ADMIN_NAME='ITRentHub Owner'
   $env:ADMIN_EMAIL='your-owner-email@example.com'
   $env:ADMIN_PASSWORD='Choose-A-Strong-Password-123'
   npm start
4. Open http://localhost:3000
5. Log in using the admin email/password you set above. These values are read only on first startup when no account with that email exists. Do not use the example password in production.

DEPLOYMENT NOTES
- This is a real server-backed application, not a static HTML-only site. Uploading only public/index.html to Netlify will NOT enable accounts or bookings. Deploy to a Node.js host that supports persistent disk storage, or configure a managed database/session store before using ephemeral hosting.
- Set NODE_ENV=production, a unique long SESSION_SECRET, ADMIN_EMAIL and ADMIN_PASSWORD in the hosting environment. Use HTTPS. Never publish .env or the data/ directory.
- SQLite data lives in data/itrenthub.sqlite and sessions in data/sessions.sqlite. Back them up. The hosting platform must preserve the data directory across restarts/deploys.
- Prices start at ₹0 (Rate on request); set real prices and deposits in Admin > Products & rates before accepting real orders. There is no online payment integration, live stock calendar, delivery integration or automated email/SMS yet. Booking status is not a payment or delivery confirmation.
- Customer sign-up cannot assign admin/staff roles. Only an authenticated admin can create staff accounts. Admin account is provisioned from environment variables on first run.
- Update contact details in public/index.html and server.js if they change.
