/**
 * Direct Bill Service
 * Completely standalone — handles the full lifecycle:
 *   1. Manager sends authorization form to guest (button click)
 *   2. Guest receives email with form attachment instructions
 *   3. Guest replies with signed form
 *   4. Manager is notified, marks document received
 *   5. Reservation shows document status + link
 *
 * Statuses:
 *   na               — guest did not choose Direct Bill
 *   pending_send     — Direct Bill chosen, doc not yet sent by manager
 *   sent             — manager sent the form, awaiting guest reply
 *   received         — guest returned signed form, manager confirmed
 */

const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM  = process.env.FROM_EMAIL  || 'reservations@topofthepalms.usf.edu';
const NAME  = 'On Top of the Palms Reservations';
const PHONE = process.env.RESTAURANT_PHONE || '(813) 974-0000';

// ── Authorization Form Content ─────────────────────────────────────────────
// Manager will replace this with the real document later
function buildFormHTML(reservation) {
  const ref = reservation.id.slice(0,8).toUpperCase();
  return `
<div style="font-family:Arial,sans-serif;max-width:640px;border:2px solid #006747;padding:0;border-radius:8px;overflow:hidden">
  <div style="background:#006747;padding:16px 24px;display:flex;align-items:center;justify-content:space-between">
    <div><h2 style="color:#fff;margin:0;font-size:18px">🌴 On Top of the Palms</h2><p style="color:#a7d9c2;margin:2px 0 0;font-size:12px">USF Dining · Compass USA · Direct Bill Authorization</p></div>
    <div style="color:#CFC493;font-size:13px;text-align:right">Ref: <strong>${ref}</strong></div>
  </div>
  <div style="padding:24px">
    <h3 style="color:#374151;font-size:15px;margin:0 0 16px">DIRECT BILL AUTHORIZATION FORM</h3>
    <p style="font-size:13px;color:#6b7280;margin-bottom:20px">Please complete all fields, sign, and reply to this email with this form attached or filled in.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr><td style="padding:10px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600;width:40%">Guest Name</td><td style="padding:10px;border:1px solid #e5e7eb">${reservation.name}</td></tr>
      <tr><td style="padding:10px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600">USF UID</td><td style="padding:10px;border:1px solid #e5e7eb">${reservation.uid}</td></tr>
      <tr><td style="padding:10px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600">Department</td><td style="padding:10px;border:1px solid #e5e7eb">${reservation.department||'___________________________'}</td></tr>
      <tr><td style="padding:10px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600">Dining Date</td><td style="padding:10px;border:1px solid #e5e7eb">${reservation.datetime}</td></tr>
      <tr><td style="padding:10px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600">Party Size</td><td style="padding:10px;border:1px solid #e5e7eb">${reservation.party} guest${reservation.party===1?'':'s'}</td></tr>
      <tr><td style="padding:10px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600">Account / Cost Center #</td><td style="padding:10px;border:1px solid #e5e7eb;color:#9ca3af">___________________________</td></tr>
      <tr><td style="padding:10px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600">Authorized By (print)</td><td style="padding:10px;border:1px solid #e5e7eb;color:#9ca3af">___________________________</td></tr>
      <tr><td style="padding:10px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600">Title / Position</td><td style="padding:10px;border:1px solid #e5e7eb;color:#9ca3af">___________________________</td></tr>
      <tr><td style="padding:10px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600">Signature</td><td style="padding:10px;border:1px solid #e5e7eb;color:#9ca3af" style="height:50px">___________________________</td></tr>
      <tr><td style="padding:10px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600">Date Signed</td><td style="padding:10px;border:1px solid #e5e7eb;color:#9ca3af">___________________________</td></tr>
    </table>
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;margin-top:20px">
      <p style="font-size:13px;color:#b45309;margin:0"><strong>Important:</strong> Payment must be received within 30 days of dining (${reservation.datetime}). Reply to this email with this completed form. Questions? Call ${PHONE}.</p>
    </div>
  </div>
</div>`;
}

// ── Send form to guest ─────────────────────────────────────────────────────
async function sendDirectBillForm(reservation) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log('[DirectBill] No SendGrid key — skipping email');
    return { success: false, reason: 'no_sendgrid' };
  }

  const ref = reservation.id.slice(0,8).toUpperCase();

  await sgMail.send({
    to:       reservation.email,
    from:     { email: FROM, name: NAME },
    replyTo:  process.env.MANAGER_EMAIL || FROM,
    subject:  `Direct Bill Authorization Form — ${ref} | On Top of the Palms`,
    html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;padding:24px 16px">
  <div style="max-width:640px;margin:0 auto">
    <div style="background:#006747;border-radius:10px 10px 0 0;padding:18px 24px">
      <p style="color:#a7d9c2;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin:0 0 2px">USF Dining · Compass USA</p>
      <h1 style="color:#fff;font-size:17px;font-weight:700;margin:0">On Top of the Palms</h1>
    </div>
    <div style="background:#fff;border-radius:0 0 10px 10px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.08)">
      <p style="color:#374151;font-size:14px;margin:0 0 16px">Hi <strong>${reservation.name}</strong>,</p>
      <p style="color:#374151;font-size:14px;margin:0 0 20px">Thank you for your reservation at On Top of the Palms. Since you selected <strong>Direct Bill</strong> as your payment method, please complete the authorization form below.</p>
      ${buildFormHTML(reservation)}
      <div style="margin-top:20px;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
        <p style="font-size:13px;color:#374151;margin:0"><strong>How to return this form:</strong><br>Print, complete, sign, and scan/photograph it. Reply to this email with the completed form attached. Our team will confirm receipt.</p>
      </div>
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:11px;margin:12px 0 0">On Top of the Palms · USF Tampa Campus · ${PHONE}</p>
  </div>
</div>`
  });

  console.log(`[DirectBill] Form sent to ${reservation.email} (ref: ${ref})`);
  return { success: true };
}

// ── Notify manager when doc is marked received ─────────────────────────────
async function notifyDocReceived(reservation) {
  if (!process.env.SENDGRID_API_KEY || !process.env.MANAGER_EMAIL) return;
  const ref = reservation.id.slice(0,8).toUpperCase();
  await sgMail.send({
    to:      process.env.MANAGER_EMAIL,
    from:    { email: FROM, name: NAME },
    subject: `✓ Direct Bill doc received — ${reservation.name} (${ref})`,
    html: `
<div style="font-family:-apple-system,sans-serif;padding:20px;max-width:480px">
  <h2 style="color:#006747">✓ Document Received</h2>
  <p>The signed Direct Bill form has been marked as received for:</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">
    <tr><td style="padding:6px 0;color:#6b7280">Name</td><td style="font-weight:600">${reservation.name}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Ref #</td><td style="font-family:monospace">${ref}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Department</td><td>${reservation.department||'—'}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Dining date</td><td>${reservation.datetime}</td></tr>
  </table>
  <p style="font-size:13px;color:#6b7280">Payment is due within 30 days of dining. Keep this record for your files.</p>
</div>`
  });
}

// ── Send confirmation email to guest that doc was received ─────────────────
async function confirmDocReceived(reservation) {
  if (!process.env.SENDGRID_API_KEY) return;
  const ref = reservation.id.slice(0,8).toUpperCase();
  await sgMail.send({
    to:      reservation.email,
    from:    { email: FROM, name: NAME },
    subject: `We received your Direct Bill form — ${ref}`,
    html: `
<div style="font-family:-apple-system,sans-serif;background:#f3f4f6;padding:24px 16px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="display:inline-block;background:#dcfce7;color:#15803d;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">✓ Document Received</div>
    <h2 style="color:#111827;font-size:18px;margin:0 0 12px">Thank you, ${reservation.name}!</h2>
    <p style="color:#374151;font-size:14px">We have received your signed Direct Bill authorization form. Your account will be processed within 30 days of your dining date.</p>
    <p style="color:#6b7280;font-size:13px;margin-top:12px">Reservation ref: <strong style="font-family:monospace">${ref}</strong></p>
    <p style="color:#6b7280;font-size:13px">Questions? Call us at ${PHONE}.</p>
  </div>
</div>`
  });
}

module.exports = { sendDirectBillForm, notifyDocReceived, confirmDocReceived, buildFormHTML };
