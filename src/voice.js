/**
 * Voice Reservation Handler — Twilio Voice (inbound calls)
 *
 * Routes in server.js:
 *   POST /voice/incoming   — Twilio calls this when a call arrives
 *   POST /voice/collect    — Twilio posts speech transcript each turn
 *   POST /voice/status     — Twilio posts final call status (logging only)
 */

const { getVoiceReply }      = require('./agent');
const { processReservation } = require('./reservations');

const escXML = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');

// Active voice sessions keyed by Twilio CallSid
const voiceSessions = {};

// Build TwiML — speaks a message then listens for speech
function gatherTwiML(baseUrl, sayText, isEnd = false) {
  if (isEnd) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say voice="Polly.Joanna">${escXML(sayText)}</Say>\n  <Hangup/>\n</Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${escXML(baseUrl)}/voice/collect" method="POST" speechTimeout="3" timeout="12" language="en-US">
    <Say voice="Polly.Joanna">${escXML(sayText)}</Say>
  </Gather>
  <Say voice="Polly.Joanna">I didn't catch that. Please call us back or visit our website to make a reservation. Goodbye!</Say>
  <Hangup/>
</Response>`;
}

// POST /voice/incoming — call arrives
function handleIncomingCall(req, res) {
  res.set('Content-Type', 'text/xml');
  const callSid = req.body.CallSid || `call-${Date.now()}`;
  const from    = req.body.From || '';
  const baseUrl = process.env.BASE_URL || `https://${req.hostname}`;

  console.log(`\n[Voice] Incoming call from ${from} — SID: ${callSid}`);

  voiceSessions[callSid] = { callSid, from, messages: [], channel: 'voice', _lastActivity: Date.now() };

  const greeting = "Hello! Thank you for calling On Top of the Palms at USF. I'm here to help you make a reservation. Can I start with your full name please?";
  res.send(gatherTwiML(baseUrl, greeting));
}

// POST /voice/collect — speech from guest
async function handleVoiceCollect(req, res) {
  res.set('Content-Type', 'text/xml');
  const callSid = req.body.CallSid || '';
  const speech  = (req.body.SpeechResult || '').trim();
  const baseUrl = process.env.BASE_URL || `https://${req.hostname}`;

  const session = voiceSessions[callSid];
  if (!session) {
    res.send(gatherTwiML(baseUrl, "I'm sorry, your session expired. Please call back to make a reservation. Goodbye!", true));
    return;
  }

  if (!speech) {
    res.send(gatherTwiML(baseUrl, "I didn't catch that. Could you please repeat?"));
    return;
  }

  console.log(`[Voice] ${callSid} | Guest said: "${speech}"`);
  session._lastActivity = Date.now();
  session.messages.push({ role: 'user', content: speech });

  try {
    const aiReply = await getVoiceReply(session.messages);
    session.messages.push({ role: 'assistant', content: aiReply.text });

    if (aiReply.complete && aiReply.collected) {
      const collected = aiReply.collected;
      collected.channel = 'voice';
      collected.phone   = session.from;
      // Fallback email if AI didn't capture it
      if (!collected.email) collected.email = `voice:${session.from}`;
      // Ensure datetime is set (voice prompt uses datetime field directly)
      if (!collected.datetime && collected.date) {
        collected.datetime = `${collected.date} ${collected.time || '12:00 PM'}`;
      }

      console.log(`[Voice] ✓ Reservation complete — ${collected.name} for ${collected.datetime}`);
      const snap = { collected, channel: 'voice' };
      delete voiceSessions[callSid];
      setImmediate(() => processReservation(snap).catch(e => console.error('[Voice] processReservation error:', e.message)));

      const farewell = (aiReply.text || '').trim() || "Perfect! We've got your details. A confirmation will be sent to your email. We look forward to seeing you. Goodbye!";
      res.send(gatherTwiML(baseUrl, farewell, true));
    } else {
      res.send(gatherTwiML(baseUrl, aiReply.text));
    }
  } catch (err) {
    console.error('[Voice] AI error:', err.message);
    res.send(gatherTwiML(baseUrl, "I'm sorry, I'm having trouble right now. Please call back or visit our website. Goodbye!", true));
  }
}

// POST /voice/status — call ended
function handleCallStatus(req, res) {
  const callSid = req.body.CallSid || '';
  const status  = req.body.CallStatus || '';
  console.log(`[Voice] Call ${callSid} ended — status: ${status}`);
  if (['completed','failed','busy','no-answer','canceled'].includes(status)) {
    delete voiceSessions[callSid];
  }
  res.sendStatus(200);
}

// Clean stale sessions every 15 min
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [sid, s] of Object.entries(voiceSessions)) {
    if ((s._lastActivity || 0) < cutoff) { delete voiceSessions[sid]; }
  }
}, 15 * 60 * 1000);

module.exports = { handleIncomingCall, handleVoiceCollect, handleCallStatus };
