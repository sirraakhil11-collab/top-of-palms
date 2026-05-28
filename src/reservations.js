const db = require('./db');
const { sendEmail, sendManagerApprovalEmail } = require('./email');

const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '30');

async function processReservation(session) {
  const data    = session.collected;
  const channel = session.channel || 'form';

  console.log(`\n[Reservation] Processing: ${data.name} (${data.status}) via ${channel}`);

  // ── Daily limit check (by reservation date, not submitted date) ───────────
  const resDate = db.parseReservationDate(data.datetime) || new Date().toISOString().split('T')[0];
  const count   = db.getDailyCount(resDate);

  if (count >= DAILY_LIMIT) {
    console.log(`[Reservation] ⚠️  Daily limit reached (${count}/${DAILY_LIMIT}) for ${resDate}`);
    const record = db.createReservation({
      name: data.name, guest_status: data.status,
      uid: data.uid, email: data.email,
      party: parseInt(data.party, 10), datetime: data.datetime,
      notes: 'Auto-denied: daily reservation limit reached', channel,
      status: 'denied'
    });
    db.updateReservation(record.id, { processed_at: new Date().toISOString() });
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

  console.log(`[Reservation] Saved → ${reservation.id} (${count + 1}/${DAILY_LIMIT} for ${resDate})`);

  if (data.status === 'faculty') {
    db.updateReservation(reservation.id, { status: 'approved', processed_at: new Date().toISOString() });
    await sendEmail(db.getReservation(reservation.id), 'confirmed').catch(console.error);
    console.log(`[Reservation] Faculty auto-approved ✓`);
    return { success: true, status: 'approved' };
  }

  await sendManagerApprovalEmail(reservation).catch(console.error);
  await sendEmail(reservation, 'pending').catch(console.error);
  console.log(`[Reservation] Student queued ✓`);
  return { success: true, status: 'pending' };
}

async function sendLimitEmail(data) {
  const sgMail = require('@sendgrid/mail');
  if (!process.env.SENDGRID_API_KEY || !data.email) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  await sgMail.send({
    to: data.email,
    from: { email: process.env.FROM_EMAIL, name: 'Top of the Palms Reservations' },
    subject: 'Reservation request — fully booked for that date',
    html: `<div style="font-family:sans-serif;max-width:520px;padding:20px">
      <h2 style="color:#006747">Top of the Palms</h2>
      <p>Hi ${data.name},</p>
      <p>Unfortunately we are fully booked for <strong>${data.datetime}</strong> and cannot accommodate your request.</p>
      <p>Please try a different date or contact us directly to check availability.</p>
      <p>— Top of the Palms Reservations Team</p>
    </div>`
  });
}

module.exports = { processReservation };
