const nodemailer = require("nodemailer");
const config = require("../config");
const prisma = require("../prisma");
const { getStoreSettings } = require("./storeSettings");

const isConfigured = Boolean(config.email.user && config.email.pass);
const transporter = isConfigured
  ? nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: { user: config.email.user, pass: config.email.pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    })
  : null;

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function renderEmailHtml(subject, lines, settings = getStoreSettings()) {
  const safeLines = Array.isArray(lines) ? lines.map((line) => String(line ?? "")) : [];
  const preheader = escapeHtml(safeLines[1] || subject);
  const brandName = settings.brandName || "Naju's Magic Shop";
  const escapedBrandName = escapeHtml(brandName);
  const logo = settings.logoUrl
    ? `<img src="${escapeHtml(settings.logoUrl)}" alt="" width="34" height="34" style="display:inline-block;width:34px;height:34px;border-radius:11px;object-fit:contain;vertical-align:middle;">`
    : `<span style="display:inline-block;width:34px;height:34px;border-radius:11px;background:#44315f;color:#f5d89a;text-align:center;line-height:34px;font-size:18px;">✦</span>`;
  const greeting = safeLines[0] || "";
  const details = [];
  const paragraphs = [];
  const detailLabels = new Set(["Order", "Status", "Total", "Delivering to", "Items", "Tracking"]);

  for (const line of safeLines.slice(1)) {
    const separator = line.indexOf(":");
    const label = separator > 0 ? line.slice(0, separator) : "";
    if (detailLabels.has(label)) {
      details.push({ label, value: line.slice(separator + 1).trim() });
    } else if (line) {
      paragraphs.push(line);
    }
  }

  const paragraphRows = paragraphs.map((paragraph) => `
    <tr>
      <td style="padding:0 0 14px;color:#514961;font-size:15px;line-height:1.75;">
        ${escapeHtml(paragraph)}
      </td>
    </tr>`).join("");
  const detailRows = details.map(({ label, value }) => `
    <tr>
      <td valign="top" style="padding:12px 14px;border-bottom:1px solid #eeeaf2;color:#746d80;font-size:12px;line-height:1.5;width:34%;">${escapeHtml(label)}</td>
      <td valign="top" style="padding:12px 14px;border-bottom:1px solid #eeeaf2;color:#302344;font-size:13px;font-weight:600;line-height:1.6;word-break:break-word;">${escapeHtml(value)}</td>
    </tr>`).join("");
  const detailCard = details.length ? `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px;border:1px solid #eae5f0;border-radius:12px;background:#fbfaff;">
                  ${detailRows}
                </table>` : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f2f7;font-family:Arial,Helvetica,sans-serif;color:#302344;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f2f7;padding:36px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">
            <tr>
              <td style="padding:0 0 16px 4px;">
                ${logo}
                <span style="padding-left:9px;color:#302344;font-size:17px;font-weight:700;letter-spacing:.1px;vertical-align:middle;">${escapedBrandName}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:0;background:#fff;border:1px solid #e8e3ec;border-radius:16px;box-shadow:0 8px 28px rgba(48,35,68,.06);">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr><td height="5" style="height:5px;border-radius:16px 16px 0 0;background:#b797d1;font-size:0;line-height:0;">&nbsp;</td></tr>
                  <tr>
                    <td style="padding:34px 38px 14px;">
                      <p style="margin:0 0 10px;color:#81669c;font-size:10px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;">A NOTE FROM THE SHOP</p>
                      <h1 style="margin:0;color:#302344;font-size:26px;line-height:1.3;font-weight:700;">${escapeHtml(subject)}</h1>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:8px 38px 30px;">
                      <p style="margin:0 0 16px;color:#302344;font-size:15px;font-weight:700;line-height:1.6;">${escapeHtml(greeting)}</p>
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                        ${paragraphRows}
                      </table>
                      ${detailCard}
                      <p style="margin:0;border-top:1px solid #eeeaf2;padding-top:20px;color:#746d80;font-size:13px;line-height:1.7;">
                        With a little magic,<br><strong style="color:#44315f;">${escapedBrandName}</strong>
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:18px 24px 0;color:#898393;font-size:11px;line-height:1.8;">
                You’re receiving this email because you have an account or order with ${escapedBrandName}.<br>
                For your security, never share your password or one-time sign-in code.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendCustomerEmail(to, subject, lines) {
  const settings = getStoreSettings();
  const brandName = settings.brandName || "Naju's Magic Shop";
  if (!to) {
    console.info(`[email] Skipping "${subject}": customer email address is not set`);
    return false;
  }
  if (!transporter) {
    console.warn(`[email] Skipping "${subject}": SMTP credentials are not configured`);
    return false;
  }
  const text = [brandName, "", ...lines, "", `With a little magic,\n${brandName}`].join("\n");
  const html = renderEmailHtml(subject, lines, settings);
  try {
    await transporter.sendMail({
      from: { name: brandName, address: config.email.user },
      to,
      subject,
      text,
      html,
    });
    console.info(`[email] Sent "${subject}"`);
    return true;
  } catch (error) {
    console.error(
      `[email] Could not send "${subject}": ${error.code || error.name || "SMTP error"}`
    );
    return false;
  }
}

async function notifyAccountCreated(user) {
  if (!user) return false;
  const brandName = getStoreSettings().brandName || "Naju's Magic Shop";
  return sendCustomerEmail(user?.email, `Welcome to ${brandName}`, [
    `Hello ${user.name},`,
    "Your account is ready. Sign in any time to see your bag, saved delivery addresses, and orders.",
    "Thank you for joining our little corner of curiosities.",
  ]);
}

async function notifyEmailUpdated(user) {
  const brandName = getStoreSettings().brandName || "Naju's Magic Shop";
  return sendCustomerEmail(user?.email, `Email saved · ${brandName}`, [
    `Hello ${user.name},`,
    "This email address is now saved for your account and future order updates.",
    "If you did not make this change, please contact the store.",
  ]);
}

const orderMessages = {
  PAYMENT_PENDING: ["Payment started", "Your order is waiting for online payment confirmation."],
  PAYMENT_REVIEW: ["Payment needs attention", "We are reviewing a payment issue and will contact you with an update."],
  CONFIRMED: ["Order confirmed", "Your order is confirmed and being prepared."],
  PAID: ["Payment confirmed", "We received your payment and confirmed your order."],
  CANCELLED: ["Order cancelled", "Your order has been cancelled. Any eligible refund will be processed to the original payment method."],
  SHIPPED: ["Your order is on its way", "Your order has been marked as shipped."],
  DELIVERED: ["Your order was delivered", "Your order has been marked as delivered. We hope you love it."],
  REFUNDED: ["Refund update", "A refund has been initiated for your order."],
};

async function notifyOrderStatus(orderId, eventType) {
  const message = orderMessages[eventType];
  if (!message) return;
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: { select: { name: true, email: true } },
        items: { select: { productName: true, quantity: true } },
      },
    });
    if (!order) {
      console.warn(`[email] Skipping order update "${eventType}": order was not found`);
      return false;
    }
    if (!order.user?.email) {
      console.info(`[email] Skipping order update "${eventType}": customer email address is not set`);
      return false;
    }
    await sendCustomerEmail(order.user.email, `${message[0]} · ${order.orderNumber || order.id}`, [
      `Hello ${order.user.name},`,
      message[1],
      `Order: ${order.orderNumber || order.id}`,
      `Status: ${order.status}`,
      `Total: ₹${(order.totalAmountPaise / 100).toFixed(2)}`,
      ...(order.paymentInstrument ? [`Payment method: ${order.paymentInstrument.toUpperCase()}`] : []),
      ...(order.paymentId ? [`Payment ID: ${order.paymentId}`] : []),
      ...(order.paymentReference ? [`Payment reference: ${order.paymentReference}`] : []),
      `Delivering to: ${order.recipientName}, ${order.addressLine}, ${order.city}, ${order.state} ${order.pincode}`,
      ...(order.items?.length
        ? [`Items: ${order.items.map((item) => `${item.productName} × ${item.quantity}`).join(", ")}`]
        : []),
      ...(order.trackingId ? [`Tracking: ${order.trackingId}`] : []),
    ]);
  } catch (error) {
    console.error(
      `[email] Could not prepare order update ${orderId}: ${error.code || error.name || "email error"}`
    );
  }
}

module.exports = {
  isConfigured,
  renderEmailHtml,
  sendCustomerEmail,
  notifyAccountCreated,
  notifyEmailUpdated,
  notifyOrderStatus,
};
