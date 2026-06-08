const sgMail = require('@sendgrid/mail');

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

async function notifyManager(reservation) {
  const baseUrl    = process.env.BASE_URL || 'http://localhost:3000';
  const approveUrl = `${baseUrl}/manager/approve/${reservation.id}`;
  const denyUrl    = `${baseUrl}/manager/deny/${reservation.id}`;
  const dashUrl    = `${baseUrl}/manager/dashboard`;
  const partyLabel = reservation.party === 1 ? '1 guest' : `${reservation.party} guests`;

  const managerEmail = process.env.MANAGER_EMAIL;

  // If email isn't configured yet, just print the links to console
  if (!managerEmail || !process.env.SENDGRID_API_KEY) {
    console.log(`\n[Manager] ⚠️  Email not configured. Approval links for ${reservation.name}:`);
    console.log(`  ✓ Approve: ${approveUrl}`);
    console.log(`  ✕ Deny:    ${denyUrl}`);
    console.log(`  Dashboard: ${dashUrl}\n`);
    return;
  }

  const btn = (url, label, bg, border) =>
    `<a href="${url}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-size:15px;font-weight:600;border:2px solid ${border}">${label}</a>`;

  await sgMail.send({
    to:   managerEmail,
    from: { email: process.env.FROM_EMAIL, name: 'Top of the Palms Reservations' },
    subject: `Action required: Student reservation — ${reservation.name} (${partyLabel}, ${reservation.datetime})`,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;background:#f3f4f6;margin:0;padding:32px 16px">
<div style="max-width:600px;margin:0 auto">
  <div style="background:#006747;border-radius:12px 12px 0 0;padding:24px 36px">
    <p style="color:#a7d9c2;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin:0 0 4px">Manager Action Required</p>
    <h1 style="color:#fff;font-size:18px;font-weight:700;margin:0">New Student Reservation Request</h1>
  </div>
  <div style="background:#fff;border-radius:0 0 12px 12px;padding:32px 36px;box-shadow:0 4px 16px rgba(0,0,0,.08)">
    <p style="color:#374151;font-size:15px;margin:0 0 24px">A student has requested a reservation at <strong>Top of the Palms</strong> and requires your approval before it is confirmed.</p>

    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:4px 20px;margin-bottom:28px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr>
          <td style="color:#6b7280;padding:9px 0;border-bottom:1px solid #f3f4f6">Name</td>
          <td style="color:#111827;font-weight:600;text-align:right;padding:9px 0;border-bottom:1px solid #f3f4f6">${reservation.name}</td>
        </tr>
        <tr>
          <td style="color:#6b7280;padding:9px 0;border-bottom:1px solid #f3f4f6">USF UID</td>
          <td style="color:#111827;font-weight:600;text-align:right;padding:9px 0;border-bottom:1px solid #f3f4f6;font-family:monospace">${reservation.uid}</td>
        </tr>
        <tr>
          <td style="color:#6b7280;padding:9px 0;border-bottom:1px solid #f3f4f6">Email</td>
          <td style="color:#111827;font-weight:600;text-align:right;padding:9px 0;border-bottom:1px solid #f3f4f6">${reservation.email}</td>
        </tr>
        <tr>
          <td style="color:#6b7280;padding:9px 0;border-bottom:1px solid #f3f4f6">Requested time</td>
          <td style="color:#111827;font-weight:600;text-align:right;padding:9px 0;border-bottom:1px solid #f3f4f6">${reservation.datetime}</td>
        </tr>
        <tr>
          <td style="color:#6b7280;padding:9px 0">Party size</td>
          <td style="color:#111827;font-weight:600;text-align:right;padding:9px 0">${partyLabel}</td>
        </tr>
      </table>
    </div>

    <div style="text-align:center;margin-bottom:24px">
      ${btn(approveUrl, '✓ Approve Reservation', '#006747', '#006747')}
      &nbsp;&nbsp;
      ${btn(denyUrl, '✕ Deny Request', '#b91c1c', '#b91c1c')}
    </div>

    <p style="text-align:center;margin:0">
      <a href="${dashUrl}" style="color:#6b7280;font-size:12px;text-decoration:none">View all pending reservations →</a>
    </p>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:11px;margin:16px 0 0">Top of the Palms · USF Tampa Campus · Managed by Compass USA</p>
</div>
</body>
</html>`
  });

  console.log(`[Manager] Approval email sent to ${managerEmail}`);
}

module.exports = { notifyManager };
