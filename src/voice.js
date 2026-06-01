/**
 * Voice Reservation Handler — Twilio Voice (inbound calls)
 *
 * Flow:
 *   Guest calls the Twilio number
 *   → System greets and asks for reservation details using speech recognition
 *   → AI collects name, date, party size, guest type, UID, email step-by-step
 *   → On completion: reservation created, SMS + email confirmation sent
 *
 * Routes added in server.js:
 *   POST /voice/incoming   — Twilio calls this when a call arrives
 *   POST /voice/collect    — Twilio posts speech transcript each turn
 *   POST /voice/status     — Twilio posts final call status (logging only)
 */

const { processReservation } = require('./reservations');
const escXML = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');

// Active voice sessions keyed by Twilio CallSid
const voiceSessions = {};

// Groq AI for voice (short, spoken responses)
const VOICE_SYSTEM_PROMPT = `You are a friendly voice reservation assistant for "On Top of the Palms," a restaurant at the University of South Florida (USF Dining).

The guest is speaking to you on the phone. Keep ALL responses SHORT — 1 or 2 sentences max. Natural spoken language only. No lists, no bullet points, no markdown.

Collect these details in a natural conversation (ask 1 thing at a time):
1. Full name
2. Are they USF faculty or a student?
3. USF UID number (9 digits) — ask them to say it slowly
4. Email address — for the confirmation
5. Number of people in the party (2 to 15 guests)
6. Preferred date and time (Mon–Fri, 11 AM–2 PM)

Rules:
- Minimum 2 guests, maximum 15
- Reservations must be at least 24 hours in advance
- Restaurant hours: Monday–Friday 11:00 AM – 2:00 PM
- Always confirm the full booking back before finishing: name, date, time, party size
- Keep spoken responses under 30 words whenever possible
- If you cannot understand something, politely ask them to repeat it

Once ALL details are confirmed, output EXACTLY this on a new line (no spaces around braces):
RESERVATION_DATA:{"name":"...","guest_status":"faculty|student","uid":"...","email":"...","party":N,"date":"YYYY-MM-DD","time":"HH:MM","payment_method":"CC/Cash"}

Then say a brief goodbye like: "Perfect! We'll send a confirmation to your email. We look forward to seeing you. Goodbye!"`;

async function getVoiceReply(messages) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 120,
      temperature: 0.4,
      messages: [{ role: 'system', content: VOICE_SYSTEM_PROMPT }, ...messages]
    })
  });
  if (!resp.ok) { const e = await resp.text(); throw new Error(`Groq ${resp.status}: ${e}`); }
  const data = await resp.json();
  const fullText = data.choices[0].message.content || '';
  const match = fullText.match(/RESERVATION_DATA:(\{[\s\S]+?\})/);
  if (match) {
    try {
      const collected = JSON.parse(match[1]);
      const text = fullText.replace(/RESERVATION_DATA:[\s\S]+$/, '').trim();
      return { text, complete: true, collected };
    } catch {
      return { text: fullText.replace(/RESERVATION_DATA:[\s\S]+$/, '').trim(), complete: false };
    }
  }
  return { text: fullText, complete: false };
}

// Build TwiML that speaks a message then gathers the next speech input
function gatherTwiML(baseUrl, callSid, sayText, isEnd = false) {
  if (isEnd) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${escXML(sayText)}</Say>
  <Hangup/>
</Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${escXML(baseUrl)}/voice/collect" method="POST" speechTimeout="3" timeout="10" language="en-US">
    <Say voice="Polly.Joanna">${escXML(sayText)}</Say>
  </Gather>
  <Say voice="Polly.Joanna">I didn't catch that. Let me transfer you. Please call us back or visit our website.</Say>
  <Hangup/>
</Response>`;
}

// POST /voice/incoming — first contact
function handleIncomingCall(req, res) {
  res.set('Content-Type', 'text/xml');
  const callSid  = req.body.CallSid || `call-${Date.now()}`;
  const from     = req.body.From || '';
  const baseUrl  = process.env.BASE_URL || `https://${req.hostname}`;

  console.log(`\n[Voice] Incoming call from ${from} — SID: ${callSid}`);

  // Init session
  voiceSessions[callSid] = {
    callSid,
    from,
    messages:  [],
    collected: null,
    channel:   'voice'
  };

  const greeting = "Hello! Thank you for calling On Top of the Palms at USF. I'm here to help you make a reservation. Can I start with your full name please?";
  res.send(gatherTwiML(baseUrl, callSid, greeting));
}

// POST /voice/collect — each speech turn
async function handleVoiceCollect(req, res) {
  res.set('Content-Type', 'text/xml');
  const callSid   = req.body.CallSid || '';
  const speech    = (req.body.SpeechResult || '').trim();
  const baseUrl   = process.env.BASE_URL || `https://${req.hostname}`;

  const session = voiceSessions[callSid];
  if (!session) {
    res.send(gatherTwiML(baseUrl, callSid, "I'm sorry, your session expired. Please call back to make a reservation."));
    return;
  }

  if (!speech) {
    res.send(gatherTwiML(baseUrl, callSid, "I didn't catch that. Could you please repeat?"));
    return;
  }

  console.log(`[Voice] ${callSid} | Guest said: "${speech}"`);
  session.messages.push({ role: 'user', content: speech });

  try {
    const aiReply = await getVoiceReply(session.messages);
    session.messages.push({ role: 'assistant', content: aiReply.text });

    if (aiReply.complete && aiReply.collected) {
      session.collected         = aiReply.collected;
      session.collected.channel = 'voice';
      session.collected.phone   = session.from;
      if (!session.collected.email) session.collected.email = `voice:${session.from}`;

      console.log(`[Voice] Reservation complete for ${session.collected.name}`);
      // Process in background after responding
      const snap = { ...session };
      delete voiceSessions[callSid];
      setImmediate(() => processReservation(snap).catch(e => console.error('[Voice] processReservation error:', e.message)));

      const farewell = aiReply.text || "Perfect! We've got your reservation. A confirmation will be sent to your email. We look forward to seeing you. Goodbye!";
      res.send(gatherTwiML(baseUrl, callSid, farewell, true));
    } else {
      // Clean up old sessions after 30 min
      session._lastActivity = Date.now();
      res.send(gatherTwiML(baseUrl, callSid, aiReply.text));
    }
  } catch (err) {
    console.error('[Voice] AI error:', err.message);
    res.send(gatherTwiML(baseUrl, callSid, "I'm sorry, I'm having trouble right now. Please call back or visit our website to make a reservation. Goodbye!", true));
  }
}

// POST /voice/status — call ended (logging only)
function handleCallStatus(req, res) {
  const callSid = req.body.CallSid || '';
  const status  = req.body.CallStatus || '';
  console.log(`[Voice] Call ${callSid} status: ${status}`);
  // Clean up session if call dropped
  if (['completed','failed','busy','no-answer','canceled'].includes(status)) {
    delete voiceSessions[callSid];
  }
  res.sendStatus(200);
}

// Periodically clean stale sessions (>30 min old)
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [sid, s] of Object.entries(voiceSessions)) {
    if ((s._lastActivity || 0) < cutoff) delete voiceSessions[sid];
  }
}, 5 * 60 * 1000);

module.exports = { handleIncomingCall, handleVoiceCollect, handleCallStatus };
