/**
 * Database layer — PostgreSQL (Railway) with JSON file fallback for local dev.
 * v11 — added department, phone_ext, seating_preference, payment_method,
 *        direct_bill_status, people-based daily limit
 */

const { randomUUID } = require('crypto');
const path = require('path');
const fs   = require('fs');

const USE_PG = !!process.env.DATABASE_URL;

let pool;
if (USE_PG) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      guest_status        TEXT NOT NULL,
      department          TEXT DEFAULT '',
      phone_ext           TEXT DEFAULT '',
      uid                 TEXT NOT NULL,
      email               TEXT NOT NULL,
      party               INTEGER NOT NULL,
      datetime            TEXT NOT NULL,
      reservation_date    TEXT,
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
      created_at          TEXT NOT NULL,
      processed_at        TEXT
    );
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
    UPDATE reservations SET reservation_date = SUBSTRING(created_at,1,10) WHERE reservation_date IS NULL;
    UPDATE reservations SET direct_bill_status = 'na' WHERE direct_bill_status IS NULL;
  `).then(() => console.log('[DB] PostgreSQL ready ✓')).catch(e => console.error('[DB] Setup error:', e.message));
}

// JSON fallback
const dataDir = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(dataDir, 'reservations.json');
if (!USE_PG) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([]));
  console.log('[DB] Using local JSON file');
}

function readJSON() { try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch { return []; } }
function writeJSON(r) { fs.writeFileSync(DB_FILE, JSON.stringify(r,null,2)); }

function toDateStr(val) {
  if (!val) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val.slice(0,10);
  try { const d=new Date(val); if(!isNaN(d)){ const y=d.getUTCFullYear(),m=String(d.getUTCMonth()+1).padStart(2,'0'),dy=String(d.getUTCDate()).padStart(2,'0'); return `${y}-${m}-${dy}`; } } catch {}
  return null;
}

if (!USE_PG) {
  const rows=readJSON(); let ch=0;
  rows.forEach(r=>{
    if(!r.reservation_date&&r.datetime){const d=toDateStr(r.datetime);if(d){r.reservation_date=d;ch++;}}
    const defaults={attendance:'pending',checked_in_at:null,table_number:'',notes:'',department:'',phone_ext:'',seating_preference:'',payment_method:'',direct_bill_status:'na',reservation_time:''};
    Object.entries(defaults).forEach(([k,v])=>{if(r[k]===undefined){r[k]=v;ch++;}});
  });
  if(ch){writeJSON(rows);console.log(`[DB] Migrated ${ch} fields`);}
}

async function createReservation(data) {
  const id  = randomUUID();
  const now = new Date().toISOString();
  const hasDirectBill = (data.payment_method||'').includes('Direct Bill');
  const record = {
    id, name:data.name, guest_status:data.guest_status,
    department:data.department||'', phone_ext:data.phone_ext||'',
    uid:data.uid, email:data.email, party:parseInt(data.party,10),
    datetime:data.datetime, reservation_date:data.reservation_date||toDateStr(data.datetime),
    reservation_time:data.reservation_time||'',
    seating_preference:data.seating_preference||'',
    payment_method:data.payment_method||'',
    direct_bill_status: hasDirectBill ? 'pending_document' : 'na',
    notes:data.notes||'', table_number:data.table_number||'',
    status:data.status||'pending_approval',
    attendance:'pending', checked_in_at:null,
    channel:data.channel||'form', created_at:now, processed_at:null
  };
  if (USE_PG) {
    await pool.query(`INSERT INTO reservations VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [record.id,record.name,record.guest_status,record.department,record.phone_ext,record.uid,record.email,record.party,record.datetime,record.reservation_date,record.reservation_time,record.seating_preference,record.payment_method,record.direct_bill_status,record.notes,record.table_number,record.status,record.attendance,record.checked_in_at,record.channel,record.created_at,record.processed_at]);
  } else { const rows=readJSON(); rows.unshift(record); writeJSON(rows); }
  return record;
}

async function getReservation(id) {
  if(USE_PG){const{rows}=await pool.query('SELECT * FROM reservations WHERE id=$1',[id]);return rows[0]||null;}
  return readJSON().find(r=>r.id===id)||null;
}
async function getAllReservations() {
  if(USE_PG){const{rows}=await pool.query('SELECT * FROM reservations ORDER BY created_at DESC');return rows;}
  return readJSON();
}
async function getReservationsByStatus(s) {
  if(USE_PG){const{rows}=await pool.query('SELECT * FROM reservations WHERE status=$1 ORDER BY created_at DESC',[s]);return rows;}
  return readJSON().filter(r=>r.status===s);
}
async function updateReservation(id, updates) {
  if(updates.datetime) updates.reservation_date=toDateStr(updates.datetime);
  if(updates.payment_method!==undefined){
    const hasDB=(updates.payment_method||'').includes('Direct Bill');
    if(hasDB&&!updates.direct_bill_status) updates.direct_bill_status='pending_document';
    if(!hasDB) updates.direct_bill_status='na';
  }
  if(USE_PG){
    const keys=Object.keys(updates);
    const sets=keys.map((k,i)=>`${k}=$${i+2}`).join(',');
    await pool.query(`UPDATE reservations SET ${sets} WHERE id=$1`,[id,...Object.values(updates)]);
    return getReservation(id);
  }
  const rows=readJSON(),idx=rows.findIndex(r=>r.id===id);
  if(idx===-1) return null;
  Object.assign(rows[idx],updates); writeJSON(rows); return rows[idx];
}
async function deleteReservation(id) {
  if(USE_PG){await pool.query('DELETE FROM reservations WHERE id=$1',[id]);}
  else writeJSON(readJSON().filter(r=>r.id!==id));
}

// Daily people count (sum of party sizes, not reservation count)
async function getDailyPeopleCount(date) {
  const d=date||new Date().toISOString().split('T')[0];
  if(USE_PG){
    const{rows}=await pool.query(`SELECT COALESCE(SUM(party),0) AS total FROM reservations WHERE reservation_date=$1 AND status IN ('pending_approval','approved')`,[d]);
    return parseInt(rows[0].total,10);
  }
  return readJSON().filter(r=>r.reservation_date===d&&['pending_approval','approved'].includes(r.status)).reduce((s,r)=>s+r.party,0);
}

async function getStats() {
  const today=new Date().toISOString().split('T')[0];
  const limit=parseInt(process.env.DAILY_LIMIT||'60');
  if(USE_PG){
    const{rows}=await pool.query(`SELECT
      COUNT(*) FILTER (WHERE status='pending_approval') AS pending,
      COUNT(*) FILTER (WHERE status='approved' AND reservation_date=$1) AS approved_today,
      COUNT(*) FILTER (WHERE status='denied') AS denied_all,
      COUNT(*) FILTER (WHERE reservation_date=$1 AND status IN ('pending_approval','approved')) AS total_today,
      COUNT(*) AS total_all,
      COALESCE(SUM(party) FILTER (WHERE reservation_date=$1 AND status IN ('pending_approval','approved')),0) AS people_today,
      COUNT(*) FILTER (WHERE attendance='checked_in' AND reservation_date=$1) AS checked_in_today,
      COUNT(*) FILTER (WHERE attendance='no_show' AND reservation_date=$1) AS no_show_today,
      COUNT(*) FILTER (WHERE direct_bill_status='pending_document') AS direct_bill_pending
    FROM reservations`,[today]);
    const s=rows[0];
    const pc=parseInt(s.people_today,10);
    return {pending:parseInt(s.pending),approved_today:parseInt(s.approved_today),denied_all:parseInt(s.denied_all),total_today:parseInt(s.total_today),total_all:parseInt(s.total_all),people_today:pc,checked_in_today:parseInt(s.checked_in_today),no_show_today:parseInt(s.no_show_today),direct_bill_pending:parseInt(s.direct_bill_pending),daily_count:pc,daily_limit:limit,slots_left:Math.max(0,limit-pc)};
  }
  const rows=readJSON();
  const forToday=rows.filter(r=>r.reservation_date===today);
  const active=forToday.filter(r=>['pending_approval','approved'].includes(r.status));
  const pc=active.reduce((s,r)=>s+r.party,0);
  return {pending:rows.filter(r=>r.status==='pending_approval').length,approved_today:forToday.filter(r=>r.status==='approved').length,denied_all:rows.filter(r=>r.status==='denied').length,total_today:active.length,total_all:rows.length,people_today:pc,checked_in_today:forToday.filter(r=>r.attendance==='checked_in').length,no_show_today:forToday.filter(r=>r.attendance==='no_show').length,direct_bill_pending:rows.filter(r=>r.direct_bill_status==='pending_document').length,daily_count:pc,daily_limit:limit,slots_left:Math.max(0,limit-pc)};
}

module.exports = {createReservation,getReservation,getAllReservations,getReservationsByStatus,updateReservation,deleteReservation,getDailyPeopleCount,getStats,toDateStr};
