# Deploying CampusMarket to Render

`render.yaml` in this package is a Render **Blueprint** — Render reads it and
creates the web service + persistent disk for you automatically. No manual
service setup needed.

## 1. Push the code to GitHub (or GitLab)
Render deploys from a git repo, not a zip upload.
```bash
cd CAMPUS_MARKETPLACE_fixed
git init
git add .
git commit -m "CampusMarket beta"
git branch -M main
git remote add origin https://github.com/<you>/campusmarket.git
git push -u origin main
```

## 2. Create the Blueprint on Render
1. Go to https://dashboard.render.com → **New +** → **Blueprint**.
2. Connect the GitHub repo you just pushed.
3. Render detects `render.yaml` and shows a preview: one web service
   (`campusmarket`) + one 1GB persistent disk. Click **Apply**.

## 3. Set the secret env vars
The blueprint deliberately leaves these blank (`sync: false`) so nothing
sensitive sits in git. After the first deploy:

Dashboard → **campusmarket** → **Environment** → add:

| Key | Value |
|---|---|
| `SECRET` | a long random string — generate with `openssl rand -hex 32` |
| `ADMIN_EMAIL` | *(optional)* your email, to get a moderator account |
| `ADMIN_PASSWORD` | *(optional, required if ADMIN_EMAIL is set)* a strong password |
| `ADMIN_NAME` | *(optional)* display name for the moderator account |

Save — Render will redeploy automatically with the new values.

If you skip `ADMIN_EMAIL`/`ADMIN_PASSWORD`, the app runs fine with zero admin
accounts (matches the "closed test" behavior already built in).

## 4. Get the URL
Render gives you a URL like `https://campusmarket.onrender.com` — that's
already HTTPS, no extra TLS setup needed. Share that with your 20 testers.

## Notes specific to this deploy
- **Free plan** spins the service down after inactivity and takes ~30–60s to
  wake back up on the next request. Fine for a casual beta; switch `plan:`
  in `render.yaml` to `starter` (~$7/mo) if you want it always warm.
- The persistent disk is mounted at `/var/data`, and `DATA_DIR=/var/data` is
  set so `server-data/db.json` and `secret.key` live there and survive
  redeploys/restarts. Without this, Render's filesystem resets on every
  deploy and you'd lose all user data.
- Back up periodically: **Dashboard → Disks → campusmarket-data → Download**,
  or shell in via **Dashboard → Shell** and copy `/var/data/db.json`.
- To rotate everyone's login (e.g. after the test ends), just change `SECRET`
  in the dashboard — all existing tokens become invalid immediately.
