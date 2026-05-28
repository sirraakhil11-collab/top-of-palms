require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');

const { handleIncomingEmail }                 = require('./src/emailInbound');
const { getEmailReply }                       = require('./src/agent');
const { processReservation }                  = require('./src/reservations');
const { sendEmail, sendManagerApprovalEmail } = require('./src/email');
const db = require('./src/db');

const app    = express();
const upload = multer();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'views')));

// ═══════════════════════════════════════════════════════════════════════════
//  EMAIL INBOUND
// ═══════════════════════════════════════════════════════════════════════════
app.post('/email/incoming', upload.none(), handleIncomingEmail);

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC RESERVATION FORM
// ═══════════════════════════════════════════════════════════════════════════
app.get('/reserve', (req, res) => res.sendFile(path.join(__dirname, 'views', 'reserve.html')));

app.post('/api/reserve', async (req, res) => {
  try {
    const { name, guest_type, uid, email, party, datetime_iso, datetime_display, notes } = req.body;

    if (!name || !guest_type || !uid || !email || !party || !datetime_iso)
      return res.status(400).json({ error: 'All fields are required.' });
    if (uid.replace(/\D/g,'').length !== 9)
      return res.status(400).json({ error: 'UID must be exactly 9 digits.' });

    const reservation_date = datetime_iso.slice(0, 10);
    const display = datetime_display || new Date(datetime_iso).toLocaleString('en-US', {
      month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'
    });

    const count = await db.getDailyCount(reservation_date);
    const limit = parseInt(process.env.DAILY_LIMIT || '30');
    if (count >= limit)
      return res.status(429).json({ error: `Fully booked for that date (${limit} limit). Please choose a different date.` });

    const session = {
      channel: 'form', callerNumber: email, callSid: `form-${Date.now()}`,
      collected: {
        name, status: guest_type.toLowerCase(),
        uid: uid.replace(/\D/g,''), email,
        party: parseInt(party), datetime: display,
        reservation_date, notes: notes || ''
      }
    };

    const result = await processReservation(session);
    res.json({ success: true, status: result.status });
  } catch (err) {
    console.error('[Form]', err.message);
    res.status(500).json({ error: 'Submission failed. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DEMO CHAT
// ═══════════════════════════════════════════════════════════════════════════
const demoSessions = {};
app.post('/api/demo/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) return res.status(400).json({ error: 'sessionId and message required' });
  const key = `demo:${sessionId}`;
  if (!demoSessions[key]) demoSessions[key] = { channel:'email', replyTo:'demo@test.com', messages:[], collected:null };
  const s = demoSessions[key];
  s.messages.push({ role:'user', content: s.messages.length===0 ? `I would like to make a reservation. My message: ${message}` : message });
  try {
    const r = await getEmailReply(s.messages);
    s.messages.push({ role:'assistant', content: r.text });
    if (r.complete && r.collected) {
      s.collected = r.collected;
      delete demoSessions[key];
      setImmediate(() => processReservation({ ...s }).catch(console.error));
    }
    res.json({ text: r.text, complete: r.complete||false, collected: r.collected||null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  MANAGER ROUTES
// ═══════════════════════════════════════════════════════════════════════════
app.get('/manager/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));

app.get('/manager/approve/:id', async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).send(statusPage('Not found','Reservation not found.','error'));
    if (r.status !== 'pending_approval') return res.send(statusPage('Already processed',`Already ${r.status}.`,'info'));
    await db.updateReservation(r.id, { status:'approved', processed_at: new Date().toISOString() });
    const updated = await db.getReservation(r.id);
    await sendEmail(updated, 'confirmed').catch(console.error);
    res.send(statusPage('✓ Approved',`<strong>${r.name}</strong> — ${r.party} guests on ${r.datetime}<br>Confirmation sent to ${r.email}.`,'success'));
  } catch(err) { res.status(500).send(statusPage('Error', err.message, 'error')); }
});

app.get('/manager/deny/:id', async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).send(statusPage('Not found','Reservation not found.','error'));
    if (r.status !== 'pending_approval') return res.send(statusPage('Already processed',`Already ${r.status}.`,'info'));
    await db.updateReservation(r.id, { status:'denied', processed_at: new Date().toISOString() });
    const updated = await db.getReservation(r.id);
    await sendEmail(updated, 'denied').catch(console.error);
    res.send(statusPage('Denied',`<strong>${r.name}</strong> notified at ${r.email}.`,'info'));
  } catch(err) { res.status(500).send(statusPage('Error', err.message, 'error')); }
});

app.put('/api/reservations/:id', async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    const allowed = ['name','guest_status','uid','email','party','datetime','status','notes','table_number'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (updates.status) updates.processed_at = new Date().toISOString();
    const updated = await db.updateReservation(r.id, updates);
    if (updates.status==='approved') await sendEmail(updated,'confirmed').catch(console.error);
    if (updates.status==='denied')   await sendEmail(updated,'denied').catch(console.error);
    res.json(updated);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/reservations/:id', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || pin !== (process.env.DELETE_PIN || '1234'))
      return res.status(403).json({ error:'Invalid PIN.' });
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    await db.deleteReservation(req.params.id);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ATTENDANCE
// ═══════════════════════════════════════════════════════════════════════════
app.patch('/api/reservations/:id/attendance', async (req, res) => {
  try {
    const { attendance } = req.body;
    if (!['checked_in','no_show','pending'].includes(attendance))
      return res.status(400).json({ error:'Invalid attendance value' });
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    const updated = await db.updateReservation(req.params.id, {
      attendance,
      checked_in_at: attendance === 'checked_in' ? new Date().toISOString() : null
    });
    res.json(updated);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POS BOARD
// ═══════════════════════════════════════════════════════════════════════════
app.get('/pos', (req, res) => res.sendFile(path.join(__dirname, 'views', 'pos-board.html')));

app.get('/api/pos', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const all  = await db.getAllReservations();
    const data = all.filter(r =>
      (r.status === 'approved' || r.status === 'auto_approved') &&
      r.reservation_date === date
    );
    res.json({ date, reservations: data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/pos/table/:id', async (req, res) => {
  try {
    const { table_number } = req.body;
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    const updated = await db.updateReservation(req.params.id, { table_number: table_number || '' });
    res.json(updated);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  JSON API
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/reservations', async (req, res) => {
  try {
    let data = await db.getAllReservations();
    if (req.query.status) data = data.filter(r => r.status === req.query.status);
    if (req.query.date)   data = data.filter(r => r.reservation_date === req.query.date);
    if (req.query.type)   data = data.filter(r => r.guest_status === req.query.type);
    if (req.query.search) {
      const q = req.query.search.toLowerCase();
      data = data.filter(r => r.name.toLowerCase().includes(q) || (r.email||'').toLowerCase().includes(q));
    }
    res.json(data);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reservations/:id', async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    return r ? res.json(r) : res.status(404).json({ error:'Not found' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', async (req, res) => {
  try { res.json(await db.getStats()); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (req, res) => res.json({
  status: 'ok',
  database: process.env.DATABASE_URL ? 'postgresql' : 'json-file',
  time: new Date().toISOString()
}));
app.get('/', (req, res) => res.redirect('/reserve'));

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function statusPage(title, message, type) {
  const c = {
    success:{bg:'#f0fdf4',badge:'#dcfce7',text:'#15803d',btn:'#006747'},
    info:   {bg:'#eff6ff',badge:'#dbeafe',text:'#1d4ed8',btn:'#2563eb'},
    error:  {bg:'#fef2f2',badge:'#fee2e2',text:'#991b1b',btn:'#b91c1c'}
  }[type]||{};
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:${c.bg};display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:16px;padding:40px;max-width:500px;width:100%;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.08)}
.badge{display:inline-block;background:${c.badge};color:${c.text};font-size:12px;font-weight:600;padding:4px 14px;border-radius:20px;margin-bottom:16px}
h1{font-size:22px;font-weight:700;color:#111827;margin-bottom:12px}p{color:#374151;font-size:14px;line-height:1.6;margin-bottom:28px}
a{display:inline-block;background:${c.btn};color:#fff;text-decoration:none;padding:11px 24px;border-radius:8px;font-size:14px;font-weight:600}</style>
</head><body><div class="card">
<div class="badge">${type==='success'?'✓ Success':type==='error'?'✕ Error':'ℹ Info'}</div>
<h1>${title}</h1><p>${message}</p>
<a href="/manager/dashboard">← Back to dashboard</a>
</div></body></html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🌴  Top of the Palms — Reservation Agent v9');
  console.log('─────────────────────────────────────────────');
  console.log(`   Database:    ${process.env.DATABASE_URL ? '✅ PostgreSQL (Railway)' : '📁 JSON file (local)'}`);
  console.log(`   Guest form:  http://localhost:${PORT}/reserve`);
  console.log(`   Dashboard:   http://localhost:${PORT}/manager/dashboard`);
  console.log(`   POS board:   http://localhost:${PORT}/pos`);
  console.log(`   Daily limit: ${process.env.DAILY_LIMIT || '30'}`);
  const missing = ['GROQ_API_KEY','SENDGRID_API_KEY','FROM_EMAIL','MANAGER_EMAIL'].filter(k=>!process.env[k]);
  if (missing.length) console.log(`\n⚠️  Missing: ${missing.join(', ')}`);
  else console.log('\n✅  All environment variables set\n');
});
