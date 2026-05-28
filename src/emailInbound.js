/**
 * INBOUND EMAIL HANDLER
 *
 * How it works:
 *   1. Guest sends email to your address
 *   2. SendGrid receives it and POSTs the email data to /email/incoming
 *   3. We extract the text, run it through the AI agent
 *   4. We reply to the guest via SendGrid outbound
 *   5. Conversation continues until all 6 fields are collected
 *   6. Reservation is saved and routed (faculty = auto, student = manager)
 *
 * SendGrid Inbound Parse setup:
 *   sendgrid.com → Settings → Inbound Parse → Add Host & URL
 *   URL: https://your-ngrok-url.ngrok-free.app/email/incoming
 */

const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const { getEmailReply }     = require('./agent');
const { processReservation } = require('./reservations');

// Sessions keyed by sender email address
const sessions = {};

function cleanEmailBody(text) {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => !line.startsWith('>'))        // Remove quoted replies
    .join('\n')
    .replace(/On .+?wrote:/gs, '')                // Remove "On X wrote:" headers
    .replace(/_{3,}/g, '')                        // Remove divider lines
    .replace(/\n{3,}/g, '\n\n')                   // Collapse blank lines
    .trim();
}

function extractSenderEmail(from) {
  if (!from) return '';
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

async function handleIncomingEmail(req, res) {
  // SendGrid sends form data — respond 200 immediately so it doesn't retry
  res.sendStatus(200);

  const from        = req.body.from    || '';
  const subject     = req.body.subject || 'Reservation Request';
  const rawText     = req.body.text    || req.body.html || '';
  const cleanedText = cleanEmailBody(rawText);
  const senderEmail = extractSenderEmail(from);

  if (!senderEmail) {
    console.log('[Email] Could not extract sender email — skipping');
    return;
  }

  console.log(`\n[Email] From: ${senderEmail}`);
  console.log(`[Email] Subject: ${subject}`);
  console.log(`[Email] Body: "${cleanedText.slice(0, 120)}..."`);

  // Get or create session for this email address
  const key = `email:${senderEmail}`;
  if (!sessions[key]) {
    sessions[key] = {
      channel:     'email',
      replyTo:     senderEmail,
      replySubject: subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`,
      messages:    [],
      collected:   null
    };
  }

  const session = sessions[key];

  // Add this email as a user message
  const userContent = session.messages.length === 0
    ? `I would like to make a reservation. Here is my message: ${cleanedText}`
    : cleanedText;

  session.messages.push({ role: 'user', content: userContent });

  try {
    const aiReply = await getEmailReply(session.messages);
    session.messages.push({ role: 'assistant', content: aiReply.text });

    // Send reply email back to guest
    if (process.env.SENDGRID_API_KEY) {
      await sgMail.send({
        to:      session.replyTo,
        from:    { email: process.env.FROM_EMAIL, name: 'Top of the Palms Reservations' },
        subject: session.replySubject,
        text:    aiReply.text,
        html:    `<div style="font-family:-apple-system,sans-serif;font-size:15px;line-height:1.7;color:#111827;max-width:560px">${aiReply.text.replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>')}</div>`
      });
      console.log(`[Email] Reply sent to ${session.replyTo}`);
    } else {
      console.log(`\n[Email] Would reply to ${session.replyTo}:\n---\n${aiReply.text}\n---`);
    }

    // If conversation is complete, process the reservation
    if (aiReply.complete && aiReply.collected) {
      session.collected          = aiReply.collected;
      session.collected.email    = session.collected.email || senderEmail;
      session.collected.channel  = 'email';

      delete sessions[key]; // Clean up session

      setImmediate(() =>
        processReservation(session).catch(err =>
          console.error('[Email] Reservation processing error:', err)
        )
      );
    }

  } catch (err) {
    console.error('[Email] Agent error:', err.message);

    // Send error reply so the guest knows something went wrong
    if (process.env.SENDGRID_API_KEY) {
      await sgMail.send({
        to:      senderEmail,
        from:    { email: process.env.FROM_EMAIL, name: 'Top of the Palms Reservations' },
        subject: session.replySubject,
        text:    "We're sorry, we experienced a technical issue. Please reply to this email and we'll assist you with your reservation."
      });
    }
  }
}

// Export sessions so server.js can clear them if needed
module.exports = { handleIncomingEmail, sessions };
