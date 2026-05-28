# Staging Environment Setup

## How to set up Dev / Staging / Production in Railway

### Step 1 — Create a staging environment

1. Go to railway.app → your project
2. Click the environment dropdown at top (says "production")
3. Click **+ New Environment** → name it `staging`
4. Railway clones your production environment

### Step 2 — Set staging variables (different from prod)

In Railway → staging environment → your service → Variables:

```
NODE_ENV        = staging
BASE_URL        = https://top-of-palms-staging.up.railway.app
MANAGER_EMAIL   = your-own-email@gmail.com   ← your email for testing
DAILY_LIMIT     = 5                          ← small limit for testing
DELETE_PIN      = 0000
POS_PIN         = 1111
MANAGER_PIN     = 2222
```

Keep GROQ_API_KEY, SENDGRID_API_KEY, FROM_EMAIL same as production.
Add a SEPARATE PostgreSQL database for staging (+ New → Database → PostgreSQL).

### Step 3 — Deploy to staging via branch

Create a staging branch in Git:
```bash
git checkout -b staging
git push origin staging
```

In Railway → staging environment → your service → Settings → Source:
Change branch from `main` to `staging`

Now:
- Push to `staging` branch → deploys to staging
- Push to `main` branch → deploys to production

### Step 4 — Staging URL

Railway will give you a staging URL like:
```
top-of-palms-staging.up.railway.app
```

Test everything here before pushing to main/production.

### Step 5 — Protect API keys

Never put API keys in your code or GitHub. Always use Railway Variables.
Your .env file is in .gitignore so it never gets committed.

To verify:
```bash
cat .gitignore  # should include .env
```

## Deploy workflow

```
Local laptop (npm start)
    ↓ test locally
git push origin staging
    ↓ auto-deploys to staging
test on staging URL
    ↓ everything looks good
git checkout main
git merge staging
git push origin main
    ↓ auto-deploys to production
```
