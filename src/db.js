/**
 * Database layer — PostgreSQL + JSON fallback
 * v11-fix: Uses explicit column names in INSERT to avoid PostgreSQL column order issues
 */
const { randomUUID } = require('crypto');
const path = require('path');
const fs   = require('fs');

const USE_PG = !!process.env.DATABASE_URL;

let pool;
if (USE_PG) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // Use explicit CREATE TABLE with all columns defined upfront
  pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL DEFAULT '',
      guest_status        TEXT NOT NULL DEFAULT 'student',
      department          TEXT DEFAULT '',
      phone_ext           TEXT DEFAULT '',
      uid                 TEXT NOT NULL DEFAULT '',
      email               TEXT NOT NULL DEFAULT '',
      party               INTEGER NOT NULL DEFAULT 1,
      datetime            TEXT NOT NULL DEFAULT '',
      reservation_date    TEXT DEFAULT '',
      reservation_time    TEXT DEFAULT '',
      seating_preference  TEXT DEFAULT '',
      payment_method      TEXT DEFAULT '',
      direct_bill_status  TEXT DEFAULT 'na',
      notes               TEXT DEFAULT '',
      table_number        TEXT DEFAULT '',
      status              TEXT DEFAULT 'pending_approval',
      attendance          TEXT DEFAULT 'pending',
      checked_in_at       TEXT,
      channel             TEXT DEFAULT 'form',
      created_at          TEXT NOT NULL DEFAULT '',
      processed_at        TEXT
    );

    -- Safe column additions for tables created before v11
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS department         TEXT DEFAULT '';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS phone_ext          TEXT DEFAULT '';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS reservation_time   TEXT DEFAULT '';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS seating_preference TEXT DEFAULT '';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS payment_method     TEXT DEFAULT '';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS direct_bill_status TEXT DEFAULT 'na';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS attendance         TEXT DEFAULT 'pending';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_in_at      TEXT;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS notes              TEXT DEFAULT '';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS table_number       TEXT DEFAULT '';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS channel            TEXT DEFAULT 'form';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS reservation_date   TEXT DEFAULT '';

    -- Fix any rows that have NULL in important fields
    UPDATE reservations SET department        = '' WHERE department IS NULL;
    UPDATE reservations SET phone_ext         = '' WHERE phone_ext IS NULL;
    UPDATE reservations SET reservation_time  = '' WHERE reservation_time IS NULL;
    UPDATE reservations SET seating_preference= '' WHERE seating_preference IS NULL;
    UPDATE reservations SET payment_method    = '' WHERE payment_method IS NULL;
    UPDATE reservations SET direct_bill_status= 'na' WHERE direct_bill_status IS NULL;
    UPDATE reservations SET attendance        = 'pending' WHERE attendance IS NULL;
    UPDATE reservations SET notes             = '' WHERE notes IS NULL;
    UPDATE reservations SET table_number      = '' WHERE table_number IS NULL;
    UPDATE reservations SET channel           = 'form' WHERE channel IS NULL;
    UPDATE reservations SET reservation_date  = SUBSTRING(created_at,1,10) WHERE reservation_date IS NULL OR reservation_date = '';
  `).then(() => console.log('[DB] PostgreSQL ready ✓'))
    .catch(e => console.error('[DB] Setup error:', e.message));
}

// ── JSON file fallback ──────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(dataDir, 'reservations.json');
if (!USE_PG) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([]));
  console.log('[DB] Using local JSON file');
}

function readJSON() { try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch { return []; } }
function writeJSON(r) { fs.writeFileSync(DB_FILE, JSON.stringify(r,null,2)); }

// ── Date helper ────────────────────────────────────────────────────────────
function toDateStr(val) {
  if (!val) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val.slice(0,10);
  try {
    const d = new Date(val);
    if (!isNaN(d)) {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    }
  } catch {}
  return null;
}

// ── JSON migration ─────────────────────────────────────────────────────────
if (!USE_PG) {
  const rows = readJSON(); let ch = 0;
  const defs = { reservation_date:'', reservation_time:'', department:'', phone_ext:'', seating_preference:'', payment_method:'', direct_bill_status:'na', attendance:'pending', checked_in_at:null, notes:'', table_number:'', channel:'form' };
  rows.forEach(r => {
    if (!r.reservation_date && r.datetime) { const d=toDateStr(r.datetime); if(d){r.reservation_date=d;ch++;} }
    Object.entries(defs).forEach(([k,v]) => { if(r[k]===undefined){r[k]=v;ch++;} });
  });
  if (ch) { writeJSON(rows); console.log(`[DB] Migrated ${ch} fields`); }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CRUD — explicit column names prevent PostgreSQL column order issues
// ═══════════════════════════════════════════════════════════════════════════

async function createReservation(data) {
  const id  = randomUUID();
  const now = new Date().toISOString();
  const hasDB = (data.payment_method||'').includes('Direct Bill');
  const record = {
    id,
    name:               data.name             || '',
    guest_status:       data.guest_status      || data.status || 'student',
    department:         data.department        || '',
    phone_ext:          data.phone_ext         || '',
    uid:                data.uid               || '',
    email:              data.email             || '',
    party:              parseInt(data.party,10) || 1,
    datetime:           data.datetime          || '',
    reservation_date:   data.reservation_date  || toDateStr(data.datetime) || '',
    reservation_time:   data.reservation_time  || '',
    seating_preference: data.seating_preference|| '',
    payment_method:     data.payment_method    || '',
    direct_bill_status: hasDB ? 'pending_document' : 'na',
    notes:              data.notes             || '',
    table_number:       data.table_number      || '',
    status:             data.status            || 'pending_approval',
    attendance:         'pending',
    checked_in_at:      null,
    channel:            data.channel           || 'form',
    created_at:         now,
    processed_at:       null
  };

  if (USE_PG) {
    // EXPLICIT column names — prevents positional mismatch from ALTER TABLE column order
    await pool.query(`
      INSERT INTO reservations
        (id, name, guest_status, department, phone_ext, uid, email, party,
         datetime, reservation_date, reservation_time, seating_preference,
         payment_method, direct_bill_status, notes, table_number, status,
         attendance, checked_in_at, channel, created_at, processed_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    `, [
      record.id, record.name, record.guest_status, record.department, record.phone_ext,
      record.uid, record.email, record.party, record.datetime, record.reservation_date,
      record.reservation_time, record.seating_preference, record.payment_method,
      record.direct_bill_status, record.notes, record.table_number, record.status,
      record.attendance, record.checked_in_at, record.channel, record.created_at, record.processed_at
    ]);
  } else {
    const rows = readJSON(); rows.unshift(record); writeJSON(rows);
  }
  return record;
}

async function getReservation(id) {
  if (USE_PG) { const {rows}=await pool.query('SELECT * FROM reservations WHERE id=$1',[id]); return rows[0]||null; }
  return readJSON().find(r=>r.id===id)||null;
}

async function getAllReservations() {
  if (USE_PG) { const {rows}=await pool.query('SELECT * FROM reservations ORDER BY created_at DESC'); return rows; }
  return readJSON();
}

async function getReservationsByStatus(status) {
  if (USE_PG) { const {rows}=await pool.query('SELECT * FROM reservations WHERE status=$1 ORDER BY created_at DESC',[status]); return rows; }
  return readJSON().filter(r=>r.status===status);
}

async function updateReservation(id, updates) {
  if (updates.datetime) updates.reservation_date = toDateStr(updates.datetime);
  // Auto-set direct_bill_status when payment_method changes
  if (updates.payment_method !== undefined) {
    const hasDB = (updates.payment_method||'').includes('Direct Bill');
    if (!updates.direct_bill_status) updates.direct_bill_status = hasDB ? 'pending_document' : 'na';
  }
  if (USE_PG) {
    const keys = Object.keys(updates);
    const sets = keys.map((k,i)=>`${k}=$${i+2}`).join(', ');
    await pool.query(`UPDATE reservations SET ${sets} WHERE id=$1`,[id,...Object.values(updates)]);
    return getReservation(id);
  }
  const rows=readJSON(), idx=rows.findIndex(r=>r.id===id);
  if (idx===-1) return null;
  Object.assign(rows[idx],updates); writeJSON(rows); return rows[idx];
}

async function deleteReservation(id) {
  if (USE_PG) { await pool.query('DELETE FROM reservations WHERE id=$1',[id]); }
  else writeJSON(readJSON().filter(r=>r.id!==id));
}

// People-based daily count (sum of party sizes)
async function getDailyPeopleCount(date) {
  const d = date || new Date().toISOString().split('T')[0];
  if (USE_PG) {
    const {rows}=await pool.query(`SELECT COALESCE(SUM(party),0) AS total FROM reservations WHERE reservation_date=$1 AND status IN ('pending_approval','approved')`,[d]);
    return parseInt(rows[0].total,10);
  }
  return readJSON().filter(r=>r.reservation_date===d&&['pending_approval','approved'].includes(r.status)).reduce((s,r)=>s+r.party,0);
}

async function getStats() {
  const today = new Date().toISOString().split('T')[0];
  const limit = parseInt(process.env.DAILY_LIMIT||'60');

  if (USE_PG) {
    const {rows}=await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending_approval')                                            AS pending,
        COUNT(*) FILTER (WHERE status IN ('approved','auto_approved') AND reservation_date=$1)       AS approved_today,
        COUNT(*) FILTER (WHERE status='denied')                                                      AS denied_all,
        COUNT(*) FILTER (WHERE reservation_date=$1 AND status IN ('pending_approval','approved'))    AS total_today,
        COUNT(*)                                                                                      AS total_all,
        COALESCE(SUM(party) FILTER (WHERE reservation_date=$1 AND status IN ('pending_approval','approved')),0) AS people_today,
        COUNT(*) FILTER (WHERE attendance='checked_in'  AND reservation_date=$1)                    AS checked_in_today,
        COUNT(*) FILTER (WHERE attendance='no_show'     AND reservation_date=$1)                    AS no_show_today,
        COUNT(*) FILTER (WHERE direct_bill_status='pending_document')                               AS direct_bill_pending
      FROM reservations
    `,[today]);
    const s=rows[0];
    const pc=parseInt(s.people_today,10);
    return {
      pending:parseInt(s.pending),approved_today:parseInt(s.approved_today),
      denied_all:parseInt(s.denied_all),total_today:parseInt(s.total_today),
      total_all:parseInt(s.total_all),people_today:pc,
      checked_in_today:parseInt(s.checked_in_today),no_show_today:parseInt(s.no_show_today),
      direct_bill_pending:parseInt(s.direct_bill_pending),
      daily_count:pc,daily_limit:limit,slots_left:Math.max(0,limit-pc)
    };
  }

  const rows=readJSON();
  const forToday=rows.filter(r=>r.reservation_date===today);
  const active=forToday.filter(r=>['pending_approval','approved'].includes(r.status));
  const pc=active.reduce((s,r)=>s+r.party,0);
  return {
    pending:rows.filter(r=>r.status==='pending_approval').length,
    approved_today:forToday.filter(r=>['approved','auto_approved'].includes(r.status)).length,
    denied_all:rows.filter(r=>r.status==='denied').length,
    total_today:active.length, total_all:rows.length, people_today:pc,
    checked_in_today:forToday.filter(r=>r.attendance==='checked_in').length,
    no_show_today:forToday.filter(r=>r.attendance==='no_show').length,
    direct_bill_pending:rows.filter(r=>r.direct_bill_status==='pending_document').length,
    daily_count:pc,daily_limit:limit,slots_left:Math.max(0,limit-pc)
  };
}

module.exports = {createReservation,getReservation,getAllReservations,getReservationsByStatus,updateReservation,deleteReservation,getDailyPeopleCount,getStats,toDateStr};
