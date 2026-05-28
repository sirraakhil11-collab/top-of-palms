const sgMail = require('@sendgrid/mail');

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const FROM_EMAIL = process.env.FROM_EMAIL || 'reservations@topofthepalms.usf.edu';
const FROM_NAME  = 'Top of the Palms at USF';
const PHONE      = process.env.RESTAURANT_PHONE || 'our main line';

// ── Shared layout wrapper ────────────────────────────────────────────────────
function layout(headerSubtitle, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;background:#f3f4f6;margin:0;padding:32px 16px">
<div style="max-width:560px;margin:0 auto">
  <div style="background:#006747;border-radius:12px 12px 0 0;padding:28px 36px">
    <p style="color:#a7d9c2;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin:0 0 4px">University of South Florida Dining</p>
    <h1 style="color:#fff;font-size:20px;font-weight:700;margin:0">Top of the Palms</h1>
    <p style="color:#a7d9c2;font-size:13px;margin:4px 0 0">${headerSubtitle}</p>
  </div>
  <div style="background:#fff;border-radius:0 0 12px 12px;padding:36px;box-shadow:0 4px 16px rgba(0,0,0,.08)">
    ${bodyHtml}
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:11px;margin:16px 0 0">Top of the Palms · USF Tampa Campus · Managed by Compass USA</p>
</div>
</body>
</html>`;
}

function detailRow(label, value, last = false) {
  const border = last ? '' : 'border-bottom:1px solid #f3f4f6;';
  return `<tr>
    <td style="color:#6b7280;padding:9px 0;font-size:13px;${border}">${label}</td>
    <td style="color:#111827;font-weight:600;text-align:right;font-size:13px;padding:9px 0;${border}">${value}</td>
  </tr>`;
}

// ── Email templates ──────────────────────────────────────────────────────────

function buildConfirmedEmail(r) {
  const confirmId = r.id.slice(0, 8).toUpperCase();
  const partyLabel = r.party === 1 ? '1 guest' : `${r.party} guests`;
  return {
    subject: `Your reservation is confirmed — Top of the Palms`,
    html: layout('Reservation Confirmed', `
      <div style="display:inline-block;background:#dcfce7;color:#15803d;font-size:12px;font-weight:600;padding:5px 12px;border-radius:20px;margin-bottom:20px">✓ Confirmed</div>
      <h2 style="color:#111827;font-size:20px;font-weight:700;margin:0 0 6px">We look forward to seeing you!</h2>
      <p style="color:#6b7280;font-size:14px;margin:0 0 24px">Hi ${r.name}, your reservation at Top of the Palms is confirmed.</p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:4px 20px;margin-bottom:24px">
        <table style="width:100%;border-collapse:collapse">
          ${detailRow('Guest', r.name)}
          ${detailRow('Date & time', r.datetime)}
          ${detailRow('Party size', partyLabel)}
          ${detailRow('Confirmation #', `<span style="font-family:monospace;background:#f3f4f6;padding:2px 6px;border-radius:4px">${confirmId}</span>`, true)}
        </table>
      </div>
      <p style="color:#374151;font-size:14px;margin:0 0 8px">Please arrive a few minutes early. If you need to cancel or modify your reservation, give us a call at <strong>${PHONE}</strong>.</p>
    `)
  };
}

function buildPendingEmail(r) {
  const partyLabel = r.party === 1 ? '1 guest' : `${r.party} guests`;
  return {
    subject: `Reservation request received — Top of the Palms`,
    html: layout('Request Under Review', `
      <div style="display:inline-block;background:#fef3c7;color:#b45309;font-size:12px;font-weight:600;padding:5px 12px;border-radius:20px;margin-bottom:20px">⏳ Pending review</div>
      <h2 style="color:#111827;font-size:20px;font-weight:700;margin:0 0 6px">We received your request</h2>
      <p style="color:#6b7280;font-size:14px;margin:0 0 24px">Hi ${r.name}, your reservation request is under review. A manager will process it shortly and you will receive another email with the outcome.</p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:4px 20px;margin-bottom:24px">
        <table style="width:100%;border-collapse:collapse">
          ${detailRow('Guest', r.name)}
          ${detailRow('Requested time', r.datetime)}
          ${detailRow('Party size', partyLabel)}
          ${detailRow('Status', '<span style="color:#b45309">Under review</span>', true)}
        </table>
      </div>
      <p style="color:#374151;font-size:14px;margin:0 0 8px">If you have urgent questions, call us at <strong>${PHONE}</strong>.</p>
    `)
  };
}

function buildDeniedEmail(r) {
  const partyLabel = r.party === 1 ? '1 guest' : `${r.party} guests`;
  return {
    subject: `Update on your reservation request — Top of the Palms`,
    html: layout('Reservation Update', `
      <div style="display:inline-block;background:#fee2e2;color:#b91c1c;font-size:12px;font-weight:600;padding:5px 12px;border-radius:20px;margin-bottom:20px">✕ Not approved</div>
      <h2 style="color:#111827;font-size:20px;font-weight:700;margin:0 0 6px">Unable to accommodate your request</h2>
      <p style="color:#6b7280;font-size:14px;margin:0 0 24px">Hi ${r.name}, unfortunately we are unable to accommodate your reservation request at this time. We apologize for any inconvenience.</p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:4px 20px;margin-bottom:24px">
        <table style="width:100%;border-collapse:collapse">
          ${detailRow('Requested time', r.datetime)}
          ${detailRow('Party size', partyLabel)}
          ${detailRow('Status', '<span style="color:#b91c1c">Not approved</span>', true)}
        </table>
      </div>
      <p style="color:#374151;font-size:14px;margin:0 0 8px">We encourage you to call us at <strong>${PHONE}</strong> to find an alternative time that works for your party.</p>
    `)
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

async function sendEmail(reservation, type) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log(`[Email] ⚠️  SENDGRID_API_KEY not set — would send '${type}' to ${reservation.email}`);
    return;
  }

  const builders = {
    confirmed: buildConfirmedEmail,
    pending:   buildPendingEmail,
    denied:    buildDeniedEmail
  };

  const template = builders[type](reservation);

  await sgMail.send({
    to:      reservation.email,
    from:    { email: FROM_EMAIL, name: FROM_NAME },
    subject: template.subject,
    html:    template.html
  });

  console.log(`[Email] Sent '${type}' to ${reservation.email}`);
}

module.exports = { sendEmail };
