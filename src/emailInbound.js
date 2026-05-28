/**
 * Email inbound channel — SendGrid Inbound Parse
 *
 * How it works:
 *   Guest emails reservations@topofthepalms.usf.edu
 *   SendGrid parses the email and POSTs form-data to /email/incoming
 *   We reply via SendGrid (outbound), continuing the conversation
 *   Session is keyed by the guest's email address
 *
 * SendGrid Inbound Parse setup:
 *   Settings → Inbound Parse → Add Host & URL
 *   Hostname: topofthepalms.usf.edu  (or subdomain)
 *   URL: https://your-server.com/email/incoming
 *   Also add MX record:  mx.sendgrid.net  pointing at your domain
 */

const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const { getAgentReply } = require('./agent');
const { processReservation } = require('./reservations');

const FROM_EMAIL = process.env.FROM_EMAIL || 'reservations@topofthepalms.usf.edu';
const FROM_NAME  = 'Top of the Palms Reservations';

let _sessions;
function init(sessions) { _sessions = sessions; }

function stripQuotedReply(text) {
  // Remove common quoted reply sections
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter(line => !line.startsWith('>'))
    .join('\n')
    .replace(/On .+? wrote:/s, '')
    .replace(/_{5,}/g, '')
    .trim();
}

async function handleIncoming(req, res) {
  // SendGrid sends multipart form data
  const from    = req.body.from    || '';
  const subject = req.body.subject || 'Reservation Request';
  const text    = stripQuotedReply(req.body.text || req.body.html || '');

  // Extract sender email
  const emailMatch = from.match(/<([^>]+)>/) || [null, from];
  const senderEmail = emailMatch[1].trim().toLowerCase();
  const key = `email:${senderEmail}`;

  console.log(`\n[Email] From: ${senderEmail} — Subject: "${subject}"`);
  console.log(`[Email] Body: "${text.slice(0, 100)}..."`);

  // Start or retrieve session
  if (!_sessions[key]) {
    _sessions[key] = {
      channel: 'email',
      callerNumber: senderEmail,
      callSid: key,
      messages: [],
      collected: null,
      replyTo: senderEmail,
      subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`
    };
  }

  const session = _sessions[key];

  // Add this email as user turn
  const userContent = session.messages.length === 0
    ? `I would like to make a reservation. Here is my request: ${text}`
    : text;

  session.messages.push({ role: 'user', content: userContent });

  try {
    const aiReply = await getAgentReply(session, 'email');
    session.messages.push({ role: 'assistant', content: aiReply.text });

    // Send reply email
    if (process.env.SENDGRID_API_KEY) {
      await sgMail.send({
        to:      session.replyTo,
        from:    { email: FROM_EMAIL, name: FROM_NAME },
        subject: session.subject,
        text:    aiReply.text,
        html:    `<div style="font-family:sans-serif;font-size:15px;line-height:1.6;color:#111">${aiReply.text.replace(/\n/g,'<br>')}</div>`
      });
      console.log(`[Email] Replied to ${senderEmail}`);
    } else {
      console.log(`[Email] Would reply to ${senderEmail}:\n${aiReply.text}`);
    }

    if (aiReply.complete && aiReply.collected) {
      session.collected = aiReply.collected;
      // Override email if guest provided it in conversation vs. sender
      if (!session.collected.email) {
        session.collected.email = senderEmail;
      }
      delete _sessions[key];
      setImmediate(() =>
        processReservation(session).catch(err =>
          console.error('[Email Reservation] Error:', err)
        )
      );
    }
  } catch (err) {
    console.error('[Email] Agent error:', err);
  }

  // SendGrid needs a 200 quickly
  res.sendStatus(200);
}

module.exports = { init, handleIncoming };
