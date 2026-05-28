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

// ── Parse any datetime string → YYYY-MM-DD ────────────────────────────────
// Handles: "May 29, 2026 12:50 PM", "Jun 7 2026 6:00 PM", "2026-05-27", ISO strings
function toDateStr(val) {
  if (!val) return null;
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val.slice(0, 10);
  // Try native parse (works for most English date strings)
  try {
    const d = new Date(val);
    if (!isNaN(d)) {
      // Use UTC to avoid timezone shift on Railway server
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
  } catch {}
  return null;
}

// ── Startup migration: backfill reservation_date for all old records ───────
function migrate() {
  const rows = read();
  let changed = 0;
  rows.forEach(r => {
    if (!r.reservation_date && r.datetime) {
      const d = toDateStr(r.datetime);
      if (d) { r.reservation_date = d; changed++; }
    }
  });
  if (changed > 0) {
    write(rows);
    console.log(`[DB] Migrated ${changed} records → reservation_date set`);
  }
}
migrate(); // Run on require

// ── CRUD ──────────────────────────────────────────────────────────────────
function createReservation(data) {
  const rows = read();
  const record = {
    id:               randomUUID(),
    name:             data.name,
    guest_status:     data.guest_status,
    uid:              data.uid,
    email:            data.email,
    party:            data.party,
    datetime:         data.datetime,          // Display string e.g. "May 29, 2026 7:00 PM"
    reservation_date: data.reservation_date   // YYYY-MM-DD — passed in from server
                      || toDateStr(data.datetime),
    notes:            data.notes || '',
    table_number:     data.table_number || '',
    status:           data.status || 'pending_approval',
    channel:          data.channel || 'form',
    created_at:       new Date().toISOString(),
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
  // Recalculate reservation_date if datetime changes
  if (updates.datetime) {
    updates.reservation_date = toDateStr(updates.datetime);
  }
  Object.assign(rows[idx], updates);
  write(rows);
  return rows[idx];
}

function deleteReservation(id) {
  write(read().filter(r => r.id !== id));
}

// Count active reservations FOR a date (uses reservation_date)
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
  const active = ['pending_approval','approved','auto_approved'];

  const forToday   = rows.filter(r => r.reservation_date === today);
  const dailyCount = forToday.filter(r => active.includes(r.status)).length;

  return {
    pending:        rows.filter(r => r.status === 'pending_approval').length,
    approved_today: forToday.filter(r => r.status === 'approved' || r.status === 'auto_approved').length,
    denied_all:     rows.filter(r => r.status === 'denied').length,
    total_today:    forToday.filter(r => active.includes(r.status)).length,
    total_all:      rows.filter(r => active.includes(r.status) || r.status === 'approved' || r.status === 'auto_approved').length,
    daily_count:    dailyCount,
    daily_limit:    limit,
    slots_left:     Math.max(0, limit - dailyCount)
  };
}

module.exports = {
  createReservation, getReservation, getAllReservations,
  getReservationsByStatus, updateReservation, deleteReservation,
  getDailyCount, getStats, toDateStr
};
