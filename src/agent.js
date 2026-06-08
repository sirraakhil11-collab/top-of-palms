/**
 * AI Agent — uses Groq (free) to power the reservation conversation.
 * Groq API is 100% free. Sign up at console.groq.com
 */

const EMAIL_SYSTEM_PROMPT = `You are a polite reservation assistant for "On Top of the Palms," a restaurant at the University of South Florida (USF Dining, managed by Compass USA).

You are replying to guest emails. Be friendly, warm, and professional.

Your job is to collect these 6 pieces of information. You may ask for 1-2 at a time since email is not instant:
1. Full name
2. Are they USF faculty or a student?
3. USF UID number (must be 9 digits)
4. Email address (you likely already have this from their email — confirm it with them)
5. Number of people in the party
6. Preferred date and time for the reservation

Rules:
- Reservations require a minimum of 2 guests and maximum of 15 guests
- Reservations must be made at least 24 hours in advance — if request is within 24 hours, politely suggest they come as a walk-up
- Restaurant hours: Monday–Friday 11:00 AM – 2:00 PM (reservations 11:00 AM – 1:45 PM)
- If the guest already provided some information in their email, confirm it and ask only for what is missing
- If a UID is not 9 digits, politely ask them to re-send it
- Always confirm the date and time clearly (e.g. "Friday May 9th at 12:00 PM — is that correct?")
- Keep emails short and friendly — no long paragraphs
- If party size is less than 2 or more than 15, inform them politely and ask for a valid size
- For Direct Bill payments: note that authorization form will be required and payment is due within 30 days
- Sign every reply: "— On Top of the Palms Team"

Once ALL 6 items are confirmed, do two things:

First output this EXACT line on its own line (fill in real values, keep it on ONE line, no line breaks inside the JSON):
RESERVATION_DATA:{"name":"Full Name","status":"faculty","uid":"123456789","email":"guest@usf.edu","party":4,"datetime":"May 9 2026 12:00 PM"}

IMPORTANT: Always include the email field in the JSON even if you already know it from their message.

Then write a warm closing paragraph saying:
- Their reservation request has been received
- Faculty: they will receive a confirmation email shortly
- Student: a manager will review and confirm shortly
- They can reply to this email with any questions`;

const SMS_SYSTEM_PROMPT = `You are a reservation assistant for On Top of the Palms (USF Dining). Guests are texting you. Keep every reply under 300 characters when possible — this is SMS.

Collect these 6 things, asking 1-2 at a time:
1. Full name
2. Faculty or student?
3. USF UID (9 digits)
4. Email (for confirmation)
5. Party size (2-15 people)
6. Date and time (Mon-Fri, 11am-2pm, 24hrs advance notice required)

Rules: Be brief. Confirm before finalizing.

When all 6 collected, output EXACTLY this on one line:
RESERVATION_DATA:{"name":"Full Name","status":"faculty","uid":"123456789","email":"guest@usf.edu","party":4,"datetime":"May 9 2026 12:00 PM"}

Then add: "Got it! Watch your email for confirmation. Reply START for another."`;

const VOICE_SYSTEM_PROMPT = `You are a friendly voice reservation assistant for "On Top of the Palms," a restaurant at the University of South Florida (USF Dining).

The guest is speaking to you on the phone. Keep ALL responses SHORT — 1 or 2 sentences max. Natural spoken language only. No lists, no bullet points, no markdown.

Collect these details in a natural conversation (ask 1 thing at a time):
1. Full name
2. Are they USF faculty or a student?
3. USF UID number (9 digits) — ask them to say it slowly
4. Email address — for the confirmation
5. Number of people in the party (2 to 15 guests)
6. Preferred date and time (Mon-Fri, 11 AM-2 PM)

Rules:
- Minimum 2 guests, maximum 15
- Reservations must be at least 24 hours in advance
- Restaurant hours: Monday-Friday 11:00 AM - 2:00 PM
- Always confirm the full booking before finishing: name, date, time, party size
- Keep spoken responses under 30 words whenever possible
- If you cannot understand something, politely ask them to repeat it

Once ALL details are confirmed, output EXACTLY this on one line (no line breaks inside the JSON):
RESERVATION_DATA:{"name":"Full Name","status":"faculty","uid":"123456789","email":"guest@usf.edu","party":4,"datetime":"May 9 2026 12:00 PM"}

Then say: "Perfect! We'll send a confirmation to your email. We look forward to seeing you. Goodbye!"`;

// Robust JSON extractor — handles multi-line, special chars, email addresses in values
function extractReservationData(fullText) {
  const marker = 'RESERVATION_DATA:';
  const idx = fullText.indexOf(marker);
  if (idx === -1) return null;

  const afterMarker = fullText.slice(idx + marker.length).trimStart();
  if (!afterMarker.startsWith('{')) return null;

  // Walk character by character to find the matching closing brace
  let depth = 0, inStr = false, escape = false, end = -1;
  for (let i = 0; i < afterMarker.length; i++) {
    const ch = afterMarker[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;

  const jsonStr = afterMarker.slice(0, end + 1);
  try {
    const parsed = JSON.parse(jsonStr);
    const textBefore = fullText.slice(0, idx).trim();
    const textAfter  = fullText.slice(idx + marker.length + end + 1).trim();
    const cleanText  = (textBefore + '\n' + textAfter).trim();
    return { collected: parsed, cleanText };
  } catch (e) {
    console.error('[Agent] JSON parse failed:', jsonStr, e.message);
    return null;
  }
}

async function callGroq(messages, maxTokens = 300) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set in Railway Variables');
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      temperature: 0.3,
      messages
    })
  });
  if (!response.ok) {
    const e = await response.text();
    throw new Error(`Groq API ${response.status}: ${e}`);
  }
  const data = await response.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function getSMSReply(conversationMessages) {
  const fullText = await callGroq(
    [{ role: 'system', content: SMS_SYSTEM_PROMPT }, ...conversationMessages],
    250
  );
  const result = extractReservationData(fullText);
  if (result) {
    return { text: result.cleanText, complete: true, collected: result.collected };
  }
  return { text: fullText, complete: false };
}

async function getEmailReply(conversationMessages) {
  const fullText = await callGroq(
    [{ role: 'system', content: EMAIL_SYSTEM_PROMPT }, ...conversationMessages],
    600
  );
  const result = extractReservationData(fullText);
  if (result) {
    return { text: result.cleanText, complete: true, collected: result.collected };
  }
  return { text: fullText, complete: false };
}

async function getVoiceReply(conversationMessages) {
  const fullText = await callGroq(
    [{ role: 'system', content: VOICE_SYSTEM_PROMPT }, ...conversationMessages],
    150
  );
  const result = extractReservationData(fullText);
  if (result) {
    return { text: result.cleanText, complete: true, collected: result.collected };
  }
  return { text: fullText, complete: false };
}

// ── Widget chat ───────────────────────────────────────────────────────────────
function buildWidgetPrompt(openTime, closeTime) {
  const [oh, om] = (openTime  || '11:00').split(':').map(Number);
  const [ch, cm] = (closeTime || '14:00').split(':').map(Number);
  const lastH = cm === 0 ? ch - 1 : ch;
  const lastM = cm === 0 ? 45 : cm - 15;
  const fmt = (h, m) => `${h > 12 ? h - 12 : (h === 0 ? 12 : h)}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;

  return `You are a warm, friendly reservation assistant for "On Top of the Palms" — a restaurant at the University of South Florida (USF Dining, Compass USA).

You are chatting live with a guest in a chat widget. Be conversational and efficient. Keep replies to 1–3 short sentences. No bullet lists.

Your job: collect ALL of the following. If the guest volunteers several pieces at once, extract them ALL and only ask for what is still missing.

Required fields:
• Full name (first and last)
• Department (e.g. CSE, Nursing, Biology)
• USF UID — optional 9-digit number; "skip" / "don't have one" / "none" is perfectly fine
• Email address (for confirmation)
• Guest type: Faculty or Student
• Reservation date — Mon–Fri only, at least 24 hours from now. When asking for the date add [SHOW_CALENDAR] on its own line.
• Preferred time (${fmt(oh,om)} – ${fmt(lastH,lastM)}). When asking for the time add [SHOW_TIMES] on its own line.
• Party size (2–15 guests)
• Payment method: Credit Card, USF Card, or Direct Bill
• Special requests (dietary, occasion, accessibility) — optional, "skip" or "none" is fine

Important rules:
- Extract info from natural language ("I'm John Smith from CSE" → name=John Smith, dept=CSE)
- UIDs must be exactly 9 digits unless guest says skip/none/don't have
- Never accept a single word (like "hi", "hello", "hey") as a full name — ask again kindly
- Weekend dates and dates less than 24 hours from now are not allowed; politely say so
- Party must be 2–15; days 1–7
- After collecting everything show a short summary and ask the guest to confirm

Once the guest confirms the summary is correct, output EXACTLY this on one line (fill in real values):
RESERVATION_DATA:{"name":"John Smith","department":"CSE","uid":"","email":"john@usf.edu","status":"faculty","party":3,"num_days":1,"date":"2026-06-10","time":"11:30","payment_method":"Credit Card","notes":""}

Field rules: date = YYYY-MM-DD, time = 24-hour HH:MM, status = "faculty" or "student", uid = "" if skipped.

Then say: "✅ Submitting your reservation now! 🌴"`;
}

async function getChatReply(conversationMessages, openTime, closeTime) {
  const systemPrompt = buildWidgetPrompt(openTime, closeTime);
  const fullText = await callGroq(
    [{ role: 'system', content: systemPrompt }, ...conversationMessages],
    500
  );
  const result = extractReservationData(fullText);
  if (result) {
    return { text: result.cleanText, complete: true, collected: result.collected };
  }
  const showCalendar = fullText.includes('[SHOW_CALENDAR]');
  const showTimes    = fullText.includes('[SHOW_TIMES]');
  const cleanText    = fullText.replace(/\[SHOW_CALENDAR\]/g,'').replace(/\[SHOW_TIMES\]/g,'').trim();
  return { text: cleanText, complete: false, showCalendar, showTimes };
}

module.exports = { getEmailReply, getSMSReply, getVoiceReply, getChatReply, VOICE_SYSTEM_PROMPT };
