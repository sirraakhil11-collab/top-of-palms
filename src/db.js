const path = require('path');
const fs   = require('fs');
const { randomUUID } = require('crypto');

const dataDir = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(dataDir, 'reservations.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([]));

function read() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return []; }
}
function write(rows) { fs.writeFileSync(DB_FILE, JSON.stringify(rows, null, 2)); }

function createReservation(data) {
  const rows   = read();
  const record = {
    id:           randomUUID(),
    name:         data.name,
    guest_status: data.guest_status,
    uid:          data.uid,
    email:        data.email,
    party:        data.party,
    datetime:     data.datetime,
    notes:        data.notes || '',
    table_number: data.table_number || '',
    status:       data.status || 'pending_approval',
    channel:      data.channel || 'form',
    created_at:   new Date().toISOString(),
    processed_at: null
  };
  rows.unshift(record);
  write(rows);
  return record;
}

function getReservation(id)        { return read().find(r => r.id === id) || null; }
function getAllReservations()       { return read(); }
function getReservationsByStatus(s){ return read().filter(r => r.status === s); }

function updateReservation(id, updates) {
  const rows = read();
  const idx  = rows.findIndex(r => r.id === id);
  if (idx === -1) return null;
  Object.assign(rows[idx], updates);
  write(rows);
  return rows[idx];
}

function deleteReservation(id) {
  write(read().filter(r => r.id !== id));
}

// Count approved/pending reservations for a specific date (YYYY-MM-DD)
function getDailyCount(date) {
  const d = date || new Date().toISOString().split('T')[0];
  return read().filter(r =>
    r.created_at.startsWith(d) &&
    ['pending_approval','approved','auto_approved'].includes(r.status)
  ).length;
}

function getStats() {
  const rows  = read();
  const today = new Date().toISOString().split('T')[0];
  const limit = parseInt(process.env.DAILY_LIMIT || '30');
  return {
    pending:        rows.filter(r => r.status === 'pending_approval').length,
    approved_today: rows.filter(r => r.status === 'approved' && r.processed_at?.startsWith(today)).length,
    denied_today:   rows.filter(r => r.status === 'denied' && r.processed_at?.startsWith(today)).length,
    total_today:    rows.filter(r => r.created_at?.startsWith(today)).length,
    daily_count:    getDailyCount(today),
    daily_limit:    limit,
    slots_left:     Math.max(0, limit - getDailyCount(today))
  };
}

module.exports = { createReservation, getReservation, getAllReservations, getReservationsByStatus, updateReservation, deleteReservation, getDailyCount, getStats };
