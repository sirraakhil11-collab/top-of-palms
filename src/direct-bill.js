/**
 * Direct Bill Service — On Top of the Palms
 * ──────────────────────────────────────────
 * buildFormPDF        → clean custom PDF sent to guest for completion
 * buildSignedFormPDF  → completed version with billing fields + signature
 * sendDirectBillForm  → email PDF to guest
 * notifyDocReceived   → notify parties when form returned
 */

const sgMail  = require('@sendgrid/mail');
const crypto  = require('crypto');
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM       = process.env.FROM_EMAIL || 'reservations@topofthepalms.usf.edu';
const NAME       = 'On Top of the Palms';
const PHONE      = process.env.RESTAURANT_PHONE || '(813) 974-3573';
const FORWARD_TO = process.env.DIRECT_BILL_EMAIL || process.env.MANAGER_EMAIL || 'topofthepalms@usf.edu';

function makeUploadToken(reservationId) {
  const secret = process.env.SESSION_SECRET || 'topp-secret-key-2026';
  return crypto.createHmac('sha256', secret).update(`directbill:${reservationId}`).digest('hex').slice(0, 40);
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF helpers — shared between buildFormPDF and buildSignedFormPDF
// ─────────────────────────────────────────────────────────────────────────────
async function createBasePDF() {
  const { PDFDocument, rgb, StandardFonts, LineCapStyle } = require('pdf-lib');

  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([612, 792]); // US Letter

  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const GREEN  = rgb(0, 0.40, 0.28);   // #006747
  const BLACK  = rgb(0, 0, 0);
  const GRAY   = rgb(0.43, 0.44, 0.48);// #6b7280
  const LGRAY  = rgb(0.90, 0.91, 0.92);// #e5e7eb
  const WHITE  = rgb(1, 1, 1);

  const W = 612, H = 792;
  const ML = 52, MR = 560; // left/right margins
  const CW = MR - ML;      // content width = 508

  // ── Safe text draw (strips non-WinAnsi) ───────────────────────────────────
  const safe = t => String(t || '').replace(/[^\x00-\xFF]/g, '');
  const text = (t, x, y, opts = {}) => {
    const s = safe(t);
    if (!s) return;
    page.drawText(s, {
      x, y,
      size:  opts.size  || 10,
      font:  opts.bold  ? helveticaB : helvetica,
      color: opts.color || BLACK,
      maxWidth: opts.maxWidth,
    });
  };

  // ── Horizontal rule ───────────────────────────────────────────────────────
  const hline = (y, opts = {}) =>
    page.drawLine({ start:{x:ML,y}, end:{x:MR,y}, thickness:opts.thick||0.5, color:opts.color||LGRAY });

  // ── Filled rect ───────────────────────────────────────────────────────────
  const rect = (x, y, w, h, fill) =>
    page.drawRectangle({ x, y, width:w, height:h, color:fill });

  // ── Underline input field ─────────────────────────────────────────────────
  const field = (label, value, x, y, w, opts = {}) => {
    text(label, x, y + 13, { size: 8, color: GRAY });
    if (value) {
      text(value, x + 2, y + 1, { size: opts.valueSize || 10, bold: opts.bold, color: BLACK, maxWidth: w - 4 });
    }
    page.drawLine({ start:{x, y}, end:{x+w, y}, thickness:0.5, color: value ? GREEN : LGRAY });
  };

  return { pdfDoc, page, helvetica, helveticaB, GREEN, BLACK, GRAY, LGRAY, WHITE, W, H, ML, MR, CW, text, hline, rect, field, safe };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildFormPDF — clean pre-filled form sent to guest (they fill billing fields)
// ─────────────────────────────────────────────────────────────────────────────
async function buildFormPDF(reservation) {
  const { pdfDoc, page, GREEN, BLACK, GRAY, LGRAY, WHITE, W, H, ML, MR, CW, text, hline, rect, field } = await createBasePDF();

  const party  = parseInt(reservation.party || 0);
  const days   = Math.max(1, parseInt(reservation.num_days || 1));
  const total  = (party * days * 12.75).toFixed(2);
  const ref    = (reservation.id || '').slice(0, 8).toUpperCase();

  let resTime = reservation.reservation_time || '';
  if (!resTime || /^\d{4}$/.test(resTime.trim())) {
    const m = (reservation.datetime || '').match(/\d{1,2}:\d{2}\s*[AP]M/i);
    resTime = m ? m[0] : '';
  }

  let y = H - 52; // start from top

  // ── Header bar ────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: H - 72, width: W, height: 72, color: GREEN });
  text('ON TOP OF THE PALMS',    ML, H - 32, { size: 18, bold: true,  color: WHITE });
  text('USF Dining · Compass USA', ML, H - 48, { size: 10,             color: require('pdf-lib').rgb(0.65,0.85,0.76) });
  text('DIRECT BILL AUTHORIZATION FORM', MR, H - 32, { size: 9, color: WHITE });
  // Align right manually
  const refStr = `Ref: ${ref}`;
  text(refStr, MR - refStr.length * 5.6, H - 46, { size: 9, color: require('pdf-lib').rgb(0.65,0.85,0.76) });

  y = H - 92;

  // ── Reservation details section ───────────────────────────────────────────
  rect(ML, y - 6, CW, 20, require('pdf-lib').rgb(0.94, 0.99, 0.96));
  text('RESERVATION DETAILS', ML + 6, y + 7, { size: 8, bold: true, color: GREEN });
  y -= 6;
  hline(y, { color: GREEN, thick: 0.8 });
  y -= 20;

  // Row 1: Date + Time
  field('Reservation Date',  reservation.reservation_date || '—',  ML,       y, 200);
  field('Time',              resTime || '—',                        ML + 220, y, 140);
  field('Ref #',             ref,                                   ML + 380, y, 128);
  y -= 32;

  // Row 2: Name + Department
  field('Guest / Invoice Name',  reservation.name       || '',  ML,       y, 240);
  field('Department',            reservation.department || '',  ML + 260, y, 248);
  y -= 32;

  // Row 3: Email + Phone
  field('Email Address',  reservation.email     || '',  ML,       y, 240);
  field('Phone / Ext',    reservation.phone_ext || '',  ML + 260, y, 248);
  y -= 40;

  // ── Billing section ───────────────────────────────────────────────────────
  rect(ML, y - 6, CW, 20, require('pdf-lib').rgb(0.94, 0.99, 0.96));
  text('ACCOUNT / BILLING INFORMATION', ML + 6, y + 7, { size: 8, bold: true, color: GREEN });
  y -= 6;
  hline(y, { color: GREEN, thick: 0.8 });
  y -= 4;
  text('Please complete ONE of the options below:', ML, y, { size: 9, color: GRAY });
  y -= 22;

  field('Chartfield Number (FOAP)',    '', ML,       y, 240);
  field('Foundation Account Number',  '', ML + 260, y, 248);
  y -= 32;
  field('In-Kind Account',            '', ML,       y, 200);
  y -= 40;

  // ── Amount breakdown ──────────────────────────────────────────────────────
  rect(ML, y - 6, CW, 20, require('pdf-lib').rgb(0.94, 0.99, 0.96));
  text('AMOUNT DUE', ML + 6, y + 7, { size: 8, bold: true, color: GREEN });
  y -= 6;
  hline(y, { color: GREEN, thick: 0.8 });
  y -= 22;

  // Table header
  rect(ML, y - 2, CW, 18, require('pdf-lib').rgb(0.25, 0.25, 0.27));
  text('DESCRIPTION',    ML + 6,       y + 5, { size: 8, bold: true, color: WHITE });
  text('QTY',            ML + 260,     y + 5, { size: 8, bold: true, color: WHITE });
  text('RATE',           ML + 330,     y + 5, { size: 8, bold: true, color: WHITE });
  text('AMOUNT',         MR - 60,      y + 5, { size: 8, bold: true, color: WHITE });
  y -= 22;

  // Row
  const descStr = days > 1 ? `Dining — ${party} guests x ${days} days` : `Dining — ${party} guest${party===1?'':'s'}`;
  text(descStr,          ML + 6,  y + 5, { size: 9 });
  text(String(party * days), ML + 260, y + 5, { size: 9 });
  text('$12.75',         ML + 330,     y + 5, { size: 9 });
  text(`$${total}`,      MR - 60,      y + 5, { size: 9 });
  hline(y - 2, { color: LGRAY });
  y -= 24;

  // Total row
  rect(ML + 300, y - 4, CW - 300, 22, require('pdf-lib').rgb(0.94, 0.99, 0.96));
  text('TOTAL AMOUNT DUE', ML + 306, y + 7, { size: 9, bold: true, color: GREEN });
  text(`$${total}`,        MR - 60,  y + 7, { size: 11, bold: true, color: GREEN });
  y -= 36;

  // ── Authorization & Signature ─────────────────────────────────────────────
  rect(ML, y - 6, CW, 20, require('pdf-lib').rgb(0.94, 0.99, 0.96));
  text('AUTHORIZATION', ML + 6, y + 7, { size: 8, bold: true, color: GREEN });
  y -= 6;
  hline(y, { color: GREEN, thick: 0.8 });
  y -= 14;

  text('By signing below, I authorize On Top of the Palms to charge the account listed above for the amount shown.', ML, y, { size: 8.5, color: GRAY, maxWidth: CW });
  text('Payment is due within 30 days of dining. Unauthorized use of University accounts is a violation of USF policy.', ML, y - 11, { size: 8.5, color: GRAY, maxWidth: CW });
  y -= 36;

  field('Authorized Signature',   '', ML,       y, 280);
  field('Date Signed',            '', ML + 300, y, 208);
  y -= 32;
  field('Printed Name',           '', ML,       y, 280);
  field('Title / Position',       '', ML + 300, y, 208);
  y -= 40;

  // ── Footer ────────────────────────────────────────────────────────────────
  hline(72, { thick: 0.5 });
  text(`On Top of the Palms · University of South Florida · ${PHONE}`, ML, 60, { size: 8, color: GRAY });
  text(`Return completed form to: ${FORWARD_TO}`, ML, 49, { size: 8, color: GRAY });
  text(`Ref: ${ref} · Submitted: ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`, MR - 160, 49, { size: 8, color: GRAY });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSignedFormPDF — completed form with billing fields + signature overlay
// ─────────────────────────────────────────────────────────────────────────────
async function buildSignedFormPDF(reservation, billing) {
  const { pdfDoc, page, GREEN, BLACK, GRAY, LGRAY, WHITE, W, H, ML, MR, CW, text, hline, rect, field } = await createBasePDF();

  const party  = parseInt(reservation.party || 0);
  const days   = Math.max(1, parseInt(reservation.num_days || 1));
  const total  = (party * days * 12.75).toFixed(2);
  const ref    = (reservation.id || '').slice(0, 8).toUpperCase();

  let resTime = reservation.reservation_time || '';
  if (!resTime || /^\d{4}$/.test(resTime.trim())) {
    const m = (reservation.datetime || '').match(/\d{1,2}:\d{2}\s*[AP]M/i);
    resTime = m ? m[0] : '';
  }

  let y = H - 52;

  // ── Header bar ────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: H - 72, width: W, height: 72, color: GREEN });
  text('ON TOP OF THE PALMS',    ML, H - 32, { size: 18, bold: true,  color: WHITE });
  text('USF Dining · Compass USA', ML, H - 48, { size: 10,             color: require('pdf-lib').rgb(0.65,0.85,0.76) });
  text('DIRECT BILL AUTHORIZATION FORM — SIGNED AT RECEPTION', MR, H - 32, { size: 8, color: WHITE });
  const refStr = `Ref: ${ref}`;
  text(refStr, MR - refStr.length * 5.6, H - 46, { size: 9, color: require('pdf-lib').rgb(0.65,0.85,0.76) });

  y = H - 92;

  // ── Reservation details ───────────────────────────────────────────────────
  rect(ML, y - 6, CW, 20, require('pdf-lib').rgb(0.94, 0.99, 0.96));
  text('RESERVATION DETAILS', ML + 6, y + 7, { size: 8, bold: true, color: GREEN });
  y -= 6;
  hline(y, { color: GREEN, thick: 0.8 });
  y -= 20;

  field('Reservation Date', reservation.reservation_date || '—', ML,       y, 200);
  field('Time',             resTime || '—',                      ML + 220, y, 140);
  field('Ref #',            ref,                                 ML + 380, y, 128);
  y -= 32;
  field('Guest / Invoice Name', reservation.name       || '', ML,       y, 240);
  field('Department',           reservation.department || '', ML + 260, y, 248);
  y -= 32;
  field('Email Address',  reservation.email     || '', ML,       y, 240);
  field('Phone / Ext',    reservation.phone_ext || '', ML + 260, y, 248);
  y -= 40;

  // ── Billing section (filled) ──────────────────────────────────────────────
  rect(ML, y - 6, CW, 20, require('pdf-lib').rgb(0.94, 0.99, 0.96));
  text('ACCOUNT / BILLING INFORMATION', ML + 6, y + 7, { size: 8, bold: true, color: GREEN });
  y -= 6;
  hline(y, { color: GREEN, thick: 0.8 });
  y -= 4;
  y -= 22;

  field('Chartfield Number (FOAP)',   billing.chartfield || '', ML,       y, 240);
  field('Foundation Account Number',  billing.foundation || '', ML + 260, y, 248);
  y -= 32;

  const inkindVal = billing.pcard ? 'P-Card — see Supervisor' : (billing.inkind || '');
  field('In-Kind Account', inkindVal, ML, y, 200);
  y -= 40;

  // ── Amount ────────────────────────────────────────────────────────────────
  rect(ML, y - 6, CW, 20, require('pdf-lib').rgb(0.94, 0.99, 0.96));
  text('AMOUNT DUE', ML + 6, y + 7, { size: 8, bold: true, color: GREEN });
  y -= 6;
  hline(y, { color: GREEN, thick: 0.8 });
  y -= 22;

  rect(ML, y - 2, CW, 18, require('pdf-lib').rgb(0.25, 0.25, 0.27));
  text('DESCRIPTION', ML + 6, y + 5, { size: 8, bold: true, color: WHITE });
  text('QTY',         ML + 260, y + 5, { size: 8, bold: true, color: WHITE });
  text('RATE',        ML + 330, y + 5, { size: 8, bold: true, color: WHITE });
  text('AMOUNT',      MR - 60,  y + 5, { size: 8, bold: true, color: WHITE });
  y -= 22;

  const descStr = days > 1 ? `Dining — ${party} guests x ${days} days` : `Dining — ${party} guest${party===1?'':'s'}`;
  text(descStr,         ML + 6,   y + 5, { size: 9 });
  text(String(party*days), ML+260, y + 5, { size: 9 });
  text('$12.75',        ML + 330, y + 5, { size: 9 });
  text(`$${total}`,     MR - 60,  y + 5, { size: 9 });
  hline(y - 2, { color: LGRAY });
  y -= 24;

  rect(ML + 300, y - 4, CW - 300, 22, require('pdf-lib').rgb(0.94, 0.99, 0.96));
  text('TOTAL AMOUNT DUE', ML + 306, y + 7, { size: 9, bold: true, color: GREEN });
  text(`$${total}`,        MR - 60,  y + 7, { size: 11, bold: true, color: GREEN });
  y -= 36;

  // ── Signature section ─────────────────────────────────────────────────────
  rect(ML, y - 6, CW, 20, require('pdf-lib').rgb(0.94, 0.99, 0.96));
  text('AUTHORIZATION', ML + 6, y + 7, { size: 8, bold: true, color: GREEN });
  y -= 6;
  hline(y, { color: GREEN, thick: 0.8 });
  y -= 14;
  text('By signing below, I authorize On Top of the Palms to charge the account listed above for the amount shown.', ML, y, { size: 8.5, color: GRAY, maxWidth: CW });
  y -= 36;

  const signDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  field('Authorized Signature', '', ML,       y, 280);
  field('Date Signed',          signDate, ML + 300, y, 208);
  y -= 32;
  field('Printed Name',   reservation.name || '',       ML,       y, 280);
  field('Title / Position', '',                         ML + 300, y, 208);

  // Signature image above the signature line
  if (billing.signature_png) {
    try {
      const b64 = billing.signature_png.replace(/^data:image\/png;base64,/, '');
      const pngImage = await pdfDoc.embedPng(Buffer.from(b64, 'base64'));
      const { width: iw, height: ih } = pngImage.scale(1);
      const maxW = 270, maxH = 28;
      const scale = Math.min(maxW / iw, maxH / ih);
      page.drawImage(pngImage, { x: ML + 2, y: y + 2, width: iw*scale, height: ih*scale, opacity: 0.92 });
    } catch(e) { console.error('[DirectBill] Signature embed failed:', e.message); }
  }

  y -= 24;

  // Signed stamp
  const ts = new Date().toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });
  text(`Signed at reception: ${ts}`, ML, y, { size: 8, color: require('pdf-lib').rgb(0.4,0.4,0.4) });

  // ── Footer ────────────────────────────────────────────────────────────────
  hline(72, { thick: 0.5 });
  text(`On Top of the Palms · University of South Florida · ${PHONE}`, ML, 60, { size: 8, color: GRAY });
  text(`Return to: ${FORWARD_TO}`, ML, 49, { size: 8, color: GRAY });
  text(`Ref: ${ref} · Processed: ${signDate}`, MR - 160, 49, { size: 8, color: GRAY });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// sendDirectBillForm — emails pre-filled PDF to guest
// ─────────────────────────────────────────────────────────────────────────────
async function sendDirectBillForm(reservation) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log('[DirectBill] No SendGrid key — skipping email send');
    return { success: false, reason: 'no_sendgrid' };
  }

  const ref       = reservation.id.slice(0,8).toUpperCase();
  const baseUrl   = process.env.BASE_URL || 'https://staging.topofthepalmsusf-chartwells.com';
  const uploadUrl = `${baseUrl}/directbill/upload/${makeUploadToken(reservation.id)}`;
  const amtDue    = (reservation.party * Math.max(1, parseInt(reservation.num_days||1)) * 12.75).toFixed(2);

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
    <p style="color:#374151;font-size:14px;margin:0 0 14px">Thank you for your reservation. A clean, pre-filled <strong>Direct Bill Authorization Form is attached</strong> as a PDF.</p>
    <ol style="color:#374151;font-size:14px;line-height:1.9;padding-left:20px;margin:0 0 20px">
      <li>Open the attached PDF</li>
      <li>Fill in your <strong>Chartfield #</strong>, <strong>Foundation #</strong>, or <strong>In-Kind</strong> account</li>
      <li>Sign and date the form</li>
      <li>Upload it using the button below</li>
    </ol>
    <div style="text-align:center;margin:24px 0">
      <a href="${uploadUrl}" style="display:inline-block;background:#006747;color:#fff;text-decoration:none;padding:15px 36px;border-radius:10px;font-size:16px;font-weight:700">📤 Upload Signed Form</a>
      <p style="font-size:11px;color:#9ca3af;margin-top:10px">Secure link · PDF, JPG, or PNG · Max 10 MB</p>
    </div>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:0 0 18px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Ref</td><td style="font-weight:700;text-align:right;font-family:monospace;border-bottom:1px solid #f3f4f6">${ref}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Date &amp; Time</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.datetime}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Party</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.party} guests</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0">Amount Due</td><td style="font-weight:700;text-align:right;color:#006747">$${amtDue}</td></tr>
      </table>
    </div>
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;margin-bottom:16px">
      <p style="font-size:13px;color:#b45309;margin:0">⚠️ Payment must be received within <strong>30 days of dining</strong>.</p>
    </div>
    <p style="font-size:12px;color:#9ca3af;margin:0">Can't use the button? Email your completed form to <strong>${FORWARD_TO}</strong> — include Ref # <strong>${ref}</strong>.<br>Questions? Call ${PHONE}.</p>
    ${!pdfBuffer ? '<p style="font-size:12px;color:#b91c1c;background:#fef2f2;border-radius:6px;padding:8px 12px;margin-top:12px">⚠️ PDF generation failed — please contact us at '+PHONE+'.</p>' : ''}
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:11px;margin:12px 0 0">On Top of the Palms · USF Tampa Campus · ${PHONE}</p>
</div>
</div>`
  });

  console.log(`[DirectBill] Email sent to ${reservation.email} (ref: ${ref})`);
  return { success: true, has_pdf: !!pdfBuffer };
}

// ─────────────────────────────────────────────────────────────────────────────
// notifyDocReceived — notify manager + guest when signed form is received
// ─────────────────────────────────────────────────────────────────────────────
async function notifyDocReceived(reservation) {
  if (!process.env.SENDGRID_API_KEY) return;
  const ref    = reservation.id.slice(0, 8).toUpperCase();
  const amtDue = (reservation.party * Math.max(1, parseInt(reservation.num_days||1)) * 12.75).toFixed(2);

  if (process.env.MANAGER_EMAIL) {
    await sgMail.send({
      to: process.env.MANAGER_EMAIL, from: { email: FROM, name: NAME },
      subject: `✓ Direct Bill doc received — ${reservation.name} (${ref})`,
      html: `<div style="font-family:sans-serif;padding:20px;max-width:480px">
        <h2 style="color:#006747">✓ Document Received</h2>
        <p>Signed form received for <strong>${reservation.name}</strong> (Ref: <code>${ref}</code>).</p>
        <table style="font-size:13px;border-collapse:collapse;width:100%;margin:12px 0">
          <tr><td style="color:#6b7280;padding:5px 0">Department</td><td>${reservation.department||'—'}</td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Dining date</td><td>${reservation.datetime}</td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Amount</td><td><strong>$${amtDue}</strong></td></tr>
        </table>
        <p style="font-size:12px;color:#6b7280">Payment due within 30 days of dining.</p>
      </div>`
    }).catch(console.error);
  }

  await sgMail.send({
    to: reservation.email, from: { email: FROM, name: NAME },
    subject: `We received your Direct Bill form — Ref ${ref}`,
    html: `<div style="font-family:sans-serif;background:#f3f4f6;padding:24px 16px"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
      <div style="display:inline-block;background:#dcfce7;color:#15803d;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">✓ Form Received</div>
      <h2 style="color:#111827;font-size:17px;margin:0 0 10px">Thank you, ${reservation.name}!</h2>
      <p style="color:#374151;font-size:14px">We received your signed Direct Bill authorization. Your account will be billed <strong>$${amtDue}</strong> within 30 days.</p>
      <p style="color:#6b7280;font-size:12px;margin-top:12px">Ref: <code>${ref}</code> · Questions? ${PHONE}</p>
    </div></div>`
  }).catch(console.error);
}

module.exports = { sendDirectBillForm, notifyDocReceived, buildFormPDF, buildSignedFormPDF };
