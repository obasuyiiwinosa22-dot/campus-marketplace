# CampusMarket — Deployment Notes

This build is prepared for a **private/closed test (~20 people)**, not a public
launch. The previously shipped demo accounts (including the demo admin) and all
demo listings have been removed — the app starts empty and real users register
their own accounts.

## What was fixed / hardened
1. **Auth secret** — no hardcoded/default secret. On first boot a strong random
   secret is generated and persisted to `server-data/secret.key` (kept out of
   git). For production set the `SECRET` env var instead.
2. **Stored XSS** — user-controlled names and listing titles are HTML-escaped
   (`escHtml`) before being embedded in notification text, so a malicious
   display name or title can't inject script.
3. **Login rate limiting** — repeated failed logins from the same IP+email lock
   out for 5 minutes after 8 attempts.
4. **Security headers** — `X-Content-Type-Options`, `X-Frame-Options`,
   `Referrer-Policy` are set on API responses.
5. **No demo/admin accounts** — `seedDB()` now starts with zero users and zero
   listings. There is no longer a guessable demo/admin login.

## Moderator account (optional)
There is no default admin. To give yourself moderator access for the test, set
these env vars on the host **before first boot** (only used to create one
`u_admin` account; there is no hardcoded password):

```
ADMIN_EMAIL=you@campus.market
ADMIN_PASSWORD=a-strong-random-password
ADMIN_NAME=Moderator        # optional
```

If you don't set these, the app runs fully without any admin/moderator account.

## How to run it
```bash
node server.js
# or with overrides:
PORT=8080 SECRET=your-long-random-string \
ADMIN_EMAIL=you@campus.market ADMIN_PASSWORD=change-me node server.js
```

The server listens on `PORT` (default `4173`) and serves both the static
frontend and the `/api/*` REST + SSE backend from one process. The database
(`server-data/db.json`) and `server-data/secret.key` are created fresh on first
boot — there is no pre-seeded `db.json` in this package.

## Where to host it
Needs a host that runs a persistent Node process **with a writable, persistent
filesystem** (it stores data in `server-data/db.json` on disk):

- Works well: Render, Railway, Fly.io, any VPS behind Nginx/Caddy.
- Must be served over **HTTPS** — use a host that provides it automatically
  (Render/Railway/Fly all do), or put it behind Caddy for TLS.
- Won't work as-is on Vercel/Netlify/Cloudflare Workers (ephemeral/read-only FS).

## Notes for this temporary test
- CORS is currently `*` (acceptable for a closed test; tighten to your domain
  before any public launch).
- The JSON-file DB is fine for ~20 people. Back up `server-data/db.json`
  periodically since it's the only copy of your data.
- Rotating the `SECRET` (or redeploying with a wiped `server-data/`) will
  invalidate all existing login tokens — fine for a temporary test.
