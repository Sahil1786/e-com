const PDFDocument = require('pdfkit');
const config = require('../config');

const formatINR = (paise) => `Rs. ${(paise / 100).toFixed(2)}`;

function generateInvoicePdf(order, res) {
  const doc = new PDFDocument({ margin: 40, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename=Invoice-${order.invoiceNumber || order.id}.pdf`
  );
  doc.pipe(res);

  const isIntraState = order.igstPaise === 0;

  // Header
  doc.fontSize(18).text('TAX INVOICE', { align: 'center' }).moveDown(0.5);

  // Seller & Invoice Meta
  doc.fontSize(10).font('Helvetica-Bold').text('Sold By:');
  doc.font('Helvetica')
    .text(config.seller.name)
    .text(config.seller.address)
    .text(`GSTIN: ${config.seller.gstin}`)
    .text(`State: ${config.seller.state}`);

  doc.moveUp(4);
  doc.font('Helvetica-Bold').text(`Invoice No: ${order.invoiceNumber || 'N/A'}`, { align: 'right' });
  doc.font('Helvetica')
    .text(`Order ID: ${order.orderNumber || `#${order.id}`}`, { align: 'right' })
    .text(`Date: ${new Date(order.paidAt || order.createdAt).toLocaleDateString('en-IN')}`, { align: 'right' })
    .text(`Payment: ${order.paymentMethod || 'RAZORPAY'}`, { align: 'right' })
    .text(`Payment method: ${order.paymentInstrument || order.paymentMethod || 'RAZORPAY'}`, { align: 'right' })
    .text(`Status: ${order.status}`, { align: 'right' });
  if (order.paymentId) {
    doc.font('Helvetica').text(`Payment ID: ${order.paymentId}`, { align: 'right' });
  }
  if (order.paymentReference) {
    doc.font('Helvetica').text(`Payment reference: ${order.paymentReference}`, { align: 'right' });
  }

  doc.moveDown(1.5);

  // Buyer Details
  doc.font('Helvetica-Bold').text('Billing / Delivery Address:');
  doc.font('Helvetica')
    .text(order.recipientName)
    .text(`${order.addressLine}, ${order.city}`)
    .text(`${order.state} - ${order.pincode}`)
    .text(`Phone: ${order.phone}`);
  if (order.buyerGstin) {
    doc.text(`Buyer GSTIN: ${order.buyerGstin}`);
  }

  doc.moveDown(1.5);

  // Table Header
  const tableTop = doc.y;
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('Item', 40, tableTop, { width: 140 });
  doc.text('HSN', 185, tableTop, { width: 45 });
  doc.text('Qty', 235, tableTop, { width: 30 });
  doc.text('Taxable', 270, tableTop, { width: 70, align: 'right' });
  doc.text('GST %', 345, tableTop, { width: 40, align: 'right' });
  if (isIntraState) {
    doc.text('CGST+SGST', 390, tableTop, { width: 80, align: 'right' });
  } else {
    doc.text('IGST', 390, tableTop, { width: 80, align: 'right' });
  }
  doc.text('Total', 475, tableTop, { width: 80, align: 'right' });

  doc.moveTo(40, tableTop + 14).lineTo(555, tableTop + 14).stroke();

  // Table Rows
  let y = tableTop + 22;
  doc.font('Helvetica').fontSize(9);

  for (const item of order.items) {
    doc.text(item.productName, 40, y, { width: 140 });
    doc.text(item.hsnCode, 185, y, { width: 45 });
    doc.text(String(item.quantity), 235, y, { width: 30 });
    doc.text(formatINR(item.taxableValuePaise), 270, y, { width: 70, align: 'right' });
    doc.text(`${item.gstRate}%`, 345, y, { width: 40, align: 'right' });

    const taxText = isIntraState
      ? `${formatINR(item.cgstPaise + item.sgstPaise)}`
      : `${formatINR(item.igstPaise)}`;
    doc.text(taxText, 390, y, { width: 80, align: 'right' });
    doc.text(formatINR(item.totalPaise), 475, y, { width: 80, align: 'right' });

    y += 22;
  }

  doc.moveTo(40, y).lineTo(555, y).stroke();
  y += 10;

  // Summary Totals
  const renderSummaryLine = (label, value, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(label, 340, y, { width: 130, align: 'right' });
    doc.text(value, 475, y, { width: 80, align: 'right' });
    y += 16;
  };

  renderSummaryLine('Subtotal (Before Discount):', formatINR(order.subtotalPaise));
  if (order.discountPaise > 0) {
    renderSummaryLine(
      order.discountIncludesGst ? 'Discount (incl. GST):' : 'Discount:',
      `- ${formatINR(order.discountPaise)}`
    );
  }
  renderSummaryLine('Taxable Value:', formatINR(order.taxableAmountPaise));

  if (isIntraState) {
    renderSummaryLine('CGST:', formatINR(order.cgstPaise));
    renderSummaryLine('SGST:', formatINR(order.sgstPaise));
  } else {
    renderSummaryLine('IGST:', formatINR(order.igstPaise));
  }

  if (order.shippingChargePaise > 0) {
    renderSummaryLine('Shipping:', formatINR(order.shippingChargePaise));
  }
  if (order.codChargePaise > 0) {
    renderSummaryLine('Cash-on-delivery fee:', formatINR(order.codChargePaise));
  }
  renderSummaryLine('Grand Total:', formatINR(order.totalAmountPaise), true);

  if (order.refundedAmountPaise > 0) {
    y += 5;
    renderSummaryLine('Refunded Amount:', `- ${formatINR(order.refundedAmountPaise)}`, true);
    renderSummaryLine(
      'Net Paid:',
      formatINR(order.totalAmountPaise - order.refundedAmountPaise),
      true
    );
    if (order.refundReason) {
      doc.font('Helvetica-Oblique').text(`Refund Note: ${order.refundReason}`, 40, y);
    }
  }

  doc.end();
}

module.exports = { generateInvoicePdf };