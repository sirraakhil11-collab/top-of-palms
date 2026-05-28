const db           = require('./db');
const { sendEmail }    = require('./email');
const pos          = require('./pos');
const { notifyManager } = require('./manager');

async function processReservation(session) {
  const data = session.collected;
  const channel = session.channel || 'voice';

  console.log(`\n[Reservation] Processing ${data.name} (${data.status}) via ${channel}`);

  const reservation = db.createReservation({
    name:          data.name,
    guest_status:  data.status,
    uid:           data.uid,
    email:         data.email,
    party:         parseInt(data.party, 10),
    datetime:      data.datetime,
    status:        data.status === 'faculty' ? 'auto_approved' : 'pending_approval',
    caller_number: session.callerNumber || '',
    call_sid:      session.callSid || ''
  });

  console.log(`[Reservation] Saved → ${reservation.id}`);

  if (data.status === 'faculty') {
    // Auto-approve: create in POS, send confirmation email
    try {
      pos.createReservation(reservation);
      await sendEmail(reservation, 'confirmed');
      console.log(`[Reservation] Faculty auto-approved ✓`);
    } catch (err) {
      console.error(`[Reservation] Faculty error:`, err.message);
    }
  } else {
    // Student: queue for manager approval
    try {
      await notifyManager(reservation);
      await sendEmail(reservation, 'pending');
      console.log(`[Reservation] Student queued for manager ✓`);
    } catch (err) {
      console.error(`[Reservation] Student routing error:`, err.message);
    }
  }
}

module.exports = { processReservation };
