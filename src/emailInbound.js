/**
 * INBOUND EMAIL HANDLER — with reply-loop protection
 *
 * Bug fixes in this version:
 *   1. Ignores automated replies (Out of Office, delivery receipts, noreply)
 *   2. Ignores emails FROM our own address (prevents infinite loop)
 *   3. Ignores reply emails that come in AFTER reservation is already created
 *      (guest replies "thank you" to confirmation → used to trigger a new session)
 *   4. Cooldown per email address — 30 min after completing, ignore new emails
 *      from same address so stray replies don't create duplicate reservations
 */

const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const { getEmailReply }      = require('./agent');
const { processReservation } = require('./reservations');

// Active conversations
const sessions = {};

// Cooldown map: email → timestamp of when reservation was completed
// Prevents reply-loop auto-denials (guest says "thanks" after reservation)
const completedAt = {};
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// ── Helpers ─────────────────────────────────────────────────────────────────

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

  // Ignore emails from ourselves (prevents reply loops from our own confirmations)
  const ourEmail = (process.env.FROM_EMAIL || '').toLowerCase();
  if (ourEmail && f.includes(ourEmail)) return true;

  // Ignore noreply/donotreply addresses
  if (f.includes('noreply') || f.includes('no-reply') || f.includes('donotreply')) return true;

  // Ignore automated subjects
  const autoSubjects = [
    'out of office', 'automatic reply', 'auto-reply', 'autoreply',
    'delivery status', 'undeliverable', 'mail delivery', 'delivery failed',
    'mailer-daemon', 'postmaster'
  ];
  if (autoSubjects.some(kw => s.includes(kw))) return true;

  return false;
}

function isReplyToOurEmail(subject) {
  const s = (subject || '').toLowerCase().trim();
  // Common subjects from our confirmation/pending emails
  const ourSubjects = [
    'your reservation is confirmed',
    'we received your reservation request',
    'update on your reservation',
    'reservation request — fully booked',
    'action needed',          // manager emails
    'action required'
  ];
  return ourSubjects.some(kw => s.includes(kw));
}

// ── Main handler ─────────────────────────────────────────────────────────────

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

  // ── Guard 1: Ignore automated/system emails ────────────────────────────────
  if (isAutomatedEmail(from, subject)) {
    console.log('[Email] Automated email detected — ignoring');
    return;
  }

  // ── Guard 2: Ignore replies to our own confirmation/notification emails ─────
  // This is the main cause of auto-denials — guest replies "thanks" to confirmation
  if (isReplyToOurEmail(subject)) {
    console.log('[Email] Reply to our notification email — ignoring');
    return;
  }

  // ── Guard 3: Cooldown — ignore emails within 30min of completing a reservation
  const key = `email:${senderEmail}`;
  const lastCompleted = completedAt[key];
  if (lastCompleted && (Date.now() - lastCompleted) < COOLDOWN_MS) {
    const minsAgo = Math.floor((Date.now() - lastCompleted) / 60000);
    console.log(`[Email] In cooldown (${minsAgo}min since last reservation) — ignoring`);
    return;
  }

  // ── Guard 4: Ignore very short replies (thank you, ok, etc.) ──────────────
  // Only applies if subject starts with Re: AND content is very short
  const isReply = subject.toLowerCase().startsWith('re:');
  if (isReply && cleanedText.length < 30) {
    console.log(`[Email] Short reply "${cleanedText}" — ignoring`);
    return;
  }

  // ── Start or continue session ──────────────────────────────────────────────
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

    // Send reply to guest
    if (process.env.SENDGRID_API_KEY) {
      await sgMail.send({
        to:      session.replyTo,
        from:    { email: process.env.FROM_EMAIL, name: 'On Top of the Palms Reservations' },
        subject: session.replySubject,
        text:    aiReply.text,
        html:    `<div style="font-family:-apple-system,sans-serif;font-size:15px;line-height:1.7;color:#111827;max-width:560px">${aiReply.text.replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>')}</div>`
      });
      console.log(`[Email] Reply sent to ${session.replyTo}`);
    } else {
      console.log(`\n[Email] Would reply:\n${aiReply.text}`);
    }

    // Reservation complete
    if (aiReply.complete && aiReply.collected) {
      session.collected         = aiReply.collected;
      session.collected.email   = session.collected.email || senderEmail;
      session.collected.channel = 'email';

      delete sessions[key];

      // Set cooldown so follow-up replies don't trigger a duplicate reservation
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
        from:    { email: process.env.FROM_EMAIL, name: 'On Top of the Palms Reservations' },
        subject: session.replySubject,
        text:    "We're sorry, something went wrong. Please reply and we'll assist you with your reservation."
      }).catch(() => {});
    }
  }
}

module.exports = { handleIncomingEmail, sessions };
