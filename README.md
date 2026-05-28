# 🌴 Top of the Palms — AI Reservation Agent v2

End-to-end phone, SMS, and email reservation automation for Top of the Palms at USF.

---

## What's installed on your PC

**Only one thing: Node.js**

1. Download from **nodejs.org** → click the green LTS button → install normally
2. That's it. npm (the package manager) comes with it automatically.

To verify it worked, open Terminal (Mac) or Command Prompt (Windows) and type:
```
node --version
```
You should see something like `v22.x.x`.

---

## Quick start (5 minutes)

```bash
# 1. Unzip and enter the folder
cd top-of-palms-reservation-agent

# 2. Install libraries (takes ~30 seconds)
npm install

# 3. Set up your config
cp .env.example .env
# Open .env in any text editor and paste your ANTHROPIC_API_KEY

# 4. Start the server
npm start
```

Open your browser: **http://localhost:3000**

The demo works with just the Anthropic API key. Twilio and SendGrid are only needed for live phone/SMS/email.

---

## Three reservation channels

| Channel | How guests use it | Setup needed |
|---|---|---|
| **Demo** | Browser at `/demo.html` | Just ANTHROPIC_API_KEY |
| **SMS** | Text your Twilio number | Twilio account + ngrok |
| **Phone** | Call your Twilio number | Twilio account + ngrok |
| **Email** | Email your SendGrid address | SendGrid Inbound Parse + domain MX record |

---

## Pages

| URL | What it is |
|---|---|
| `/demo.html` | Interactive chat simulator (try it now!) |
| `/manager/dashboard` | Approve/deny student reservations |
| `/pos` | Kitchen display — confirmed reservations for today |
| `/health` | Server health check |

---

## Flows

**Faculty:** Call/text/email → AI collects info → Auto-approved → Created in POS → Confirmation email sent

**Student:** Call/text/email → AI collects info → Manager gets approval email with Approve/Deny links → Manager clicks → POS created + guest notified

---

## Twilio setup (for SMS + phone)

1. Create account at twilio.com
2. Buy a phone number (~$1/month)
3. Run `npx ngrok http 3000` to get a public URL
4. In Twilio console:
   - **Voice:** A call comes in → Webhook → `https://your-url.ngrok.io/voice/incoming` → POST
   - **SMS:** A message comes in → Webhook → `https://your-url.ngrok.io/sms/incoming` → POST

---

## SendGrid email setup

1. Create account at sendgrid.com (free tier works)
2. Verify a sender domain
3. Settings → Inbound Parse → Add your domain
4. Set URL to `https://your-server.com/email/incoming`
5. Add MX record at your DNS: `mx.sendgrid.net`

---

## GH One POS

GH One is not connected yet — the `/pos` board acts as your POS display in the meantime. It shows all confirmed reservations for today in real-time.

When you get GH One API credentials from Grubhub (Andy Allen / Sean Hanlon), edit `src/ghone.js` — the payload structure is already built, just add credentials to `.env`.

---

## Project files

```
top-of-palms/
├── server.js               All routes — voice, SMS, email, manager, POS, demo API
├── src/
│   ├── agent.js            Claude AI — adapts prompts per channel (voice/sms/email)
│   ├── db.js               JSON file database — zero setup
│   ├── reservations.js     Faculty/student routing logic
│   ├── pos.js              Internal POS (replaces GH One until credentials arrive)
│   ├── sms.js              Twilio SMS webhook handler
│   ├── emailInbound.js     SendGrid Inbound Parse handler
│   ├── email.js            SendGrid outbound — confirmed/pending/denied templates
│   └── manager.js          Manager approval email with one-click links
├── views/
│   ├── demo.html           Interactive chat demo (phone simulator UI)
│   ├── manager-dashboard.html   Full manager approval dashboard
│   └── pos-board.html      Kitchen display — today's confirmed reservations
├── data/
│   └── reservations.json   All reservation records (auto-created)
├── .env.example            Config template
└── README.md
```
