const db = require('./db');
const { sendEmail, sendManagerApprovalEmail, sendDirectBillEmail } = require('./email');

const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '60'); // 60 PEOPLE not reservations

async function processReservation(session) {
  const data    = session.collected;
  const channel = session.channel || 'form';
  const resDate = data.reservation_date || db.toDateStr(data.datetime) || new Date().toISOString().split('T')[0];
  const partySize = parseInt(data.party, 10);

  // Check people-based daily limit
  const currentPeople = await db.getDailyPeopleCount(resDate);
  const wouldTotal    = currentPeople + partySize;

  console.log(`\n[Reservation] ${data.name} party:${partySize} | ${currentPeople}+${partySize}=${wouldTotal}/${DAILY_LIMIT} people for ${resDate}`);

  if (wouldTotal > DAILY_LIMIT) {
    const remaining = Math.max(0, DAILY_LIMIT - currentPeople);
    console.log(`[Reservation] ⚠️  Exceeds people limit — only ${remaining} spots left`);
    const rec = await db.createReservation({ ...data, guest_status:data.status, channel, reservation_date:resDate, status:'denied' });
    await db.updateReservation(rec.id, { processed_at:new Date().toISOString(), notes:`Auto-denied: only ${remaining} covers remaining for this date` });
    await sendLimitEmail(data, remaining).catch(console.error);
    return { success:false, reason:'daily_limit', remaining };
  }

  // ALL reservations go to manager — no auto-approve (requirement 5)
  const reservation = await db.createReservation({
    name:data.name, guest_status:data.status,
    department:data.department||'', phone_ext:data.phone_ext||'',
    uid:data.uid, email:data.email, party:partySize,
    datetime:data.datetime, reservation_date:resDate,
    reservation_time:data.reservation_time||'',
    seating_preference:data.seating_preference||'',
    payment_method:data.payment_method||'',
    notes:data.notes||'', channel,
    status:'pending_approval'
  });

  console.log(`[Reservation] Saved → ${reservation.id} (all go to manager for approval)`);

  // Notify manager
  await sendManagerApprovalEmail(reservation).catch(console.error);
  // Tell guest it's under review
  await sendEmail(reservation, 'pending').catch(console.error);
  // If Direct Bill — send document email to guest
  if ((data.payment_method||'').includes('Direct Bill')) {
    await sendDirectBillEmail(reservation).catch(console.error);
    console.log(`[Reservation] Direct Bill document sent to ${data.email}`);
  }

  return { success:true, status:'pending' };
}

async function sendLimitEmail(data, remaining) {
  if (!process.env.SENDGRID_API_KEY || !data.email) return;
  const sg = require('@sendgrid/mail');
  sg.setApiKey(process.env.SENDGRID_API_KEY);
  await sg.send({
    to:data.email, from:{email:process.env.FROM_EMAIL, name:'Top of the Palms Reservations'},
    subject:'Reservation request — insufficient capacity for that date',
    html:`<div style="font-family:sans-serif;max-width:520px;padding:20px"><h2 style="color:#006747">Top of the Palms</h2>
    <p>Hi ${data.name},</p>
    <p>Unfortunately we cannot accommodate your party of <strong>${data.party}</strong> for <strong>${data.datetime}</strong>.</p>
    ${remaining>0?`<p>We currently have <strong>${remaining} covers</strong> remaining for that date. Please try a smaller party size or a different date.</p>`:`<p>We are fully booked for that date. Please try a different date.</p>`}
    <p>— Top of the Palms Reservations Team</p></div>`
  });
}

module.exports = { processReservation };
