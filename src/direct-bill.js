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

const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM       = process.env.FROM_EMAIL || 'reservations@topofthepalms.usf.edu';
const NAME       = 'On Top of the Palms';
const PHONE      = process.env.RESTAURANT_PHONE || '(813) 974-3573';
const FORWARD_TO = process.env.DIRECT_BILL_EMAIL || process.env.MANAGER_EMAIL || 'topofthepalms@usf.edu';

// ─────────────────────────────────────────────────────────────────────────────
// buildFormPDF — generates the pre-filled Direct Bill authorization PDF
// Uses pdfkit (pure Node.js — no Python needed, works on Railway)
// TO UPDATE THE FORM: edit only this function
// ─────────────────────────────────────────────────────────────────────────────
function buildFormPDF(reservation) {
  return new Promise((resolve, reject) => {
    try {
      const PDFDocument = require('pdfkit');
      const chunks = [];
      const doc = new PDFDocument({ size:'LETTER', margins:{top:60,bottom:60,left:72,right:72} });
      doc.on('data', c => chunks.push(c));
      doc.on('end',  () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const party = parseInt(reservation.party || 0);
      const total = (party * 12.75).toFixed(2);
      const resDate = reservation.reservation_date || '';
      const resTime = reservation.reservation_time || '';

      // ── Logo / Title area ────────────────────────────────────────────────
      doc.fontSize(9).font('Helvetica').fillColor('#444')
         .text('USF Dining · Compass USA', { align:'center' });
      doc.moveDown(0.3);
      doc.fontSize(26).font('Helvetica-Bold').fillColor('#000')
         .text('DIRECT BILL FORM', { align:'center' });
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica').fillColor('#000')
         .text('Phone: (813) 974-3573', { align:'center' });
      doc.moveDown(0.15);
      doc.fontSize(11).text('Forward by e-mail only to: topofthepalms@usf.edu', { align:'center' });
      doc.moveDown(0.7);

      // ── Divider ──────────────────────────────────────────────────────────
      doc.moveTo(72, doc.y).lineTo(540, doc.y).lineWidth(1).strokeColor('#000').stroke();
      doc.moveDown(0.7);

      // ── Helper: labeled field with underline ─────────────────────────────
      const lineField = (label, value, x1=72, x2=540, skipMove=false) => {
        const y = doc.y;
        doc.font('Helvetica').fontSize(11).fillColor('#000').text(label, x1, y, {continued:false});
        const lw = doc.widthOfString(label) + 6;
        if(value) doc.font('Helvetica').fontSize(11).text(value, x1+lw, y, {continued:false});
        doc.moveTo(x1+lw, y+15).lineTo(x2, y+15).lineWidth(0.5).strokeColor('#000').stroke();
        if(!skipMove) doc.moveDown(0.9);
      };

      // ── Two-column row ───────────────────────────────────────────────────
      const twoField = (l1,v1,l2,v2) => {
        const y = doc.y;
        doc.font('Helvetica').fontSize(11).text(l1, 72, y, {continued:false});
        const lw1 = doc.widthOfString(l1)+6;
        if(v1) doc.text(v1, 72+lw1, y, {continued:false});
        doc.moveTo(72+lw1, y+15).lineTo(285, y+15).lineWidth(0.5).stroke();

        doc.font('Helvetica').fontSize(11).text(l2, 305, y, {continued:false});
        const lw2 = doc.widthOfString(l2)+6;
        if(v2) doc.text(v2, 305+lw2, y, {continued:false});
        doc.moveTo(305+lw2, y+15).lineTo(540, y+15).lineWidth(0.5).stroke();
        doc.moveDown(0.9);
      };

      // ── Pre-filled fields ────────────────────────────────────────────────
      twoField('Reservation Date:', resDate, 'Reservation Time:', resTime);
      lineField('Invoice to the Attention of:  ', reservation.name||'');
      lineField('Invoice to Department Name:  ', reservation.department||'');
      twoField('Email:  ', reservation.email||'', 'Phone #:  ', reservation.phone_ext||'');
      lineField('Dining Guest Name:  ', reservation.name||'');

      doc.moveDown(0.5);
      doc.moveTo(72, doc.y).lineTo(540, doc.y).lineWidth(1).strokeColor('#000').stroke();
      doc.moveDown(0.7);

      // ── BILLING section ──────────────────────────────────────────────────
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#000')
         .text('BILLING', { align:'center', underline:true });
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica-Bold')
         .text('A Chartfield number, Foundation Fund number, P-card or In-Kind approval is', { align:'center' })
         .text('required prior to your reservation.', { align:'center' });
      doc.moveDown(0.6);

      // ── Billing fields (blank for guest to fill) ─────────────────────────
      const billingField = (label) => {
        const y = doc.y;
        const lw = doc.widthOfString(label) + 6;
        doc.font('Helvetica-Bold').fontSize(11).text(label, 72, y, {continued:false});
        doc.moveTo(72+lw, y+15).lineTo(480, y+15).lineWidth(0.5).strokeColor('#000').stroke();
        doc.moveDown(0.9);
      };

      billingField('Chartfield #');
      billingField('Foundation #');
      billingField('In-Kind Account Name (if applicable)');

      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica-Oblique').fillColor('#000')
         .text('If paying with a P-card, please speak with the Supervisor for more information.');
      doc.moveDown(0.1);
      doc.text('If paying with In-Kind, the booking contact must be an authorized user of the In-Kind account.');
      doc.moveDown(0.7);

      // ── Pre-filled: guest count & total ──────────────────────────────────
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#000')
         .text(`Guest Count: ${party}     @     $12.75 Per Person`, { align:'center' });
      doc.moveDown(0.2);
      doc.text(`Total: $${total}`, { align:'center' });
      doc.moveDown(0.9);

      // ── Signature line ───────────────────────────────────────────────────
      const sigY = doc.y;
      doc.font('Helvetica').fontSize(11).text('Signature:  ', 72, sigY, {continued:false});
      const slw = doc.widthOfString('Signature:  ') + 6;
      doc.moveTo(72+slw, sigY+15).lineTo(540, sigY+15).lineWidth(0.5).stroke();

      doc.moveDown(2);
      doc.moveTo(72, doc.y).lineTo(540, doc.y).lineWidth(0.5).strokeColor('#888').stroke();
      doc.moveDown(0.3);
      doc.fontSize(8).font('Helvetica').fillColor('#888')
         .text('Revised Version 10/2025', { align:'center' });

      doc.end();
    } catch(err) { reject(err); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// sendDirectBillForm — sends pre-filled PDF to guest as email attachment
// ─────────────────────────────────────────────────────────────────────────────
async function sendDirectBillForm(reservation) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log('[DirectBill] No SendGrid key — skipping email send');
    return { success: false, reason: 'no_sendgrid' };
  }

  const ref = reservation.id.slice(0,8).toUpperCase();
  let pdfBuffer = null;

  try {
    pdfBuffer = await buildFormPDF(reservation);
    console.log(`[DirectBill] PDF generated: ${pdfBuffer.length} bytes`);
  } catch(pdfErr) {
    console.error('[DirectBill] PDF generation failed:', pdfErr.message);
    // Still send the email even without attachment
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
    subject:  `Direct Bill Authorization Form — Ref ${ref} | On Top of the Palms`,
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
    <p style="color:#374151;font-size:14px;margin:0 0 18px">The <strong>Direct Bill Authorization Form is attached to this email as a PDF.</strong> Please:</p>

    <ol style="color:#374151;font-size:14px;line-height:1.9;padding-left:20px;margin:0 0 20px">
      <li>Print the attached PDF form</li>
      <li>Fill in your Chartfield #, Foundation #, or In-Kind account details</li>
      <li>Sign the form</li>
      <li>Reply to this email with the completed form attached (scan or photo)</li>
    </ol>

    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:0 0 18px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Reservation Ref</td><td style="font-weight:700;text-align:right;font-family:monospace;border-bottom:1px solid #f3f4f6">${ref}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Date & Time</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.datetime}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Party Size</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.party} guest${reservation.party===1?'':'s'}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0">Amount Due</td><td style="font-weight:700;text-align:right;color:#006747">$${(reservation.party*12.75).toFixed(2)}</td></tr>
      </table>
    </div>

    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;margin-bottom:16px">
      <p style="font-size:13px;color:#b45309;margin:0">⚠️ Payment must be received within <strong>30 days of dining</strong>. Reply to this email with your completed and signed form.</p>
    </div>

    <p style="font-size:13px;color:#374151;margin:0 0 4px"><strong>Forward completed form to:</strong> ${FORWARD_TO}</p>
    <p style="font-size:13px;color:#374151;margin:0 0 16px"><strong>Phone:</strong> ${PHONE}</p>
    ${!pdfBuffer ? '<p style="font-size:12px;color:#b91c1c;background:#fef2f2;border-radius:6px;padding:8px 12px">⚠️ PDF attachment failed to generate — please contact us at '+PHONE+' for a copy of the form.</p>' : ''}
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:11px;margin:12px 0 0">On Top of the Palms · USF Tampa Campus · ${PHONE}</p>
</div>
</div>`
  });

  console.log(`[DirectBill] Email ${pdfBuffer?'with PDF':'WITHOUT PDF'} sent to ${reservation.email} (ref: ${ref})`);
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

module.exports = { sendDirectBillForm, notifyDocReceived, buildFormPDF };
