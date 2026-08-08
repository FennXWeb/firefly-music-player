# Firefly account and sync service

This is the server-side half of Firefly Accounts. It is designed for a Hostinger Business/Cloud Node.js deployment with MySQL, or a Hostinger VPS.

It provides:

- email/password and email-code accounts;
- phone/password and SMS-code accounts;
- WebAuthn passkeys on the account domain;
- short-lived, single-use desktop connection codes;
- 90-day revocable desktop sessions;
- opt-in library, settings, artwork, history, playlist, and music-file sync;
- a 150 MB default per-account quota;
- SHA-256 integrity checks and per-account file deduplication;
- AES-256-GCM encryption for every stored cloud object and snapshot.

## Deployment

1. In Hostinger hPanel, create a MySQL database and a database user dedicated to Firefly.
2. Create an email account such as `accounts@yourdomain.com`. Hostinger SMTP normally uses `smtp.hostinger.com` on port 465 with TLS.
3. Create an HTTPS subdomain such as `accounts.yourdomain.com` and deploy this directory as a Node.js app using Node 22 or 24.
4. Copy `.env.example` to the deployment environment variables and fill every required value. Never commit `.env`.
5. Generate secrets locally:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   Use the first value for `BETTER_AUTH_SECRET` and the second for `STORAGE_ENCRYPTION_KEY`. Back up the storage key in a password manager; losing it makes stored backups unrecoverable.
6. Run `npm install`, then `npm run auth:migrate` to create Better Auth's tables. Import `schema.sql` into the same database using phpMyAdmin or the MySQL command line.
7. Run `npm start`. Verify `https://accounts.yourdomain.com/health` returns `{"ok":true,"service":"firefly-cloud"}`.
8. In Firefly, open **Settings → Account & sync**, enter the HTTPS account-server address, then create or sign into an account.

The deployment needs a persistent writable directory for `STORAGE_ROOT`. Do not place it inside a directory replaced by every deployment. On managed Hostinger hosting, choose a persistent application-data directory available to the Node app; on a VPS, `/var/lib/firefly-cloud` is a sensible choice owned only by the service user.

## Phone codes

Hostinger provides SMTP email delivery but is not an SMS carrier. Phone codes are disabled until these environment variables are configured:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

The implementation keeps SMS delivery isolated in `src/messaging.js`, so Twilio can be replaced with another provider without changing account or sync storage.

## Security notes

- Terminate TLS at Hostinger and force HTTPS for the account subdomain.
- Keep MySQL private to the application host; never expose its port publicly.
- Set a strict database user with access only to the Firefly database.
- Back up both MySQL and `STORAGE_ROOT`; neither is useful alone.
- Rotate SMTP/SMS credentials if they are ever disclosed.
- Do not put database, SMTP, SMS, or encryption credentials in the Windows app.
- Configure Hostinger backups and test restoring them before inviting users.

The Windows app stores only its revocable account session token through Electron's protected Windows storage. Passwords, OTPs, passkeys, database credentials, and storage encryption keys never enter the installed Firefly application.
