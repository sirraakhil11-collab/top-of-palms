require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const crypto  = require('crypto');

const { handleIncomingEmail }                       = require('./src/emailInbound');
const { handleIncomingSMS }                         = require('./src/sms');
const { handleIncomingCall, handleVoiceCollect, handleCallStatus } = require('./src/voice');
const { getEmailReply }                             = require('./src/agent');
const { processReservation }                        = require('./src/reservations');
const { sendEmail, sendManagerApprovalEmail, sendDirectBillEmail } = require('./src/email');
const directBill = require('./src/direct-bill');
const multerMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } }); // 10MB for doc uploads

// ── Direct Bill upload token — HMAC of reservationId, valid forever unless secret changes
function makeUploadToken(reservationId) {
  const secret = process.env.SESSION_SECRET || 'topp-secret-key-2026';
  return crypto.createHmac('sha256', secret).update(`directbill:${reservationId}`).digest('hex').slice(0, 40);
}
function verifyUploadToken(token, reservationId) {
  return token === makeUploadToken(reservationId);
}
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

// ── PWA icons — generated as SVG/PNG without needing static files ──────────
function makePwaIcon(size) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${size*0.2}" fill="#006747"/><text x="50%" y="55%" font-size="${size*0.55}" text-anchor="middle" dominant-baseline="middle" font-family="serif">🌴</text></svg>`;
  return Buffer.from(svg);
}
app.get('/icon-192.png', (req, res) => { res.setHeader('Content-Type','image/svg+xml'); res.send(makePwaIcon(192)); });
app.get('/icon-512.png', (req, res) => { res.setHeader('Content-Type','image/svg+xml'); res.send(makePwaIcon(512)); });

// ══════════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════════
app.get('/login', (req, res) => res.sendFile(path.join(__dirname,'views','login.html')));
app.post('/api/login', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!rateLimit(ip, 'login', 10, 60000)) return res.status(429).json({ success:false, error:'Too many attempts — try again in a minute.' });
  const { pin, role } = req.body;
  if (!pin || !role) return res.json({ success:false });
  if ((role==='pos'     && pin===auth.POS_PIN) ||
      (role==='manager' && pin===auth.MANAGER_PIN) ||
      (role==='admin'   && auth.ADMIN_PIN && pin===auth.ADMIN_PIN)) {
    auth.setSession(res, role);
    return res.json({ success:true, role });
  }
  res.json({ success:false });
});

// Current user info — used by dashboard to gate admin-only UI elements
app.get('/api/me', (req, res) => {
  const s = auth.getSession(req);
  if (!s) return res.status(401).json({ error:'Not authenticated' });
  res.json({ role: s.role });
});
app.post('/api/logout', (req, res) => { auth.clearSession(res); res.json({ success:true }); });

// ══════════════════════════════════════════════════════════════════════════
//  EMAIL INBOUND (SendGrid Inbound Parse)
// ══════════════════════════════════════════════════════════════════════════
// multerMem.any() captures attachments (signed Direct Bill PDFs/images) into req.files
// Guard: only process email intake when enabled via service settings
app.post('/email/incoming', multerMem.any(), async (req, res, next) => {
  // Direct Bill returns ALWAYS get processed regardless of email_intake toggle.
  // The toggle only gates NEW reservation requests via email, not document returns.
  const subject = (req.body.subject || '').toLowerCase();
  const isDirectBillReturn = subject.includes('direct bill authorization form') || subject.includes('direct bill form');
  if (isDirectBillReturn) {
    console.log('[Email] Direct Bill return — bypassing email_intake toggle');
    return next();
  }

  const s = await db.getAllSettings().catch(() => ({}));
  if (s.email_intake_enabled !== 'true') {
    console.log('[Email] Email intake is disabled — ignoring inbound email');
    return res.sendStatus(200); // Always return 200 to SendGrid
  }
  next();
}, handleIncomingEmail);

// ══════════════════════════════════════════════════════════════════════════
//  SMS INBOUND (Twilio)
//  Webhook URL to set in Twilio: https://your-app.railway.app/sms/incoming
// ══════════════════════════════════════════════════════════════════════════
app.post('/sms/incoming', upload.none(), async (req, res, next) => {
  const s = await db.getAllSettings().catch(() => ({}));
  if (s.sms_intake_enabled !== 'true') {
    console.log('[SMS] SMS intake is disabled');
    res.set('Content-Type','text/xml');
    return res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Reservations via text are not currently available. Please visit our website or call us.</Message></Response>');
  }
  next();
});

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
//  VOICE INBOUND (Twilio Voice)
//  Webhook URL to set in Twilio: https://your-app.railway.app/voice/incoming
// ══════════════════════════════════════════════════════════════════════════
app.post('/voice/incoming', upload.none(), handleIncomingCall);
app.post('/voice/collect',  upload.none(), handleVoiceCollect);
app.post('/voice/status',   upload.none(), handleCallStatus);

// ══════════════════════════════════════════════════════════════════════════
//  PUBLIC PAGES
// ══════════════════════════════════════════════════════════════════════════
app.get('/',         (req, res) => res.redirect('/reserve'));
app.get('/reserve',  (req, res) => res.sendFile(path.join(__dirname,'views','reserve.html')));
app.get('/demo.html',(req, res) => res.sendFile(path.join(__dirname,'views','demo.html')));

// ══════════════════════════════════════════════════════════════════════════
//  RESERVATION FORM API
// ══════════════════════════════════════════════════════════════════════════
// Public endpoint — lets the reserve page know if the web form is open
app.get('/api/reserve/status', async (req, res) => {
  const s = await db.getAllSettings().catch(() => ({}));
  res.json({ web_form_enabled: s.web_form_enabled === 'true' });
});

// Public endpoint — returns operating hours for the guest form time picker
app.get('/api/reserve/hours', async (req, res) => {
  const s = await db.getAllSettings().catch(() => ({}));
  res.json({ open_time: s.open_time || '11:00', close_time: s.close_time || '14:00' });
});

app.post('/api/reserve', async (req, res) => {
  try {
    // Check if web form intake is enabled
    const settings = await db.getAllSettings().catch(() => ({}));
    if (settings.web_form_enabled === 'false') {
      return res.status(503).json({ error: 'Online reservations are temporarily unavailable. Please call us or visit in person.' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (!rateLimit(ip, 'reserve', 5, 60000)) return res.status(429).json({ error:'Too many submissions — please wait a minute.' });
    const { name, department, phone_ext, guest_type, uid, email, party, num_days, datetime_iso, datetime_display, reservation_time, seating_preference, payment_method, notes } = req.body;

    if (!name||!guest_type||!email||!party||!datetime_iso)
      return res.status(400).json({ error:'All required fields must be filled.' });
    // UID is optional — validate only when provided
    const cleanUid = (uid||'').replace(/\D/g,'');
    if (cleanUid && cleanUid.length !== 9)
      return res.status(400).json({ error:'USF UID must be exactly 9 digits (or leave blank).' });

    const partySize = parseInt(party, 10);
    if (partySize < 2)  return res.status(400).json({ error:'Minimum party size is 2 guests.' });
    if (partySize > 15) return res.status(400).json({ error:'Maximum party size is 15 guests.' });

    const startDate = datetime_iso.slice(0, 10);
    const numDays   = Math.min(7, Math.max(1, parseInt(num_days || '1', 10)));

    // Check weekday for start date
    const startDay = new Date(startDate + 'T12:00:00').getDay();
    if (startDay === 0 || startDay === 6)
      return res.status(400).json({ error:'We are only open Monday–Friday. Please select a weekday.' });

    // Check 24-hour advance
    if (new Date(datetime_iso) < new Date(Date.now() + 24*60*60*1000))
      return res.status(400).json({ error:'Reservations must be made at least 24 hours in advance. Walk-ups are welcome!' });

    // Build list of valid weekdays starting from startDate (skip weekends + blocked dates)
    const reservationDates = [];
    const cursor = new Date(startDate + 'T12:00:00');
    while (reservationDates.length < numDays) {
      const iso = cursor.toISOString().split('T')[0];
      const dow = cursor.getDay();
      if (dow !== 0 && dow !== 6) {
        const bl = await blockedDates.isBlocked(iso);
        if (!bl) reservationDates.push(iso);
      }
      cursor.setDate(cursor.getDate() + 1);
      if (cursor - new Date(startDate + 'T12:00:00') > 30 * 24*60*60*1000) break; // safety: max 30 day scan
    }
    if (!reservationDates.length)
      return res.status(400).json({ error:'No available weekdays found starting from that date.' });

    const partyN   = partySize;
    const groupId  = numDays > 1 ? crypto.randomUUID() : null;
    const timeStr  = datetime_iso.slice(11,16); // HH:MM
    const displayTime = new Date(datetime_iso).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });

    const createdReservations = [];
    const skippedDates = [];

    for (const resDate of reservationDates) {
      const dateDisplay = new Date(resDate+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
      const datetimeDisplay = `${dateDisplay} ${displayTime}`;
      const session = {
        channel:'form', callerNumber:email, callSid:`form-${Date.now()}-${resDate}`,
        collected:{
          name, department:department||'', phone_ext:phone_ext||'',
          status:guest_type.toLowerCase(), uid:cleanUid, email, party:partyN,
          num_days:1, // each reservation = 1 day; total days shown in combined email
          group_id:groupId,
          datetime:datetimeDisplay, reservation_date:resDate,
          reservation_time:reservation_time||displayTime||'',
          seating_preference:'', payment_method:payment_method||'', notes:notes||''
        }
      };
      // Suppress individual guest + manager emails + Direct Bill for all but first day
      const isFirst = createdReservations.length === 0;
      const result = await processReservation(session, {
        suppressGuestEmail:   true,     // we send one combined guest email after
        suppressManagerEmail: true,     // we send one combined manager email after
        suppressDirectBill:   !isFirst  // only send Direct Bill form on first day
      });
      if (result.success) {
        createdReservations.push({ date: resDate, display: datetimeDisplay, reservation: result.reservation });
      } else {
        skippedDates.push({ date: resDate, reason: result.reason });
      }
    }

    if (!createdReservations.length)
      return res.status(429).json({ error:'No dates could be booked — capacity may be full. Please try different dates.' });

    // Send ONE combined manager notification (all days in one email)
    if (process.env.SENDGRID_API_KEY && process.env.MANAGER_EMAIL && createdReservations.length) {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      const FROM_EMAIL = process.env.FROM_EMAIL || 'reservations@topofthepalms.usf.edu';
      const firstRes = createdReservations[0].reservation;
      const firstId  = firstRes.id;
      const baseUrl  = process.env.BASE_URL || 'https://top-of-palms-staging.up.railway.app';
      const mgr_dateRows = createdReservations.map(d =>
        `<tr><td style="padding:6px 12px;border-bottom:1px solid #f3f4f6">${esc(d.display)}</td>
         <td style="padding:6px 12px;border-bottom:1px solid #f3f4f6">
           <a href="${baseUrl}/manager/approve/${d.reservation.id}" style="color:#006747;font-weight:600;text-decoration:none">Approve</a> &nbsp;|&nbsp;
           <a href="${baseUrl}/manager/deny/${d.reservation.id}" style="color:#b91c1c;text-decoration:none">Deny</a>
         </td></tr>`
      ).join('');
      await sgMail.send({
        to: process.env.MANAGER_EMAIL, from: { email: FROM_EMAIL, name: 'On Top of the Palms' },
        subject: `New Reservation Request — ${name} · ${createdReservations.length} day${createdReservations.length>1?'s':''} · Party of ${partyN}`,
        html: `<div style="font-family:sans-serif;padding:20px;max-width:560px">
          <h2 style="color:#006747">New Reservation Request</h2>
          <p><strong>${esc(name)}</strong> (${esc(guest_type)}) has requested ${createdReservations.length} day${createdReservations.length>1?'s':''} for a party of ${partyN}.</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e5e7eb;margin:12px 0">
            <thead><tr style="background:#f9fafb"><th style="padding:8px 12px;text-align:left">Date &amp; Time</th><th style="padding:8px 12px;text-align:left">Action</th></tr></thead>
            <tbody>${mgr_dateRows}</tbody>
          </table>
          <p style="font-size:13px;color:#374151"><strong>Email:</strong> ${esc(email)}<br>
          <strong>Department:</strong> ${esc(department||'—')}<br>
          <strong>Payment:</strong> ${esc(payment_method||'—')}<br>
          ${notes ? `<strong>Notes:</strong> ${esc(notes)}` : ''}</p>
        </div>`
      }).catch(e => console.error('[Manager email]', e.message));
    }

    // Send ONE combined confirmation email to guest
    if (process.env.SENDGRID_API_KEY && email) {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      const FROM_EMAIL = process.env.FROM_EMAIL || 'reservations@topofthepalms.usf.edu';
      const dateRows = createdReservations.map(d =>
        `<tr><td style="padding:6px 12px;border-bottom:1px solid #f3f4f6">${d.display}</td><td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;color:#006747;font-weight:600">Pending approval</td></tr>`
      ).join('');
      const skippedNote = skippedDates.length ? `<p style="font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;padding:10px;border-radius:6px;margin-top:12px">⚠️ ${skippedDates.length} date${skippedDates.length>1?'s were':' was'} unavailable (fully booked) and skipped.</p>` : '';
      await sgMail.send({
        to: email, from: { email: FROM_EMAIL, name: 'On Top of the Palms' },
        subject: `Reservation Request Received — ${createdReservations.length} day${createdReservations.length>1?'s':''} | On Top of the Palms`,
        html: `<div style="font-family:-apple-system,sans-serif;background:#f3f4f6;padding:24px 16px"><div style="max-width:560px;margin:0 auto">
          <div style="background:#006747;border-radius:10px 10px 0 0;padding:18px 24px"><h1 style="color:#fff;font-size:17px;font-weight:700;margin:0">On Top of the Palms</h1><p style="color:#a7d9c2;font-size:11px;margin:2px 0 0">USF Dining · Compass USA</p></div>
          <div style="background:#fff;border-radius:0 0 10px 10px;padding:24px 28px">
            <h2 style="color:#111827;font-size:17px;margin:0 0 12px">Hi ${name}, your request is submitted!</h2>
            <p style="color:#374151;font-size:14px;margin:0 0 16px">We received your reservation request for <strong>${createdReservations.length} day${createdReservations.length>1?'s':''}</strong>. A manager will review and confirm each date.</p>
            <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
              <thead><tr style="background:#f9fafb"><th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Date &amp; Time</th><th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Status</th></tr></thead>
              <tbody>${dateRows}</tbody>
            </table>
            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;font-size:13px;margin-bottom:16px">
              <div><strong>Party size:</strong> ${partyN} guest${partyN>1?'s':''}</div>
              <div><strong>Payment:</strong> ${payment_method||'—'}</div>
            </div>
            ${skippedNote}
            ${(payment_method||'').includes('Direct Bill') ? '<p style="font-size:13px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;padding:10px;border-radius:6px">📄 A Direct Bill authorization form has been sent to you separately. Please complete and return it.</p>' : ''}
            <p style="font-size:12px;color:#9ca3af;margin-top:16px">Walk-ups are always welcome based on availability.</p>
          </div></div></div>`
      }).catch(console.error);
    }

    res.json({ success:true, status:'pending', days_booked: createdReservations.length, days_skipped: skippedDates.length });
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
    res.send(statusPage('✓ Approved',`<strong>${esc(r.name)}</strong> (${esc(String(r.party))} guests) on ${esc(r.datetime)}<br>Confirmation sent to ${esc(r.email)}.`,'success'));
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
    res.send(statusPage('Denied',`<strong>${esc(r.name)}</strong> notified at ${esc(r.email)}.`,'info'));
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
    // Smart direct_bill_status: only transition, never downgrade sent/received
    if (updates.payment_method !== undefined) {
      const hadDB = (r.payment_method||'').includes('Direct Bill');
      const hasDB = (updates.payment_method||'').includes('Direct Bill');
      if (!hadDB && hasDB) {
        updates.direct_bill_status = 'pending_send';
      } else if (hadDB && !hasDB) {
        updates.direct_bill_status = 'na';
      }
    }
    const updated=await db.updateReservation(r.id,updates);
    if (updates.status==='approved') await sendEmail(updated,'confirmed').catch(console.error);
    if (updates.status==='denied')   await sendEmail(updated,'denied').catch(console.error);
    res.json(updated);
  } catch(err){ res.status(500).json({ error:err.message }); }
});

app.delete('/api/reservations/:id', auth.requireAdmin, async (req, res) => {
  try {
    const { pin } = req.body;
    const deletePIN = process.env.DELETE_PIN;
    if (!deletePIN) console.warn('[SECURITY] DELETE_PIN env var not set — set it in Railway Variables before going to production!');
    if (!pin || pin!==(deletePIN||'1234')) return res.status(403).json({ error:'Invalid PIN.' });
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

// ══════════════════════════════════════════════════════════════════════════
//  DIRECT BILL SERVICE
//  Modular: change direct-bill.js to update form or email templates
//  Change db.storeDocument() to switch to S3/Cloudinary in future
// ══════════════════════════════════════════════════════════════════════════

// Send authorization form PDF to guest
app.post('/api/reservations/:id/directbill/send', auth.requireManager, async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    const result = await directBill.sendDirectBillForm(r);
    const updated = await db.updateReservation(r.id, { direct_bill_status:'sent' });
    res.json({ success:true, email_sent:result.success, reservation:updated });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// Manager uploads the received signed document
app.post('/api/reservations/:id/directbill/upload', auth.requireManager, multerMem.single('document'), async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    if (!req.file) return res.status(400).json({ error:'No file uploaded' });

    const b64      = req.file.buffer.toString('base64');
    const filename = req.file.originalname || `DirectBill_${r.id.slice(0,8)}.pdf`;
    const doc      = await db.storeDocument(r.id, filename, req.file.mimetype, b64, req.file.size);
    const updated  = await db.updateReservation(r.id, { direct_bill_status:'received' });

    // Notify manager + guest
    await directBill.notifyDocReceived(updated).catch(console.error);

    res.json({ success:true, document:doc, reservation:updated });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// In-person reception signing page (POS + manager access)
app.get('/directbill/sign', auth.requirePos, (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'sign-directbill.html'))
);

// In-person reception signing — generate signed PDF, store, update status
app.post('/api/reservations/:id/directbill/sign-reception', auth.requirePos, async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });

    const { billing_type, attn_name, department, email, phone, guest_name,
            inkind_account, approver_email, signature_png } = req.body;

    if (!billing_type || !['pcard','inkind'].includes(billing_type))
      return res.status(400).json({ error: 'Please select P-Card or In-Kind billing.' });
    if (!signature_png)
      return res.status(400).json({ error: 'Signature is required.' });
    if (billing_type === 'inkind' && (!inkind_account || !approver_email))
      return res.status(400).json({ error: 'In-Kind account name and approver email are required.' });

    const billing = { billing_type, attn_name, department, email, phone, guest_name,
                      inkind_account, approver_email, signature_png };

    // Generate signed PDF
    const pdfBuffer = await directBill.buildCompletedPDF(r, billing);
    const ref = r.id.slice(0, 8).toUpperCase();
    const fname = `DirectBill_Signed_${ref}_${(r.name||'Guest').replace(/\s+/g,'_')}.pdf`;
    await db.storeDocument(r.id, fname, 'application/pdf', pdfBuffer.toString('base64'), pdfBuffer.length);

    const updated = await db.updateReservation(r.id, {
      direct_bill_status: 'received',
      direct_bill_data:   JSON.stringify(billing)
    });

    // If In-Kind, also send approval email to manager for records
    if (billing_type === 'inkind' && approver_email) {
      const approvalToken = directBill.makeApprovalToken(r.id);
      await db.updateReservation(r.id, { direct_bill_approval_token: approvalToken });
      directBill.sendInKindApprovalRequest(r, billing, approvalToken).catch(console.error);
    }

    await directBill.notifyDocReceived(updated).catch(console.error);
    res.json({ success: true, reservation: updated });
  } catch(err) {
    console.error('[Sign] Reception sign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Guest-facing Direct Bill upload page (public, token-protected) ────────────
// Serve the upload UI
app.get('/directbill/upload/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'directbill-upload.html'));
});

// Return reservation info for the upload page (validates token, no auth cookie needed)
app.get('/api/directbill/upload-info/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const all   = await db.getAllReservations();
    const r     = all.find(r => makeUploadToken(r.id) === token);
    if (!r) return res.status(404).json({ error: 'This link is invalid. Please contact us for a new one.' });
    if (r.direct_bill_status === 'received') {
      return res.status(410).json({ error: 'A signed form has already been received for this reservation. If you need to re-submit, please contact us.' });
    }
    const PHONE = process.env.RESTAURANT_PHONE || '(813) 974-3573';
    res.json({
      ref:        r.id.slice(0, 8).toUpperCase(),
      name:       r.name,
      datetime:   r.datetime,
      party:      r.party,
      department: r.department,
      phone:      PHONE
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Accept the uploaded signed form (public, token-protected)
app.post('/api/directbill/upload/:token', multerMem.single('file'), async (req, res) => {
  try {
    const token = req.params.token;
    const all   = await db.getAllReservations();
    const r     = all.find(r => makeUploadToken(r.id) === token);
    if (!r) return res.status(404).json({ error: 'Invalid upload link.' });
    if (r.direct_bill_status === 'received') {
      return res.status(410).json({ error: 'A form has already been received for this reservation.' });
    }

    if (!req.file) return res.status(400).json({ error: 'No file received. Please attach a file and try again.' });

    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    if (!allowed.includes(req.file.mimetype) && !req.file.originalname.match(/\.(pdf|jpg|jpeg|png)$/i)) {
      return res.status(400).json({ error: 'Only PDF, JPG, and PNG files are accepted.' });
    }

    const ref      = r.id.slice(0, 8).toUpperCase();
    const filename = `DirectBill_Signed_${ref}_${(r.name || 'Guest').replace(/\s+/g, '_')}_${Date.now()}${req.file.originalname.slice(req.file.originalname.lastIndexOf('.'))}`;
    const b64      = req.file.buffer.toString('base64');

    await db.storeDocument(r.id, filename, req.file.mimetype, b64, req.file.size);
    const updated = await db.updateReservation(r.id, { direct_bill_status: 'received' });

    console.log(`[DirectBill] ✓ Signed form uploaded by guest — ${r.name} (${ref}), ${req.file.size} bytes`);

    // Notify manager + confirm to guest (non-blocking)
    directBill.notifyDocReceived(updated).catch(e => console.error('[DirectBill] Notify error:', e.message));

    res.json({ success: true });
  } catch (err) {
    console.error('[DirectBill] Upload error:', err.message);
    res.status(500).json({ error: 'Upload failed. Please try again or contact us.' });
  }
});

// Mark as received without file (manual override)
app.post('/api/reservations/:id/directbill/received', auth.requireManager, async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    const updated = await db.updateReservation(r.id, { direct_bill_status:'received' });
    await directBill.notifyDocReceived(updated).catch(console.error);
    res.json({ success:true, reservation:updated });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// Get documents for a reservation
app.get('/api/reservations/:id/documents', auth.requireManager, async (req, res) => {
  try { res.json(await db.getDocuments(req.params.id)); }
  catch(err){ res.status(500).json({ error:err.message }); }
});

// Download a specific document
app.get('/api/documents/:docId/download', auth.requireManager, async (req, res) => {
  try {
    const doc = await db.getDocumentById(req.params.docId);
    if (!doc) return res.status(404).json({ error:'Document not found' });
    const buf = Buffer.from(doc.data_base64, 'base64');
    res.set({ 'Content-Type':doc.mimetype||'application/pdf', 'Content-Disposition':`attachment; filename="${doc.filename}"`, 'Content-Length':buf.length });
    res.send(buf);
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// List received documents across reservations for a date range (no base64 — for the dashboard table)
app.get('/api/directbill/documents', auth.requireManager, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error:'from and to date params required (YYYY-MM-DD)' });
    const docs = await db.getDocumentsByDateRange(from, to);
    res.json(docs);
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// Send batch — email selected docs to a specified recipient
// Accepts: { from_date, to_date, doc_ids (optional array), recipient_email, save_email (bool) }
app.post('/api/directbill/send-batch', auth.requireManager, async (req, res) => {
  try {
    const { from_date, to_date, doc_ids, recipient_email, save_email } = req.body;

    // Resolve docs: either by specific IDs or by date range
    let docs;
    if (doc_ids && Array.isArray(doc_ids) && doc_ids.length > 0) {
      const all = await db.getDocumentsByDateRange('1900-01-01','2999-12-31',true);
      docs = all.filter(d => doc_ids.includes(d.id));
    } else {
      if (!from_date || !to_date) return res.status(400).json({ error:'from_date and to_date required when not specifying doc_ids' });
      docs = await db.getDocumentsByDateRange(from_date, to_date, true);
    }
    if (!docs.length) return res.status(404).json({ error:'No documents found for the given selection' });

    // Resolve recipient — use provided email or fall back to MANAGER_EMAIL
    const toEmail = (recipient_email || '').trim() || process.env.MANAGER_EMAIL;
    if (!toEmail) return res.status(400).json({ error:'No recipient email provided and MANAGER_EMAIL not configured' });

    // Optionally save the email for future use
    if (save_email && recipient_email) {
      await db.updateSetting('batch_recipient_email', recipient_email.trim()).catch(()=>{});
    }

    if (!process.env.SENDGRID_API_KEY) return res.status(400).json({ error:'SENDGRID_API_KEY not configured' });
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const FROM_EMAIL = process.env.FROM_EMAIL || 'reservations@topofthepalms.usf.edu';

    // Build attachments array
    const attachments = docs.map(d => ({
      content:     d.data_base64,
      filename:    d.filename,
      type:        d.mimetype || 'application/pdf',
      disposition: 'attachment'
    }));

    // Build summary table rows
    const rows = docs.map(d => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6">${d.name||'—'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6">${d.department||'—'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6">${d.reservation_date||'—'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6">$${((d.party||0)*12.75).toFixed(2)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;font-size:11px;color:#6b7280">${d.filename}</td>
      </tr>`).join('');

    const rangeLabel = from_date && to_date ? `${from_date} to ${to_date}` : `${docs.length} selected document${docs.length===1?'':'s'}`;
    await sgMail.send({
      to:      toEmail,
      from:    { email: FROM_EMAIL, name: 'On Top of the Palms' },
      subject: `Direct Bill Batch — ${rangeLabel} (${docs.length} document${docs.length===1?'':'s'})`,
      attachments,
      html: `<div style="font-family:-apple-system,sans-serif;padding:24px;max-width:640px">
        <h2 style="color:#006747">📋 Weekly Direct Bill Batch</h2>
        <p style="font-size:14px;color:#374151;margin-bottom:4px">Date range: <strong>${from_date}</strong> to <strong>${to_date}</strong></p>
        <p style="font-size:14px;color:#374151;margin-bottom:20px">Total documents: <strong>${docs.length}</strong></p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
          <thead><tr style="background:#f9fafb">
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Guest</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Department</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Date</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Amount</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">File</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="font-size:12px;color:#9ca3af;margin-top:20px">All signed documents are attached to this email. Generated by On Top of the Palms reservation system.</p>
      </div>`
    });

    res.json({ success: true, count: docs.length, sent_to: toEmail });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// Update direct bill status manually
app.patch('/api/reservations/:id/directbill', auth.requireManager, async (req, res) => {
  try {
    const { direct_bill_status } = req.body;
    if (!['na','pending_send','sent','received'].includes(direct_bill_status))
      return res.status(400).json({ error:'Invalid status' });
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    res.json(await db.updateReservation(req.params.id,{ direct_bill_status }));
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  DIRECT BILL — WEB FORM FLOW (guest fills billing details online)
// ══════════════════════════════════════════════════════════════════════════

// Serve guest-facing billing form
app.get('/directbill/form/:token', (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'directbill-form.html'))
);

// Return pre-fill data for the form page
app.get('/api/directbill/form-info/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const all   = await db.getAllReservations();
    const r     = all.find(r => directBill.makeUploadToken(r.id) === token);
    if (!r) return res.status(404).json({ error:'This link is invalid. Please contact us.' });
    if (r.direct_bill_status === 'received') {
      return res.status(410).json({ error:'This form has already been completed. Contact us if you need help.' });
    }
    const rate = await directBill.getRate();
    res.json({
      ref:              r.id.slice(0,8).toUpperCase(),
      name:             r.name,
      email:            r.email,
      phone_ext:        r.phone_ext,
      department:       r.department,
      datetime:         r.datetime,
      reservation_date: r.reservation_date,
      reservation_time: r.reservation_time,
      party:            r.party,
      num_days:         r.num_days || 1,
      rate
    });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// Handle form submission — P-Card completes immediately, In-Kind sends approval email
app.post('/api/directbill/form/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const all   = await db.getAllReservations();
    const r     = all.find(r => directBill.makeUploadToken(r.id) === token);
    if (!r) return res.status(404).json({ error:'Invalid link.' });
    if (r.direct_bill_status === 'received') {
      return res.status(410).json({ error:'This form has already been completed.' });
    }

    const { billing_type, attn_name, department, email, phone, guest_name, inkind_account, approver_email } = req.body;
    if (!['pcard','inkind'].includes(billing_type)) return res.status(400).json({ error:'Invalid billing type.' });
    if (!attn_name || !email || !guest_name) return res.status(400).json({ error:'Required fields missing.' });
    if (billing_type === 'inkind' && (!inkind_account || !approver_email)) {
      return res.status(400).json({ error:'In-Kind account and approver email are required.' });
    }

    const billing = { billing_type, attn_name, department, email, phone, guest_name, inkind_account, approver_email };

    if (billing_type === 'pcard') {
      // P-Card: generate PDF immediately and mark received
      const pdfBuf = await directBill.buildCompletedPDF(r, billing);
      const ref    = r.id.slice(0,8).toUpperCase();
      const fname  = `DirectBill_PCard_${ref}_${(r.name||'Guest').replace(/\s+/g,'_')}.pdf`;
      await db.storeDocument(r.id, fname, 'application/pdf', pdfBuf.toString('base64'), pdfBuf.length);
      await db.updateReservation(r.id, {
        direct_bill_status: 'received',
        direct_bill_data:   JSON.stringify(billing)
      });
      directBill.notifyDocReceived({ ...r, ...billing }).catch(console.error);
      return res.json({ success:true, type:'pcard' });
    }

    // In-Kind: store billing data + send approval email
    const approvalToken = directBill.makeApprovalToken(r.id);
    await db.updateReservation(r.id, {
      direct_bill_status:       'sent',
      direct_bill_data:          JSON.stringify(billing),
      direct_bill_approval_token: approvalToken
    });
    await directBill.sendInKindApprovalRequest(r, billing, approvalToken);
    return res.json({ success:true, type:'inkind' });
  } catch(err){
    console.error('[DirectBill] Form submit error:', err.message);
    res.status(500).json({ error:'Submission failed. Please try again.' });
  }
});

// Serve approval page for the approver manager
app.get('/directbill/approve/:token', (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'directbill-approve.html'))
);

// Return approval info for the approval page
app.get('/api/directbill/approve-info/:token', async (req, res) => {
  try {
    const token = req.params.token;
    if (!token) return res.status(400).json({ error:'Missing token.' });
    const all = await db.getAllReservations();
    const r   = all.find(r => r.direct_bill_approval_token === token);
    if (!r) return res.status(404).json({ error:'This approval link is invalid or has expired.' });
    if (r.direct_bill_status === 'received') {
      return res.json({ already_approved: true });
    }
    const billing  = r.direct_bill_data ? JSON.parse(r.direct_bill_data) : {};
    const rate     = await directBill.getRate();
    const amtDue   = '$' + (r.party * Math.max(1, parseInt(r.num_days||1)) * rate).toFixed(2);
    res.json({
      name:           r.name,
      datetime:       r.datetime,
      party:          r.party,
      inkind_account: billing.inkind_account || '',
      amount:         amtDue
    });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// Process approval — generate PDF, store, notify
app.post('/api/directbill/approve/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const all   = await db.getAllReservations();
    const r     = all.find(r => r.direct_bill_approval_token === token);
    if (!r) return res.status(404).json({ error:'Invalid approval link.' });
    if (r.direct_bill_status === 'received') {
      return res.json({ success:true, already_approved:true });
    }
    const billing = r.direct_bill_data ? JSON.parse(r.direct_bill_data) : {};
    const pdfBuf  = await directBill.buildCompletedPDF(r, billing);
    const ref     = r.id.slice(0,8).toUpperCase();
    const fname   = `DirectBill_InKind_Approved_${ref}_${(r.name||'Guest').replace(/\s+/g,'_')}.pdf`;
    await db.storeDocument(r.id, fname, 'application/pdf', pdfBuf.toString('base64'), pdfBuf.length);
    const updated = await db.updateReservation(r.id, { direct_bill_status:'received' });
    directBill.notifyDocReceived(updated).catch(console.error);
    res.json({ success:true });
  } catch(err){
    console.error('[DirectBill] Approval error:', err.message);
    res.status(500).json({ error:'Approval failed. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  REVENUE API (manager only)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/revenue', auth.requireManager, async (req, res) => {
  try {
    const all  = await db.getAllReservations();
    const rate = await directBill.getRate();
    const active = all.filter(r => ['approved','auto_approved','pending_approval'].includes(r.status));

    // Monthly breakdown
    const monthly = {};
    for (const r of active) {
      const mon = (r.reservation_date || r.created_at || '').slice(0,7);
      if (!mon) continue;
      if (!monthly[mon]) monthly[mon] = { month:mon, reservations:0, guests:0, revenue:0, direct_bill:0, other:0 };
      const amt = r.party * Math.max(1, parseInt(r.num_days||1)) * rate;
      monthly[mon].reservations++;
      monthly[mon].guests    += r.party;
      monthly[mon].revenue   += amt;
      const isDB = (r.payment_method||'').includes('Direct Bill');
      if (isDB) monthly[mon].direct_bill += amt;
      else      monthly[mon].other       += amt;
    }
    const months = Object.values(monthly).sort((a,b) => b.month.localeCompare(a.month));

    const totalGuests  = active.reduce((s,r) => s + r.party, 0);
    const totalRevenue = active.reduce((s,r) => s + r.party * Math.max(1, parseInt(r.num_days||1)) * rate, 0);
    const dbRevenue    = active.filter(r=>(r.payment_method||'').includes('Direct Bill'))
                               .reduce((s,r) => s + r.party * Math.max(1, parseInt(r.num_days||1)) * rate, 0);
    const checkedIn    = all.filter(r => r.attendance === 'checked_in');
    const actualRevenue= checkedIn.reduce((s,r) => s + r.party * Math.max(1, parseInt(r.num_days||1)) * rate, 0);

    res.json({
      rate,
      total_reservations: active.length,
      total_guests:       totalGuests,
      estimated_revenue:  +totalRevenue.toFixed(2),
      actual_revenue:     +actualRevenue.toFixed(2),
      direct_bill_revenue:+dbRevenue.toFixed(2),
      other_revenue:      +(totalRevenue - dbRevenue).toFixed(2),
      monthly
    });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  PUBLIC RATE endpoint (no auth — needed by reserve.html)
// ══════════════════════════════════════════════════════════════════════════
// Debug: shows what base URL the server will use in emails (manager only)
app.get('/api/debug/baseurl', auth.requireManager, (req, res) => {
  const safeUrl  = process.env.SAFE_URL || null;
  const base     = (process.env.BASE_URL || '').trim().replace(/\/$/,'');
  const resolved = safeUrl
    ? safeUrl
    : base && base.includes('railway.app')
      ? base
      : 'https://top-of-palms-staging.up.railway.app';
  res.json({
    SAFE_URL:              safeUrl,
    RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN || null,
    BASE_URL:              process.env.BASE_URL || null,
    resolved_url:          resolved,
    is_safe:               resolved.includes('railway.app') || (safeUrl && !safeUrl.includes('chartwells.com'))
  });
});

app.get('/api/public/rate', async (req, res) => {
  try {
    const s    = await db.getAllSettings();
    const rate = parseFloat(s.direct_bill_rate) || 12.75;
    res.json({ rate });
  } catch { res.json({ rate: 12.75 }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  SERVICE SETTINGS (feature flags — manager only)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/settings', auth.requireManager, async (req, res) => {
  try { res.json(await db.getAllSettings()); }
  catch(err){ res.status(500).json({ error:err.message }); }
});

app.patch('/api/settings/:key', auth.requireManager, async (req, res) => {
  try {
    const adminOnly = ['web_form_enabled','email_intake_enabled','sms_intake_enabled'];
    const managerOk = ['open_time','close_time','direct_bill_rate','daily_limit'];
    const key = req.params.key;
    if (!adminOnly.includes(key) && !managerOk.includes(key))
      return res.status(400).json({ error:'Unknown setting key' });
    if (adminOnly.includes(key)) {
      const sess = auth.getSession(req);
      if (!sess || sess.role !== 'admin') return res.status(403).json({ error:'Admin access required' });
      const { value } = req.body;
      if (value !== 'true' && value !== 'false') return res.status(400).json({ error:'Value must be "true" or "false"' });
      await db.updateSetting(key, value);
      return res.json({ key, value });
    }
    const { value } = req.body;
    if (key === 'direct_bill_rate') {
      const n = parseFloat(value);
      if (isNaN(n) || n <= 0 || n > 999) return res.status(400).json({ error:'Rate must be a positive number.' });
      await db.updateSetting(key, n.toFixed(2));
      console.log(`[Settings] direct_bill_rate = ${n.toFixed(2)}`);
      return res.json({ key, value: n.toFixed(2) });
    }
    if (key === 'daily_limit') {
      const n = parseInt(value);
      if (isNaN(n) || n < 1 || n > 500) return res.status(400).json({ error:'Limit must be 1–500.' });
      await db.updateSetting(key, String(n));
      console.log(`[Settings] daily_limit = ${n}`);
      return res.json({ key, value: String(n) });
    }
    if (!/^\d{1,2}:\d{2}$/.test(value)) return res.status(400).json({ error:'Value must be HH:MM format' });
    await db.updateSetting(key, value);
    console.log(`[Settings] ${key} = ${value}`);
    res.json({ key, value });
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

// POS: collect Direct Bill details when switching payment at reception
app.post('/api/pos/directbill/:id', auth.requirePos, async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    const billing = req.body;
    if (!['pcard','inkind'].includes(billing.billing_type)) return res.status(400).json({ error:'Invalid billing type' });
    if (billing.billing_type === 'inkind' && (!billing.inkind_account || !billing.approver_email)) {
      return res.status(400).json({ error:'In-Kind account and approver email required' });
    }
    // Generate PDF and store it
    const pdfBuf = await directBill.buildCompletedPDF(r, billing);
    const ref    = r.id.slice(0,8).toUpperCase();
    const fname  = `DirectBill_POS_${billing.billing_type}_${ref}_${(r.name||'Guest').replace(/\s+/g,'_')}.pdf`;
    await db.storeDocument(r.id, fname, 'application/pdf', pdfBuf.toString('base64'), pdfBuf.length);
    const updated = await db.updateReservation(r.id, {
      payment_method:     (r.payment_method ? r.payment_method + ', Direct Bill' : 'Direct Bill').replace(/Direct Bill,\s*Direct Bill/,'Direct Bill'),
      direct_bill_status: 'received',
      direct_bill_data:   JSON.stringify(billing)
    });
    // If In-Kind, still send approval email to approver (for records)
    if (billing.billing_type === 'inkind' && billing.approver_email) {
      const approvalToken = directBill.makeApprovalToken(r.id);
      await db.updateReservation(r.id, { direct_bill_approval_token: approvalToken });
      directBill.sendInKindApprovalRequest(r, billing, approvalToken).catch(console.error);
    }
    directBill.notifyDocReceived(updated).catch(console.error);
    res.json({ success:true });
  } catch(err) {
    console.error('[POS DirectBill]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/pos/party/:id', auth.requirePos, async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    const party = parseInt(req.body.party);
    if (isNaN(party) || party < 1 || party > 50) return res.status(400).json({ error:'Party size must be 1–50.' });
    res.json(await db.updateReservation(req.params.id, { party }));
  } catch(err){ res.status(500).json({ error:err.message }); }
});

app.patch('/api/pos/payment/:id', auth.requirePos, async (req, res) => {
  try {
    const r = await db.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error:'Not found' });
    const payment_method = req.body.payment_method || '';
    const updates = { payment_method };
    // Smart direct_bill_status: only transition, never downgrade sent/received
    const hadDB = (r.payment_method||'').includes('Direct Bill');
    const hasDB = payment_method.includes('Direct Bill');
    if (!hadDB && hasDB) {
      updates.direct_bill_status = 'pending_send'; // newly added Direct Bill
    } else if (hadDB && !hasDB) {
      updates.direct_bill_status = 'na';           // removed Direct Bill
    }
    // If Direct Bill unchanged (or already sent/received), leave direct_bill_status alone
    res.json(await db.updateReservation(req.params.id, updates));
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
  try { const r=await db.getReservation(req.params.id); return r?res.json(r):res.status(404).json({error:'Not found'}); }
  catch(err){ res.status(500).json({ error:err.message }); }
});
app.get('/api/stats', auth.requireManager, async (req, res) => {
  try { res.json(await db.getStats()); }
  catch(err){ res.status(500).json({ error:err.message }); }
});
app.get('/api/slots', async (req, res) => {
  try {
    const date=req.query.date||new Date().toISOString().split('T')[0];
    const s=await db.getAllSettings().catch(()=>({}));
    const limit=parseInt(s.daily_limit||process.env.DAILY_LIMIT||'60');
    const used=await db.getDailyPeopleCount(date);
    const blocked=await blockedDates.isBlocked(date);
    const dayOfWeek=new Date(date+'T12:00:00').getDay();
    const isWeekend=dayOfWeek===0||dayOfWeek===6;
    res.json({ date, daily_limit:limit, people_booked:used, slots_left:Math.max(0,limit-used), blocked:!!blocked, blocked_reason:blocked?.reason||null, is_weekend:isWeekend, available:!blocked&&!isWeekend });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

app.get('/health', (req,res)=>res.json({ status:'ok', version:'v15', env:process.env.NODE_ENV||'production', database:process.env.DATABASE_URL?'postgresql':'json-file', time:new Date().toISOString() }));

// Admin-only diagnostics — shows which env vars are set (never exposes values)
app.get('/api/diagnostics', auth.requireAdmin, async (req, res) => {
  const chk = (k) => !!process.env[k];
  const settings = await db.getAllSettings().catch(()=>({}));
  res.json({
    railway_vars: {
      SENDGRID_API_KEY:    chk('SENDGRID_API_KEY'),
      FROM_EMAIL:          process.env.FROM_EMAIL || '(not set — default used)',
      MANAGER_EMAIL:       process.env.MANAGER_EMAIL || '(not set)',
      DIRECT_BILL_EMAIL:   process.env.DIRECT_BILL_EMAIL || '(not set — falls back to MANAGER_EMAIL)',
      GROQ_API_KEY:        chk('GROQ_API_KEY'),
      TWILIO_ACCOUNT_SID:  chk('TWILIO_ACCOUNT_SID'),
      TWILIO_AUTH_TOKEN:   chk('TWILIO_AUTH_TOKEN'),
      TWILIO_PHONE:        process.env.TWILIO_PHONE || '(not set)',
      BASE_URL:            process.env.BASE_URL || '(not set)',
      DIRECT_BILL_INBOUND: process.env.DIRECT_BILL_INBOUND || 'false',
      ADMIN_PIN:           chk('ADMIN_PIN'),
      SESSION_SECRET:      chk('SESSION_SECRET'),
      DATABASE_URL:        chk('DATABASE_URL'),
    },
    service_toggles: {
      web_form_enabled:    settings.web_form_enabled,
      email_intake_enabled:settings.email_intake_enabled,
      sms_intake_enabled:  settings.sms_intake_enabled,
    },
    channels: {
      email_sending:  chk('SENDGRID_API_KEY') ? '✅ ready' : '❌ SENDGRID_API_KEY missing',
      email_inbound:  chk('SENDGRID_API_KEY') && settings.email_intake_enabled==='true' ? '✅ ready' : `❌ ${!chk('SENDGRID_API_KEY')?'SENDGRID_API_KEY missing':'email_intake_enabled is off'}`,
      sms:            chk('GROQ_API_KEY') && chk('TWILIO_ACCOUNT_SID') && settings.sms_intake_enabled==='true' ? '✅ ready' : `❌ missing: ${[!chk('GROQ_API_KEY')&&'GROQ_API_KEY',!chk('TWILIO_ACCOUNT_SID')&&'TWILIO_ACCOUNT_SID',settings.sms_intake_enabled!=='true'&&'sms_intake_enabled=off'].filter(Boolean).join(', ')}`,
      voice:          chk('GROQ_API_KEY') && chk('TWILIO_ACCOUNT_SID') ? '✅ ready' : `❌ missing: ${[!chk('GROQ_API_KEY')&&'GROQ_API_KEY',!chk('TWILIO_ACCOUNT_SID')&&'TWILIO_ACCOUNT_SID'].filter(Boolean).join(', ')}`,
      direct_bill_pdf:chk('SENDGRID_API_KEY') ? '✅ ready' : '❌ SENDGRID_API_KEY missing',
      direct_bill_inbound: process.env.DIRECT_BILL_INBOUND==='true' && chk('SENDGRID_API_KEY') ? '✅ ready' : `❌ ${process.env.DIRECT_BILL_INBOUND!=='true'?'DIRECT_BILL_INBOUND not true':'SENDGRID_API_KEY missing'}`,
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════
// Escape user data before embedding in HTML — prevents XSS
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Simple in-memory rate limiter — no extra packages needed
const _rl = new Map();
function rateLimit(ip, key, max, windowMs=60000){
  const k=`${key}:${ip}`, now=Date.now();
  const hits=(_rl.get(k)||[]).filter(t=>now-t<windowMs);
  if(hits.length>max) return false;
  hits.push(now); _rl.set(k,hits); return true;
}

function statusPage(title,message,type){
  const c={success:{bg:'#f0fdf4',badge:'#dcfce7',text:'#15803d',btn:'#006747'},info:{bg:'#eff6ff',badge:'#dbeafe',text:'#1d4ed8',btn:'#2563eb'},error:{bg:'#fef2f2',badge:'#fee2e2',text:'#991b1b',btn:'#b91c1c'}}[type]||{};
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:${c.bg};display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:16px;padding:40px;max-width:500px;width:100%;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.08)}
.badge{display:inline-block;background:${c.badge};color:${c.text};font-size:12px;font-weight:600;padding:4px 14px;border-radius:20px;margin-bottom:16px}
h1{font-size:22px;font-weight:700;color:#111827;margin-bottom:12px}p{color:#374151;font-size:14px;line-height:1.6;margin-bottom:28px}
a{display:inline-block;background:${c.btn};color:#fff;text-decoration:none;padding:11px 24px;border-radius:8px;font-size:14px;font-weight:600}</style>
</head><body><div class="card"><div class="badge">${type==='success'?'✓ Success':type==='error'?'✕ Error':'ℹ Info'}</div>
<h1>${esc(title)}</h1><p>${message}</p><a href="/manager/dashboard">← Back to dashboard</a></div></body></html>`;
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
