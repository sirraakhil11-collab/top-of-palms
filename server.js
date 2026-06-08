require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const crypto  = require('crypto');

const { handleIncomingEmail }                       = require('./src/emailInbound');
const { handleIncomingSMS }                         = require('./src/sms');
const { getEmailReply }                             = require('./src/agent');
const { processReservation }                        = require('./src/reservations');
const { sendEmail, sendManagerApprovalEmail, sendDirectBillEmail } = require('./src/email');
const blockedDates = require('./src/blocked-dates');
const auth = require('./src/auth');
const db   = require('./src/db');

const app    = express();
const upload = multer();

// Cookie parser
app.use((req, res, next) => {
  req.cookies = {};
  (req.headers.cookie||'').split(';').forEach(c => {
    const [k,...v] = c.trim().split('=');
    if(k) req.cookies[k.trim()] = v.join('=').trim();
  });
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'views')));

// ══════════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════════
app.get('/login', (req, res) => res.sendFile(path.join(__dirname,'views','login.html')));
app.post('/api/login', (req, res) => {
  const { pin, role } = req.body;
  if (!pin || !role) return res.json({ success:false });
  if ((role==='pos'     && pin===auth.POS_PIN) ||
      (role==='manager' && pin===auth.MANAGER_PIN)) {
    auth.setSession(res, role);
    return res.json({ success:true, role });
  }
  res.json({ success:false });
});
app.post('/api/logout', (req, res) => { auth.clearSession(res); res.json({ success:true }); });

// ══════════════════════════════════════════════════════════════════════════
//  EMAIL INBOUND (SendGrid Inbound Parse)
// ══════════════════════════════════════════════════════════════════════════
app.post('/email/incoming', upload.none(), handleIncomingEmail);

// ══════════════════════════════════════════════════════════════════════════
//  SMS INBOUND (Twilio)
//  Webhook URL to set in Twilio: https://your-app.railway.app/sms/incoming
// ══════════════════════════════════════════════════════════════════════════
app.post('/sms/incoming', upload.none(), (req, res) => {
  // Validate Twilio signature in production
  if (process.env.TWILIO_AUTH_TOKEN && process.env.NODE_ENV !== 'staging') {
    const sig     = req.headers['x-twilio-signature'] || '';
    const url     = (process.env.BASE_URL||'') + '/sms/incoming';
    const params  = req.body;
    const twilio  = require('twilio');
    const valid   = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, sig, url, params);
    if (!valid) {
      console.warn('[SMS] Invalid Twilio signature');
      res.status(403).send('Forbidden');
      return;
    }
  }
  handleIncomingSMS(req, res);
});

// ══════════════════════════════════════════════════════════════════════════
//  PUBLIC PAGES
// ══════════════════════════════════════════════════════════════════════════
app.get('/',         (req, res) => res.redirect('/reserve'));
app.get('/reserve',  (req, res) => res.sendFile(path.join(__dirname,'views','reserve.html')));
app.get('/demo.html',(req, res) => res.sendFile(path.join(__dirname,'views','demo.html')));

// ══════════════════════════════════════════════════════════════════════════
//  RESERVATION FORM API
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/reserve', async (req, res) => {
  try {
    const { name, department, phone_ext, guest_type, uid, email, party, datetime_iso, datetime_display, reservation_time, seating_preference, payment_method, notes } = req.body;

    if (!name||!guest_type||!uid||!email||!party||!datetime_iso)
      return res.status(400).json({ error:'All required fields must be filled.' });
    if (uid.replace(/\D/g,'').length !== 9)
      return res.status(400).json({ error:'USF UID must be exactly 9 digits.' });

    const partySize = parseInt(party, 10);
    if (partySize < 2)  return res.status(400).json({ error:'Minimum party size is 2 guests.' });
    if (partySize > 15) return res.status(400).json({ error:'Maximum party size is 15 guests.' });

    const reservation_date = datetime_iso.slice(0, 10);

    // Check weekday (Mon=1 ... Fri=5)
    const dayOfWeek = new Date(reservation_date+'T12:00:00').getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6)
      return res.status(400).json({ error:'We are only open Monday–Friday. Please select a weekday.' });

    // Check 24-hour advance
    const resDateTime = new Date(datetime_iso);
    if (resDateTime < new Date(Date.now() + 24*60*60*1000))
      return res.status(400).json({ error:'Reservations must be made at least 24 hours in advance. Walk-ups are welcome!' });

    // Check blocked/holiday dates
    const blocked = await blockedDates.isBlocked(reservation_date);
    if (blocked)
      return res.status(400).json({ error:`We are closed on ${reservation_date} (${blocked.reason}). Please choose another date.` });

    // People-based daily limit
    const partyN   = partySize;
    const used     = await db.getDailyPeopleCount(reservation_date);
    const limit    = parseInt(process.env.DAILY_LIMIT || '60');
    if (used + partyN > limit) {
      const left = Math.max(0, limit - used);
      return res.status(429).json({ error:`Only ${left} covers remaining for that date. Please reduce party size or choose a different date.` });
    }

    const display = datetime_display || new Date(datetime_iso).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
    const session = {
      channel:'form', callerNumber:email, callSid:`form-${Date.now()}`,
      collected:{ name, department:department||'', phone_ext:phone_ext||'', status:guest_type.toLowerCase(), uid:uid.replace(/\D/g,''), email, party:partyN, datetime:display, reservation_date, reservation_time:reservation_time||'', seating_preference:seating_preference||'', payment_method:payment_method||'', notes:notes||'' }
    };
    const result = await processReservation(session);
    res.json({ success:true, status:result.status });
  } catch(err) { console.error('[Form]',err.message); res.status(500).json({ error:'Submission failed. Please try again.' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  DEMO CHAT
// ══════════════════════════════════════════════════════════════════════════
const demoSessions = {};
app.post('/api/demo/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId||!message) return res.status(400).json({ error:'sessionId and message required' });
  const key=`demo:${sessionId}`;
  if (!demoSessions[key]) demoSessions[key]={ channel:'email', replyTo:'demo@test.com', messages:[], collected:null };
  const s=demoSessions[key];
  s.messages.push({ role:'user', content:s.messages.length===0?`I would like to make a reservation. My message: ${message}`:message });
  try {
    const r=await getEmailReply(s.messages);
    s.messages.push({ role:'assistant', content:r.text });
    if (r.complete&&r.collected){ s.collected=r.collected; delete demoSessions[key]; setImmediate(()=>processReservation({...s}).catch(console.error)); }
    res.json({ text:r.text, complete:r.complete||false, collected:r.collected||null });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  MANAGER PAGES
// ══════════════════════════════════════════════════════════════════════════
app.get('/manager/dashboard', auth.requireManager, (req,res)=>res.sendFile(path.join(__dirname,'views','dashboard.html')));
app.get('/manager/confirm/:action/:id', (req,res)=>res.sendFile(path.join(__dirname,'views','confirm-action.html')));

app.get('/manager/approve/:id', async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).send(statusPage('Not found','Reservation not found.','error'));
    if (r.status !== 'pending_approval') return res.send(statusPage('Already processed',`Already ${r.status}.`,'info'));
    await db.updateReservation(r.id,{ status:'approved', processed_at:new Date().toISOString() });
    const updated = await db.getReservation(r.id);
    await sendEmail(updated,'confirmed').catch(console.error);
    res.send(statusPage('✓ Approved',`<strong>${r.name}</strong> (${r.party} guests) on ${r.datetime}<br>Confirmation sent to ${r.email}.`,'success'));
  } catch(err){ res.status(500).send(statusPage('Error',err.message,'error')); }
});

app.get('/manager/deny/:id', async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).send(statusPage('Not found','Reservation not found.','error'));
    if (r.status !== 'pending_approval') return res.send(statusPage('Already processed',`Already ${r.status}.`,'info'));
    await db.updateReservation(r.id,{ status:'denied', processed_at:new Date().toISOString() });
    const updated = await db.getReservation(r.id);
    await sendEmail(updated,'denied').catch(console.error);
    res.send(statusPage('Denied',`<strong>${r.name}</strong> notified at ${r.email}.`,'info'));
  } catch(err){ res.status(500).send(statusPage('Error',err.message,'error')); }
});

app.put('/api/reservations/:id', auth.requireManager, async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    const allowed=['name','guest_status','department','phone_ext','uid','email','party','datetime','status','notes','table_number','seating_preference','payment_method'];
    const updates={};
    allowed.forEach(k=>{ if(req.body[k]!==undefined) updates[k]=req.body[k]; });
    if (updates.status) updates.processed_at=new Date().toISOString();
    const updated=await db.updateReservation(r.id,updates);
    if (updates.status==='approved') await sendEmail(updated,'confirmed').catch(console.error);
    if (updates.status==='denied')   await sendEmail(updated,'denied').catch(console.error);
    res.json(updated);
  } catch(err){ res.status(500).json({ error:err.message }); }
});

app.delete('/api/reservations/:id', auth.requireManager, async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin||pin!==(process.env.DELETE_PIN||'1234')) return res.status(403).json({ error:'Invalid PIN.' });
    const r=await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    await db.deleteReservation(req.params.id);
    res.json({ success:true });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  ATTENDANCE — Direct bill email sent on check-in
// ══════════════════════════════════════════════════════════════════════════
app.patch('/api/reservations/:id/attendance', auth.requirePos, async (req, res) => {
  try {
    const { attendance } = req.body;
    if (!['checked_in','no_show','pending'].includes(attendance))
      return res.status(400).json({ error:'Invalid attendance value' });
    const r=await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    const updated=await db.updateReservation(req.params.id,{
      attendance,
      checked_in_at: attendance==='checked_in' ? new Date().toISOString() : null
    });
    // Send Direct Bill document email when guest checks in
    if (attendance==='checked_in' && (r.payment_method||'').includes('Direct Bill')) {
      await sendDirectBillEmail(updated).catch(console.error);
      console.log(`[DirectBill] Document sent to ${r.email} on check-in`);
    }
    res.json(updated);
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// Direct bill status
app.patch('/api/reservations/:id/directbill', auth.requireManager, async (req, res) => {
  try {
    const { direct_bill_status } = req.body;
    if (!['na','pending_document','document_received'].includes(direct_bill_status))
      return res.status(400).json({ error:'Invalid status' });
    const r=await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    res.json(await db.updateReservation(req.params.id,{ direct_bill_status }));
  } catch(err){ res.status(500).json({ error:err.message }); }
});

app.post('/api/reservations/:id/resend-directbill', auth.requireManager, async (req, res) => {
  try {
    const r=await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    await sendDirectBillEmail(r);
    res.json({ success:true });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  POS BOARD
// ══════════════════════════════════════════════════════════════════════════
app.get('/pos', auth.requirePos, (req,res)=>res.sendFile(path.join(__dirname,'views','pos-board.html')));
app.get('/api/pos', auth.requirePos, async (req, res) => {
  try {
    const date=req.query.date||new Date().toISOString().split('T')[0];
    const all=await db.getAllReservations();
    res.json({ date, reservations:all.filter(r=>(r.status==='approved'||r.status==='auto_approved')&&r.reservation_date===date) });
  } catch(err){ res.status(500).json({ error:err.message }); }
});
app.patch('/api/pos/table/:id', auth.requirePos, async (req, res) => {
  try {
    const r=await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    res.json(await db.updateReservation(req.params.id,{ table_number:req.body.table_number||'' }));
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  BLOCKED DATES (holidays)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/blocked-dates', async (req, res) => {
  try { res.json(await blockedDates.getAllBlocked()); }
  catch(err){ res.status(500).json({ error:err.message }); }
});
app.post('/api/blocked-dates', auth.requireManager, async (req, res) => {
  try {
    const { date, reason } = req.body;
    if (!date||!reason) return res.status(400).json({ error:'Date and reason required' });
    res.json(await blockedDates.addBlocked(date, reason));
  } catch(err){ res.status(500).json({ error:err.message }); }
});
app.delete('/api/blocked-dates/:date', auth.requireManager, async (req, res) => {
  try {
    await blockedDates.removeBlocked(req.params.date);
    res.json({ success:true });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  JSON API
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/reservations', auth.requireManager, async (req, res) => {
  try {
    let data=await db.getAllReservations();
    if (req.query.status) data=data.filter(r=>r.status===req.query.status);
    if (req.query.date)   data=data.filter(r=>r.reservation_date===req.query.date);
    if (req.query.type)   data=data.filter(r=>r.guest_status===req.query.type);
    if (req.query.search){ const q=req.query.search.toLowerCase(); data=data.filter(r=>r.name.toLowerCase().includes(q)||(r.email||'').toLowerCase().includes(q)); }
    res.json(data);
  } catch(err){ res.status(500).json({ error:err.message }); }
});
app.get('/api/reservations/:id', async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    return r ? res.json(r) : res.status(404).json({ error:`Reservation ${req.params.id.slice(0,8)} not found. It may have been created before the last deployment — please use the dashboard to manage existing reservations.` });
  } catch(err) { res.status(500).json({ error:`Database error: ${err.message}` }); }
});
app.get('/api/stats', auth.requireManager, async (req, res) => {
  try { res.json(await db.getStats()); }
  catch(err){ res.status(500).json({ error:err.message }); }
});
app.get('/api/slots', async (req, res) => {
  try {
    const date=req.query.date||new Date().toISOString().split('T')[0];
    const limit=parseInt(process.env.DAILY_LIMIT||'60');
    const used=await db.getDailyPeopleCount(date);
    const blocked=await blockedDates.isBlocked(date);
    const dayOfWeek=new Date(date+'T12:00:00').getDay();
    const isWeekend=dayOfWeek===0||dayOfWeek===6;
    res.json({ date, daily_limit:limit, people_booked:used, slots_left:Math.max(0,limit-used), blocked:!!blocked, blocked_reason:blocked?.reason||null, is_weekend:isWeekend, available:!blocked&&!isWeekend });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

app.get('/health', (req,res)=>res.json({ status:'ok', version:'v14', env:process.env.NODE_ENV||'production', database:process.env.DATABASE_URL?'postgresql':'json-file', time:new Date().toISOString() }));

// ══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════
function statusPage(title,message,type){
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
  const env = process.env.NODE_ENV || 'production';
  console.log(`\n🌴  On Top of the Palms — v14 [${env.toUpperCase()}]`);
  console.log('─────────────────────────────────────────');
  console.log(`   Database:  ${process.env.DATABASE_URL?'✅ PostgreSQL':'📁 JSON file'}`);
  console.log(`   POS PIN:   ${process.env.POS_PIN?'set':'5678 (default)'}`);
  console.log(`   Manager:   ${process.env.MANAGER_PIN?'set':'9012 (default)'}`);
  console.log(`   SMS:       ${process.env.TWILIO_ACCOUNT_SID?'✅ Twilio configured':'⚠️  No Twilio (set TWILIO_ACCOUNT_SID)'}`);
  console.log(`   Email:     ${process.env.SENDGRID_API_KEY?'✅ SendGrid configured':'⚠️  No SendGrid'}`);
  console.log(`   Server:    http://localhost:${PORT}\n`);
});
