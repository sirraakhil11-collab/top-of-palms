require('dotenv').config();
const express = require('express');
const twilio  = require('twilio');
const multer  = require('multer');
const path    = require('path');

const { getAgentReply }      = require('./src/agent');
const { processReservation } = require('./src/reservations');
const pos                    = require('./src/pos');
const { createGHOneReservation } = require('./src/ghone');
const { sendEmail }          = require('./src/email');
const db                     = require('./src/db');
const smsHandler             = require('./src/sms');
const emailHandler           = require('./src/emailInbound');

const app    = express();
const upload = multer();   // For SendGrid multipart inbound email

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'views')));

// Shared in-memory sessions across all channels (keyed by callSid / sms:phone / email:addr)
const sessions = {};
smsHandler.init(sessions);
emailHandler.init(sessions);

// ═══════════════════════════════════════════════════════════════════════════
//  CHANNEL 1 — PHONE (Twilio Voice)
// ═══════════════════════════════════════════════════════════════════════════

app.post('/voice/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  sessions[callSid] = { channel: 'voice', callSid, callerNumber: req.body.From || '', messages: [], collected: null };
  console.log(`\n[Call] Incoming from ${req.body.From || 'unknown'} — SID: ${callSid}`);

  const twiml  = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({ input: 'speech', action: `/voice/respond/${callSid}`, speechTimeout: 'auto', speechModel: 'phone_call', language: 'en-US' });
  gather.say({ voice: 'Polly.Joanna' }, 'Welcome to Top of the Palms at USF. I\'m your reservation assistant. Please tell me your full name to get started.');
  twiml.redirect({ method: 'POST' }, '/voice/incoming');
  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/respond/:callSid', async (req, res) => {
  const { callSid } = req.params;
  const userSpeech  = req.body.SpeechResult || '';
  const session     = sessions[callSid];

  if (!session) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("I'm sorry, something went wrong. Please call us back.");
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  console.log(`[Call ${callSid.slice(-6)}] Guest: "${userSpeech}"`);
  session.messages.push({ role: 'user', content: userSpeech });

  try {
    const aiReply = await getAgentReply(session, 'voice');
    session.messages.push({ role: 'assistant', content: aiReply.text });

    const twiml = new twilio.twiml.VoiceResponse();
    if (aiReply.complete && aiReply.collected) {
      session.collected = aiReply.collected;
      twiml.say({ voice: 'Polly.Joanna' }, aiReply.text);
      twiml.pause({ length: 1 });
      twiml.hangup();
      setImmediate(() => processReservation(session).catch(console.error));
    } else {
      const gather = twiml.gather({ input: 'speech', action: `/voice/respond/${callSid}`, speechTimeout: 'auto', speechModel: 'phone_call', language: 'en-US' });
      gather.say({ voice: 'Polly.Joanna' }, aiReply.text);
      twiml.say({ voice: 'Polly.Joanna' }, "I didn't catch that. Could you please repeat?");
      twiml.redirect({ method: 'POST' }, `/voice/respond/${callSid}`);
    }
    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error(`[Call] Error:`, err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("I'm sorry, technical issue. Please call us back. Thank you.");
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CHANNEL 2 — SMS (Twilio Programmable SMS)
// ═══════════════════════════════════════════════════════════════════════════

app.post('/sms/incoming', smsHandler.handleIncoming);

// ═══════════════════════════════════════════════════════════════════════════
//  CHANNEL 3 — EMAIL (SendGrid Inbound Parse)
// ═══════════════════════════════════════════════════════════════════════════

app.post('/email/incoming', upload.none(), emailHandler.handleIncoming);

// ═══════════════════════════════════════════════════════════════════════════
//  DEMO API — powers the interactive chat demo page
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/demo/chat', async (req, res) => {
  const { sessionId, message, channel = 'sms' } = req.body;

  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const key = `demo:${sessionId}`;
  if (!sessions[key]) {
    sessions[key] = { channel, callSid: key, callerNumber: 'demo', messages: [], collected: null };
  }

  const session = sessions[key];

  const userContent = session.messages.length === 0
    ? `Hi, I want to make a reservation. ${message}`
    : message;

  session.messages.push({ role: 'user', content: userContent });

  try {
    const aiReply = await getAgentReply(session, channel);
    session.messages.push({ role: 'assistant', content: aiReply.text });

    if (aiReply.complete && aiReply.collected) {
      session.collected = aiReply.collected;
      // Save to DB and run full flow in background
      setImmediate(() => processReservation({ ...session }).catch(console.error));
      delete sessions[key]; // Clean up demo session
    }

    res.json({ text: aiReply.text, complete: aiReply.complete || false, collected: aiReply.collected || null });
  } catch (err) {
    console.error('[Demo API] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  MANAGER APPROVAL ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/manager/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'views', 'manager-dashboard.html')));

app.get('/manager/approve/:id', async (req, res) => {
  const reservation = db.getReservation(req.params.id);
  if (!reservation) return res.status(404).send(statusPage('Not Found', 'Reservation not found.', 'error'));
  if (reservation.status !== 'pending_approval') return res.send(statusPage('Already Processed', `Already ${reservation.status}.`, 'info'));

  try {
    pos.createReservation(reservation);
    const updated = db.getReservation(req.params.id);
    await sendEmail(updated, 'confirmed');
    res.send(statusPage('✓ Approved', `Reservation for <strong>${reservation.name}</strong> (${reservation.party} guests, ${reservation.datetime}) approved. Confirmation sent to ${reservation.email}.`, 'success'));
  } catch (err) {
    res.status(500).send(statusPage('Error', err.message, 'error'));
  }
});

app.get('/manager/deny/:id', async (req, res) => {
  const reservation = db.getReservation(req.params.id);
  if (!reservation) return res.status(404).send(statusPage('Not Found', 'Reservation not found.', 'error'));
  if (reservation.status !== 'pending_approval') return res.send(statusPage('Already Processed', `Already ${reservation.status}.`, 'info'));

  try {
    db.updateReservation(req.params.id, { status: 'denied', processed_at: new Date().toISOString() });
    const updated = db.getReservation(req.params.id);
    await sendEmail(updated, 'denied');
    res.send(statusPage('Denied', `Reservation for <strong>${reservation.name}</strong> denied. Guest notified at ${reservation.email}.`, 'info'));
  } catch (err) {
    res.status(500).send(statusPage('Error', err.message, 'error'));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POS BOARD — kitchen / floor display for confirmed reservations
// ═══════════════════════════════════════════════════════════════════════════

app.get('/pos', (req, res) => res.sendFile(path.join(__dirname, 'views', 'pos-board.html')));

app.get('/api/pos/today', (req, res) => {
  res.json(pos.getTodaysReservations());
});

// ═══════════════════════════════════════════════════════════════════════════
//  JSON API
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/reservations',      (req, res) => res.json(req.query.status ? db.getReservationsByStatus(req.query.status) : db.getAllReservations()));
app.get('/api/reservations/:id',  (req, res) => { const r = db.getReservation(req.params.id); return r ? res.json(r) : res.status(404).json({ error: 'Not found' }); });
app.get('/api/stats',             (req, res) => res.json(db.getStats()));
app.get('/health',                (req, res) => res.json({ status: 'ok', channels: ['voice', 'sms', 'email'], time: new Date().toISOString() }));

// Root — redirect to demo
app.get('/', (req, res) => res.redirect('/demo.html'));

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function statusPage(title, message, type) {
  const c = { success: { bg:'#f0fdf4', badge:'#dcfce7', text:'#15803d', accent:'#006747' }, info: { bg:'#eff6ff', badge:'#dbeafe', text:'#1d4ed8', accent:'#2563eb' }, error: { bg:'#fef2f2', badge:'#fee2e2', text:'#991b1b', accent:'#b91c1c' } }[type] || {};
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:${c.bg};display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}.card{background:#fff;border-radius:16px;padding:48px 40px;max-width:520px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}.badge{display:inline-block;background:${c.badge};color:${c.text};font-size:12px;font-weight:600;padding:5px 14px;border-radius:20px;margin-bottom:20px}h1{font-size:26px;font-weight:700;color:#111827;margin-bottom:14px}p{color:#374151;font-size:15px;line-height:1.6;margin-bottom:32px}a{display:inline-block;background:${c.accent};color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600}</style>
</head><body><div class="card"><div class="badge">${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'} ${type}</div><h1>${title}</h1><p>${message}</p><a href="/manager/dashboard">← Back to dashboard</a></div></body></html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🌴  Top of the Palms — Reservation Agent v2');
  console.log(`   Demo:          http://localhost:${PORT}/demo.html`);
  console.log(`   Dashboard:     http://localhost:${PORT}/manager/dashboard`);
  console.log(`   POS board:     http://localhost:${PORT}/pos`);
  console.log(`   Health:        http://localhost:${PORT}/health`);
  console.log('\n   Channels:');
  console.log(`   📞 Voice:      POST /voice/incoming  (Twilio webhook)`);
  console.log(`   💬 SMS:        POST /sms/incoming    (Twilio webhook)`);
  console.log(`   📧 Email:      POST /email/incoming  (SendGrid Inbound Parse)`);
  const missing = ['ANTHROPIC_API_KEY','TWILIO_ACCOUNT_SID','SENDGRID_API_KEY'].filter(k => !process.env[k]);
  if (missing.length) console.log(`\n⚠️  Missing: ${missing.join(', ')} — see .env.example\n`);
});
