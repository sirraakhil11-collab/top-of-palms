/**
 * Direct Bill Service — On Top of the Palms
 * ──────────────────────────────────────────
 * TO UPDATE THE FORM: only edit buildFormPDF() — nothing else changes
 * TO CHANGE EMAIL TEMPLATE: only edit sendDirectBillForm() html section
 * TO CHANGE STORAGE: only edit db.storeDocument() in db.js
 *
 * Lifecycle:
 *   pending_send → reservation created w/ Direct Bill, form not sent yet
 *   sent         → form PDF emailed to guest
 *   received     → guest returned signed form, stored in DB
 */

const sgMail  = require('@sendgrid/mail');
const crypto  = require('crypto');
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM       = process.env.FROM_EMAIL || 'reservations@topofthepalms.usf.edu';
const NAME       = 'On Top of the Palms';
const PHONE      = process.env.RESTAURANT_PHONE || '(813) 974-3573';
const FORWARD_TO = process.env.DIRECT_BILL_EMAIL || process.env.MANAGER_EMAIL || 'topofthepalms@usf.edu';

// Generate a secure guest-facing upload token (same logic as server.js)
function makeUploadToken(reservationId) {
  const secret = process.env.SESSION_SECRET || 'topp-secret-key-2026';
  return crypto.createHmac('sha256', secret).update(`directbill:${reservationId}`).digest('hex').slice(0, 40);
}

// ─────────────────────────────────────────────────────────────────────────────
// buildFormPDF — fills the official Direct Bill template with reservation data
// Loads On_Top_of_the_Palms_Billing_Form.pdf and overlays pre-filled values
// TO UPDATE FIELD POSITIONS: adjust the coordinates in the overlay section below
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const TEMPLATE_PATH = path.join(__dirname, '..', 'On_Top_of_the_Palms_Billing_Form.pdf');

async function buildFormPDF(reservation) {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  const fs = require('fs');

  const party = parseInt(reservation.party || 0);
  const total = (party * 12.75).toFixed(2);
  const resDate = reservation.reservation_date || '';

  // Fix old records that have '2026' (year only) stored due to a previous bug.
  // Extract time from the human-readable datetime string as fallback.
  let resTime = reservation.reservation_time || '';
  if (!resTime || /^\d{4}$/.test(resTime.trim())) {
    const m = (reservation.datetime || '').match(/\d{1,2}:\d{2}\s*[AP]M/i);
    resTime = m ? m[0] : '';
  }

  // Load the official template PDF
  const templateBytes = fs.readFileSync(TEMPLATE_PATH);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const page = pdfDoc.getPages()[0];
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 11;
  const color = rgb(0, 0, 0);

  // Helper — only ASCII/Latin-1 text; pdf-lib Helvetica uses WinAnsi encoding
  const draw = (text, x, y, size = fontSize) => {
    if (!text) return;
    // Strip any chars outside WinAnsi (0x00-0xFF) to prevent encode errors
    const safe = String(text).replace(/[^\x00-\xFF]/g, '');
    if (!safe) return;
    page.drawText(safe, { x, y, size, font, color });
  };

  // ── Pre-filled field overlays ─────────────────────────────────────────────
  // Coordinates: (x, y) from bottom-left of Letter page (612×792 pt)
  // Verified against rendered PDF output — adjust here if template changes.
  //
  // Guest info rows (confirmed positions):
  draw(resDate,                   178, 533);  // Reservation Date value
  draw(resTime,                   455, 533);  // Reservation Time value
  draw(reservation.name || '',    237, 505);  // Invoice to the Attention of
  draw(reservation.department||'',232, 477);  // Invoice to Department Name
  draw(reservation.email || '',   103, 449);  // Email
  draw(reservation.phone_ext||'', 393, 449);  // Phone #
  draw(reservation.name || '',    177, 421);  // Dining Guest Name
  //
  // Bottom billing rows — template already has "Total: $", so we draw the number only:
  draw(String(party),             252, 157);  // Guest Count: value (blank is after "Count: ")
  draw(total,                     210, 137);  // Total amount (no '$' — template prints it; x=210 starts after 'Total: $' label)

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSignedFormPDF — complete signed version for in-person reception signing
// Overlays guest info + billing fields + signature image on the template
// ─────────────────────────────────────────────────────────────────────────────
async function buildSignedFormPDF(reservation, billing) {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  const fs = require('fs');

  const party = parseInt(reservation.party || 0);
  const total = (party * 12.75).toFixed(2);

  const templateBytes = fs.readFileSync(TEMPLATE_PATH);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const page   = pdfDoc.getPages()[0];
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const black  = rgb(0, 0, 0);
  const green  = rgb(0, 0.4, 0.27);

  // Safe draw — strips chars outside WinAnsi (0x00-0xFF) to prevent Helvetica encode crash
  const draw = (text, x, y, opts = {}) => {
    if (!text) return;
    const safe = String(text).replace(/[^\x00-\xFF]/g, '');
    if (!safe) return;
    page.drawText(safe, { x, y, size: opts.size || 11, font: opts.bold ? fontB : font, color: opts.color || black });
  };

  // ── Guest info — same corrected positions as buildFormPDF ─────────────────
  // Fix old records with '2026' stored in reservation_time (data bug)
  let resTime = reservation.reservation_time || '';
  if (!resTime || /^\d{4}$/.test(resTime.trim())) {
    const m = (reservation.datetime || '').match(/\d{1,2}:\d{2}\s*[AP]M/i);
    resTime = m ? m[0] : '';
  }
  draw(reservation.reservation_date || '',  178, 533);
  draw(resTime,                             455, 533);
  draw(reservation.name || '',             237, 505);
  draw(reservation.department || '',       232, 477);
  draw(reservation.email || '',           103, 449);
  draw(reservation.phone_ext || '',       393, 449);
  draw(reservation.name || '',           177, 421);
  // Guest Count blank (between "Count: " label and "@ $12.75"), Total (template prints "$"):
  draw(String(party),                     252, 157);
  draw(total,                             168, 137);

  // ── Billing fields ────────────────────────────────────────────────────────
  // x starts after the bold label ends on each underline.
  // Chartfield/Foundation labels end at ~x=252; In-Kind label ends at ~x=382.
  if (billing.chartfield) draw(billing.chartfield,           255, 296);
  if (billing.foundation) draw(billing.foundation,           252, 269);
  if (billing.inkind)     draw(billing.inkind,               385, 242);
  if (billing.pcard) {
    // NOTE: no special Unicode chars — Helvetica WinAnsi only supports Latin-1
    draw('(P-card) Paying by P-card - see Supervisor', 165, 222, { color: green, size: 10 });
  }

  // ── Signature image ───────────────────────────────────────────────────────
  // Template signature line is at y≈107. Guest Count at y=157, Total at y=137.
  // Image bottom-edge at y=108, capped at maxH=30pt → top reaches y=138.
  // Keeps it tight on the signature line and safely below Total (y=137).
  if (billing.signature_png) {
    try {
      const b64 = billing.signature_png.replace(/^data:image\/png;base64,/, '');
      const pngBytes = Buffer.from(b64, 'base64');
      const pngImage = await pdfDoc.embedPng(pngBytes);
      const { width: imgW, height: imgH } = pngImage.scale(1);
      const maxW = 355, maxH = 28;
      const scale = Math.min(maxW / imgW, maxH / imgH);
      const drawW = imgW * scale, drawH = imgH * scale;
      page.drawImage(pngImage, { x: 172, y: 108, width: drawW, height: drawH, opacity: 0.92 });
    } catch (sigErr) {
      console.error('[DirectBill] Could not embed signature PNG:', sigErr.message);
    }
  }

  // ── "Signed at reception" stamp ───────────────────────────────────────────
  const ts = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  draw(`Signed at reception: ${ts}`, 165, 88, { size: 8, color: rgb(0.5, 0.5, 0.5) });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// sendDirectBillForm — sends pre-filled PDF to guest as email attachment
// ─────────────────────────────────────────────────────────────────────────────
async function sendDirectBillForm(reservation) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log('[DirectBill] No SendGrid key — skipping email send');
    return { success: false, reason: 'no_sendgrid' };
  }

  const ref       = reservation.id.slice(0,8).toUpperCase();
  const baseUrl   = process.env.BASE_URL || 'https://staging.topofthepalmsusf-chartwells.com';
  const uploadUrl = `${baseUrl}/directbill/upload/${makeUploadToken(reservation.id)}`;

  let pdfBuffer = null;
  try {
    pdfBuffer = await buildFormPDF(reservation);
    console.log(`[DirectBill] PDF generated: ${pdfBuffer.length} bytes`);
  } catch(pdfErr) {
    console.error('[DirectBill] PDF generation failed:', pdfErr.message);
  }

  const attachments = pdfBuffer ? [{
    content:     pdfBuffer.toString('base64'),
    filename:    `DirectBill_${ref}_${(reservation.name||'Guest').replace(/\s+/g,'_')}.pdf`,
    type:        'application/pdf',
    disposition: 'attachment'
  }] : [];

  await sgMail.send({
    to:       reservation.email,
    from:     { email: FROM, name: NAME },
    replyTo:  FORWARD_TO,
    subject:  `Action Required: Direct Bill Form — Ref ${ref} | On Top of the Palms`,
    attachments,
    html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;padding:24px 16px">
<div style="max-width:580px;margin:0 auto">
  <div style="background:#006747;border-radius:10px 10px 0 0;padding:18px 24px">
    <p style="color:#a7d9c2;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin:0 0 2px">USF Dining · Compass USA</p>
    <h1 style="color:#fff;font-size:17px;font-weight:700;margin:0">On Top of the Palms</h1>
  </div>
  <div style="background:#fff;border-radius:0 0 10px 10px;padding:24px 28px;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="display:inline-block;background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">📄 Action Required — Direct Bill</div>
    <h2 style="color:#111827;font-size:18px;margin:0 0 12px">Hi ${reservation.name},</h2>
    <p style="color:#374151;font-size:14px;margin:0 0 14px">Thank you for your reservation at <strong>On Top of the Palms</strong>. You selected <strong>Direct Bill</strong> as your payment method.</p>
    <p style="color:#374151;font-size:14px;margin:0 0 18px">The <strong>pre-filled Authorization Form is attached</strong> to this email. Please complete, sign, and return it using the button below.</p>

    <ol style="color:#374151;font-size:14px;line-height:1.9;padding-left:20px;margin:0 0 20px">
      <li>Print the attached PDF form</li>
      <li>Fill in your Chartfield #, Foundation #, or In-Kind account details</li>
      <li>Sign the form</li>
      <li><strong>Click the button below to upload your completed form</strong></li>
    </ol>

    <!-- Upload button — the main CTA -->
    <div style="text-align:center;margin:24px 0">
      <a href="${uploadUrl}"
         style="display:inline-block;background:#006747;color:#fff;text-decoration:none;padding:15px 36px;border-radius:10px;font-size:16px;font-weight:700;letter-spacing:.01em">
        📤 Upload Signed Form
      </a>
      <p style="font-size:11px;color:#9ca3af;margin-top:10px">Secure link · PDF, JPG, or PNG · Max 10 MB</p>
    </div>

    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:0 0 18px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Reservation Ref</td><td style="font-weight:700;text-align:right;font-family:monospace;border-bottom:1px solid #f3f4f6">${ref}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Date & Time</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.datetime}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Party Size</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.party} guest${reservation.party===1?'':'s'}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0">Amount Due</td><td style="font-weight:700;text-align:right;color:#006747">$${(reservation.party*12.75).toFixed(2)}</td></tr>
      </table>
    </div>

    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;margin-bottom:16px">
      <p style="font-size:13px;color:#b45309;margin:0">⚠️ Payment must be received within <strong>30 days of dining</strong>.</p>
    </div>

    <p style="font-size:12px;color:#9ca3af;margin:0">Can't use the button? Email your completed form to <strong>${FORWARD_TO}</strong> and include your Ref # <strong>${ref}</strong> in the subject line.<br>Questions? Call us at ${PHONE}.</p>
    ${!pdfBuffer ? '<p style="font-size:12px;color:#b91c1c;background:#fef2f2;border-radius:6px;padding:8px 12px;margin-top:12px">⚠️ PDF attachment failed to generate — please contact us at '+PHONE+' for a copy of the form.</p>' : ''}
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:11px;margin:12px 0 0">On Top of the Palms · USF Tampa Campus · ${PHONE}</p>
</div>
</div>`
  });

  console.log(`[DirectBill] Email sent to ${reservation.email} (ref: ${ref}) — upload URL: ${uploadUrl}`);
  return { success: true, has_pdf: !!pdfBuffer };
}

// ─────────────────────────────────────────────────────────────────────────────
// notifyDocReceived — manager marked form as received → notify both parties
// ─────────────────────────────────────────────────────────────────────────────
async function notifyDocReceived(reservation) {
  if (!process.env.SENDGRID_API_KEY) return;
  const ref = reservation.id.slice(0,8).toUpperCase();

  // Notify manager
  if (process.env.MANAGER_EMAIL) {
    await sgMail.send({
      to: process.env.MANAGER_EMAIL, from: { email: FROM, name: NAME },
      subject: `✓ Direct Bill doc received — ${reservation.name} (${ref})`,
      html: `<div style="font-family:sans-serif;padding:20px;max-width:480px">
        <h2 style="color:#006747">✓ Document Received</h2>
        <p style="font-size:14px">Signed form received for <strong>${reservation.name}</strong> (Ref: <code>${ref}</code>).</p>
        <table style="font-size:13px;border-collapse:collapse;width:100%;margin:12px 0">
          <tr><td style="color:#6b7280;padding:5px 0">Department</td><td>${reservation.department||'—'}</td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Dining date</td><td>${reservation.datetime}</td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Amount</td><td><strong>$${(reservation.party*12.75).toFixed(2)}</strong></td></tr>
        </table>
        <p style="font-size:12px;color:#6b7280">Payment due within 30 days of dining.</p>
      </div>`
    }).catch(console.error);
  }

  // Confirm to guest
  await sgMail.send({
    to: reservation.email, from: { email: FROM, name: NAME },
    subject: `We received your Direct Bill form — Ref ${ref}`,
    html: `<div style="font-family:sans-serif;background:#f3f4f6;padding:24px 16px"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
      <div style="display:inline-block;background:#dcfce7;color:#15803d;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">✓ Form Received</div>
      <h2 style="color:#111827;font-size:17px;margin:0 0 10px">Thank you, ${reservation.name}!</h2>
      <p style="color:#374151;font-size:14px">We received your signed Direct Bill authorization. Your account will be billed <strong>$${(reservation.party*12.75).toFixed(2)}</strong> within 30 days.</p>
      <p style="color:#6b7280;font-size:12px;margin-top:12px">Ref: <code>${ref}</code> · Questions? ${PHONE}</p>
    </div></div>`
  }).catch(console.error);
}

module.exports = { sendDirectBillForm, notifyDocReceived, buildFormPDF, buildSignedFormPDF };
