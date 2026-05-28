/**
 * AI Agent — supports two providers:
 *   1. Groq  (FREE)      — set GROQ_API_KEY in .env
 *   2. Anthropic (paid)  — set ANTHROPIC_API_KEY in .env
 * Groq is tried first if both keys are present.
 */

const PROMPTS = {
  voice: `You are a friendly reservation assistant for "Top of the Palms," a restaurant at USF Dining.
Your responses will be read aloud by TTS — keep them natural and conversational, no lists.
Collect these 6 items one at a time: (1) Full name (2) faculty or student (3) USF UID 9 digits (4) email address (5) party size (6) preferred date and time.
Confirm each answer before moving on. Keep responses SHORT — this is a phone call.
Once ALL 6 confirmed, output exactly: RESERVATION_DATA:{"name":"...","status":"faculty","uid":"...","email":"...","party":4,"datetime":"May 10 2026 7:00 PM"}
Then say: "Thank you! You will receive a confirmation email shortly. Goodbye!"`,

  sms: `You are a friendly SMS reservation assistant for "Top of the Palms" at USF Dining.
Replies go as SMS — keep each reply to 1-2 SHORT sentences. No bullet points.
Collect these 6 items one at a time: (1) Full name (2) faculty or student (3) USF UID 9 digits (4) email address (5) party size (6) preferred date and time.
Confirm each before moving on. Be brief — this is texting.
Once ALL 6 confirmed, output exactly: RESERVATION_DATA:{"name":"...","status":"faculty","uid":"...","email":"...","party":4,"datetime":"May 10 2026 7:00 PM"}
Then say: "Got it! Check your email for your confirmation. Thanks for texting Top of the Palms!"`,

  email: `You are a polite email reservation assistant for "Top of the Palms" at USF Dining.
You write email reply bodies — be friendly and professional.
Collect these 6 items, you may ask for two at a time since email is async:
(1) Full name (2) faculty or student (3) USF UID 9 digits (4) email address (5) party size (6) preferred date and time.
Extract anything already given in the guest email, confirm it, ask only for what is missing.
Once ALL 6 confirmed, output exactly: RESERVATION_DATA:{"name":"...","status":"faculty","uid":"...","email":"...","party":4,"datetime":"May 10 2026 7:00 PM"}
Then write a friendly closing saying their request is received and a follow-up email is coming.
Sign off: "— Top of the Palms Reservations"`
};

// ── Groq (free) ──────────────────────────────────────────────────────────────
async function callGroq(messages, systemPrompt, maxTokens) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// ── Anthropic (paid) ─────────────────────────────────────────────────────────
async function callAnthropic(messages, systemPrompt, maxTokens) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function getAgentReply(session, channel) {
  channel = channel || session.channel || 'sms';
  const systemPrompt = PROMPTS[channel] || PROMPTS.sms;
  const maxTokens    = channel === 'sms' ? 200 : 400;

  let fullText;

  if (process.env.GROQ_API_KEY) {
    console.log('[Agent] Using Groq (free)');
    fullText = await callGroq(session.messages, systemPrompt, maxTokens);
  } else if (process.env.ANTHROPIC_API_KEY) {
    console.log('[Agent] Using Anthropic');
    fullText = await callAnthropic(session.messages, systemPrompt, maxTokens);
  } else {
    throw new Error('No AI provider configured. Set GROQ_API_KEY (free) or ANTHROPIC_API_KEY in your .env file.');
  }

  const dataMatch = fullText.match(/RESERVATION_DATA:(\{[^}]+\})/);

  if (dataMatch) {
    let collected;
    try { collected = JSON.parse(dataMatch[1]); }
    catch (e) {
      console.error('[Agent] JSON parse error:', dataMatch[1]);
      return { text: fullText.replace(/RESERVATION_DATA:.*$/s, '').trim(), complete: false };
    }
    return {
      text: fullText.replace(/RESERVATION_DATA:\{[^}]+\}/, '').trim(),
      complete: true,
      collected
    };
  }

  return { text: fullText, complete: false };
}

module.exports = { getAgentReply };
