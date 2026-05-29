# Staging Setup — On Top of the Palms

## Overview
Production = `main` branch → Railway production environment
Staging = `staging` branch → Railway staging environment

---

## STEP 1: Create staging branch in Git

Open Git Bash in your project folder:

```bash
git checkout main
git pull
git checkout -b staging
git push origin staging
```

You now have two branches: `main` (prod) and `staging`.

---

## STEP 2: Create Railway staging environment

1. Go to **railway.app** → your project
2. Click the environment dropdown at top (says "production")
3. Click **+ New Environment** → name it `staging`
4. Railway clones the environment

---

## STEP 3: Add a separate PostgreSQL for staging

In staging environment:
1. Click **+ New** → **Database** → **Add PostgreSQL**
2. Railway adds it to staging — completely separate from prod DB
3. Staging data never touches prod data

---

## STEP 4: Connect staging service to staging branch

1. Click your **top-of-palms** service in the staging environment
2. Go to **Settings** → **Source**
3. Change branch from `main` to `staging`
4. Railway will redeploy from the staging branch

---

## STEP 5: Set staging Variables (different from prod)

In Railway staging → your service → **Variables** tab:

```
NODE_ENV        = staging
BASE_URL        = https://top-of-palms-staging.up.railway.app
MANAGER_EMAIL   = your-personal-email@gmail.com    ← your email for testing
DAILY_LIMIT     = 5                                 ← small limit for testing
POS_PIN         = 1111
MANAGER_PIN     = 2222
DELETE_PIN      = 0000
SESSION_SECRET  = staging-secret-2026

# Same API keys as prod (or use test keys)
GROQ_API_KEY    = gsk_...
SENDGRID_API_KEY= SG...
FROM_EMAIL      = your-verified@email.com
RESTAURANT_PHONE= (813) 974-0000

# Twilio (for SMS testing)
TWILIO_ACCOUNT_SID = AC...
TWILIO_AUTH_TOKEN  = ...
TWILIO_PHONE_NUMBER= +1813...
```

DATABASE_URL is auto-injected by Railway PostgreSQL.

---

## STEP 6: Test on staging URL

Railway gives you a URL like:
```
https://top-of-palms-staging.up.railway.app
```

Test everything here. Production is completely untouched.

---

## Deploy workflow

```
# Work on staging
git checkout staging
# make changes, test locally
git add . && git commit -m "test: new feature"
git push origin staging
# → deploys to staging automatically

# When ready for prod
git checkout main
git merge staging
git push origin main
# → deploys to production automatically
```

**Rule:** Never push directly to `main`. Always test on `staging` first.

---

## Twilio SMS Setup

1. Go to twilio.com → Phone Numbers → your number
2. Under "Messaging" → "A message comes in":
   - Webhook URL: `https://top-of-palms-staging.up.railway.app/sms/incoming`
   - Method: HTTP POST
3. For production: `https://top-of-palms-production.up.railway.app/sms/incoming`

---

## SendGrid Inbound Parse (Email reservations)

1. Go to sendgrid.com → Settings → Inbound Parse
2. Add Host & URL:
   - For staging: `https://top-of-palms-staging.up.railway.app/email/incoming`
   - For prod: `https://top-of-palms-production.up.railway.app/email/incoming`
3. The email address guests use: whatever FROM_EMAIL you verified in SendGrid
4. Future: topofthepalms.usf.edu — set MX record pointing to `mx.sendgrid.net`

---

## Email: topofthepalms.usf.edu

When USF IT gives you the domain:
1. Ask them to add MX record: `mx.sendgrid.net` (priority 10)
2. In SendGrid → Inbound Parse → add `topofthepalms.usf.edu` as domain
3. Emails to `reservations@topofthepalms.usf.edu` will be parsed and sent to your webhook
4. Update FROM_EMAIL in Railway Variables to that address
5. Update the form display email in `views/reserve.html`

For now your compass email works fine for testing.
