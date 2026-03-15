const PDFDocument = require('pdfkit');
const { Readable } = require('stream');

// ─── Brand Colors ─────────────────────────────────────────────────────────────
const BRAND = {
  orange: '#E85D04',
  dark:   '#1A1A2E',
  mid:    '#2C3E50',
  gray:   '#666666',
  light:  '#F8F9FA',
  border: '#DDDDDD',
  white:  '#FFFFFF',
  green:  '#27AE60',
  red:    '#C0392B',
};

// ─── Helper: format currency ──────────────────────────────────────────────────
function formatNaira(amount) {
  return `₦${Number(amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

// ─── Helper: format date ──────────────────────────────────────────────────────
function formatDate(date) {
  return new Date(date).toLocaleDateString('en-NG', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

// ─── Helper: draw horizontal rule ────────────────────────────────────────────
function drawRule(doc, y, color = BRAND.border) {
  doc.strokeColor(color).lineWidth(0.5).moveTo(50, y).lineTo(545, y).stroke();
}

// ─── Helper: draw header band ─────────────────────────────────────────────────
function drawHeader(doc, title) {
  // Orange top bar
  doc.rect(0, 0, 595, 8).fill(BRAND.orange);

  // Logo area
  doc.rect(50, 25, 120, 40).fill(BRAND.orange);
  doc.fillColor(BRAND.white).font('Helvetica-Bold').fontSize(22).text('BOWA', 55, 33);
  doc.fillColor(BRAND.white).font('Helvetica').fontSize(11).text('GO', 100, 37);

  // Company info
  doc.fillColor(BRAND.gray).font('Helvetica').fontSize(8)
    .text('BowaGO Logistics Ltd', 200, 28)
    .text('support@bowago.com', 200, 40)
    .text('www.bowago.com', 200, 52);

  // Document title
  doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(20)
    .text(title, 350, 28, { align: 'right', width: 195 });

  drawRule(doc, 78, BRAND.orange);
  doc.y = 95;
}

// ─── Helper: draw footer ──────────────────────────────────────────────────────
function drawFooter(doc) {
  const bottom = doc.page.height - 50;
  drawRule(doc, bottom - 15, BRAND.border);
  doc.fillColor(BRAND.gray).font('Helvetica').fontSize(7)
    .text(
      'BowaGO Logistics Ltd  |  This document was generated automatically  |  support@bowago.com  |  www.bowago.com',
      50, bottom,
      { align: 'center', width: 495 }
    );
}

// ─── Helper: two-column row ───────────────────────────────────────────────────
function twoCol(doc, label, value, y, labelColor = BRAND.gray, valueColor = BRAND.dark) {
  doc.fillColor(labelColor).font('Helvetica').fontSize(9).text(label, 50, y);
  doc.fillColor(valueColor).font('Helvetica-Bold').fontSize(9).text(value, 300, y, { align: 'right', width: 245 });
}

// ─── Helper: info block ───────────────────────────────────────────────────────
function infoBlock(doc, title, lines, x, y, width = 230) {
  doc.fillColor(BRAND.orange).font('Helvetica-Bold').fontSize(8).text(title.toUpperCase(), x, y);
  let lineY = y + 14;
  for (const line of lines) {
    doc.fillColor(BRAND.dark).font('Helvetica').fontSize(9).text(line, x, lineY, { width });
    lineY += 13;
  }
  return lineY;
}

// ─── GENERATE INVOICE PDF ─────────────────────────────────────────────────────
async function generateInvoicePDF(data) {
  const {
    invoice,       // { number, date, dueDate }
    customer,      // { firstName, lastName, email, phone, address? }
    shipment,      // full shipment object
    payment,       // payment record
    surchargeBreakdown, // [{ label, amount }]
  } = data;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const buffers = [];

    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    drawHeader(doc, 'INVOICE');

    // ─── Invoice meta ────────────────────────────────────────────────────────
    const metaY = doc.y;
    doc.fillColor(BRAND.gray).font('Helvetica').fontSize(9)
      .text('Invoice Number', 50, metaY)
      .text('Invoice Date', 50, metaY + 14)
      .text('Status', 50, metaY + 28);

    const isPaid = payment?.status === 'PAID';
    const statusColor = isPaid ? BRAND.green : BRAND.orange;

    doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(9)
      .text(`INV-${invoice.number}`, 200, metaY)
      .text(formatDate(invoice.date), 200, metaY + 14);

    // Status badge
    doc.rect(195, metaY + 24, 60, 14).fill(isPaid ? '#E8F8F5' : '#FFF3E0');
    doc.fillColor(statusColor).font('Helvetica-Bold').fontSize(8)
      .text(isPaid ? 'PAID' : 'PENDING', 197, metaY + 27);

    // ─── Billed To / Ship To blocks ───────────────────────────────────────────
    doc.y = metaY + 60;
    drawRule(doc, doc.y - 5);
    doc.y += 5;

    const blockY = doc.y;
    infoBlock(doc, 'Billed To', [
      `${customer.firstName} ${customer.lastName}`,
      customer.email,
      customer.phone || '',
      customer.address || '',
    ], 50, blockY);

    infoBlock(doc, 'Ship From', [
      shipment.senderName,
      shipment.senderAddress,
      `${shipment.senderCity}, ${shipment.senderState}`,
      shipment.senderPhone,
    ], 300, blockY);

    doc.y = blockY + 75;
    drawRule(doc, doc.y);
    doc.y += 15;

    infoBlock(doc, 'Deliver To', [
      shipment.recipientName,
      shipment.recipientAddress,
      `${shipment.recipientCity}, ${shipment.recipientState}`,
      shipment.recipientPhone,
    ], 300, doc.y);

    doc.y += 65;
    drawRule(doc, doc.y);
    doc.y += 15;

    // ─── Line items table ─────────────────────────────────────────────────────
    const tableY = doc.y;
    doc.rect(50, tableY, 495, 20).fill(BRAND.dark);
    doc.fillColor(BRAND.white).font('Helvetica-Bold').fontSize(9)
      .text('DESCRIPTION', 58, tableY + 6)
      .text('DETAILS', 250, tableY + 6)
      .text('AMOUNT', 450, tableY + 6, { align: 'right', width: 90 });

    let rowY = tableY + 28;
    const rows = [
      {
        desc: `Shipping — ${shipment.senderCity} → ${shipment.recipientCity}`,
        detail: `Zone ${shipment.zone} | ${shipment.weight}kg | ${shipment.serviceType || 'STANDARD'}`,
        amount: shipment.quotedPrice,
      },
      ...(surchargeBreakdown || []).map((s) => ({
        desc: s.label,
        detail: s.description || '',
        amount: s.amount,
      })),
    ];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (i % 2 === 0) doc.rect(50, rowY - 4, 495, 18).fill('#F9F9F9');

      doc.fillColor(BRAND.dark).font('Helvetica').fontSize(9)
        .text(row.desc, 58, rowY, { width: 185 });
      doc.fillColor(BRAND.gray).fontSize(8)
        .text(row.detail, 250, rowY, { width: 190 });
      doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(9)
        .text(formatNaira(row.amount), 450, rowY, { align: 'right', width: 90 });

      rowY += 22;
    }

    doc.y = rowY + 10;
    drawRule(doc, doc.y);
    doc.y += 10;

    // ─── Totals ───────────────────────────────────────────────────────────────
    const subtotal = shipment.quotedPrice;
    const surchargeTotal = (surchargeBreakdown || []).reduce((sum, s) => sum + s.amount, 0);
    const total = subtotal + surchargeTotal;

    twoCol(doc, 'Subtotal', formatNaira(subtotal), doc.y);
    doc.y += 16;
    if (surchargeTotal > 0) {
      twoCol(doc, 'Total Surcharges', formatNaira(surchargeTotal), doc.y);
      doc.y += 16;
    }
    drawRule(doc, doc.y + 5, BRAND.orange);
    doc.y += 12;
    twoCol(doc, 'TOTAL', formatNaira(total), doc.y, BRAND.dark, BRAND.orange);
    doc.fillColor(BRAND.orange).font('Helvetica-Bold').fontSize(12);
    doc.y += 20;

    if (isPaid && payment?.paidAt) {
      doc.rect(50, doc.y, 495, 24).fill('#E8F8F5');
      doc.fillColor(BRAND.green).font('Helvetica-Bold').fontSize(10)
        .text(`✓  Payment received on ${formatDate(payment.paidAt)} via ${payment.channel || 'card'}`, 58, doc.y + 7);
      doc.y += 34;
    }

    // ─── Shipment reference box ───────────────────────────────────────────────
    doc.y += 10;
    doc.rect(50, doc.y, 495, 40).strokeColor(BRAND.border).lineWidth(0.5).stroke();
    doc.fillColor(BRAND.gray).font('Helvetica').fontSize(8)
      .text('Tracking Number', 60, doc.y + 8)
      .text('Payment Reference', 250, doc.y + 8);
    doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(10)
      .text(shipment.trackingNumber, 60, doc.y + 20)
      .text(payment?.reference || 'N/A', 250, doc.y + 20);

    drawFooter(doc);
    doc.end();
  });
}

// ─── GENERATE SHIPPING LABEL PDF ─────────────────────────────────────────────
async function generateShippingLabelPDF(shipment) {
  return new Promise((resolve, reject) => {
    // Smaller label format — 4×6 inches
    const doc = new PDFDocument({ size: [288, 432], margin: 15, bufferPages: true });
    const buffers = [];

    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // Header band
    doc.rect(0, 0, 288, 6).fill(BRAND.orange);

    // Logo
    doc.rect(15, 12, 70, 24).fill(BRAND.orange);
    doc.fillColor(BRAND.white).font('Helvetica-Bold').fontSize(14).text('BowaGO', 18, 17);

    // Service type badge
    const serviceColor = shipment.serviceType === 'EXPRESS' ? BRAND.red :
                         shipment.serviceType === 'ECONOMY' ? BRAND.gray : BRAND.orange;
    doc.rect(200, 12, 73, 24).fill(serviceColor);
    doc.fillColor(BRAND.white).font('Helvetica-Bold').fontSize(9)
      .text(shipment.serviceType || 'STANDARD', 202, 22, { align: 'center', width: 69 });

    // Tracking number — large and scannable
    drawRule(doc, 42, BRAND.border);
    doc.fillColor(BRAND.gray).font('Helvetica').fontSize(7).text('TRACKING NUMBER', 15, 48);
    doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(16).text(shipment.trackingNumber, 15, 58);
    drawRule(doc, 80, BRAND.border);

    // Zone badge
    doc.rect(220, 84, 53, 28).fill(BRAND.dark);
    doc.fillColor(BRAND.white).font('Helvetica').fontSize(7).text('ZONE', 222, 86);
    doc.fillColor(BRAND.orange).font('Helvetica-Bold').fontSize(18).text(`${shipment.zone}`, 225, 94);

    // FROM block
    doc.fillColor(BRAND.orange).font('Helvetica-Bold').fontSize(7).text('FROM', 15, 86);
    doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(10)
      .text(shipment.senderName, 15, 96, { width: 200 });
    doc.fillColor(BRAND.gray).font('Helvetica').fontSize(8)
      .text(shipment.senderAddress, 15, 108, { width: 200 })
      .text(`${shipment.senderCity}, ${shipment.senderState}`, 15, 120, { width: 200 });

    drawRule(doc, 135, BRAND.orange);

    // TO block — larger, more prominent
    doc.fillColor(BRAND.orange).font('Helvetica-Bold').fontSize(8).text('DELIVER TO', 15, 141);
    doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(13)
      .text(shipment.recipientName, 15, 153, { width: 258 });
    doc.fillColor(BRAND.dark).font('Helvetica').fontSize(9)
      .text(shipment.recipientAddress, 15, 170, { width: 258 })
      .text(`${shipment.recipientCity}, ${shipment.recipientState}`, 15, 183, { width: 258 });
    doc.fillColor(BRAND.gray).font('Helvetica').fontSize(8)
      .text(`Phone: ${shipment.recipientPhone}`, 15, 196);

    drawRule(doc, 212, BRAND.border);

    // Package info row
    const pkgY = 220;
    doc.fillColor(BRAND.gray).font('Helvetica').fontSize(7)
      .text('WEIGHT', 15, pkgY)
      .text('SERVICE', 90, pkgY)
      .text('DATE', 175, pkgY);
    doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(9)
      .text(`${shipment.weight}kg`, 15, pkgY + 10)
      .text(shipment.serviceType || 'STANDARD', 90, pkgY + 10)
      .text(formatDate(shipment.createdAt), 175, pkgY + 10);

    if (shipment.isFragile) {
      doc.rect(15, 240, 100, 14).fill('#FFF3E0');
      doc.fillColor(BRAND.orange).font('Helvetica-Bold').fontSize(7)
        .text('⚠  FRAGILE — HANDLE WITH CARE', 18, 244);
    }

    drawRule(doc, 262, BRAND.border);

    // Notes / special instructions
    if (shipment.notes) {
      doc.fillColor(BRAND.gray).font('Helvetica').fontSize(7).text('NOTES', 15, 267);
      doc.fillColor(BRAND.dark).font('Helvetica').fontSize(8)
        .text(shipment.notes, 15, 277, { width: 258 });
    }

    // Footer
    doc.rect(0, 420, 288, 6).fill(BRAND.orange);
    doc.fillColor(BRAND.gray).font('Helvetica').fontSize(6)
      .text('bowago.com  |  support@bowago.com', 0, 408, { align: 'center', width: 288 });

    doc.end();
  });
}

// ─── GENERATE BOOKING CONFIRMATION PDF ───────────────────────────────────────
async function generateBookingConfirmationPDF(data) {
  const { shipment, customer, quote } = data;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const buffers = [];

    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    drawHeader(doc, 'BOOKING CONFIRMATION');

    // Success banner
    doc.rect(50, doc.y, 495, 36).fill('#E8F8F5');
    doc.fillColor(BRAND.green).font('Helvetica-Bold').fontSize(13)
      .text('✓  Your shipment has been booked successfully!', 58, doc.y + 12);
    doc.y += 48;

    // Tracking number highlight
    doc.rect(50, doc.y, 495, 50).fill(BRAND.dark);
    doc.fillColor(BRAND.gray).font('Helvetica').fontSize(9)
      .text('TRACKING NUMBER', 60, doc.y + 10);
    doc.fillColor(BRAND.orange).font('Helvetica-Bold').fontSize(22)
      .text(shipment.trackingNumber, 60, doc.y + 22);
    doc.fillColor(BRAND.white).font('Helvetica').fontSize(9)
      .text(`Track at: bowago.com/track/${shipment.trackingNumber}`, 300, doc.y + 28);
    doc.y += 65;

    // Cut-off warning
    if (shipment.cutoffWarning) {
      doc.rect(50, doc.y, 495, 26).fill('#FFF3E0');
      doc.fillColor(BRAND.orange).font('Helvetica-Bold').fontSize(9)
        .text('⚠  Booked after 2:00 PM — earliest pickup is the next business day.', 58, doc.y + 9);
      doc.y += 36;
    }

    doc.y += 10;

    // Shipment details grid
    const detailsY = doc.y;
    doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(11).text('Shipment Details', 50, detailsY);
    doc.y += 18;
    drawRule(doc, doc.y);
    doc.y += 12;

    const details = [
      ['From', `${shipment.senderName} — ${shipment.senderCity}, ${shipment.senderState}`],
      ['To', `${shipment.recipientName} — ${shipment.recipientCity}, ${shipment.recipientState}`],
      ['Weight', `${shipment.weight}kg`],
      ['Service', shipment.serviceType || 'STANDARD'],
      ['Zone', `Zone ${shipment.zone} (${shipment.distanceKm ? Math.round(shipment.distanceKm) + 'km' : 'N/A'})`],
      ['Pickup Date', shipment.pickupDate ? formatDate(shipment.pickupDate) : 'To be scheduled'],
      ['Est. Delivery', shipment.estimatedDelivery ? formatDate(shipment.estimatedDelivery) : 'To be confirmed'],
    ];

    for (const [label, value] of details) {
      twoCol(doc, label, value, doc.y);
      doc.y += 16;
    }

    doc.y += 10;
    drawRule(doc, doc.y, BRAND.orange);
    doc.y += 12;

    // Pricing breakdown
    doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(11).text('Pricing Breakdown', 50, doc.y);
    doc.y += 18;

    twoCol(doc, 'Base Shipping Price', formatNaira(shipment.quotedPrice), doc.y);
    doc.y += 16;

    if (quote?.surchargeBreakdown?.length > 0) {
      for (const s of quote.surchargeBreakdown) {
        twoCol(doc, s.label, formatNaira(s.amount), doc.y);
        doc.y += 14;
      }
    }

    drawRule(doc, doc.y + 5, BRAND.orange);
    doc.y += 12;
    twoCol(doc, 'TOTAL QUOTED PRICE', formatNaira(shipment.quotedPrice), doc.y, BRAND.dark, BRAND.orange);
    doc.fillColor(BRAND.orange).font('Helvetica-Bold').fontSize(12);
    doc.y += 24;

    // Next steps box
    doc.rect(50, doc.y, 495, 70).strokeColor(BRAND.border).lineWidth(0.5).stroke();
    doc.fillColor(BRAND.orange).font('Helvetica-Bold').fontSize(9).text('NEXT STEPS', 60, doc.y + 10);
    doc.fillColor(BRAND.dark).font('Helvetica').fontSize(9)
      .text('1.  Complete payment to confirm your booking.', 60, doc.y + 24)
      .text('2.  Package your items securely. Visit bowago.com/packaging-guide for tips.', 60, doc.y + 38)
      .text('3.  Have your package ready at the pickup address on the scheduled date.', 60, doc.y + 52);

    drawFooter(doc);
    doc.end();
  });
}

module.exports = {
  generateInvoicePDF,
  generateShippingLabelPDF,
  generateBookingConfirmationPDF,
};
