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

// Parse "Jun 7 2026 6:00 PM" or "May 29, 2026 12:50 PM" → "2026-06-07"
function parseReservationDate(datetimeStr) {
  if (!datetimeStr) return null;
  try {
    const d = new Date(datetimeStr);
    if (isNaN(d)) return null;
    return d.toISOString().split('T')[0];
  } catch { return null; }
}

function createReservation(data) {
  const rows = read();
  const record = {
    id:               randomUUID(),
    name:             data.name,
    guest_status:     data.guest_status,
    uid:              data.uid,
    email:            data.email,
    party:            data.party,
    datetime:         data.datetime,
    reservation_date: parseReservationDate(data.datetime), // YYYY-MM-DD of the actual reservation
    notes:            data.notes || '',
    table_number:     data.table_number || '',
    status:           data.status || 'pending_approval',
    channel:          data.channel || 'form',
    created_at:       new Date().toISOString(),   // when submitted
    processed_at:     null
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
  // If datetime is being updated, recalculate reservation_date
  if (updates.datetime) {
    updates.reservation_date = parseReservationDate(updates.datetime);
  }
  Object.assign(rows[idx], updates);
  write(rows);
  return rows[idx];
}

function deleteReservation(id) {
  write(read().filter(r => r.id !== id));
}

// Count active reservations FOR a specific date (by reservation_date, not created_at)
function getDailyCount(date) {
  const d = date || new Date().toISOString().split('T')[0];
  return read().filter(r =>
    r.reservation_date === d &&
    ['pending_approval', 'approved', 'auto_approved'].includes(r.status)
  ).length;
}

function getStats() {
  const rows  = read();
  const today = new Date().toISOString().split('T')[0];
  const limit = parseInt(process.env.DAILY_LIMIT || '30');

  // Reservations FOR today (by actual reservation date)
  const forToday  = rows.filter(r => r.reservation_date === today);
  const dailyCount = forToday.filter(r => ['pending_approval','approved','auto_approved'].includes(r.status)).length;

  return {
    // Card 1: all currently pending
    pending:           rows.filter(r => r.status === 'pending_approval').length,
    // Card 2: approved reservations FOR today
    approved_today:    forToday.filter(r => r.status === 'approved' || r.status === 'auto_approved').length,
    // Card 3: all denied ever
    total_denied:      rows.filter(r => r.status === 'denied').length,
    // Card 4: total reservations FOR today (pending + approved)
    total_today:       forToday.filter(r => r.status !== 'denied').length,
    // Card 5: slots remaining today
    daily_count:       dailyCount,
    daily_limit:       limit,
    slots_left:        Math.max(0, limit - dailyCount),
    // Overall total
    total_all:         rows.length
  };
}

module.exports = {
  createReservation, getReservation, getAllReservations,
  getReservationsByStatus, updateReservation, deleteReservation,
  getDailyCount, getStats, parseReservationDate
};
