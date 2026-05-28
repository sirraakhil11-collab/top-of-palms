const db = require('./db');
const { sendEmail, sendManagerApprovalEmail } = require('./email');

const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '30');

async function processReservation(session) {
  const data    = session.collected;
  const channel = session.channel || 'form';

  console.log(`\n[Reservation] Processing: ${data.name} (${data.status}) via ${channel}`);

  // ── Daily limit check ──────────────────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0];
  const count = db.getDailyCount(today);

  if (count >= DAILY_LIMIT) {
    console.log(`[Reservation] ⚠️  Daily limit reached (${count}/${DAILY_LIMIT}) — rejecting ${data.name}`);

    // Save as denied with limit reason
    const record = db.createReservation({
      name: data.name, guest_status: data.status,
      uid: data.uid, email: data.email,
      party: parseInt(data.party, 10), datetime: data.datetime,
      notes: data.notes || '', channel,
      status: 'denied'
    });
    db.updateReservation(record.id, {
      processed_at: new Date().toISOString(),
      notes: 'Auto-denied: daily reservation limit reached'
    });

    // Notify guest
    await sendLimitEmail(data).catch(console.error);
    return { success: false, reason: 'daily_limit' };
  }

  // ── Save to database ───────────────────────────────────────────────────────
  const reservation = db.createReservation({
    name: data.name, guest_status: data.status,
    uid: data.uid, email: data.email,
    party: parseInt(data.party, 10), datetime: data.datetime,
    notes: data.notes || '', channel,
    status: data.status === 'faculty' ? 'auto_approved' : 'pending_approval'
  });

  console.log(`[Reservation] Saved → ${reservation.id} (${count + 1}/${DAILY_LIMIT} today)`);

  // ── Faculty: auto-approve ──────────────────────────────────────────────────
  if (data.status === 'faculty') {
    db.updateReservation(reservation.id, {
      status: 'approved', processed_at: new Date().toISOString()
    });
    await sendEmail(db.getReservation(reservation.id), 'confirmed').catch(console.error);
    console.log(`[Reservation] Faculty auto-approved ✓`);
    return { success: true, status: 'approved' };
  }

  // ── Student: manager approval ──────────────────────────────────────────────
  await sendManagerApprovalEmail(reservation).catch(console.error);
  await sendEmail(reservation, 'pending').catch(console.error);
  console.log(`[Reservation] Student queued for manager approval ✓`);
  return { success: true, status: 'pending' };
}

async function sendLimitEmail(data) {
  const sgMail = require('@sendgrid/mail');
  if (!process.env.SENDGRID_API_KEY || !data.email) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  await sgMail.send({
    to:   data.email,
    from: { email: process.env.FROM_EMAIL, name: 'Top of the Palms Reservations' },
    subject: 'Reservation request — fully booked for today',
    html: `<div style="font-family:sans-serif;max-width:520px;padding:20px">
      <h2 style="color:#006747">Top of the Palms</h2>
      <p>Hi ${data.name},</p>
      <p>Unfortunately we are fully booked for today and cannot accommodate your reservation request.</p>
      <p>Please try again tomorrow or contact us directly to check availability for another date.</p>
      <p>We apologize for the inconvenience and hope to see you soon!</p>
      <p>— Top of the Palms Reservations Team<br>USF Dining · Compass USA</p>
    </div>`
  });
}

module.exports = { processReservation };
