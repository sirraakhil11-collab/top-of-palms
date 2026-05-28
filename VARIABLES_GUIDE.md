# Variables & Settings Guide — On Top of the Palms

## WHERE TO CHANGE THINGS

### 1. Business Rules → src/policy.js
Edit this file when you want to change operational settings.
After editing, push to GitHub → Railway auto-deploys in 2 min.

```
RESTAURANT_NAME   = 'On Top of the Palms'
SEATING_OPTIONS   = Window, Middle, Bench, Private Room A/B/C
PAYMENT_OPTIONS   = CC/Cash, USF Card, Direct Bill
MIN_PARTY         = 2       ← minimum guests per reservation
MAX_PARTY         = 15      ← maximum guests per reservation
ADVANCE_HOURS     = 24      ← how many hours ahead must book
DAILY_LIMIT_COVERS= 60      ← max covers per day (also set in Railway)
```

### 2. Secrets & Credentials → Railway Variables
Go to: railway.app → your project → top-of-palms service → Variables tab

| Variable | What it controls | Where to get it |
|---|---|---|
| `GROQ_API_KEY` | AI brain (free) | console.groq.com |
| `SENDGRID_API_KEY` | Email sending | app.sendgrid.com |
| `FROM_EMAIL` | Sender email address | Your verified SendGrid email |
| `MANAGER_EMAIL` | Who gets approval emails | Manager's email |
| `BASE_URL` | Your Railway public URL | Auto-set by Railway |
| `DAILY_LIMIT` | Max covers per day | Default: 60 |
| `POS_PIN` | PIN for /pos page | You choose (4-6 digits) |
| `MANAGER_PIN` | PIN for /manager/dashboard | You choose (4-6 digits) |
| `DELETE_PIN` | PIN to delete records | You choose (4-6 digits) |
| `SESSION_SECRET` | Secures login cookies | Any random string |
| `DATABASE_URL` | PostgreSQL connection | Auto-set by Railway PostgreSQL |
| `RESTAURANT_PHONE` | Phone shown in emails | Your restaurant number |

### 3. Daily Limit (two places — keep in sync)
- In Railway Variables: `DAILY_LIMIT = 60`
- In `src/policy.js`: `DAILY_LIMIT_COVERS = parseInt(process.env.DAILY_LIMIT || '60')`

## QUICK CHANGE GUIDE

### Change the daily cover limit (e.g. from 60 to 45):
Railway → Variables → edit `DAILY_LIMIT` → set to 45 → auto-redeploys

### Change PINs:
Railway → Variables → edit `POS_PIN` or `MANAGER_PIN` → auto-redeploys

### Change manager email:
Railway → Variables → edit `MANAGER_EMAIL`

### Change restaurant hours shown on form:
Open `views/reserve.html` → search "11:00 AM" → update the text + time slot builder

### Add a new seating option:
Open `src/policy.js` → add to SEATING_OPTIONS array
Open `views/pos-board.html` → find seatingOpts array → add same option
Open `views/dashboard.html` → find the eseat select options → add same option

### Add a new payment option:
Open `src/policy.js` → add to PAYMENT_OPTIONS array
Open `views/reserve.html` → add new ms-option in pay-dropdown
Open `views/dashboard.html` → add new checkbox in epay-dropdown
Open `views/pos-board.html` → add to payMethods array

## URLS

| Page | URL | Access |
|---|---|---|
| Guest reservation form | /reserve | Public — share this link |
| Manager dashboard | /manager/dashboard | Manager PIN required |
| POS board | /pos | POS PIN or Manager PIN |
| AI chat demo | /demo.html | Public |
| Health check | /health | Public |

## DEPLOY PROCESS

1. Edit files on your laptop
2. `git add . && git commit -m "description" && git push`
3. Railway auto-deploys in ~2 minutes
4. Check /health to confirm new version is live

## ENVIRONMENT BRANCHES

- `main` branch → Production (top-of-palms-production.up.railway.app)
- `staging` branch → Staging (set up in Railway separately)
- Local → `npm start` → localhost:3000
