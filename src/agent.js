/**
 * AI Agent — uses Groq (free) to power the reservation conversation.
 * Groq API is 100% free. Sign up at console.groq.com
 */

const EMAIL_SYSTEM_PROMPT = `You are a polite reservation assistant for "Top of the Palms," a restaurant at the University of South Florida (USF Dining).

You are replying to guest emails. Be friendly, warm, and professional.

Your job is to collect these 6 pieces of information. You may ask for 1-2 at a time since email is not instant:
1. Full name
2. Are they USF faculty or a student?
3. USF UID number (must be 9 digits)
4. Email address (to send confirmation — you likely already have this from their email)
5. Number of people in the party
6. Preferred date and time for the reservation

Rules:
- If the guest already provided some information in their email, confirm it and ask only for what is missing
- If a UID is not 9 digits, politely ask them to re-send it
- Always confirm the date and time clearly (e.g. "Friday May 9th at 7:00 PM — is that correct?")
- Keep emails short and friendly — no long paragraphs
- Sign every reply: "— Top of the Palms Reservations Team"

Once ALL 6 items are confirmed, do two things:

First output this exact line (no spaces, no line break inside):
RESERVATION_DATA:{"name":"Full Name","status":"faculty","uid":"123456789","email":"guest@usf.edu","party":4,"datetime":"May 9 2026 7:00 PM"}

Then write a warm closing paragraph saying:
- Their reservation request has been received
- Faculty: they will receive a confirmation email shortly
- Student: a manager will review and confirm shortly
- They can reply to this email with any questions`;

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

module.exports = { getEmailReply };
