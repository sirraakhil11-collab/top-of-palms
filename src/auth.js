/**
 * PIN-based access control — three roles
 *
 * POS_PIN     → floor staff (/pos board)
 * MANAGER_PIN → manager dashboard (approve, view, edit — no delete, no service controls)
 * ADMIN_PIN   → admin (all manager features + delete reservations + toggle services)
 *
 * Set all three PINs in Railway Variables before going to production.
 */

const crypto = require('crypto');

const POS_PIN     = process.env.POS_PIN     || '5678';
const MANAGER_PIN = process.env.MANAGER_PIN || '9012';
const ADMIN_PIN   = process.env.ADMIN_PIN   || '';   // empty = admin disabled until explicitly set
const SECRET      = process.env.SESSION_SECRET || 'topp-secret-key-2026';

if (!process.env.SESSION_SECRET) console.warn('[SECURITY] SESSION_SECRET not set — set a strong random value in Railway Variables!');
if (!process.env.ADMIN_PIN)      console.warn('[SECURITY] ADMIN_PIN not set — admin login is disabled. Set ADMIN_PIN in Railway Variables.');

function sign(payload) {
  const data = JSON.stringify(payload);
  const sig  = crypto.createHmac('sha256', SECRET).update(data).digest('hex').slice(0, 32);
  return Buffer.from(data).toString('base64') + '.' + sig;
}

function verify(token) {
  if (!token) return null;
  try {
    const [b64, sig] = token.split('.');
    const data = Buffer.from(b64, 'base64').toString();
    if (data.length > 4096) return null;
    const expected = crypto.createHmac('sha256', SECRET).update(data).digest('hex').slice(0, 32);
    if (sig !== expected) return null;
    return JSON.parse(data);
  } catch { return null; }
}

function getSession(req) {
  const raw = req.cookies?.topp_session;
  const session = verify(raw);
  if (!session) return null;
  if (session.exp && Date.now() > session.exp) return null; // expired
  return session;
}

const SESSION_MAX_AGE = 8 * 60 * 60; // 8 hours
function setSession(res, role) {
  const token = sign({ role, ts: Date.now(), exp: Date.now() + SESSION_MAX_AGE * 1000 });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `topp_session=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${SESSION_MAX_AGE}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `topp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// POS + manager + admin can access POS board
function requirePos(req, res, next) {
  const s = getSession(req);
  if (s && (s.role === 'pos' || s.role === 'manager' || s.role === 'admin')) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect(`/login?next=${encodeURIComponent(req.path)}&type=pos`);
}

// Manager + admin can access dashboard and most APIs
function requireManager(req, res, next) {
  const s = getSession(req);
  if (s && (s.role === 'manager' || s.role === 'admin')) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect(`/login?next=${encodeURIComponent(req.path)}&type=manager`);
}

// Admin only — used for: delete reservation, toggle services
function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (s && s.role === 'admin') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Admin access required' });
  res.redirect(`/login?next=${encodeURIComponent(req.path)}&type=admin`);
}

module.exports = { POS_PIN, MANAGER_PIN, ADMIN_PIN, sign, verify, getSession, setSession, clearSession, requirePos, requireManager, requireAdmin };
