const db = require('./db');
const { sendEmail, sendManagerApprovalEmail } = require('./email');

const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '30');

async function processReservation(session) {
  const data    = session.collected;
  const channel = session.channel || 'form';

  const resDate = data.reservation_date || db.toDateStr(data.datetime) || new Date().toISOString().split('T')[0];
  const count   = await db.getDailyCount(resDate);

  console.log(`\n[Reservation] ${data.name} (${data.status}) for ${resDate} | ${count}/${DAILY_LIMIT}`);

  // Daily limit check
  if (count >= DAILY_LIMIT) {
    console.log(`[Reservation] ⚠️  Limit reached — auto-denying`);
    const rec = await db.createReservation({
      ...data, guest_status: data.status, channel,
      reservation_date: resDate, status: 'denied'
    });
    await db.updateReservation(rec.id, {
      processed_at: new Date().toISOString(),
      notes: 'Auto-denied: daily reservation limit reached'
    });
    await sendLimitEmail(data).catch(console.error);
    return { success: false, reason: 'daily_limit' };
  }

  // Save reservation
  const reservation = await db.createReservation({
    name:             data.name,
    guest_status:     data.status,
    uid:              data.uid,
    email:            data.email,
    party:            parseInt(data.party, 10),
    datetime:         data.datetime,
    reservation_date: resDate,
    notes:            data.notes || '',
    channel,
    status: data.status === 'faculty' ? 'auto_approved' : 'pending_approval'
  });

  console.log(`[Reservation] Saved → ${reservation.id}`);

  if (data.status === 'faculty') {
    await db.updateReservation(reservation.id, { status:'approved', processed_at: new Date().toISOString() });
    const updated = await db.getReservation(reservation.id);
    await sendEmail(updated, 'confirmed').catch(console.error);
    console.log(`[Reservation] Faculty auto-approved ✓`);
    return { success: true, status: 'approved' };
  }

  await sendManagerApprovalEmail(reservation).catch(console.error);
  await sendEmail(reservation, 'pending').catch(console.error);
  console.log(`[Reservation] Student queued for manager approval ✓`);
  return { success: true, status: 'pending' };
}

async function sendLimitEmail(data) {
  if (!process.env.SENDGRID_API_KEY || !data.email) return;
  const sg = require('@sendgrid/mail');
  sg.setApiKey(process.env.SENDGRID_API_KEY);
  await sg.send({
    to: data.email,
    from: { email: process.env.FROM_EMAIL, name: 'Top of the Palms Reservations' },
    subject: 'Reservation request — fully booked for that date',
    html: `<div style="font-family:sans-serif;max-width:520px;padding:20px">
      <h2 style="color:#006747">Top of the Palms</h2>
      <p>Hi ${data.name},</p>
      <p>We are fully booked for <strong>${data.datetime}</strong>. Please try a different date or contact us directly.</p>
      <p>— Top of the Palms Reservations Team</p>
    </div>`
  });
}

module.exports = { processReservation };
