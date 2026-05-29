/**
 * Blocked dates manager — stores holidays and closures
 * Uses PostgreSQL in production, JSON file locally
 */
const path = require('path');
const fs   = require('fs');

const USE_PG = !!process.env.DATABASE_URL;
let pool;

if (USE_PG) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.query(`
    CREATE TABLE IF NOT EXISTS blocked_dates (
      date        TEXT PRIMARY KEY,
      reason      TEXT NOT NULL DEFAULT 'Holiday',
      created_at  TEXT NOT NULL
    );
  `).then(() => console.log('[Blocked] Table ready ✓')).catch(e => console.error('[Blocked]', e.message));
}

const dataDir = path.join(__dirname, '..', 'data');
const FILE = path.join(dataDir, 'blocked-dates.json');
if (!USE_PG) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(FILE)) {
    // Pre-load US Federal Holidays 2025 + 2026
    const defaults = [
      { date:'2025-01-01', reason:'New Year\'s Day' },
      { date:'2025-01-20', reason:'Martin Luther King Jr. Day' },
      { date:'2025-02-17', reason:'Presidents Day' },
      { date:'2025-05-26', reason:'Memorial Day' },
      { date:'2025-07-04', reason:'Independence Day' },
      { date:'2025-09-01', reason:'Labor Day' },
      { date:'2025-11-11', reason:'Veterans Day' },
      { date:'2025-11-27', reason:'Thanksgiving Day' },
      { date:'2025-12-25', reason:'Christmas Day' },
      { date:'2026-01-01', reason:'New Year\'s Day' },
      { date:'2026-01-19', reason:'Martin Luther King Jr. Day' },
      { date:'2026-02-16', reason:'Presidents Day' },
      { date:'2026-05-25', reason:'Memorial Day' },
      { date:'2026-07-03', reason:'Independence Day (observed)' },
      { date:'2026-09-07', reason:'Labor Day' },
      { date:'2026-11-11', reason:'Veterans Day' },
      { date:'2026-11-26', reason:'Thanksgiving Day' },
      { date:'2026-12-25', reason:'Christmas Day' },
    ].map(d => ({ ...d, created_at: new Date().toISOString() }));
    fs.writeFileSync(FILE, JSON.stringify(defaults, null, 2));
  }
}

function readJSON() { try { return JSON.parse(fs.readFileSync(FILE,'utf8')); } catch { return []; } }

async function getAllBlocked() {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT * FROM blocked_dates ORDER BY date ASC');
    return rows;
  }
  return readJSON().sort((a,b) => a.date.localeCompare(b.date));
}

async function isBlocked(date) {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT * FROM blocked_dates WHERE date=$1', [date]);
    return rows[0] || null;
  }
  return readJSON().find(d => d.date === date) || null;
}

async function addBlocked(date, reason) {
  const now = new Date().toISOString();
  if (USE_PG) {
    await pool.query('INSERT INTO blocked_dates (date,reason,created_at) VALUES ($1,$2,$3) ON CONFLICT (date) DO UPDATE SET reason=$2', [date, reason, now]);
  } else {
    const rows = readJSON().filter(d => d.date !== date);
    rows.push({ date, reason, created_at: now });
    fs.writeFileSync(FILE, JSON.stringify(rows.sort((a,b)=>a.date.localeCompare(b.date)), null, 2));
  }
  return { date, reason };
}

async function removeBlocked(date) {
  if (USE_PG) {
    await pool.query('DELETE FROM blocked_dates WHERE date=$1', [date]);
  } else {
    fs.writeFileSync(FILE, JSON.stringify(readJSON().filter(d => d.date !== date), null, 2));
  }
}

// Returns all blocked dates as a Set of YYYY-MM-DD strings (for fast lookup)
async function getBlockedSet() {
  const all = await getAllBlocked();
  return new Set(all.map(d => d.date));
}

module.exports = { getAllBlocked, isBlocked, addBlocked, removeBlocked, getBlockedSet };
