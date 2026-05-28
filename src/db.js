/**
 * Lightweight JSON file database.
 * No native compilation required — works on any platform.
 * For high-traffic production use, swap this module for a PostgreSQL or
 * MySQL adapter without changing any other file.
 */
const path = require('path');
const fs   = require('fs');
const { randomUUID } = require('crypto');

const dataDir  = path.join(__dirname, '..', 'data');
const DB_FILE  = path.join(dataDir, 'reservations.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([]));

// ── Read / write helpers ─────────────────────────────────────────────────────

function read() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return []; }
}

function write(rows) {
  fs.writeFileSync(DB_FILE, JSON.stringify(rows, null, 2));
}

// ── Public API ───────────────────────────────────────────────────────────────

function createReservation(data) {
  const rows = read();
  const record = {
    id:           randomUUID(),
    name:         data.name,
    guest_status: data.guest_status,
    uid:          data.uid,
    email:        data.email,
    party:        data.party,
    datetime:     data.datetime,
    status:       data.status || 'pending_approval',
    ghone_id:     null,
    caller_number: data.caller_number || '',
    call_sid:     data.call_sid || '',
    created_at:   new Date().toISOString(),
    processed_at: null
  };
  rows.unshift(record);
  write(rows);
  return record;
}

function getReservation(id) {
  return read().find(r => r.id === id) || null;
}

function updateReservation(id, updates) {
  const rows = read();
  const idx  = rows.findIndex(r => r.id === id);
  if (idx === -1) return null;
  Object.assign(rows[idx], updates);
  write(rows);
  return rows[idx];
}

function getReservationsByStatus(status) {
  return read().filter(r => r.status === status);
}

function getAllReservations() {
  return read();   // already sorted newest-first from unshift
}

function getStats() {
  const rows  = read();
  const today = new Date().toISOString().split('T')[0];
  return {
    pending:        rows.filter(r => r.status === 'pending_approval').length,
    approved_today: rows.filter(r => r.status === 'approved' && r.processed_at?.startsWith(today)).length,
    denied_today:   rows.filter(r => r.status === 'denied'   && r.processed_at?.startsWith(today)).length,
    total_today:    rows.filter(r => r.created_at?.startsWith(today)).length
  };
}

module.exports = { createReservation, getReservation, updateReservation, getReservationsByStatus, getAllReservations, getStats };
