const db = require('./db');

/**
 * Creates a reservation in GH One (Grubhub) POS system.
 *
 * GH One API credentials must be obtained from your Grubhub account rep.
 * Contact: Andy Allen or Sean Hanlon (Client Success team).
 *
 * Required .env vars:
 *   GHONE_API_URL      — e.g. https://api.grubhub.com/v1
 *   GHONE_API_KEY      — Bearer token from Grubhub
 *   GHONE_LOCATION_ID  — Your restaurant's location ID in GH One
 *
 * If these are not set, the function logs and returns a simulated result
 * so the rest of the flow (emails, DB) still works during setup.
 */
async function createGHOneReservation(reservation) {
  const apiUrl    = process.env.GHONE_API_URL;
  const apiKey    = process.env.GHONE_API_KEY;
  const locationId = process.env.GHONE_LOCATION_ID;

  if (!apiUrl || !apiKey) {
    console.log(`[GH One] ⚠️  Not configured — skipping POS create for ${reservation.name}`);
    console.log(`[GH One]    Set GHONE_API_URL, GHONE_API_KEY, GHONE_LOCATION_ID in .env`);
    console.log(`[GH One]    Details: ${reservation.party} guests on ${reservation.datetime}`);
    return { simulated: true, id: `SIM-${reservation.id.slice(0, 8).toUpperCase()}` };
  }

  const payload = {
    location_id:      locationId,
    guest_name:       reservation.name,
    guest_email:      reservation.email,
    party_size:       reservation.party,
    reservation_time: reservation.datetime,
    special_notes:    `USF ${reservation.guest_status.toUpperCase()} — UID: ${reservation.uid} | Ref: ${reservation.id.slice(0, 8)}`,
    source:           'phone_agent',
    external_id:      reservation.id
  };

  const response = await fetch(`${apiUrl}/reservations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GH One API ${response.status}: ${body}`);
  }

  const data = await response.json();
  const ghoneId = String(data.reservation_id || data.id || 'unknown');

  console.log(`[GH One] Reservation created: ${ghoneId}`);

  // Store GH One ID back in our database
  db.updateReservation(reservation.id, { ghone_id: ghoneId });

  return data;
}

module.exports = { createGHOneReservation };
