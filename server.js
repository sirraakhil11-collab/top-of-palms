require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');

const { handleIncomingEmail }                 = require('./src/emailInbound');
const { getEmailReply }                       = require('./src/agent');
const { processReservation }                  = require('./src/reservations');
const { sendEmail, sendManagerApprovalEmail } = require('./src/email');
const auth = require('./src/auth');
const db   = require('./src/db');

const app    = express();
const upload = multer();

// Parse cookies manually (no extra library needed)
app.use((req, res, next) => {
  const raw = req.headers.cookie || '';
  req.cookies = {};
  raw.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) req.cookies[k.trim()] = v.join('=').trim();
  });
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'views')));

// ═══════════════════════════════════════════════════════════════════════════
//  AUTH — PIN LOGIN
// ═══════════════════════════════════════════════════════════════════════════

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));

app.post('/api/login', (req, res) => {
  const { pin, role } = req.body;
  if (!pin || !role) return res.json({ success: false });

  const isPos     = role === 'pos'     && pin === auth.POS_PIN;
  const isManager = role === 'manager' && pin === auth.MANAGER_PIN;

  if (isPos || isManager) {
    auth.setSession(res, role);
    return res.json({ success: true, role });
  }
  res.json({ success: false });
});

app.post('/api/logout', (req, res) => {
  auth.clearSession(res);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  EMAIL INBOUND
// ═══════════════════════════════════════════════════════════════════════════
app.post('/email/incoming', upload.none(), handleIncomingEmail);

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC PAGES (no auth required)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/',        (req, res) => res.redirect('/reserve'));
app.get('/reserve', (req, res) => res.sendFile(path.join(__dirname, 'views', 'reserve.html')));
app.get('/demo.html',(req,res) => res.sendFile(path.join(__dirname, 'views', 'demo.html')));

app.post('/api/reserve', async (req, res) => {
  try {
    const { name, department, phone_ext, guest_type, uid, email, party, datetime_iso, datetime_display, reservation_time, seating_preference, payment_method, notes } = req.body;
    if (!name || !guest_type || !uid || !email || !party || !datetime_iso)
      return res.status(400).json({ error: 'All fields are required.' });
    if (uid.replace(/\D/g,'').length !== 9)
      return res.status(400).json({ error: 'UID must be exactly 9 digits.' });
    const reservation_date = datetime_iso.slice(0, 10);
    const display = datetime_display || new Date(datetime_iso).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});

    // Check people-based limit (60 covers)
    const partySize     = parseInt(party, 10);
    if (partySize < 2) return res.status(400).json({ error: 'Minimum party size is 2 guests.' });
    if (partySize > 15) return res.status(400).json({ error: 'Maximum party size is 15 guests.' });
    const currentPeople = await db.getDailyPeopleCount(reservation_date);
    const limit         = parseInt(process.env.DAILY_LIMIT || '60');
    if (currentPeople + partySize > limit) {
      const remaining = Math.max(0, limit - currentPeople);
      return res.status(429).json({ error: `Insufficient capacity for that date. Only ${remaining} covers remaining. Please reduce party size or choose a different date.` });
    }

    const session = {
      channel: 'form', callerNumber: email, callSid: `form-${Date.now()}`,
      collected: { name, department:department||'', phone_ext:phone_ext||'', status: guest_type.toLowerCase(), uid: uid.replace(/\D/g,''), email, party: partySize, datetime: display, reservation_date, reservation_time:reservation_time||'', seating_preference:seating_preference||'', payment_method:payment_method||'', notes: notes||'' }
    };
    const result = await processReservation(session);
    res.json({ success: true, status: result.status });
  } catch (err) { console.error('[Form]', err.message); res.status(500).json({ error: 'Submission failed.' }); }
});

// Demo chat
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
    if (r.complete && r.collected) { s.collected = r.collected; delete demoSessions[key]; setImmediate(() => processReservation({...s}).catch(console.error)); }
    res.json({ text: r.text, complete: r.complete||false, collected: r.collected||null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  MANAGER CONFIRMATION PAGES (no auth — linked from email)
// ═══════════════════════════════════════════════════════════════════════════

// These are the links in manager emails — show a confirmation page
// PREVENTS Outlook Safe Links from auto-executing approve/deny
app.get('/manager/confirm/:action/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'confirm-action.html'));
});

// ═══════════════════════════════════════════════════════════════════════════
//  MANAGER ROUTES (auth required)
// ═══════════════════════════════════════════════════════════════════════════

app.get('/manager/dashboard', auth.requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));

// These are only called after manager clicks confirm on the confirmation page
app.get('/manager/approve/:id', async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).send(statusPage('Not found','Reservation not found.','error'));
    if (r.status !== 'pending_approval') return res.send(statusPage('Already processed',`This reservation was already ${r.status}.`,'info'));
    await db.updateReservation(r.id, { status:'approved', processed_at: new Date().toISOString() });
    const updated = await db.getReservation(r.id);
    await sendEmail(updated, 'confirmed').catch(console.error);
    res.send(statusPage('✓ Approved',`<strong>${r.name}</strong> — ${r.party} guest${r.party===1?'':'s'} on ${r.datetime}<br>Confirmation sent to ${r.email}.`,'success'));
  } catch(err) { res.status(500).send(statusPage('Error', err.message, 'error')); }
});

app.get('/manager/deny/:id', async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).send(statusPage('Not found','Reservation not found.','error'));
    if (r.status !== 'pending_approval') return res.send(statusPage('Already processed',`This reservation was already ${r.status}.`,'info'));
    await db.updateReservation(r.id, { status:'denied', processed_at: new Date().toISOString() });
    const updated = await db.getReservation(r.id);
    await sendEmail(updated, 'denied').catch(console.error);
    res.send(statusPage('Denied',`<strong>${r.name}</strong> notified at ${r.email}.`,'info'));
  } catch(err) { res.status(500).send(statusPage('Error', err.message, 'error')); }
});

app.put('/api/reservations/:id', auth.requireManager, async (req, res) => {
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

app.delete('/api/reservations/:id', auth.requireManager, async (req, res) => {
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
//  POS BOARD (pos or manager auth)
// ═══════════════════════════════════════════════════════════════════════════

app.get('/pos', auth.requirePos, (req, res) => res.sendFile(path.join(__dirname, 'views', 'pos-board.html')));

app.get('/api/pos', auth.requirePos, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const all  = await db.getAllReservations();
    const data = all.filter(r => (r.status==='approved'||r.status==='auto_approved') && r.reservation_date===date);
    res.json({ date, reservations: data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/pos/table/:id', auth.requirePos, async (req, res) => {
  try {
    const { table_number } = req.body;
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    res.json(await db.updateReservation(req.params.id, { table_number: table_number||'' }));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/reservations/:id/attendance', auth.requirePos, async (req, res) => {
  try {
    const { attendance } = req.body;
    if (!['checked_in','no_show','pending'].includes(attendance))
      return res.status(400).json({ error:'Invalid attendance value' });
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    res.json(await db.updateReservation(req.params.id, { attendance, checked_in_at: attendance==='checked_in' ? new Date().toISOString() : null }));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Direct bill status update
app.patch('/api/reservations/:id/directbill', auth.requireManager, async (req, res) => {
  try {
    const { direct_bill_status } = req.body;
    if (!['na','pending_document','document_received'].includes(direct_bill_status))
      return res.status(400).json({ error:'Invalid status' });
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    const updated = await db.updateReservation(req.params.id, { direct_bill_status });
    // Send notification email when document received
    if (direct_bill_status === 'document_received') {
      const { sendEmail } = require('./src/email');
      // Manager can now approve — just update status, manager approves separately
      console.log(`[DirectBill] Document received for ${r.name}`);
    }
    res.json(updated);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// Resend direct bill document email
app.post('/api/reservations/:id/resend-directbill', auth.requireManager, async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    const { sendDirectBillEmail } = require('./src/email');
    await sendDirectBillEmail(r);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  JSON API
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/reservations', auth.requireManager, async (req, res) => {
  try {
    let data = await db.getAllReservations();
    if (req.query.status) data = data.filter(r => r.status === req.query.status);
    if (req.query.date)   data = data.filter(r => r.reservation_date === req.query.date);
    if (req.query.type)   data = data.filter(r => r.guest_status === req.query.type);
    if (req.query.search) { const q=req.query.search.toLowerCase(); data=data.filter(r=>r.name.toLowerCase().includes(q)||(r.email||'').toLowerCase().includes(q)); }
    res.json(data);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reservations/:id', async (req, res) => {
  try { const r=await db.getReservation(req.params.id); return r ? res.json(r) : res.status(404).json({error:'Not found'}); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', auth.requireManager, async (req, res) => {
  try { res.json(await db.getStats()); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (req, res) => res.json({ status:'ok', version:'v11', database: process.env.DATABASE_URL?'postgresql':'json-file', daily_limit: process.env.DAILY_LIMIT||'60', time: new Date().toISOString() }));

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function statusPage(title, message, type) {
  const c={success:{bg:'#f0fdf4',badge:'#dcfce7',text:'#15803d',btn:'#006747'},info:{bg:'#eff6ff',badge:'#dbeafe',text:'#1d4ed8',btn:'#2563eb'},error:{bg:'#fef2f2',badge:'#fee2e2',text:'#991b1b',btn:'#b91c1c'}}[type]||{};
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:${c.bg};display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:16px;padding:40px;max-width:500px;width:100%;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.08)}
.badge{display:inline-block;background:${c.badge};color:${c.text};font-size:12px;font-weight:600;padding:4px 14px;border-radius:20px;margin-bottom:16px}
h1{font-size:22px;font-weight:700;color:#111827;margin-bottom:12px}p{color:#374151;font-size:14px;line-height:1.6;margin-bottom:28px}
a{display:inline-block;background:${c.btn};color:#fff;text-decoration:none;padding:11px 24px;border-radius:8px;font-size:14px;font-weight:600}</style>
</head><body><div class="card"><div class="badge">${type==='success'?'✓ Success':type==='error'?'✕ Error':'ℹ Info'}</div>
<h1>${title}</h1><p>${message}</p><a href="/manager/dashboard">← Back to dashboard</a></div></body></html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🌴  Top of the Palms — Reservation Agent v11');
  console.log('─────────────────────────────────────────────');
  console.log(`   Database:    ${process.env.DATABASE_URL ? '✅ PostgreSQL' : '📁 JSON file'}`);
  console.log(`   POS PIN:     ${process.env.POS_PIN     || '5678 (default)'}`);
  console.log(`   Manager PIN: ${process.env.MANAGER_PIN || '9012 (default)'}`);
  console.log(`   Guest form:  http://localhost:${PORT}/reserve`);
  console.log(`   Dashboard:   http://localhost:${PORT}/manager/dashboard`);
  console.log(`   POS board:   http://localhost:${PORT}/pos`);
  const missing = ['GROQ_API_KEY','SENDGRID_API_KEY','FROM_EMAIL','MANAGER_EMAIL'].filter(k=>!process.env[k]);
  if (missing.length) console.log(`\n⚠️  Missing: ${missing.join(', ')}`);
  else console.log('\n✅  All set!\n');
});
