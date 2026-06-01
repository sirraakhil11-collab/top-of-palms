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
4. Email address (to send confirmation — you likely already have this from their email)
5. Number of people in the party
6. Preferred date and time for the reservation

Rules:
- Reservations require a minimum of 2 guests and maximum of 15 guests
- Reservations must be made at least 24 hours in advance — if request is within 24 hours, politely suggest they come as a walk-up
- Restaurant hours: Monday–Friday 11:00 AM – 2:00 PM (reservations 11:00 AM – 1:45 PM)
- If the guest already provided some information in their email, confirm it and ask only for what is missing
- If a UID is not 9 digits, politely ask them to re-send it
- Always confirm the date and time clearly (e.g. "Friday May 9th at 7:00 PM — is that correct?")
- Keep emails short and friendly — no long paragraphs
- If party size is less than 2 or more than 15, inform them politely and ask for a valid size
- For Direct Bill payments: note that authorization form will be required and payment is due within 30 days
- Sign every reply: "— On Top of the Palms Team"

Once ALL 6 items are confirmed, do two things:

First output this exact line (no spaces, no line break inside):
RESERVATION_DATA:{"name":"Full Name","status":"faculty","uid":"123456789","email":"guest@usf.edu","party":4,"datetime":"May 9 2026 7:00 PM"}

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
5. Party size (2–15)
6. Date and time (Mon-Fri, 11am-2pm, 24hrs advance)

Rules: Be brief and friendly. No lists or long text. Confirm info before finalizing.

When all 6 collected, output exactly:
RESERVATION_DATA:{"name":"...","status":"faculty","uid":"...","email":"...","party":4,"datetime":"..."}

Then add: "Got it! Request received. Watch your email for confirmation. Reply START for another."`;

async function getSMSReply(conversationMessages) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 200,
      messages: [{ role: 'system', content: SMS_SYSTEM_PROMPT }, ...conversationMessages]
    })
  });
  if (!response.ok) { const e = await response.text(); throw new Error(`Groq ${response.status}: ${e}`); }
  const data = await response.json();
  const fullText = data.choices[0].message.content;
  const match = fullText.match(/RESERVATION_DATA:(\{[^}]+\})/);
  if (match) {
    let collected;
    try { collected = JSON.parse(match[1]); }
    catch { return { text: fullText.replace(/RESERVATION_DATA:.*$/s,'').trim(), complete:false }; }
    return { text: fullText.replace(/RESERVATION_DATA:\{[^}]+\}/,'').trim(), complete:true, collected };
  }
  return { text: fullText, complete: false };
}

async function getEmailReply(conversationMessages) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not set in your .env file. Get a free key at console.groq.com');
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      model:      'llama-3.3-70b-versatile',
      max_tokens: 500,
      messages: [
        { role: 'system', content: EMAIL_SYSTEM_PROMPT },
        ...conversationMessages
      ]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error ${response.status}: ${err}`);
  }

  const data     = await response.json();
  const fullText = data.choices[0].message.content;

  // Check if all info has been collected
  const match = fullText.match(/RESERVATION_DATA:(\{[^}]+\})/);
  if (match) {
    let collected;
    try { collected = JSON.parse(match[1]); }
    catch (e) {
      console.error('[Agent] Could not parse reservation JSON:', match[1]);
      return { text: fullText.replace(/RESERVATION_DATA:.*$/s, '').trim(), complete: false };
    }
    return {
      text:      fullText.replace(/RESERVATION_DATA:\{[^}]+\}/, '').trim(),
      complete:  true,
      collected
    };
  }

  return { text: fullText, complete: false };
}

module.exports = { getEmailReply, getSMSReply };
