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
const directBill = require('./src/direct-bill');
const multerMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } }); // 10MB for doc uploads
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
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!rateLimit(ip, 'login', 10, 60000)) return res.status(429).json({ success:false, error:'Too many attempts — try again in a minute.' });
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
// multerMem.any() captures attachments (signed Direct Bill PDFs/images) into req.files
// Guard: only process email intake when enabled via service settings
app.post('/email/incoming', multerMem.any(), async (req, res, next) => {
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
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (!rateLimit(ip, 'reserve', 5, 60000)) return res.status(429).json({ error:'Too many submissions — please wait a minute.' });
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

app.delete('/api/reservations/:id', auth.requireManager, async (req, res) => {
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

    const { chartfield, foundation, inkind, pcard, signature_png } = req.body;
    if (!chartfield && !foundation && !inkind && !pcard)
      return res.status(400).json({ error: 'At least one billing field is required.' });
    if (!signature_png)
      return res.status(400).json({ error: 'Signature is required.' });

    // Generate signed PDF with all fields + signature overlaid on the template
    const pdfBuffer = await directBill.buildSignedFormPDF(r, { chartfield, foundation, inkind, pcard, signature_png });

    const ref = r.id.slice(0, 8).toUpperCase();
    const filename = `DirectBill_Signed_${ref}_${(r.name || 'Guest').replace(/\s+/g, '_')}.pdf`;
    await db.storeDocument(r.id, filename, 'application/pdf', pdfBuffer.toString('base64'), pdfBuffer.length);

    const updated = await db.updateReservation(r.id, { direct_bill_status: 'received' });

    // Notify manager that form was signed at reception
    await directBill.notifyDocReceived(updated).catch(console.error);

    res.json({ success: true, reservation: updated });
  } catch(err) {
    console.error('[Sign] Reception sign error:', err.message);
    res.status(500).json({ error: err.message });
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

// Send weekly batch — email all received docs for a date range to the manager
app.post('/api/directbill/send-batch', auth.requireManager, async (req, res) => {
  try {
    const { from_date, to_date } = req.body;
    if (!from_date || !to_date) return res.status(400).json({ error:'from_date and to_date required' });

    const docs = await db.getDocumentsByDateRange(from_date, to_date, true); // true = include base64
    if (!docs.length) return res.status(404).json({ error:'No received documents found for that date range' });

    const managerEmail = process.env.MANAGER_EMAIL;
    if (!managerEmail) return res.status(400).json({ error:'MANAGER_EMAIL not configured' });
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

    await sgMail.send({
      to:      managerEmail,
      from:    { email: FROM_EMAIL, name: 'On Top of the Palms' },
      subject: `Weekly Direct Bill Batch — ${from_date} to ${to_date} (${docs.length} document${docs.length===1?'':'s'})`,
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

    res.json({ success: true, count: docs.length, sent_to: managerEmail });
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
//  SERVICE SETTINGS (feature flags — manager only)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/settings', auth.requireManager, async (req, res) => {
  try { res.json(await db.getAllSettings()); }
  catch(err){ res.status(500).json({ error:err.message }); }
});

app.patch('/api/settings/:key', auth.requireManager, async (req, res) => {
  try {
    const allowed = ['web_form_enabled','email_intake_enabled','sms_intake_enabled'];
    if (!allowed.includes(req.params.key)) return res.status(400).json({ error:'Unknown setting key' });
    const { value } = req.body;
    if (value !== 'true' && value !== 'false') return res.status(400).json({ error:'Value must be "true" or "false"' });
    await db.updateSetting(req.params.key, value);
    console.log(`[Settings] ${req.params.key} = ${value}`);
    res.json({ key: req.params.key, value });
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
// Escape user data before embedding in HTML — prevents XSS
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Simple in-memory rate limiter — no extra packages needed
const _rl = new Map();
function rateLimit(ip, key, max, windowMs=60000){
  const k=`${key}:${ip}`, now=Date.now();
  const hits=(_rl.get(k)||[]).filter(t=>now-t<windowMs);
  if(hits.length>=max) return false;
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
