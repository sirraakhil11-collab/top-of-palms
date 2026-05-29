/**
 * Direct Bill Service — On Top of the Palms
 * ─────────────────────────────────────────
 * Lifecycle:
 *   pending_send  → reservation created w/ Direct Bill, form not sent yet
 *   sent          → manager (or auto) sent form to guest
 *   received      → guest returned signed form, stored in DB
 *
 * Triggers:
 *   1. Reservation submitted with Direct Bill → auto-send form
 *   2. Manager changes payment to Direct Bill → button sends form
 *   3. Guest sends back signed form → manager marks received → both notified
 *
 * Document storage:
 *   Received documents stored as base64 in PostgreSQL (documents table)
 *   Each document linked to reservation by reservation_id
 *   Future: swap storage to S3/Cloudinary by changing storeDocument() only
 *
 * To update the form in future:
 *   → Replace buildFormPDF() only. Everything else stays the same.
 */

const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM       = process.env.FROM_EMAIL || 'reservations@topofthepalms.usf.edu';
const NAME       = 'On Top of the Palms';
const PHONE      = process.env.RESTAURANT_PHONE || '(813) 974-3573';
const FORWARD_TO = process.env.DIRECT_BILL_EMAIL || process.env.MANAGER_EMAIL || 'topofthepalms@usf.edu';

// ── PDF generation ──────────────────────────────────────────────────────────
// Generates the pre-filled Direct Bill form as a PDF Buffer
// TO UPDATE FORM: only change this function
function buildFormPDF(reservation) {
  const { execSync } = require('child_process');
  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');

  const tmpIn  = path.join(os.tmpdir(), `db-form-${reservation.id||Date.now()}.py`);
  const tmpOut = path.join(os.tmpdir(), `db-form-${reservation.id||Date.now()}.pdf`);

  const party = parseInt(reservation.party || 0);
  const total = (party * 12.75).toFixed(2);
  const resDate = reservation.reservation_date || '';
  const resTime = reservation.reservation_time || '';

  const script = `
import sys
sys.path.insert(0, '/usr/lib/python3/dist-packages')
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER

buf_path = ${JSON.stringify(tmpOut)}

doc = SimpleDocTemplate(buf_path, pagesize=letter,
    leftMargin=1*inch, rightMargin=1*inch,
    topMargin=0.75*inch, bottomMargin=0.75*inch)

def S(name, font='Times-Roman', size=11, leading=16, align=None, bold=False, italic=False):
    f = ('Times-Bold' if bold else 'Times-Italic' if italic else font)
    s = ParagraphStyle(name, fontName=f, fontSize=size, leading=leading)
    if align: s.alignment = align
    return s

normal = S('n'); bold = S('b', bold=True); center = S('c', align=TA_CENTER)
title  = S('t', size=24, leading=30, align=TA_CENTER, bold=True)
sub    = S('s', align=TA_CENTER)
italic = S('i', italic=True, size=10, leading=14)
small  = S('sm', size=8, leading=12, align=TA_CENTER)

def line(label, val, lw=2.5*inch, vw=4.3*inch):
    pad = max(0, 50-len(val))
    t = Table([[Paragraph(label, normal), Paragraph(f'<u>{val}{" "*pad}</u>', normal)]],
              colWidths=[lw, vw])
    t.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),0)]))
    return t

story = []
story.append(Spacer(1, 0.1*inch))
story.append(Paragraph('DIRECT BILL FORM', title))
story.append(Spacer(1, 0.2*inch))
story.append(Paragraph('Phone: (813) 974-3573', sub))
story.append(Spacer(1, 0.05*inch))
story.append(Paragraph('Forward by e-mail only to: <font color="#0066CC">topofthepalms@usf.edu</font>', sub))
story.append(Spacer(1, 0.25*inch))
story.append(HRFlowable(width='100%', thickness=0.5, color=colors.black))
story.append(Spacer(1, 0.15*inch))

# Date/time row
rd, rt = ${JSON.stringify(resDate)}, ${JSON.stringify(resTime)}
t = Table([[Paragraph('Reservation Date:', normal), Paragraph(f'<u>{rd}{" "*max(0,25-len(rd))}</u>', normal),
            Paragraph('Reservation Time:', normal), Paragraph(f'<u>{rt}{" "*max(0,20-len(rt))}</u>', normal)]],
          colWidths=[1.5*inch,2*inch,1.5*inch,1.8*inch])
t.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(-1,-1),6)]))
story.append(t)
story.append(Spacer(1, 0.15*inch))

name  = ${JSON.stringify(reservation.name||'')}
dept  = ${JSON.stringify(reservation.department||'')}
email = ${JSON.stringify(reservation.email||'')}
phone = ${JSON.stringify(reservation.phone_ext||'')}
party = ${JSON.stringify(String(party))}
total = '${total}'

story.append(line('Invoice to the Attention of:', name))
story.append(Spacer(1, 0.1*inch))
story.append(line('Invoice to Department Name:', dept))
story.append(Spacer(1, 0.1*inch))
ep = Table([[Paragraph('Email:', normal), Paragraph(f'<u>{email}{" "*max(0,32-len(email))}</u>', normal),
             Paragraph('Phone #:', normal), Paragraph(f'<u>{phone}{" "*max(0,22-len(phone))}</u>', normal)]],
           colWidths=[0.7*inch,2.8*inch,0.9*inch,2.4*inch])
ep.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(-1,-1),8)]))
story.append(ep)
story.append(Spacer(1, 0.1*inch))
story.append(line('Dining Guest Name:', name, 1.8*inch, 5.0*inch))
story.append(Spacer(1, 0.2*inch))
story.append(HRFlowable(width='100%', thickness=0.5, color=colors.black))
story.append(Spacer(1, 0.15*inch))

story.append(Paragraph('<b><u>BILLING</u></b>', ParagraphStyle('bt', fontName='Times-Bold', fontSize=14, alignment=TA_CENTER)))
story.append(Spacer(1, 0.15*inch))
story.append(Paragraph('<b>A Chartfield number, Foundation Fund number, P-card or In-Kind approval is<br/>required prior to your reservation.</b>', ParagraphStyle('bs', fontName='Times-Bold', fontSize=11, alignment=TA_CENTER, leading=18)))
story.append(Spacer(1, 0.2*inch))

for label in ['Chartfield #', 'Foundation #', 'In-Kind Account Name (if applicable)']:
    t2 = Table([[Paragraph(f'<b>{label}</b>', bold), Paragraph(f'<u>{"_"*40}</u>', normal)]],
               colWidths=[3.2*inch, 3.6*inch])
    t2.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),0)]))
    story.append(t2); story.append(Spacer(1, 0.1*inch))

story.append(Spacer(1,0.05*inch))
story.append(Paragraph('<i>If paying with a P-card, please speak with the Supervisor for more information.</i>', italic))
story.append(Spacer(1,0.05*inch))
story.append(Paragraph('<i>If paying with In-Kind, the booking contact must be an authorized user of the In-Kind account.</i>', italic))
story.append(Spacer(1, 0.2*inch))
story.append(Paragraph(f'<b>Guest Count: {party} @ $12.75 Per Person</b>', ParagraphStyle('gc', fontName='Times-Bold', fontSize=12, alignment=TA_CENTER)))
story.append(Paragraph(f'<b>Total: \${total}</b>', ParagraphStyle('gt', fontName='Times-Bold', fontSize=12, alignment=TA_CENTER)))
story.append(Spacer(1, 0.3*inch))
sig = Table([[Paragraph('Signature:', normal), Paragraph(f'<u>{"_"*55}</u>', normal)]],
            colWidths=[1*inch, 5.8*inch])
sig.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),0)]))
story.append(sig)
story.append(Spacer(1, 0.3*inch))
story.append(HRFlowable(width='100%', thickness=0.5, color=colors.grey))
story.append(Spacer(1,0.05*inch))
story.append(Paragraph('Revised Version 10/2025', small))

doc.build(story)
print('ok')
`;

  try {
    fs.writeFileSync(tmpIn, script);
    execSync(`python3 ${tmpIn}`, { timeout: 15000 });
    const pdfBytes = fs.readFileSync(tmpOut);
    fs.unlinkSync(tmpIn);
    fs.unlinkSync(tmpOut);
    return pdfBytes;
  } catch(e) {
    console.error('[DirectBill] PDF generation error:', e.message);
    // Clean up temp files
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
    return null;
  }
}

// ── Send form to guest ──────────────────────────────────────────────────────
async function sendDirectBillForm(reservation) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log('[DirectBill] No SendGrid key — skipping');
    return { success: false, reason: 'no_sendgrid' };
  }

  const ref = reservation.id.slice(0,8).toUpperCase();
  const pdfBytes = buildFormPDF(reservation);

  const attachments = pdfBytes ? [{
    content:     pdfBytes.toString('base64'),
    filename:    `DirectBill_${ref}_${reservation.name.replace(/\s+/g,'_')}.pdf`,
    type:        'application/pdf',
    disposition: 'attachment'
  }] : [];

  await sgMail.send({
    to:      reservation.email,
    from:    { email: FROM, name: NAME },
    replyTo: FORWARD_TO,
    subject: `Direct Bill Authorization Form — Ref ${ref} | On Top of the Palms`,
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
    <p style="color:#374151;font-size:14px;margin:0 0 14px">Thank you for your reservation at <strong>On Top of the Palms</strong>. Since you selected <strong>Direct Bill</strong> as your payment method, please complete and return the attached authorization form.</p>

    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:0 0 18px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Reservation Ref</td><td style="font-weight:700;text-align:right;font-family:monospace;border-bottom:1px solid #f3f4f6">${ref}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Date & Time</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.datetime}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;border-bottom:1px solid #f3f4f6">Party Size</td><td style="font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${reservation.party} guest${reservation.party===1?'':'s'}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0">Amount Due</td><td style="font-weight:700;text-align:right;color:#006747">$${(reservation.party*12.75).toFixed(2)}</td></tr>
      </table>
    </div>

    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px;margin-bottom:18px">
      <p style="font-size:13px;font-weight:700;color:#b45309;margin:0 0 8px">📎 Complete the attached PDF form and reply to this email</p>
      <p style="font-size:13px;color:#374151;margin:0">Print, complete all required fields (Chartfield #, signature, etc.), and <strong>reply to this email</strong> with the signed form attached. You can also photograph the completed form and attach it.</p>
    </div>

    <p style="font-size:13px;color:#374151;margin:0 0 6px"><strong>Forward completed form to:</strong> ${FORWARD_TO}</p>
    <p style="font-size:13px;color:#374151;margin:0 0 16px"><strong>Phone:</strong> ${PHONE}</p>
    <p style="font-size:12px;color:#9ca3af;margin:0">Your reservation will be confirmed once your form is received. Payment is due within 30 days of dining.</p>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:11px;margin:12px 0 0">On Top of the Palms · USF Tampa Campus · ${PHONE}</p>
</div>
</div>`
  });

  console.log(`[DirectBill] Form + PDF sent to ${reservation.email} (ref: ${ref})`);
  return { success: true };
}

// ── Manager: mark doc as received ──────────────────────────────────────────
async function notifyDocReceived(reservation) {
  if (!process.env.SENDGRID_API_KEY) return;
  const ref = reservation.id.slice(0,8).toUpperCase();
  if (process.env.MANAGER_EMAIL) {
    await sgMail.send({
      to: process.env.MANAGER_EMAIL,
      from: { email: FROM, name: NAME },
      subject: `✓ Direct Bill doc received — ${reservation.name} (${ref})`,
      html: `<div style="font-family:sans-serif;padding:20px;max-width:480px">
        <h2 style="color:#006747">✓ Direct Bill Document Received</h2>
        <p style="font-size:14px">Signed form received for <strong>${reservation.name}</strong> (Ref: <code>${ref}</code>).</p>
        <table style="font-size:13px;border-collapse:collapse;width:100%;margin:12px 0">
          <tr><td style="color:#6b7280;padding:5px 0">Department</td><td>${reservation.department||'—'}</td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Dining date</td><td>${reservation.datetime}</td></tr>
          <tr><td style="color:#6b7280;padding:5px 0">Amount</td><td>$${(reservation.party*12.75).toFixed(2)}</td></tr>
        </table>
        <p style="font-size:13px;color:#6b7280">Payment due within 30 days. See the attached document in your email inbox.</p>
      </div>`
    });
  }
  // Confirm to guest
  await sgMail.send({
    to: reservation.email,
    from: { email: FROM, name: NAME },
    subject: `We received your Direct Bill form — Ref ${reservation.id.slice(0,8).toUpperCase()}`,
    html: `<div style="font-family:sans-serif;background:#f3f4f6;padding:24px 16px"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.08)">
      <div style="display:inline-block;background:#dcfce7;color:#15803d;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px">✓ Form Received</div>
      <h2 style="color:#111827;font-size:17px;margin:0 0 10px">Thank you, ${reservation.name}!</h2>
      <p style="color:#374151;font-size:14px">We have received your signed Direct Bill authorization form. Your account will be billed <strong>$${(reservation.party*12.75).toFixed(2)}</strong> within 30 days.</p>
      <p style="color:#6b7280;font-size:12px;margin-top:12px">Ref: <code>${ref}</code> · Questions? Call ${PHONE}</p>
    </div></div>`
  });
}

module.exports = { sendDirectBillForm, notifyDocReceived, buildFormPDF };
