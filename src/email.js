const sgMail = require('@sendgrid/mail');

const FROM         = process.env.FROM_EMAIL;
const NAME         = 'On Top of the Palms Reservations';
const MANAGER_MAIL = process.env.MANAGER_EMAIL;
const PHONE        = process.env.RESTAURANT_PHONE || '(813) 974-0000';

// Always set the API key if available
function getSg() {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error('SENDGRID_API_KEY is not set in environment variables');
  sgMail.setApiKey(key);
  return sgMail;
}

function layout(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px 16px">
<div style="max-width:560px;margin:0 auto">
  <div style="background:#006747;border-radius:10px 10px 0 0;padding:20px 28px">
    <p style="color:#a7d9c2;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin:0 0 2px">USF Dining · Compass USA</p>
    <h1 style="color:#fff;font-size:18px;font-weight:700;margin:0">Top of the Palms</h1>
  </div>
  <div style="background:#fff;border-radius:0 0 10px 10px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.08)">${body}</div>
  <p style="text-align:center;color:#9ca3af;font-size:11px;margin:12px 0 0">On Top of the Palms · USF Tampa Campus · ${PHONE}</p>
</div></body></html>`;
}

function row(k,v,last){ return `<tr><td style="color:#6b7280;padding:8px 0;font-size:13px;${last?'':'border-bottom:1px solid #f3f4f6'}">${k}</td><td style="color:#111827;font-weight:600;text-align:right;font-size:13px;padding:8px 0;${last?'':'border-bottom:1px solid #f3f4f6'}">${v}</td></tr>`; }

function reservationRows(r) {
  const party = r.party+(r.party===1?' guest':' guests');
  return [
    row('Name', r.name),
    row('Date & time', r.datetime),
    row('Party size', party),
    r.department ? row('Department', r.department) : '',
    r.seating_preference ? row('Seating preference', r.seating_preference) : '',
    r.payment_method ? row('Payment method', r.payment_method) : '',
    row('Confirmation #', `<span style="font-family:monospace;background:#f3f4f6;padding:2px 6px;border-radius:4px">${r.id.slice(0,8).toUpperCase()}</span>`, true)
  ].filter(Boolean).join('');
}

async function _send(msg, label) {
  const sg = getSg();
  console.log(`[Email] Sending "${label}" → to:${msg.to} from:${msg.from?.email || msg.from}`);
  try {
    await sg.send(msg);
    console.log(`[Email] ✓ Sent "${label}" → ${msg.to}`);
  } catch(err) {
    const detail = err.response?.body ? JSON.stringify(err.response.body) : err.message;
    console.error(`[Email] ✗ FAILED "${label}" → ${msg.to} | ${detail}`);
    throw err;
  }
}

// ── Guest emails ──────────────────────────────────────────────────────────────
async function sendEmail(reservation, type) {
  const templates = { confirmed: confirmedEmail, pending: pendingEmail, denied: deniedEmail };
  const t = templates[type](reservation);
  await _send({ to: reservation.email, from: { email: FROM, name: NAME }, subject: t.subject, html: t.html }, type);
}

function confirmedEmail(r) {
  return { subject: 'Your reservation is confirmed — Top of the Palms ✓', html: layout(`
    <div style="display:inline-block;background:#dcfce7;color:#15803d;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">✓ Confirmed</div>
    <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">We look forward to seeing you!</h2>
    <p style="color:#6b7280;font-size:14px;margin:0 0 20px">Hi ${r.name}, your reservation is confirmed.</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 16px;margin-bottom:20px"><table style="width:100%;border-collapse:collapse">${reservationRows(r)}</table></div>
    <p style="color:#374151;font-size:14px">Please arrive a few minutes early. Reply here or call ${PHONE} with any questions.</p>`) };
}

function pendingEmail(r) {
  return { subject: 'We received your reservation request — Top of the Palms', html: layout(`
    <div style="display:inline-block;background:#fef3c7;color:#b45309;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">⏳ Under review</div>
    <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">Request received!</h2>
    <p style="color:#6b7280;font-size:14px;margin:0 0 20px">Hi ${r.name}, your request is under review. A manager will confirm it shortly — usually within a few hours.</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 16px;margin-bottom:20px"><table style="width:100%;border-collapse:collapse">
      ${row('Requested time', r.datetime)}
      ${row('Party size', r.party+(r.party===1?' guest':' guests'))}
      ${r.payment_method ? row('Payment', r.payment_method) : ''}
      ${row('Status', '<span style="color:#b45309">Pending manager review</span>', true)}
    </table></div>
    <p style="color:#374151;font-size:14px">You will receive another email once confirmed. Reply here with any questions.</p>`) };
}

function deniedEmail(r) {
  return { subject: 'Update on your reservation request — Top of the Palms', html: layout(`
    <div style="display:inline-block;background:#fee2e2;color:#b91c1c;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">✕ Unable to accommodate</div>
    <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">We're sorry</h2>
    <p style="color:#6b7280;font-size:14px;margin:0 0 20px">Hi ${r.name}, unfortunately we cannot accommodate your request for ${r.datetime}.</p>
    <p style="color:#374151;font-size:14px">Please reply here or call ${PHONE} to find an alternative time. We'd love to have you!</p>`) };
}

// ── Manager approval email ────────────────────────────────────────────────────
async function sendManagerApprovalEmail(reservation) {
  const base       = getSafeBase();
  const approveUrl = `${base}/manager/confirm/approve/${reservation.id}`;
  const denyUrl    = `${base}/manager/confirm/deny/${reservation.id}`;
  const dashUrl    = `${base}/manager/dashboard`;
  const party      = reservation.party + (reservation.party===1?' guest':' guests');

  function r(k,v,last){ return `<tr><td style="color:#6b7280;padding:8px 0;font-size:13px;${last?'':'border-bottom:1px solid #f3f4f6'}">${k}</td><td style="color:#111827;font-weight:600;text-align:right;font-size:13px;padding:8px 0;${last?'':'border-bottom:1px solid #f3f4f6'}">${v}</td></tr>`; }

  await _send({
    to:      MANAGER_MAIL,
    from:    { email: FROM, name: NAME },
    subject: `Action needed — ${reservation.name} · ${parseInt(reservation.num_days||1)>1?reservation.num_days+' days · ':''}${party} · ${reservation.datetime}`,
    html: layout(`
      <div style="display:inline-block;background:#fef3c7;color:#b45309;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">Action required</div>
      <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">New reservation request</h2>
      ${(reservation.payment_method||'').includes('Direct Bill')?'<p style="background:#dbeafe;border:1px solid #93c5fd;border-radius:8px;padding:10px 14px;font-size:13px;color:#1d4ed8;margin-bottom:16px">💳 <strong>Direct Bill</strong> — authorization form will be sent to guest automatically.</p>':''}
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 16px;margin-bottom:24px">
        <table style="width:100%;border-collapse:collapse">
          ${r('Name', reservation.name)}
          ${r('USF UID', `<span style="font-family:monospace">${reservation.uid||'—'}</span>`)}
          ${r('Department', reservation.department||'—')}
          ${r('Email', reservation.email)}
          ${r('Start date', reservation.datetime)}
          ${parseInt(reservation.num_days||1)>1 ? r('Days', `<strong>${reservation.num_days} consecutive weekdays</strong>`) : ''}
          ${r('Party size', party)}
          ${r('Payment', reservation.payment_method||'—')}
          ${reservation.notes ? r('Notes', reservation.notes) : ''}
          ${r('Type', reservation.guest_status==='faculty'?'Faculty':'Student', true)}
        </table>
      </div>
      <p style="color:#374151;font-size:13px;margin-bottom:20px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px">
        ⚠️ Click a button below — you will see a confirmation page before any action is taken.
      </p>
      <div style="text-align:center;margin-bottom:20px">
        <a href="${approveUrl}" style="display:inline-block;background:#006747;color:#fff;text-decoration:none;padding:13px 32px;border-radius:8px;font-size:15px;font-weight:600;margin-right:12px">✓ Review &amp; Approve</a>
        <a href="${denyUrl}" style="display:inline-block;background:#fff;color:#b91c1c;text-decoration:none;padding:12px 32px;border-radius:8px;font-size:15px;font-weight:600;border:1.5px solid #b91c1c">✕ Review &amp; Deny</a>
      </div>
      <p style="text-align:center"><a href="${dashUrl}" style="color:#9ca3af;font-size:12px;text-decoration:none">View all pending reservations →</a></p>`)
  }, 'manager-approval');
}

// ── Direct Bill email ─────────────────────────────────────────────────────────
async function sendDirectBillEmail(reservation) {
  const ref = reservation.id.slice(0,8).toUpperCase();

  await _send({
    to:      reservation.email,
    from:    { email: FROM, name: NAME },
    subject: `Direct Bill Authorization Required — ${ref} | On Top of the Palms`,
    html: layout(`
      <div style="display:inline-block;background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">📄 Action Required</div>
      <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">Direct Bill Authorization</h2>
      <p style="color:#6b7280;font-size:14px;margin:0 0 16px">Hi ${reservation.name}, thank you for dining with us today! As you selected <strong>Direct Bill</strong> payment, please complete the authorization below.</p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 16px;margin-bottom:20px"><table style="width:100%;border-collapse:collapse">
        ${row('Reservation #', `<span style="font-family:monospace;background:#f3f4f6;padding:2px 6px;border-radius:4px">${ref}</span>`)}
        ${row('Name', reservation.name)}
        ${row('Department', reservation.department||'—')}
        ${row('Date', reservation.datetime)}
        ${row('Party size', String(reservation.party)+(reservation.party===1?' guest':' guests'), true)}
      </table></div>
      <p style="color:#374151;font-size:13px">Return the completed form by replying directly to this email or contact us at ${PHONE}.</p>
      <p style="color:#9ca3af;font-size:12px;margin-top:16px">Reply-to: ${MANAGER_MAIL} · Reference: ${ref}</p>`)
  }, 'directbill-guest');

  // Notify manager that direct bill guest has checked in
  await _send({
    to:      MANAGER_MAIL,
    from:    { email: FROM, name: NAME },
    subject: `Direct Bill checked in — ${reservation.name} (${ref})`,
    html: layout(`
      <div style="display:inline-block;background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">Direct Bill — Checked In</div>
      <h2 style="color:#111827;font-size:17px;font-weight:700;margin:0 0 12px">${reservation.name} has checked in</h2>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 16px;margin-bottom:16px"><table style="width:100%;border-collapse:collapse">
        ${row('Confirmation', ref)}
        ${row('Department', reservation.department||'—')}
        ${row('Party', String(reservation.party)+(reservation.party===1?' guest':' guests'))}
        ${row('Email', reservation.email, true)}
      </table></div>
      <p style="color:#374151;font-size:13px">Authorization form has been emailed to the guest.</p>
      <p style="margin-top:12px"><a href="${getSafeBase()}/manager/dashboard" style="background:#006747;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600">Open Dashboard →</a></p>`)
  }, 'directbill-manager');

  console.log(`[DirectBill] Check-in emails sent for ${reservation.email}`);
}

// ── Test email — called from /api/test-email ──────────────────────────────────
async function sendTestEmail(toEmail) {
  await _send({
    to:      toEmail,
    from:    { email: FROM, name: NAME },
    subject: `✅ Email test — On Top of the Palms (${new Date().toLocaleTimeString()})`,
    html: layout(`
      <div style="display:inline-block;background:#dcfce7;color:#15803d;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">✅ Email Working</div>
      <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">SendGrid is configured correctly!</h2>
      <p style="color:#6b7280;font-size:14px;margin:0 0 16px">This test email confirms that all email services are active.</p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 16px;margin-bottom:16px"><table style="width:100%;border-collapse:collapse">
        ${row('From', FROM)}
        ${row('Manager email', MANAGER_MAIL)}
        ${row('Sent at', new Date().toISOString(), true)}
      </table></div>
      <p style="color:#374151;font-size:13px">All reservation emails (guest pending, confirmation, denial, manager approval, direct bill) are enabled.</p>`)
  }, 'test');
}

function getSafeBase() {
  // Priority 1: SAFE_URL — set this in Railway Variables to your .up.railway.app URL
  if (process.env.SAFE_URL) return process.env.SAFE_URL.trim().replace(/\/$/,'');
  // Priority 2: RAILWAY_STATIC_URL — Railway auto-injects the *.up.railway.app domain here
  if (process.env.RAILWAY_STATIC_URL) return process.env.RAILWAY_STATIC_URL.trim().replace(/\/$/,'');
  // Priority 3: RAILWAY_PUBLIC_DOMAIN — may be custom domain (Zscaler-blocked on campus)
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN.trim()}`;
  const base = (process.env.BASE_URL||'').trim().replace(/\/$/,'');
  return base || 'http://localhost:3000';
}

module.exports = { sendEmail, sendManagerApprovalEmail, sendDirectBillEmail, sendTestEmail };
