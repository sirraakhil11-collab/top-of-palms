/**
 * SMS Reservation Handler — Twilio incoming SMS
 * Guests text the restaurant number → AI collects info → creates pending reservation
 * Same flow as email channel
 */
const { getEmailReply } = require('./agent');
const { processReservation } = require('./reservations');

// Active SMS conversations keyed by phone number
const smsSessions = {};
// Cooldown after completing reservation (30 min)
const completedAt = {};
const COOLDOWN_MS = 30 * 60 * 1000;

async function handleIncomingSMS(req, res) {
  // Always respond with Twilio TwiML
  const twiml = (msg) => {
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escXML(msg)}</Message></Response>`);
  };

  const from    = req.body.From || req.body.from || '';
  const body    = (req.body.Body || req.body.body || '').trim();
  const phoneNo = from.replace(/\D/g,'').slice(-10); // normalize to 10 digits

  if (!phoneNo || !body) { res.set('Content-Type','text/xml'); res.send('<Response></Response>'); return; }

  console.log(`\n[SMS] From: ${from} | Message: "${body}"`);

  // Cooldown check
  const key = `sms:${phoneNo}`;
  if (completedAt[key] && (Date.now() - completedAt[key]) < COOLDOWN_MS) {
    return twiml('Thank you! Your reservation request has been received. We will send a confirmation email shortly. Reply START to make another reservation.');
  }

  // Reset command
  if (body.toLowerCase() === 'start' || body.toLowerCase() === 'restart') {
    delete smsSessions[key];
    return twiml('Welcome to On Top of the Palms! 🌴 To make a reservation, please tell us your name and desired date. Example: "Hi, I\'m Dr. Smith and I\'d like a table for 4 on June 15th at noon."');
  }

  // Start or continue session
  if (!smsSessions[key]) {
    smsSessions[key] = {
      channel: 'sms',
      replyTo: from,
      phoneNumber: from,
      messages: [],
      collected: null
    };
    console.log(`[SMS] New session for ${phoneNo}`);
  }

  const session = smsSessions[key];
  const userContent = session.messages.length === 0
    ? `I would like to make a reservation. My message: ${body}`
    : body;

  session.messages.push({ role: 'user', content: userContent });

  try {
    const aiReply = await getEmailReply(session.messages);
    session.messages.push({ role: 'assistant', content: aiReply.text });

    if (aiReply.complete && aiReply.collected) {
      session.collected          = aiReply.collected;
      session.collected.channel  = 'sms';
      // Use phone as fallback email placeholder (real email collected in conversation)
      if (!session.collected.email) session.collected.email = `sms:${from}`;

      delete smsSessions[key];
      completedAt[key] = Date.now();
      setTimeout(() => delete completedAt[key], COOLDOWN_MS);

      setImmediate(() => processReservation(session).catch(console.error));
      return twiml(aiReply.text + '\n\nReply START to make another reservation.');
    }

    // Truncate SMS to 1600 chars (Twilio limit)
    const smsText = aiReply.text.length > 1550 ? aiReply.text.slice(0, 1547) + '...' : aiReply.text;
    return twiml(smsText);

  } catch (err) {
    console.error('[SMS] Error:', err.message);
    return twiml('Sorry, something went wrong. Please try again or call us at ' + (process.env.RESTAURANT_PHONE || '(813) 974-0000'));
  }
}

function escXML(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

module.exports = { handleIncomingSMS };
