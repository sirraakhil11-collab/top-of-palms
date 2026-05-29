const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM  = process.env.FROM_EMAIL || 'reservations@topofthepalms.usf.edu';
const NAME  = 'On Top of the Palms Reservations';
const PHONE = process.env.RESTAURANT_PHONE || '(813) 974-0000';

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

async function sendEmail(reservation, type) {
  if (!process.env.SENDGRID_API_KEY) { console.log(`[Email] No key — would send "${type}" to ${reservation.email}`); return; }
  const templates = { confirmed: confirmedEmail, pending: pendingEmail, denied: deniedEmail };
  const t = templates[type](reservation);
  await sgMail.send({ to:reservation.email, from:{email:FROM,name:NAME}, subject:t.subject, html:t.html });
  console.log(`[Email] Sent "${type}" to ${reservation.email}`);
}

function confirmedEmail(r) {
  return { subject:'Your reservation is confirmed — Top of the Palms ✓', html:layout(`
    <div style="display:inline-block;background:#dcfce7;color:#15803d;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">✓ Confirmed</div>
    <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">We look forward to seeing you!</h2>
    <p style="color:#6b7280;font-size:14px;margin:0 0 20px">Hi ${r.name}, your reservation is confirmed.</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 16px;margin-bottom:20px"><table style="width:100%;border-collapse:collapse">${reservationRows(r)}</table></div>
    <p style="color:#374151;font-size:14px">Please arrive a few minutes early. Reply here or call ${PHONE} with any questions.</p>`) };
}

function pendingEmail(r) {
  return { subject:'We received your reservation request — Top of the Palms', html:layout(`
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
  return { subject:'Update on your reservation request — Top of the Palms', html:layout(`
    <div style="display:inline-block;background:#fee2e2;color:#b91c1c;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">✕ Unable to accommodate</div>
    <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">We're sorry</h2>
    <p style="color:#6b7280;font-size:14px;margin:0 0 20px">Hi ${r.name}, unfortunately we cannot accommodate your request for ${r.datetime}.</p>
    <p style="color:#374151;font-size:14px">Please reply here or call ${PHONE} to find an alternative time. We'd love to have you!</p>`) };
}

// Direct Bill document email — sent at CHECK-IN (not at reservation creation)
async function sendDirectBillEmail(reservation) {
  if (!process.env.SENDGRID_API_KEY) { console.log('[Email] No key — would send direct bill doc'); return; }
  const ref = reservation.id.slice(0,8).toUpperCase();
  await sgMail.send({
    to:   reservation.email,
    from: { email:FROM, name:NAME },
    subject: `Direct Bill authorization — Welcome! Confirmation ${ref}`,
    html: layout(`
      <div style="display:inline-block;background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">📄 Action required</div>
      <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">Direct Bill Authorization</h2>
      <p style="color:#6b7280;font-size:14px;margin:0 0 16px">Hi ${reservation.name}, thank you for dining with us today! Since you selected <strong>Direct Bill</strong>, please complete the authorization form below. Payment is due within <strong>30 days of dining</strong>.</p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 16px;margin-bottom:20px"><table style="width:100%;border-collapse:collapse">
        ${row('Reservation', ref)}
        ${row('Date', reservation.datetime)}
        ${row('Department', reservation.department||'—', true)}
      </table></div>
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:16px;margin-bottom:20px">
        <p style="font-size:14px;font-weight:600;color:#b45309;margin-bottom:8px">📎 Direct Bill Authorization Form</p>
        <p style="font-size:13px;color:#374151;margin-bottom:12px">Please download, complete, and reply to this email with the signed form attached.</p>
        <p style="font-size:12px;color:#6b7280">Fields required: Name, Department, USF ID, Account number, Authorized signature, Date</p>
      </div>
      <p style="color:#374151;font-size:13px">Your reservation will be confirmed once the completed form is received. Reply to this email with any questions.</p>
      <p style="color:#9ca3af;font-size:12px;margin-top:16px">Reference: ${ref} · ${PHONE}</p>`)
  });
  console.log(`[Email] Direct bill doc sent to ${reservation.email}`);
}

// Manager approval email — links go to confirmation page (not direct action)
async function sendManagerApprovalEmail(reservation) {
  const base       = process.env.BASE_URL || 'http://localhost:3000';
  const approveUrl = `${base}/manager/confirm/approve/${reservation.id}`;
  const denyUrl    = `${base}/manager/confirm/deny/${reservation.id}`;
  const dashUrl    = `${base}/manager/dashboard`;
  const party      = reservation.party+(reservation.party===1?' guest':' guests');

  if (!process.env.SENDGRID_API_KEY || !process.env.MANAGER_EMAIL) {
    console.log(`[Manager] Not configured. Approve: ${approveUrl} | Deny: ${denyUrl}`); return;
  }

  const extraRows = [
    row('Name', reservation.name),
    row('USF UID', `<span style="font-family:monospace">${reservation.uid}</span>`),
    row('Department', reservation.department||'—'),
    row('Phone Ext', reservation.phone_ext||'—'),
    row('Email', reservation.email),
    row('Requested time', reservation.datetime),
    row('Party size', party),
    row('Seating preference', reservation.seating_preference||'—'),
    row('Payment method', reservation.payment_method||'—'),
    reservation.notes ? row('Notes', reservation.notes) : '',
    row('Type', reservation.guest_status==='faculty'?'Faculty':'Student', true)
  ].filter(Boolean).join('');

  await sgMail.send({
    to:process.env.MANAGER_EMAIL, from:{email:FROM,name:NAME},
    subject:`Action needed — Reservation: ${reservation.name} (${party}, ${reservation.datetime})`,
    html: layout(`
      <div style="display:inline-block;background:#fef3c7;color:#b45309;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">Action required</div>
      <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">New reservation request</h2>
      ${(reservation.payment_method||'').includes('Direct Bill')?'<p style="background:#dbeafe;border:1px solid #93c5fd;border-radius:8px;padding:10px 14px;font-size:13px;color:#1d4ed8;margin-bottom:16px">💳 <strong>Direct Bill</strong> — authorization document will be sent to guest. Mark as received when you get the form.</p>':''}
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 16px;margin-bottom:24px"><table style="width:100%;border-collapse:collapse">${extraRows}</table></div>
      <p style="color:#374151;font-size:13px;margin-bottom:20px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px">⚠️ Click a button below — you will see a confirmation page before any action is taken.</p>
      <div style="text-align:center;margin-bottom:20px">
        <a href="${approveUrl}" style="display:inline-block;background:#006747;color:#fff;text-decoration:none;padding:13px 32px;border-radius:8px;font-size:15px;font-weight:600;margin-right:12px">✓ Review &amp; Approve</a>
        <a href="${denyUrl}" style="display:inline-block;background:#fff;color:#b91c1c;text-decoration:none;padding:12px 32px;border-radius:8px;font-size:15px;font-weight:600;border:1.5px solid #b91c1c">✕ Review &amp; Deny</a>
      </div>
      <p style="text-align:center"><a href="${dashUrl}" style="color:#9ca3af;font-size:12px;text-decoration:none">View all pending reservations →</a></p>`)
  });
  console.log(`[Manager] Approval email sent`);
}

module.exports = { sendEmail, sendManagerApprovalEmail, sendDirectBillEmail };
