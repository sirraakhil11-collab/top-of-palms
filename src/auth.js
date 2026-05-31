/**
 * Simple PIN-based access control
 *
 * POS_PIN    → access to /pos  (floor staff)
 * MANAGER_PIN → access to /manager/dashboard  (management)
 *
 * Stored in a signed cookie. No expiry — stays logged in until
 * the user clicks Logout. Set both PINs in Railway Variables.
 *
 * Default PINs (change in .env / Railway Variables):
 *   POS_PIN     = 5678
 *   MANAGER_PIN = 9012
 */

const crypto = require('crypto');

const POS_PIN     = process.env.POS_PIN     || '5678';
const MANAGER_PIN = process.env.MANAGER_PIN || '9012';
const SECRET      = process.env.SESSION_SECRET || 'topp-secret-key-2026';
if (!process.env.SESSION_SECRET) console.warn('[SECURITY] SESSION_SECRET not set — set a strong random value in Railway Variables before going to production!');

// Simple HMAC-signed token so users can't forge a cookie
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
    if (data.length > 4096) return null; // reject oversized tokens
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

const SESSION_MAX_AGE = 8 * 60 * 60; // 8 hours in seconds
function setSession(res, role) {
  const token = sign({ role, ts: Date.now(), exp: Date.now() + SESSION_MAX_AGE * 1000 });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `topp_session=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${SESSION_MAX_AGE}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `topp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function requirePos(req, res, next) {
  const s = getSession(req);
  if (s && (s.role === 'pos' || s.role === 'manager')) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error:'Not authenticated' });
  res.redirect(`/login?next=${encodeURIComponent(req.path)}&type=pos`);
}

function requireManager(req, res, next) {
  const s = getSession(req);
  if (s && s.role === 'manager') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error:'Not authenticated' });
  res.redirect(`/login?next=${encodeURIComponent(req.path)}&type=manager`);
}

module.exports = { POS_PIN, MANAGER_PIN, sign, verify, getSession, setSession, clearSession, requirePos, requireManager };
