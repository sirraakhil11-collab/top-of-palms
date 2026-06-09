/**
 * INBOUND EMAIL HANDLER
 *
 * Priority 1 — Direct Bill returns:
 *   Guest replies with signed form attached → detected by "Direct Bill Authorization Form"
 *   + Ref# in subject → attachment stored in DB → manager notified → status set to 'received'
 *
 * Priority 2 — New reservation requests via email AI agent
 *
 * Guards prevent reply-loops, automated emails, and duplicate reservations.
 */

const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const { getEmailReply }      = require('./agent');
const { processReservation } = require('./reservations');
const db          = require('./db');
const directBill  = require('./direct-bill');

// Set DIRECT_BILL_INBOUND=true in Railway Variables once MX/SendGrid is configured
const DIRECT_BILL_INBOUND = process.env.DIRECT_BILL_INBOUND === 'true';

// Active AI reservation conversations
const sessions = {};

// Cooldown: prevents duplicate reservations from stray replies
const completedAt = {};
const COOLDOWN_MS = 30 * 60 * 1000;

const FROM = process.env.FROM_EMAIL;
const NAME = 'On Top of the Palms';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function cleanEmailBody(text) {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => !line.startsWith('>'))
    .join('\n')
    .replace(/On .+?wrote:/gs, '')
    .replace(/_{3,}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractSenderEmail(from) {
  if (!from) return '';
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

function isAutomatedEmail(from, subject) {
  const f = (from || '').toLowerCase();
  const s = (subject || '').toLowerCase();
  const ourEmail = (process.env.FROM_EMAIL || '').toLowerCase();
  if (ourEmail && f.includes(ourEmail)) return true;
  if (f.includes('noreply') || f.includes('no-reply') || f.includes('donotreply')) return true;
  const autoSubjects = [
    'out of office','automatic reply','auto-reply','autoreply',
    'delivery status','undeliverable','mail delivery','delivery failed',
    'mailer-daemon','postmaster'
  ];
  if (autoSubjects.some(kw => s.includes(kw))) return true;
  return false;
}

function isReplyToOurEmail(subject) {
  const s = (subject || '').toLowerCase().trim();
  const ourSubjects = [
    'your reservation is confirmed',
    'we received your reservation request',
    'update on your reservation',
    'reservation request — fully booked',
    'action needed',
    'action required',
    'direct bill authorization form',   // Direct Bill returns caught here as fallback
    'direct bill form',
    'we received your direct bill form'
  ];
  return ourSubjects.some(kw => s.includes(kw));
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct Bill return detection
// ─────────────────────────────────────────────────────────────────────────────

function extractRefFromSubject(subject) {
  // Matches "Ref XXXXXXXX" (8 uppercase alphanumeric chars) in the subject line
  const match = (subject || '').match(/\bRef[:\s]+([A-Z0-9]{8})\b/i);
  return match ? match[1].toUpperCase() : null;
}

function isDirectBillSubject(subject) {
  const s = (subject || '').toLowerCase();
  return s.includes('direct bill authorization form') || s.includes('direct bill form');
}

async function handleDirectBillReturn(req) {
  const subject     = req.body.subject || '';
  const from        = req.body.from    || '';
  const senderEmail = extractSenderEmail(from);

  // Must be a reply to our Direct Bill form email
  if (!isDirectBillSubject(subject)) return false;

  const ref = extractRefFromSubject(subject);
  if (!ref) {
    console.log(`[DirectBill] Subject matched but no Ref found: "${subject}"`);
    return true; // Still consume — don't let AI agent process it
  }

  // Find the matching reservation
  const all = await db.getAllReservations();
  const reservation = all.find(r => r.id.slice(0, 8).toUpperCase() === ref);

  if (!reservation) {
    console.log(`[DirectBill] No reservation found for Ref ${ref} from ${senderEmail}`);
    return true; // Consume — don't process as new reservation
  }

  console.log(`[DirectBill] ✓ Return email from ${senderEmail} — Ref ${ref} (${reservation.name})`);

  // Collect attachments from multer (SendGrid sends them as attachment1, attachment2, …)
  const files = (req.files || []).filter(f =>
    f.mimetype === 'application/pdf' ||
    f.mimetype.startsWith('image/')  ||
    f.originalname?.toLowerCase().endsWith('.pdf')
  );

  // Also handle base64-encoded attachments in req.body (some email clients)
  // SendGrid provides attachment-info as a JSON field
  const attachmentInfo = (() => {
    try { return JSON.parse(req.body['attachment-info'] || '{}'); }
    catch { return {}; }
  })();

  let storedCount = 0;

  if (files.length > 0) {
    for (const file of files) {
      const b64      = file.buffer.toString('base64');
      const filename = file.originalname || `SignedDirectBill_${ref}.pdf`;
      await db.storeDocument(reservation.id, filename, file.mimetype, b64, file.size);
      storedCount++;
      console.log(`[DirectBill] Stored attachment: ${filename} (${file.size} bytes)`);
    }
  } else {
    console.log(`[DirectBill] No attachments in return email for Ref ${ref} — marking received without file`);
  }

  // Update status to received regardless of attachment (document may come separately)
  const updated = await db.updateReservation(reservation.id, { direct_bill_status: 'received' });

  // Notify manager + confirm to guest
  await directBill.notifyDocReceived(updated).catch(e =>
    console.error('[DirectBill] Notify error:', e.message)
  );

  // Extra manager notification with context about how it came in
  if (process.env.SENDGRID_API_KEY && process.env.MANAGER_EMAIL) {
    const managerUrl = (process.env.BASE_URL || 'http://localhost:3000') + '/manager/dashboard';
    await sgMail.send({
      to:      process.env.MANAGER_EMAIL,
      from:    { email: FROM, name: NAME },
      subject: `📎 Signed Direct Bill received by email — ${reservation.name} (${ref})`,
      html: `<div style="font-family:-apple-system,sans-serif;padding:20px;max-width:520px">
        <h2 style="color:#006747">📎 Signed Form Received via Email</h2>
        <p style="font-size:14px">Guest <strong>${reservation.name}</strong> replied with their completed Direct Bill form.</p>
        <table style="font-size:13px;border-collapse:collapse;width:100%;margin:12px 0">
          <tr><td style="color:#6b7280;padding:5px 0">Ref</td><td><strong>${ref}</strong></td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Guest email</td><td>${senderEmail}</td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Department</td><td>${reservation.department || '—'}</td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Dining date</td><td>${reservation.datetime}</td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Amount</td><td><strong>$${(reservation.party * 12.75).toFixed(2)}</strong></td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Attachments</td><td>${storedCount > 0 ? `${storedCount} file(s) stored` : 'None — mark manually if received separately'}</td></tr>
        </table>
        <p style="margin-top:16px">
          <a href="${managerUrl}" style="background:#006747;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600">
            View in Dashboard →
          </a>
        </p>
        <p style="font-size:11px;color:#9ca3af;margin-top:12px">The document is stored under the reservation record. Open the Direct Bill panel to download it.</p>
      </div>`
    }).catch(e => console.error('[DirectBill] Manager email error:', e.message));
  }

  console.log(`[DirectBill] Return processed — status set to 'received', ${storedCount} attachment(s) stored`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main inbound handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleIncomingEmail(req, res) {
  res.sendStatus(200); // Always respond 200 to SendGrid immediately

  const from        = req.body.from    || '';
  const subject     = req.body.subject || '';
  const rawText     = req.body.text    || req.body.html || '';
  const cleanedText = cleanEmailBody(rawText);
  const senderEmail = extractSenderEmail(from);

  if (!senderEmail) {
    console.log('[Email] No sender email — skipping');
    return;
  }

  console.log(`\n[Email] From: ${senderEmail} | Subject: "${subject}"`);

  // ── Priority 1: Direct Bill return (enabled once email MX is configured) ──
  if (DIRECT_BILL_INBOUND && isDirectBillSubject(subject)) {
    const handled = await handleDirectBillReturn(req).catch(err => {
      console.error('[DirectBill] Return handler error:', err.message);
      return false;
    });
    if (handled) {
      console.log('[Email] Handled as Direct Bill return — done');
      return;
    }
  }

  // ── Guard 1: Ignore automated emails ─────────────────────────────────────
  if (isAutomatedEmail(from, subject)) {
    console.log('[Email] Automated email detected — ignoring');
    return;
  }

  // ── Guard 2: Ignore replies to our own notification emails ────────────────
  if (isReplyToOurEmail(subject)) {
    console.log('[Email] Reply to our notification email — ignoring');
    return;
  }

  // ── Guard 3: Cooldown ─────────────────────────────────────────────────────
  const key = `email:${senderEmail}`;
  const lastCompleted = completedAt[key];
  if (lastCompleted && (Date.now() - lastCompleted) < COOLDOWN_MS) {
    const minsAgo = Math.floor((Date.now() - lastCompleted) / 60000);
    console.log(`[Email] In cooldown (${minsAgo}min since last reservation) — ignoring`);
    return;
  }

  // ── Guard 4: Short replies ────────────────────────────────────────────────
  const isReply = subject.toLowerCase().startsWith('re:');
  if (isReply && cleanedText.length < 30) {
    console.log(`[Email] Short reply "${cleanedText}" — ignoring`);
    return;
  }

  // ── AI reservation session ────────────────────────────────────────────────
  if (!sessions[key]) {
    sessions[key] = {
      channel:      'email',
      replyTo:      senderEmail,
      replySubject: isReply ? subject : `Re: ${subject || 'Your Reservation Request'}`,
      messages:     [],
      collected:    null
    };
    console.log(`[Email] New session started for ${senderEmail}`);
  } else {
    console.log(`[Email] Continuing session for ${senderEmail} (${sessions[key].messages.length} messages)`);
  }

  const session = sessions[key];
  const userContent = session.messages.length === 0
    ? `I would like to make a reservation. Here is my message: ${cleanedText}`
    : cleanedText;

  session.messages.push({ role: 'user', content: userContent });

  try {
    const aiReply = await getEmailReply(session.messages);
    session.messages.push({ role: 'assistant', content: aiReply.text });

    if (process.env.SENDGRID_API_KEY) {
      await sgMail.send({
        to:      session.replyTo,
        from:    { email: FROM, name: `${NAME} Reservations` },
        subject: session.replySubject,
        text:    aiReply.text,
        html:    `<div style="font-family:-apple-system,sans-serif;font-size:15px;line-height:1.7;color:#111827;max-width:560px">${aiReply.text.replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>')}</div>`
      });
      console.log(`[Email] Reply sent to ${session.replyTo}`);
    } else {
      console.log(`\n[Email] Would reply:\n${aiReply.text}`);
    }

    if (aiReply.complete && aiReply.collected) {
      session.collected         = aiReply.collected;
      session.collected.email   = session.collected.email || senderEmail;
      session.collected.channel = 'email';
      delete sessions[key];
      completedAt[key] = Date.now();
      setTimeout(() => delete completedAt[key], COOLDOWN_MS);
      console.log(`[Email] Reservation collected for ${senderEmail} — processing`);
      setImmediate(() =>
        processReservation(session).catch(err =>
          console.error('[Email] Processing error:', err)
        )
      );
    }
  } catch (err) {
    console.error('[Email] Agent error:', err.message);
    if (process.env.SENDGRID_API_KEY) {
      await sgMail.send({
        to:      senderEmail,
        from:    { email: FROM, name: `${NAME} Reservations` },
        subject: sessions[key]?.replySubject || 'Re: Your message',
        text:    "We're sorry, something went wrong. Please reply and we'll assist you with your reservation."
      }).catch(() => {});
    }
  }
}

module.exports = { handleIncomingEmail, sessions };
