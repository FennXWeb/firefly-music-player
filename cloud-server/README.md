# Ignifire account and sync service

This is the server-side half of Ignifire Accounts. It is designed for a Hostinger Business/Cloud Node.js deployment backed by Supabase PostgreSQL, or for a Hostinger VPS using the same database.

It provides:

- email/password and email-code accounts;
- phone/password and SMS-code accounts;
- WebAuthn passkeys on the account domain;
- short-lived, single-use desktop connection codes;
- 90-day revocable desktop sessions;
- opt-in library, settings, artwork, history, playlist, and music-file sync;
- a 256 GB default per-account quota;
- SHA-256 integrity checks and per-account file deduplication;
- AES-256-GCM encryption for every stored cloud object and snapshot.
- cookie-authenticated, read-only web library access;
- private byte-range audio streaming for the Windows app and `https://ignifire.app`.

## Deployment

1. Create a Supabase project. Open **Connect**, copy the **Session pooler** PostgreSQL connection string, and save it as `DATABASE_URL` in the Node service environment. Session mode is appropriate for a persistent Hostinger Node service and works on IPv4 networks.
2. Create an email account such as `accounts@yourdomain.com`. Hostinger SMTP normally uses `smtp.hostinger.com` on port 465 with TLS.
3. Create an HTTPS subdomain such as `accounts.yourdomain.com` and deploy this directory as a Node.js app using Node 22 or 24.
4. Copy `.env.example` to the deployment environment variables and fill every required value. Never commit `.env`. Add `PUBLIC_WEB_URL=https://ignifire.app` so the account service accepts browser requests only from the production web player.
5. Generate secrets locally:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   Use the first value for `BETTER_AUTH_SECRET` and the second for `STORAGE_ENCRYPTION_KEY`. Back up the storage key in a password manager; losing it makes stored backups unrecoverable.
6. In the Supabase SQL Editor, run `better-auth-schema.sql` once, choosing **Run without RLS** when Supabase offers to append automatic RLS statements. Then run `schema.sql` to create Ignifire's private sync tables and safely enable RLS with correctly quoted identifiers. No browser-facing policies are granted; the trusted Node service connects directly through PostgreSQL.
7. Run `npm start`. Verify `https://accounts.yourdomain.com/health` returns `{"ok":true,"service":"ignifire-cloud"}`.
8. In Ignifire, open **Settings → Account & sync**, then create or sign into an account through `https://accounts.ignifire.app`.

The deployment needs a persistent writable directory for `STORAGE_ROOT`. Do not place it inside a directory replaced by every deployment. On managed Hostinger hosting, choose a persistent application-data directory available to the Node app; on a VPS, `/var/lib/firefly-cloud` is a sensible choice owned only by the service user.

## Web player

Deploy the matching `Ignifire-Web-<version>.zip` as the static website for `https://ignifire.app`. Deploy or redeploy this account service first, because the static web player depends on its authenticated `/v1/web/library` and `/v1/web/stream/:hash` endpoints.

The web player intentionally exposes a smaller, read-only feature set: Home, Albums, Songs, Playlists, search, and playback. Importing, metadata editing, AI tools, Shelf Mode, advanced settings, and update-channel selection remain Windows-only. The download button always points at the latest stable GitHub release, never the beta channel.

## Phone codes

Hostinger provides SMTP email delivery but is not an SMS carrier. Phone codes are disabled until these environment variables are configured:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

The implementation keeps SMS delivery isolated in `src/messaging.js`, so Twilio can be replaced with another provider without changing account or sync storage.

## Security notes

- Terminate TLS at Hostinger and force HTTPS for the account subdomain.
- Keep `DATABASE_URL` server-side. Never put the database password or connection string in the Windows app or browser bundle.
- Keep RLS enabled on all tables in Supabase's exposed `public` schema.
- Back up both PostgreSQL and `STORAGE_ROOT`; neither is useful alone.
- Rotate SMTP/SMS credentials if they are ever disclosed.
- Do not put database, SMTP, SMS, or encryption credentials in the Windows app.
- Configure Hostinger backups and test restoring them before inviting users.

The Windows app stores only its revocable account session token through Electron's protected Windows storage. Passwords, OTPs, passkeys, database credentials, and storage encryption keys never enter the installed Ignifire application.
