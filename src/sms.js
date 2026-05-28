/**
 * SMS channel — Twilio Programmable SMS
 *
 * How it works:
 *   Guest texts your Twilio number → Twilio POSTs to /sms/incoming
 *   We reply with TwiML <Message> responses, building up the conversation
 *   Session is keyed by the guest's phone number (not a call SID)
 *
 * Twilio setup:
 *   Phone Numbers → your number → Messaging → "A message comes in" → Webhook
 *   URL: https://your-server.com/sms/incoming   Method: POST
 */

const twilio = require('twilio');
const { getAgentReply } = require('./agent');
const { processReservation } = require('./reservations');

// Shared sessions store (same object passed in from server.js)
let _sessions;
function init(sessions) { _sessions = sessions; }

async function handleIncoming(req, res) {
  const from   = req.body.From  || '';
  const body   = (req.body.Body || '').trim();
  const key    = `sms:${from}`;

  console.log(`\n[SMS] From: ${from} — "${body}"`);

  // Start or retrieve session
  if (!_sessions[key]) {
    _sessions[key] = {
      channel: 'sms',
      callerNumber: from,
      callSid: key,
      messages: [],
      collected: null
    };
  }

  const session = _sessions[key];

  // First message — greet
  if (session.messages.length === 0 && body.length > 0) {
    // Treat whatever they sent as the opener
    session.messages.push({
      role: 'user',
      content: `Hello, I would like to make a reservation. My first message is: ${body}`
    });
  } else if (body.length > 0) {
    session.messages.push({ role: 'user', content: body });
  } else {
    // Empty first text — greet them
    session.messages.push({ role: 'user', content: 'Hi, I want to make a reservation.' });
  }

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const aiReply = await getAgentReply(session, 'sms');
    session.messages.push({ role: 'assistant', content: aiReply.text });

    twiml.message(aiReply.text);

    if (aiReply.complete && aiReply.collected) {
      session.collected = aiReply.collected;
      delete _sessions[key]; // Clean up session
      setImmediate(() =>
        processReservation(session).catch(err =>
          console.error('[SMS Reservation] Error:', err)
        )
      );
    }
  } catch (err) {
    console.error('[SMS] Agent error:', err);
    twiml.message("Sorry, something went wrong. Please text us again or call (813) 974-0000.");
  }

  res.type('text/xml').send(twiml.toString());
}

module.exports = { init, handleIncoming };
