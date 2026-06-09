const db = require('./db');
const { sendEmail, sendManagerApprovalEmail } = require('./email');
const directBill = require('./direct-bill');

const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '60'); // 60 PEOPLE not reservations

// options.suppressGuestEmail = true → skip guest pending email (used for multi-day batches)
async function processReservation(session, options = {}) {
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
    if (!options.suppressGuestEmail) await sendLimitEmail(data, remaining).catch(console.error);
    return { success:false, reason:'daily_limit', remaining };
  }

  // ALL reservations go to manager — no auto-approve
  const reservation = await db.createReservation({
    name:data.name, guest_status:data.status,
    department:data.department||'', phone_ext:data.phone_ext||'',
    uid:data.uid, email:data.email, party:partySize,
    num_days:Math.max(1, parseInt(data.num_days||1, 10)),
    group_id:data.group_id||null,
    datetime:data.datetime, reservation_date:resDate,
    reservation_time:data.reservation_time||'',
    seating_preference:data.seating_preference||'',
    payment_method:data.payment_method||'',
    notes:data.notes||'', channel,
    status:'pending_approval'
  });

  console.log(`[Reservation] Saved → ${reservation.id} (all go to manager for approval)`);

  // Notify manager — suppressed for multi-day batches (caller sends one combined email)
  if (!options.suppressManagerEmail) {
    await sendManagerApprovalEmail(reservation).catch(console.error);
  }

  // Guest pending email — suppressed for multi-day batches (caller sends one combined email)
  if (!options.suppressGuestEmail) {
    await sendEmail(reservation, 'pending').catch(console.error);
  }

  // Auto-send Direct Bill form on first day only (caller controls this for multi-day)
  if (!options.suppressDirectBill && (data.payment_method||'').includes('Direct Bill')) {
    setImmediate(async () => {
      try {
        await directBill.sendDirectBillForm(reservation);
        await db.updateReservation(reservation.id, { direct_bill_status: 'sent' });
        console.log(`[DirectBill] Form sent and status updated to 'sent' for ${reservation.email}`);
      } catch(e) {
        console.error('[DirectBill] Auto-send failed:', e.message);
      }
    });
    console.log(`[Reservation] Direct Bill form will be sent to ${reservation.email}`);
  }

  return { success:true, status:'pending', reservation };
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
