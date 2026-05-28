/**
 * Database layer — PostgreSQL (Railway) with JSON file fallback for local dev.
 *
 * If DATABASE_URL is set  → uses PostgreSQL (Railway production)
 * If DATABASE_URL not set → uses data/reservations.json (local laptop)
 *
 * No code changes needed anywhere else — same functions, same return shapes.
 */

const { randomUUID } = require('crypto');
const path = require('path');
const fs   = require('fs');

// ── Detect which backend to use ─────────────────────────────────────────────
const USE_PG = !!process.env.DATABASE_URL;

// ── PostgreSQL setup ────────────────────────────────────────────────────────
let pool;
if (USE_PG) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  // Create table on startup if it doesn't exist
  pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      guest_status     TEXT NOT NULL,
      uid              TEXT NOT NULL,
      email            TEXT NOT NULL,
      party            INTEGER NOT NULL,
      datetime         TEXT NOT NULL,
      reservation_date TEXT,
      notes            TEXT    DEFAULT '',
      table_number     TEXT    DEFAULT '',
      status           TEXT    DEFAULT 'pending_approval',
      attendance       TEXT    DEFAULT 'pending',
      checked_in_at    TEXT,
      channel          TEXT    DEFAULT 'form',
      created_at       TEXT    NOT NULL,
      processed_at     TEXT
    );

    -- Add new columns to existing table if upgrading
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS reservation_date TEXT;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS notes         TEXT    DEFAULT '';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS table_number  TEXT    DEFAULT '';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS attendance     TEXT    DEFAULT 'pending';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_in_at TEXT;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS channel        TEXT    DEFAULT 'form';

    -- Backfill reservation_date for any old rows
    UPDATE reservations
    SET reservation_date = SUBSTRING(created_at, 1, 10)
    WHERE reservation_date IS NULL;
  `).then(() => {
    console.log('[DB] PostgreSQL connected and table ready ✓');
  }).catch(err => {
    console.error('[DB] PostgreSQL setup error:', err.message);
  });
}

// ── JSON file fallback ──────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(dataDir, 'reservations.json');

if (!USE_PG) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([]));
  console.log('[DB] Using local JSON file (no DATABASE_URL set)');
}

function readJSON() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return []; }
}
function writeJSON(rows) { fs.writeFileSync(DB_FILE, JSON.stringify(rows, null, 2)); }

// ── Date helper ─────────────────────────────────────────────────────────────
function toDateStr(val) {
  if (!val) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val.slice(0, 10);
  try {
    const d = new Date(val);
    if (!isNaN(d)) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
  } catch {}
  return null;
}

// ── JSON file migration (local only) ────────────────────────────────────────
if (!USE_PG) {
  const rows = readJSON();
  let changed = 0;
  rows.forEach(r => {
    if (!r.reservation_date && r.datetime) { const d = toDateStr(r.datetime); if (d) { r.reservation_date = d; changed++; } }
    if (r.attendance   === undefined) { r.attendance   = 'pending'; changed++; }
    if (r.checked_in_at=== undefined) { r.checked_in_at= null;    changed++; }
    if (r.table_number === undefined) { r.table_number  = '';      changed++; }
    if (r.notes        === undefined) { r.notes         = '';      changed++; }
  });
  if (changed) { writeJSON(rows); console.log(`[DB] Migrated ${changed} field(s) in JSON`); }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC API — same signatures regardless of backend
// ═══════════════════════════════════════════════════════════════════════════

async function createReservation(data) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const record = {
    id,
    name:             data.name,
    guest_status:     data.guest_status,
    uid:              data.uid,
    email:            data.email,
    party:            parseInt(data.party, 10),
    datetime:         data.datetime,
    reservation_date: data.reservation_date || toDateStr(data.datetime),
    notes:            data.notes || '',
    table_number:     data.table_number || '',
    status:           data.status || 'pending_approval',
    attendance:       'pending',
    checked_in_at:    null,
    channel:          data.channel || 'form',
    created_at:       now,
    processed_at:     null
  };

  if (USE_PG) {
    await pool.query(`
      INSERT INTO reservations
        (id,name,guest_status,uid,email,party,datetime,reservation_date,
         notes,table_number,status,attendance,checked_in_at,channel,created_at,processed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    `, [record.id,record.name,record.guest_status,record.uid,record.email,
        record.party,record.datetime,record.reservation_date,record.notes,
        record.table_number,record.status,record.attendance,record.checked_in_at,
        record.channel,record.created_at,record.processed_at]);
  } else {
    const rows = readJSON();
    rows.unshift(record);
    writeJSON(rows);
  }
  return record;
}

async function getReservation(id) {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT * FROM reservations WHERE id=$1', [id]);
    return rows[0] || null;
  }
  return readJSON().find(r => r.id === id) || null;
}

async function getAllReservations() {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT * FROM reservations ORDER BY created_at DESC');
    return rows;
  }
  return readJSON();
}

async function getReservationsByStatus(status) {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT * FROM reservations WHERE status=$1 ORDER BY created_at DESC', [status]);
    return rows;
  }
  return readJSON().filter(r => r.status === status);
}

async function updateReservation(id, updates) {
  // Recalculate reservation_date if datetime changes
  if (updates.datetime) updates.reservation_date = toDateStr(updates.datetime);

  if (USE_PG) {
    const keys = Object.keys(updates);
    const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
    await pool.query(
      `UPDATE reservations SET ${sets} WHERE id=$1`,
      [id, ...Object.values(updates)]
    );
    return getReservation(id);
  }

  const rows = readJSON();
  const idx  = rows.findIndex(r => r.id === id);
  if (idx === -1) return null;
  Object.assign(rows[idx], updates);
  writeJSON(rows);
  return rows[idx];
}

async function deleteReservation(id) {
  if (USE_PG) {
    await pool.query('DELETE FROM reservations WHERE id=$1', [id]);
  } else {
    writeJSON(readJSON().filter(r => r.id !== id));
  }
}

async function getDailyCount(date) {
  const d = date || new Date().toISOString().split('T')[0];
  if (USE_PG) {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS c FROM reservations
      WHERE reservation_date=$1
        AND status IN ('pending_approval','approved','auto_approved')
    `, [d]);
    return parseInt(rows[0].c, 10);
  }
  return readJSON().filter(r =>
    r.reservation_date === d &&
    ['pending_approval','approved','auto_approved'].includes(r.status)
  ).length;
}

async function getStats() {
  const today = new Date().toISOString().split('T')[0];
  const limit = parseInt(process.env.DAILY_LIMIT || '30');

  if (USE_PG) {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending_approval')                                           AS pending,
        COUNT(*) FILTER (WHERE status IN ('approved','auto_approved') AND reservation_date=$1)      AS approved_today,
        COUNT(*) FILTER (WHERE status='denied')                                                     AS denied_all,
        COUNT(*) FILTER (WHERE reservation_date=$1 AND status IN ('pending_approval','approved','auto_approved')) AS total_today,
        COUNT(*)                                                                                     AS total_all,
        COUNT(*) FILTER (WHERE attendance='checked_in'  AND reservation_date=$1)                   AS checked_in_today,
        COUNT(*) FILTER (WHERE attendance='no_show'     AND reservation_date=$1)                   AS no_show_today,
        COUNT(*) FILTER (WHERE reservation_date=$1 AND status IN ('pending_approval','approved','auto_approved')) AS daily_count
      FROM reservations
    `, [today]);
    const s = rows[0];
    return {
      pending:          parseInt(s.pending,10),
      approved_today:   parseInt(s.approved_today,10),
      denied_all:       parseInt(s.denied_all,10),
      total_today:      parseInt(s.total_today,10),
      total_all:        parseInt(s.total_all,10),
      checked_in_today: parseInt(s.checked_in_today,10),
      no_show_today:    parseInt(s.no_show_today,10),
      daily_count:      parseInt(s.daily_count,10),
      daily_limit:      limit,
      slots_left:       Math.max(0, limit - parseInt(s.daily_count,10))
    };
  }

  // JSON fallback
  const rows  = readJSON();
  const active = ['pending_approval','approved','auto_approved'];
  const forToday   = rows.filter(r => r.reservation_date === today);
  const dailyCount = forToday.filter(r => active.includes(r.status)).length;
  return {
    pending:          rows.filter(r => r.status === 'pending_approval').length,
    approved_today:   forToday.filter(r => ['approved','auto_approved'].includes(r.status)).length,
    denied_all:       rows.filter(r => r.status === 'denied').length,
    total_today:      forToday.filter(r => active.includes(r.status)).length,
    total_all:        rows.length,
    checked_in_today: forToday.filter(r => r.attendance === 'checked_in').length,
    no_show_today:    forToday.filter(r => r.attendance === 'no_show').length,
    daily_count:      dailyCount,
    daily_limit:      limit,
    slots_left:       Math.max(0, limit - dailyCount)
  };
}

module.exports = {
  createReservation, getReservation, getAllReservations,
  getReservationsByStatus, updateReservation, deleteReservation,
  getDailyCount, getStats, toDateStr
};
