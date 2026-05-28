/**
 * Internal POS (Point-of-Sale) replacement
 *
 * Since GH One API access is pending, this module acts as the reservation
 * store that the restaurant floor staff use. Once GH One credentials arrive,
 * swap the body of createReservation() for the real API call in ghone.js.
 *
 * The data IS already in our JSON database — this module just adds a
 * "confirmed" flag and returns a printable reservation slip object.
 */

const db = require('./db');

function createReservation(reservation) {
  // Mark as confirmed in our own system (POS stand-in)
  const updated = db.updateReservation(reservation.id, {
    status:       'approved',
    processed_at: new Date().toISOString()
  });

  const confirmId = reservation.id.slice(0, 8).toUpperCase();

  console.log(`[POS] Reservation confirmed: ${confirmId} — ${reservation.name} × ${reservation.party} — ${reservation.datetime}`);

  // Return a "receipt" object — used for logging and the print view
  return {
    confirmation_number: confirmId,
    name:     reservation.name,
    party:    reservation.party,
    datetime: reservation.datetime,
    uid:      reservation.uid,
    status:   'confirmed',
    note:     `USF ${reservation.guest_status} | Internal ref: ${reservation.id}`
  };
}

function getTodaysReservations() {
  const today = new Date().toISOString().split('T')[0];
  return db.getAllReservations().filter(r =>
    (r.status === 'approved' || r.status === 'auto_approved') &&
    r.created_at.startsWith(today)
  );
}

module.exports = { createReservation, getTodaysReservations };
