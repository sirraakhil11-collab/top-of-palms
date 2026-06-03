/**
 * Direct Bill Service — On Top of the Palms
 */

const sgMail  = require('@sendgrid/mail');
const crypto  = require('crypto');
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM       = process.env.FROM_EMAIL || 'reservations@topofthepalms.usf.edu';
const NAME       = 'On Top of the Palms';
const PHONE      = process.env.RESTAURANT_PHONE || '(813) 974-3573';
const FORWARD_TO = process.env.DIRECT_BILL_EMAIL || process.env.MANAGER_EMAIL || 'topofthepalms@usf.edu';

// Fetch rate from settings, fall back to 12.75
async function getRate() {
  try {
    const db = require('./db');
    const s = await db.getAllSettings();
    const r = parseFloat(s.direct_bill_rate);
    return isNaN(r) ? 12.75 : r;
  } catch { return 12.75; }
}

function makeUploadToken(reservationId) {
  const secret = process.env.SESSION_SECRET || 'topp-secret-key-2026';
  return crypto.createHmac('sha256', secret).update(`directbill:${reservationId}`).digest('hex').slice(0, 40);
}

function makeApprovalToken(reservationId) {
  const secret = process.env.SESSION_SECRET || 'topp-secret-key-2026';
  return crypto.createHmac('sha256', secret).update(`dba:${reservationId}:${Date.now()}`).digest('hex').slice(0, 48);
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF helpers — shared
// ─────────────────────────────────────────────────────────────────────────────
async function createBasePDF() {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([612, 792]);

  const helvetica  = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const GREEN = rgb(0, 0.40, 0.28);
  const BLACK = rgb(0, 0, 0);
  const GRAY  = rgb(0.43, 0.44, 0.48);
  const LGRAY = rgb(0.90, 0.91, 0.92);
  const WHITE = rgb(1, 1, 1);

  const W = 612, H = 792;
  const ML = 52, MR = 560;
  const CW = MR - ML;

  const safe = t => String(t || '').replace(/[^\x00-\xFF]/g, '');
  const text = (t, x, y, opts = {}) => {
    const s = safe(t);
    if (!s) return;
    page.drawText(s, { x, y, size: opts.size || 10, font: opts.bold ? helveticaB : helvetica, color: opts.color || BLACK, maxWidth: opts.maxWidth });
  };
  const hline = (y, opts = {}) =>
    page.drawLine({ start:{x:ML,y}, end:{x:MR,y}, thickness:opts.thick||0.5, color:opts.color||LGRAY });
  const rect = (x, y, w, h, fill) =>
    page.drawRectangle({ x, y, width:w, height:h, color:fill });
  const field = (label, value, x, y, w, opts = {}) => {
    text(label, x, y + 13, { size: 8, color: GRAY });
    if (value) text(value, x + 2, y + 1, { size: opts.valueSize || 10, bold: opts.bold, color: BLACK, maxWidth: w - 4 });
    page.drawLine({ start:{x: x, y: y}, end:{x: x+w, y: y}, thickness:0.5, color: value ? GREEN : LGRAY });
  };

  return { pdfDoc, page, GREEN, BLACK, GRAY, LGRAY, WHITE, W, H, ML, MR, CW, text, hline, rect, field, safe };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildFormPDF — blank form sent to guest (legacy path kept for POS sign flow)
// ─────────────────────────────────────────────────────────────────────────────
async function buildFormPDF(reservation) {
  const rate  = await getRate();
  const { pdfDoc, page, GREEN, BLACK, GRAY, LGRAY, WHITE, W, H, ML, MR, CW, text, hline, rect, field } = await createBasePDF();
  const { rgb } = require('pdf-lib');

  const party = parseInt(reservation.party || 0);
  const days  = Math.max(1, parseInt(reservation.num_days || 1));
  const total = (party * days * rate).toFixed(2);
  const ref   = (reservation.id || '').slice(0, 8).toUpperCase();

  let resTime = reservation.reservation_time || '';
  if (!resTime || /^\d{4}$/.test(resTime.trim())) {
    const m = (reservation.datetime || '').match(/\d{1,2}:\d{2}\s*[AP]M/i);
    resTime = m ? m[0] : '';
  }

  let y = H - 52;

  // Header
  page.drawRectangle({ x:0, y:H-72, width:W, height:72, color:GREEN });
  text('ON TOP OF THE PALMS',    ML, H-32, { size:18, bold:true, color:WHITE });
  text('USF Dining · Compass USA', ML, H-48, { size:10, color:rgb(0.65,0.85,0.76) });
  text('DIRECT BILL FORM', MR-120, H-32, { size:9, color:WHITE });
  const refStr = `Ref: ${ref}`;
  text(refStr, MR - refStr.length*5.6, H-46, { size:9, color:rgb(0.65,0.85,0.76) });

  y = H - 92;

  // Restaurant info bar
  rect(ML, y-6, CW, 20, rgb(0.94,0.99,0.96));
  text(`Phone: ${PHONE}   Email: ${FROM}`, ML+6, y+7, { size:8, color:GREEN });
  y -= 28;

  // Reservation details
  rect(ML, y-6, CW, 20, rgb(0.94,0.99,0.96));
  text('RESERVATION DETAILS', ML+6, y+7, { size:8, bold:true, color:GREEN });
  y -= 6; hline(y, { color:GREEN, thick:0.8 }); y -= 20;

  field('Reservation Date', reservation.reservation_date || '—', ML,      y, 200);
  field('Reservation Time', resTime || '—',                      ML+220,  y, 140);
  field('Ref #',            ref,                                  ML+380,  y, 128);
  y -= 32;

  // Invoice to
  rect(ML, y-6, CW, 20, rgb(0.94,0.99,0.96));
  text('INVOICE TO', ML+6, y+7, { size:8, bold:true, color:GREEN });
  y -= 6; hline(y, { color:GREEN, thick:0.8 }); y -= 20;

  field('Attention of',    reservation.attn_name    || '', ML,      y, 240);
  field('Department',      reservation.department   || '', ML+260,  y, 248);
  y -= 32;
  field('Email',           reservation.email        || '', ML,      y, 240);
  field('Phone',           reservation.phone_ext    || '', ML+260,  y, 248);
  y -= 32;
  field('Dining Guest Name', reservation.name       || '', ML,      y, 300);
  y -= 40;

  // Billing
  rect(ML, y-6, CW, 20, rgb(0.94,0.99,0.96));
  text('BILLING', ML+6, y+7, { size:8, bold:true, color:GREEN });
  y -= 6; hline(y, { color:GREEN, thick:0.8 }); y -= 10;
  text('P-card or In-Kind approval is required prior to your reservation.', ML, y, { size:8.5, color:GRAY, maxWidth:CW });
  y -= 22;

  field('In-Kind Account Name',     '', ML,      y, 200);
  field('Approver Manager Email',   '', ML+220,  y, 200);
  y -= 28;
  text('— OR —', ML, y, { size:9, color:GRAY });
  y -= 18;
  text('[ ] P-Card', ML, y, { size:10, bold:true, color:BLACK });
  y -= 36;

  // Amount
  rect(ML, y-6, CW, 20, rgb(0.94,0.99,0.96));
  text('AMOUNT DUE', ML+6, y+7, { size:8, bold:true, color:GREEN });
  y -= 6; hline(y, { color:GREEN, thick:0.8 }); y -= 22;

  rect(ML, y-2, CW, 18, rgb(0.25,0.25,0.27));
  text('DESCRIPTION', ML+6,  y+5, { size:8, bold:true, color:WHITE });
  text('QTY',         ML+260,y+5, { size:8, bold:true, color:WHITE });
  text('RATE',        ML+330,y+5, { size:8, bold:true, color:WHITE });
  text('AMOUNT',      MR-60, y+5, { size:8, bold:true, color:WHITE });
  y -= 22;

  const descStr = days > 1 ? `Dining — ${party} guests x ${days} days` : `Dining — ${party} guest${party===1?'':'s'}`;
  text(descStr,          ML+6,  y+5, { size:9 });
  text(String(party*days),ML+260,y+5,{ size:9 });
  text(`$${rate.toFixed(2)}`, ML+330, y+5, { size:9 });
  text(`$${total}`,      MR-60, y+5, { size:9 });
  hline(y-2, { color:LGRAY }); y -= 24;

  rect(ML+300, y-4, CW-300, 22, rgb(0.94,0.99,0.96));
  text('TOTAL AMOUNT DUE', ML+306, y+7, { size:9, bold:true, color:GREEN });
  text(`$${total}`,        MR-60,  y+7, { size:11, bold:true, color:GREEN });
  y -= 36;

  // Authorization
  rect(ML, y-6, CW, 20, rgb(0.94,0.99,0.96));
  text('AUTHORIZATION', ML+6, y+7, { size:8, bold:true, color:GREEN });
  y -= 6; hline(y, { color:GREEN, thick:0.8 }); y -= 14;
  text('By signing below, I authorize On Top of the Palms to charge the account listed above for the amount shown.', ML, y, { size:8.5, color:GRAY, maxWidth:CW });
  text('Payment is due within 30 days of dining. Unauthorized use of University accounts is a violation of USF policy.', ML, y-11, { size:8.5, color:GRAY, maxWidth:CW });
  y -= 36;

  field('Authorized Signature', '', ML,      y, 280);
  field('Date Signed',          '', ML+300,  y, 208);
  y -= 32;
  field('Printed Name',         '', ML,      y, 280);
  field('Title / Position',     '', ML+300,  y, 208);

  // Footer
  hline(72, { thick:0.5 });
  text(`On Top of the Palms · University of South Florida · ${PHONE}`, ML, 60, { size:8, color:GRAY });
  text(`Return completed form to: ${FORWARD_TO}`, ML, 49, { size:8, color:GRAY });
  text(`Ref: ${ref} · ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`, MR-160, 49, { size:8, color:GRAY });

  return Buffer.from(await pdfDoc.save());
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSignedFormPDF — completed form with billing fields + signature overlay
// ─────────────────────────────────────────────────────────────────────────────
async function buildSignedFormPDF(reservation, billing) {
  const rate  = await getRate();
  const { pdfDoc, page, GREEN, BLACK, GRAY, LGRAY, WHITE, W, H, ML, MR, CW, text, hline, rect, field } = await createBasePDF();
  const { rgb } = require('pdf-lib');

  const party = parseInt(reservation.party || 0);
  const days  = Math.max(1, parseInt(reservation.num_days || 1));
  const total = (party * days * rate).toFixed(2);
  const ref   = (reservation.id || '').slice(0, 8).toUpperCase();

  let resTime = reservation.reservation_time || '';
  if (!resTime || /^\d{4}$/.test(resTime.trim())) {
    const m = (reservation.datetime || '').match(/\d{1,2}:\d{2}\s*[AP]M/i);
    resTime = m ? m[0] : '';
  }

  let y = H - 52;

  page.drawRectangle({ x:0, y:H-72, width:W, height:72, color:GREEN });
  text('ON TOP OF THE PALMS',    ML, H-32, { size:18, bold:true, color:WHITE });
  text('USF Dining · Compass USA', ML, H-48, { size:10, color:rgb(0.65,0.85,0.76) });
  text('DIRECT BILL FORM — AUTHORIZED', MR-170, H-32, { size:8, color:WHITE });
  const refStr = `Ref: ${ref}`;
  text(refStr, MR-refStr.length*5.6, H-46, { size:9, color:rgb(0.65,0.85,0.76) });

  y = H - 92;

  // Restaurant info
  rect(ML, y-6, CW, 20, rgb(0.94,0.99,0.96));
  text(`Phone: ${PHONE}   Email: ${FROM}`, ML+6, y+7, { size:8, color:GREEN });
  y -= 28;

  // Reservation details
  rect(ML, y-6, CW, 20, rgb(0.94,0.99,0.96));
  text('RESERVATION DETAILS', ML+6, y+7, { size:8, bold:true, color:GREEN });
  y -= 6; hline(y, { color:GREEN, thick:0.8 }); y -= 20;

  field('Reservation Date', reservation.reservation_date || '—', ML,      y, 200);
  field('Reservation Time', resTime || '—',                       ML+220,  y, 140);
  field('Ref #',            ref,                                   ML+380,  y, 128);
  y -= 32;

  // Invoice to (filled)
  rect(ML, y-6, CW, 20, rgb(0.94,0.99,0.96));
  text('INVOICE TO', ML+6, y+7, { size:8, bold:true, color:GREEN });
  y -= 6; hline(y, { color:GREEN, thick:0.8 }); y -= 20;

  field('Attention of',    billing.attn_name  || reservation.name || '', ML,      y, 240);
  field('Department',      billing.department || reservation.department || '', ML+260, y, 248);
  y -= 32;
  field('Email',           billing.email      || reservation.email || '', ML,      y, 240);
  field('Phone',           billing.phone      || reservation.phone_ext || '', ML+260, y, 248);
  y -= 32;
  field('Dining Guest Name', billing.guest_name || reservation.name || '', ML, y, 300);
  y -= 40;

  // Billing (filled)
  rect(ML, y-6, CW, 20, rgb(0.94,0.99,0.96));
  text('BILLING', ML+6, y+7, { size:8, bold:true, color:GREEN });
  y -= 6; hline(y, { color:GREEN, thick:0.8 }); y -= 10;

  if (billing.billing_type === 'pcard') {
    text('Payment Method: P-Card', ML, y, { size:10, bold:true, color:BLACK });
    y -= 22;
  } else {
    field('In-Kind Account Name',   billing.inkind_account || '', ML,      y, 220);
    field('Approver Manager Email', billing.approver_email || '', ML+240,  y, 220);
    y -= 22;
    text('Approval Status: APPROVED', ML, y, { size:9, bold:true, color:GREEN });
    y -= 18;
  }
  y -= 16;

  // Amount
  rect(ML, y-6, CW, 20, rgb(0.94,0.99,0.96));
  text('AMOUNT DUE', ML+6, y+7, { size:8, bold:true, color:GREEN });
  y -= 6; hline(y, { color:GREEN, thick:0.8 }); y -= 22;

  rect(ML, y-2, CW, 18, rgb(0.25,0.25,0.27));
  text('DESCRIPTION', ML+6,  y+5, { size:8, bold:true, color:WHITE });
  text('QTY',         ML+260,y+5, { size:8, bold:true, color:WHITE });
  text('RATE',        ML+330,y+5, { size:8, bold:true, color:WHITE });
  text('AMOUNT',      MR-60, y+5, { size:8, bold:true, color:WHITE });
  y -= 22;

  const descStr = days > 1 ? `Dining — ${party} guests x ${days} days` : `Dining — ${party} guest${party===1?'':'s'}`;
  text(descStr,           ML+6,  y+5, { size:9 });
  text(String(party*days),ML+260,y+5, { size:9 });
  text(`$${rate.toFixed(2)}`,ML+330,y+5, { size:9 });
  text(`$${total}`,       MR-60, y+5, { size:9 });
  hline(y-2, { color:LGRAY }); y -= 24;

  rect(ML+300, y-4, CW-300, 22, rgb(0.94,0.99,0.96));
  text('TOTAL AMOUNT DUE', ML+306, y+7, { size:9, bold:true, color:GREEN });
  text(`$${total}`,        MR-60,  y+7, { size:11, bold:true, color:GREEN });
  y -= 36;

  // Signature section
  rect(ML, y-6, CW, 20, rgb(0.94,0.99,0.96));
  text('AUTHORIZATION', ML+6, y+7, { size:8, bold:true, color:GREEN });
  y -= 6; hline(y, { color:GREEN, thick:0.8 }); y -= 14;
  text('By signing below, I authorize On Top of the Palms to charge the account listed above for the amount shown.', ML, y, { size:8.5, color:GRAY, maxWidth:CW });
  y -= 36;

  const signDate = new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  field('Authorized Signature', '', ML, y, 280);
  field('Date Signed', signDate, ML+300, y, 208);
  y -= 32;
  field('Printed Name', reservation.name || '', ML, y, 280);
  field('Title / Position', '', ML+300, y, 208);

  if (billing.signature_png) {
    try {
      const b64 = billing.signature_png.replace(/^data:image\/png;base64,/, '');
      const pngImage = await pdfDoc.embedPng(Buffer.from(b64, 'base64'));
      const { width:iw, height:ih } = pngImage.scale(1);
      const maxW = 270, maxH = 28, scale = Math.min(maxW/iw, maxH/ih);
      page.drawImage(pngImage, { x:ML+2, y:y+2, width:iw*scale, height:ih*scale, opacity:0.92 });
    } catch(e) { console.error('[DirectBill] Sig embed failed:', e.message); }
  }

  y -= 24;
  const ts = new Date().toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });
  text(`Authorized: ${ts}`, ML, y, { size:8, color:rgb(0.4,0.4,0.4) });

  // Footer
  hline(72, { thick:0.5 });
  text(`On Top of the Palms · University of South Florida · ${PHONE}`, ML, 60, { size:8, color:GRAY });
  text(`Return to: ${FORWARD_TO}`, ML, 49, { size:8, color:GRAY });
  text(`Ref: ${ref} · Processed: ${signDate}`, MR-160, 49, { size:8, color:GRAY });

  return Buffer.from(await pdfDoc.save());
}

// ─────────────────────────────────────────────────────────────────────────────
// buildCompletedPDF — final PDF from web form submission + approval
// ─────────────────────────────────────────────────────────────────────────────
async function buildCompletedPDF(reservation, billing) {
  return buildSignedFormPDF(reservation, billing);
}

// ─────────────────────────────────────────────────────────────────────────────
// sendDirectBillForm — emails link to the web form to guest
// ─────────────────────────────────────────────────────────────────────────────
async function sendDirectBillForm(reservation) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log('[DirectBill] No SendGrid key — skipping email send');
    return { success:false, reason:'no_sendgrid' };
  }

  const rate    = await getRate();
  const ref     = reservation.id.slice(0,8).toUpperCase();
  const baseUrl = process.env.BASE_URL || 'https://staging.topofthepalmsusf-chartwells.com';
  const formUrl = `${baseUrl}/directbill/form/${makeUploadToken(reservation.id)}`;
  const amtDue  = (reservation.party * Math.max(1, parseInt(reservation.num_days||1)) * rate).toFixed(2);

  await sgMail.send({
    to:      reservation.email,
    from:    { email:FROM, name:NAME },
    replyTo: FORWARD_TO,
    subject: `Action Required: Direct Bill Authorization — Ref ${ref} | On Top of the Palms`,
    html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;padding:24px 16px">
<div style="max-width:580px;margin:0 auto">
  <div style="background:#006747;border-radius:10px 10px 0 0;padding:18px 24px">
    <p style="color:#a7d9c2;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin:0 0 2px">USF Dining · Compass USA</p>
    <h1 style="color:#fff;font-size:17px;font-weight:700;margin:0">On Top of the Palms</h1>
  </div>
  <div style="background:#fff;border-radius:0 0 10px 10px;padding:24px 28px;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="display:inline-block;background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">📋 Action Required — Direct Bill</div>
    <h2 style="color:#111827;font-size:18px;margin:0 0 12px">Hi ${reservation.name},</h2>
    <p style="color:#374151;font-size:14px;margin:0 0 14px">Thank you for your reservation. Please complete your <strong>Direct Bill Authorization Form</strong> using the link below.</p>
    <ol style="color:#374151;font-size:14px;line-height:1.9;padding-left:20px;margin:0 0 20px">
      <li>Click the button below to open your personalized form</li>
      <li>Fill in your billing details (In-Kind or P-Card)</li>
      <li>For In-Kind: your approver manager will receive an email to authorize</li>
      <li>Once complete, your authorization is recorded automatically</li>
    </ol>
    <div style="text-align:center;margin:24px 0">
      <a href="${formUrl}" style="display:inline-block;background:#006747;color:#fff;text-decoration:none;padding:15px 36px;border-radius:10px;font-size:16px;font-weight:700">📋 Complete Direct Bill Form</a>
      <p style="font-size:11px;color:#9ca3af;margin-top:10px">Secure personal link · Takes about 2 minutes</p>
    </div>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:0 0 18px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Ref</td><td style="font-weight:700;text-align:right;font-family:monospace;border-bottom:1px solid #f3f4f6">${ref}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Date &amp; Time</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.datetime}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Party</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.party} guests</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0">Amount Due</td><td style="font-weight:700;text-align:right;color:#006747">$${amtDue}</td></tr>
      </table>
    </div>
    <p style="font-size:12px;color:#9ca3af;margin:0">Questions? Call ${PHONE} or email <strong>${FORWARD_TO}</strong></p>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:11px;margin:12px 0 0">On Top of the Palms · USF Tampa Campus · ${PHONE}</p>
</div>
</div>`
  });

  console.log(`[DirectBill] Form link sent to ${reservation.email} (ref: ${ref})`);
  return { success:true };
}

// ─────────────────────────────────────────────────────────────────────────────
// sendInKindApprovalRequest — email to approver manager for In-Kind approval
// ─────────────────────────────────────────────────────────────────────────────
async function sendInKindApprovalRequest(reservation, billing, approvalToken) {
  if (!process.env.SENDGRID_API_KEY) return;

  const rate    = await getRate();
  const ref     = reservation.id.slice(0,8).toUpperCase();
  const baseUrl = process.env.BASE_URL || 'https://staging.topofthepalmsusf-chartwells.com';
  const approveUrl = `${baseUrl}/directbill/approve/${approvalToken}`;
  const amtDue  = (reservation.party * Math.max(1, parseInt(reservation.num_days||1)) * rate).toFixed(2);

  await sgMail.send({
    to:      billing.approver_email,
    from:    { email:FROM, name:NAME },
    replyTo: FORWARD_TO,
    subject: `Approval Required: Direct Bill In-Kind — ${reservation.name} (Ref ${ref})`,
    html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;padding:24px 16px">
<div style="max-width:560px;margin:0 auto">
  <div style="background:#006747;border-radius:10px 10px 0 0;padding:18px 24px">
    <p style="color:#a7d9c2;font-size:11px;font-weight:600;margin:0 0 2px;text-transform:uppercase">USF Dining · On Top of the Palms</p>
    <h1 style="color:#fff;font-size:17px;font-weight:700;margin:0">In-Kind Approval Required</h1>
  </div>
  <div style="background:#fff;border-radius:0 0 10px 10px;padding:24px 28px;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <p style="color:#374151;font-size:14px;margin:0 0 16px">You have been listed as the approving manager for the following dining reservation's In-Kind billing:</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 18px;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Guest Name</td><td style="font-weight:700;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.name}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Dining Date</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.datetime}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Party Size</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.party} guests</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">In-Kind Account</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${billing.inkind_account}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0">Total Amount</td><td style="font-weight:700;text-align:right;color:#006747">$${amtDue}</td></tr>
      </table>
    </div>
    <p style="color:#374151;font-size:14px;margin:0 0 20px">Please review and click the button below to <strong>approve this charge to your In-Kind account</strong>.</p>
    <div style="text-align:center;margin:20px 0">
      <a href="${approveUrl}" style="display:inline-block;background:#006747;color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:16px;font-weight:700">✓ Approve In-Kind Billing</a>
      <p style="font-size:11px;color:#9ca3af;margin-top:10px">This link is single-use and tied to this reservation</p>
    </div>
    <p style="font-size:12px;color:#9ca3af;margin:0">Questions? Contact On Top of the Palms: ${PHONE}</p>
  </div>
</div>
</div>`
  });

  console.log(`[DirectBill] In-Kind approval request sent to ${billing.approver_email} (ref: ${ref})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// notifyDocReceived — notify manager + guest when form is authorized
// ─────────────────────────────────────────────────────────────────────────────
async function notifyDocReceived(reservation) {
  if (!process.env.SENDGRID_API_KEY) return;
  const rate   = await getRate();
  const ref    = reservation.id.slice(0, 8).toUpperCase();
  const amtDue = (reservation.party * Math.max(1, parseInt(reservation.num_days||1)) * rate).toFixed(2);

  if (process.env.MANAGER_EMAIL) {
    await sgMail.send({
      to: process.env.MANAGER_EMAIL, from: { email:FROM, name:NAME },
      subject: `✓ Direct Bill authorized — ${reservation.name} (${ref})`,
      html: `<div style="font-family:sans-serif;padding:20px;max-width:480px">
        <h2 style="color:#006747">✓ Direct Bill Authorized</h2>
        <p>Authorization received for <strong>${reservation.name}</strong> (Ref: <code>${ref}</code>).</p>
        <table style="font-size:13px;border-collapse:collapse;width:100%;margin:12px 0">
          <tr><td style="color:#6b7280;padding:5px 0">Department</td><td>${reservation.department||'—'}</td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Dining date</td><td>${reservation.datetime}</td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Amount</td><td><strong>$${amtDue}</strong></td></tr>
        </table>
      </div>`
    }).catch(console.error);
  }

  await sgMail.send({
    to: reservation.email, from: { email:FROM, name:NAME },
    subject: `Direct Bill Authorized — Ref ${ref} | On Top of the Palms`,
    html: `<div style="font-family:sans-serif;background:#f3f4f6;padding:24px 16px"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
      <div style="display:inline-block;background:#dcfce7;color:#15803d;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">✓ Authorization Complete</div>
      <h2 style="color:#111827;font-size:17px;margin:0 0 10px">Thank you, ${reservation.name}!</h2>
      <p style="color:#374151;font-size:14px">Your Direct Bill authorization is complete. Your account will be billed <strong>$${amtDue}</strong>.</p>
      <p style="color:#6b7280;font-size:12px;margin-top:12px">Ref: <code>${ref}</code> · Questions? ${PHONE}</p>
    </div></div>`
  }).catch(console.error);
}

module.exports = { sendDirectBillForm, notifyDocReceived, buildFormPDF, buildSignedFormPDF, buildCompletedPDF, sendInKindApprovalRequest, makeUploadToken, makeApprovalToken, getRate };
