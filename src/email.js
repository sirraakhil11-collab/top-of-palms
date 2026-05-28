const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM   = process.env.FROM_EMAIL || 'reservations@topofthepalms.usf.edu';
const NAME   = 'Top of the Palms Reservations';
const PHONE  = process.env.RESTAURANT_PHONE || 'our main line';

function layout(body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px 16px">
<div style="max-width:540px;margin:0 auto">
  <div style="background:#006747;border-radius:10px 10px 0 0;padding:20px 28px">
    <p style="color:#a7d9c2;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin:0 0 2px">USF Dining · Compass USA</p>
    <h1 style="color:#fff;font-size:18px;font-weight:700;margin:0">Top of the Palms</h1>
  </div>
  <div style="background:#fff;border-radius:0 0 10px 10px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.08)">${body}</div>
  <p style="text-align:center;color:#9ca3af;font-size:11px;margin:12px 0 0">Top of the Palms · University of South Florida Tampa Campus</p>
</div></body></html>`;
}

function row(label, value, last) {
  const b = last ? '' : 'border-bottom:1px solid #f3f4f6;';
  return `<tr>
    <td style="color:#6b7280;padding:8px 0;font-size:13px;${b}">${label}</td>
    <td style="color:#111827;font-weight:600;text-align:right;font-size:13px;padding:8px 0;${b}">${value}</td>
  </tr>`;
}

function confirmedEmail(r) {
  const ref = r.id.slice(0,8).toUpperCase();
  return {
    subject: 'Your reservation is confirmed — Top of the Palms ✓',
    html: layout(`
      <div style="display:inline-block;background:#dcfce7;color:#15803d;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">✓ Confirmed</div>
      <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">We look forward to seeing you!</h2>
      <p style="color:#6b7280;font-size:14px;margin:0 0 20px">Hi ${r.name}, your reservation at Top of the Palms is confirmed.</p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 16px;margin-bottom:20px">
        <table style="width:100%;border-collapse:collapse">
          ${row('Name', r.name)}
          ${row('Date & time', r.datetime)}
          ${row('Party size', r.party + (r.party===1?' guest':' guests'))}
          ${row('Confirmation #', `<span style="font-family:monospace;background:#f3f4f6;padding:2px 6px;border-radius:4px">${ref}</span>`, true)}
        </table>
      </div>
      <p style="color:#374151;font-size:14px">Please arrive a few minutes early. Reply to this email or call ${PHONE} if you need to make any changes.</p>`)
  };
}

function pendingEmail(r) {
  return {
    subject: 'We received your reservation request — Top of the Palms',
    html: layout(`
      <div style="display:inline-block;background:#fef3c7;color:#b45309;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">⏳ Under review</div>
      <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">Request received!</h2>
      <p style="color:#6b7280;font-size:14px;margin:0 0 20px">Hi ${r.name}, your reservation request is under review. A manager will confirm it shortly.</p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 16px;margin-bottom:20px">
        <table style="width:100%;border-collapse:collapse">
          ${row('Requested time', r.datetime)}
          ${row('Party size', r.party + (r.party===1?' guest':' guests'))}
          ${row('Status', '<span style="color:#b45309">Pending manager review</span>', true)}
        </table>
      </div>
      <p style="color:#374151;font-size:14px">You will receive another email once confirmed. Reply here with any questions.</p>`)
  };
}

function deniedEmail(r) {
  return {
    subject: 'Update on your reservation request — Top of the Palms',
    html: layout(`
      <div style="display:inline-block;background:#fee2e2;color:#b91c1c;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">✕ Unable to accommodate</div>
      <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">We're sorry</h2>
      <p style="color:#6b7280;font-size:14px;margin:0 0 20px">Hi ${r.name}, unfortunately we are unable to accommodate your reservation request for ${r.datetime}.</p>
      <p style="color:#374151;font-size:14px">Please reply to this email or call ${PHONE} to find an alternative time. We would love to have you!</p>`)
  };
}

// ── Manager approval email ──────────────────────────────────────────────────
// IMPORTANT: Links go to a CONFIRMATION PAGE, not directly to approve/deny.
// This prevents Microsoft Outlook Safe Links from pre-fetching and
// auto-executing both links before the manager opens the email.
async function sendManagerApprovalEmail(reservation) {
  const base       = process.env.BASE_URL || 'http://localhost:3000';
  // These now go to confirmation PAGES, not direct actions
  const approveUrl = `${base}/manager/confirm/approve/${reservation.id}`;
  const denyUrl    = `${base}/manager/confirm/deny/${reservation.id}`;
  const dashUrl    = `${base}/manager/dashboard`;
  const party      = reservation.party + (reservation.party===1?' guest':' guests');

  if (!process.env.SENDGRID_API_KEY || !process.env.MANAGER_EMAIL) {
    console.log(`\n[Manager] Email not configured. Links:`);
    console.log(`  APPROVE: ${approveUrl}`);
    console.log(`  DENY:    ${denyUrl}`);
    return;
  }

  await sgMail.send({
    to:   process.env.MANAGER_EMAIL,
    from: { email: FROM, name: NAME },
    subject: `Action needed — Student reservation: ${reservation.name} (${party}, ${reservation.datetime})`,
    html: layout(`
      <div style="display:inline-block;background:#fef3c7;color:#b45309;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">Action required</div>
      <h2 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 8px">New student reservation request</h2>
      <p style="color:#6b7280;font-size:14px;margin:0 0 20px">A student needs your approval before their reservation is confirmed.</p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 16px;margin-bottom:24px">
        <table style="width:100%;border-collapse:collapse">
          ${row('Name', reservation.name)}
          ${row('USF UID', `<span style="font-family:monospace">${reservation.uid}</span>`)}
          ${row('Email', reservation.email)}
          ${row('Requested time', reservation.datetime)}
          ${row('Party size', party, true)}
        </table>
      </div>
      <p style="color:#374151;font-size:13px;margin-bottom:20px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px">
        ⚠️ Click the button below, then confirm on the next page. Do not click links if you did not request this.
      </p>
      <div style="text-align:center;margin-bottom:20px">
        <a href="${approveUrl}" style="display:inline-block;background:#006747;color:#fff;text-decoration:none;padding:13px 32px;border-radius:8px;font-size:15px;font-weight:600;margin-right:12px">✓ Review &amp; Approve</a>
        <a href="${denyUrl}" style="display:inline-block;background:#fff;color:#b91c1c;text-decoration:none;padding:12px 32px;border-radius:8px;font-size:15px;font-weight:600;border:1.5px solid #b91c1c">✕ Review &amp; Deny</a>
      </div>
      <p style="text-align:center"><a href="${dashUrl}" style="color:#9ca3af;font-size:12px;text-decoration:none">View all pending reservations →</a></p>`)
  });
  console.log(`[Manager] Approval email sent to ${process.env.MANAGER_EMAIL}`);
}

async function sendEmail(reservation, type) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log(`[Email] No key — would send "${type}" to ${reservation.email}`);
    return;
  }
  const builders = { confirmed: confirmedEmail, pending: pendingEmail, denied: deniedEmail };
  const t = builders[type](reservation);
  await sgMail.send({ to: reservation.email, from: { email: FROM, name: NAME }, subject: t.subject, html: t.html });
  console.log(`[Email] Sent "${type}" to ${reservation.email}`);
}

module.exports = { sendEmail, sendManagerApprovalEmail };
