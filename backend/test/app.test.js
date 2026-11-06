const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
process.env.ENABLE_RAZORPAY = "false";
process.env.ENABLE_SHIPROCKET = "false";
process.env.SHIPPING_CHARGE_PAISE = "9900";
process.env.COD_CHARGE_PAISE = "10000";
const { app } = require("../app");
const config = require("../src/config");
const { webhookRouter } = require("../src/controllers/payment");
const accountRoutes = require("../src/controllers/account");
const {
  getDateRange,
  summarizeCollections,
  summarizeAnalyticsEvents,
} = require("../src/utils/collectionReport");
const { renderEmailHtml } = require("../src/utils/email");
const { requireCustomer } = require("../src/middleware/auth");
const { assertSurfaceRole } = require("../src/controllers/login");
const { rateLimit } = require("express-rate-limit");
const { otpRateLimitKey } = require("../src/middleware/rateLimit");

async function listen(t, application = app) {
  const server = application.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("API application starts and serves its health endpoint", async (t) => {
  const baseUrl = await listen(t);
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
});

test("publishes payment availability without exposing provider secrets", async (t) => {
  const baseUrl = await listen(t);
  const response = await fetch(`${baseUrl}/v1/storefront/config`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.payments.cod, true);
  assert.equal(payload.payments.razorpay, false);
  assert.equal("keySecret" in payload.payments, false);
  assert.equal("razorpayKeyId" in payload.payments, true);
  assert.equal(payload.shippingChargePaise, 9900);
  assert.equal(payload.codChargePaise, 10000);
});

test("renders branded, escaped customer email HTML", () => {
  const html = renderEmailHtml("Order confirmed", [
    "Hello <script>alert(1)</script>,",
    "Your order is ready & on its way.",
    "Order: NM-2026-001",
    "Status: CONFIRMED",
    "Total: ₹1,234.50",
    "Delivering to: Main Road <script>, Kolkata",
    "Items: Moon charm × 2",
  ]);
  assert.match(html, /Naju&#39;s Magic Shop/);
  assert.match(html, /Order confirmed/);
  assert.match(html, /Your order is ready &amp; on its way\./);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /role="presentation"/);
  assert.match(html, /With a little magic/);
  assert.match(html, /NM-2026-001/);
  assert.match(html, /CONFIRMED/);
  assert.match(html, /Main Road &lt;script&gt;, Kolkata/);
  assert.match(html, /Moon charm × 2/);
});

test("requires a customer session to access saved delivery addresses", async (t) => {
  const baseUrl = await listen(t);
  const response = await fetch(`${baseUrl}/v1/user/addresses`);
  assert.equal(response.status, 401);
});

test("protects admin dashboard, store settings, and inventory routes", async (t) => {
  const baseUrl = await listen(t);
  const [dashboardResponse, analyticsResponse, customersResponse, settingsGetResponse, settingsPutResponse, movementsResponse, restockResponse, cancelResponse] = await Promise.all([
    fetch(`${baseUrl}/v1/admin/dashboard`),
    fetch(`${baseUrl}/v1/admin/analytics`),
    fetch(`${baseUrl}/v1/admin/customers`),
    fetch(`${baseUrl}/v1/admin/store-settings`),
    fetch(`${baseUrl}/v1/admin/store-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shippingChargePaise: 9900 }),
    }),
    fetch(`${baseUrl}/v1/admin/inventory/movements`),
    fetch(`${baseUrl}/v1/admin/products/64b000000000000000000001/restock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: 1 }),
    }),
    fetch(`${baseUrl}/v1/admin/orders/64b000000000000000000001/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  ]);
  assert.equal(dashboardResponse.status, 401);
  assert.equal(analyticsResponse.status, 401);
  assert.equal(customersResponse.status, 401);
  assert.equal(settingsGetResponse.status, 401);
  assert.equal(settingsPutResponse.status, 401);
  assert.equal(movementsResponse.status, 401);
  assert.equal(restockResponse.status, 401);
  assert.equal(cancelResponse.status, 401);
});

test("keeps admin and customer login surfaces role-specific", () => {
  assert.throws(
    () => assertSurfaceRole({ baseUrl: "/auth" }, { role: "ADMIN" }),
    /Admin accounts must sign in through the admin dashboard/
  );
  assert.throws(
    () => assertSurfaceRole({ baseUrl: "/admin" }, { role: "CUSTOMER" }),
    /Customer accounts must sign in through the shop/
  );
  assert.doesNotThrow(() => assertSurfaceRole({ baseUrl: "/admin" }, { role: "ADMIN" }));
  assert.doesNotThrow(() => assertSurfaceRole({ baseUrl: "/v1/admin" }, { role: "ADMIN" }));
  assert.doesNotThrow(() => assertSurfaceRole({ baseUrl: "/auth" }, { role: "CUSTOMER" }));
  assert.doesNotThrow(() => assertSurfaceRole({ baseUrl: "/v1/auth" }, { role: "CUSTOMER" }));
});

test("applies OTP request limits independently to each mobile number", async (t) => {
  assert.equal(otpRateLimitKey({ body: { mobile: "+91 81012 56761" }, ip: "127.0.0.1" }), "mobile:8101256761");
  const limitedApp = express();
  limitedApp.use(express.json());
  limitedApp.post(
    "/otp",
    rateLimit({
      windowMs: 60_000,
      limit: 1,
      keyGenerator: otpRateLimitKey,
      standardHeaders: false,
      legacyHeaders: false,
    }),
    (req, res) => res.sendStatus(204)
  );
  const baseUrl = await listen(t, limitedApp);
  const send = (mobile) => fetch(`${baseUrl}/otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mobile }),
  });

  assert.equal((await send("8101256761")).status, 204);
  assert.equal((await send("+91 81012 56761")).status, 429);
  assert.equal((await send("9876543210")).status, 204);
});

test("restricts customer APIs to customer accounts while preserving admin invoice access", () => {
  let error;
  requireCustomer(
    { user: { role: "ADMIN" }, method: "GET", path: "/cart" },
    {},
    (nextError) => { error = nextError; }
  );
  assert.equal(error.statusCode, 403);

  error = undefined;
  let nextCalled = false;
  requireCustomer(
    { user: { role: "ADMIN" }, method: "GET", path: "/orders/64b000000000000000000001/invoice" },
    {},
    (nextError) => { error = nextError; nextCalled = !nextError; }
  );
  assert.equal(error, undefined);
  assert.equal(nextCalled, true);
});

test("logout clears the session cookie", async (t) => {
  const baseUrl = await listen(t);
  const response = await fetch(`${baseUrl}/v1/auth/logout`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /token=;/);
  assert.match(response.headers.get("set-cookie"), /Expires=Thu, 01 Jan 1970/i);
});

test("parses saved address default state from the request body", () => {
  const address = accountRoutes.parseAddress({
    recipientName: "Sahil Hossain",
    phone: "8101256761",
    addressLine: "Main Road",
    city: "Kolkata",
    state: "West Bengal",
    pincode: "700001",
    isDefault: true,
  });
  assert.equal(address.isDefault, true);
  assert.equal(address.state, "WEST BENGAL");
});

test("builds date-wise online and COD collection totals in India time", () => {
  const report = summarizeCollections([
    {
      paymentMethod: "RAZORPAY",
      totalAmountPaise: 10000,
      refundedAmountPaise: 1000,
      totalGstPaise: 1800,
      paidAt: new Date("2026-11-04T20:00:00.000Z"),
      status: "PAID",
    },
    {
      paymentMethod: "COD",
      totalAmountPaise: 5000,
      refundedAmountPaise: 0,
      totalGstPaise: 900,
      paidAt: new Date("2026-11-04T21:00:00.000Z"),
      status: "DELIVERED",
    },
    {
      paymentMethod: "COD",
      totalAmountPaise: 9000,
      paidAt: null,
      status: "DELIVERED",
    },
    {
      paymentMethod: "RAZORPAY",
      paymentInstrument: "card",
      totalAmountPaise: 3000,
      refundedAmountPaise: 0,
      totalGstPaise: 450,
      paidAt: new Date("2026-11-04T22:00:00.000Z"),
      status: "PAID",
    },
    {
      paymentMethod: "RAZORPAY",
      paymentInstrument: "upi",
      totalAmountPaise: 2000,
      refundedAmountPaise: 0,
      totalGstPaise: 300,
      paidAt: new Date("2026-11-04T23:00:00.000Z"),
      status: "PAID",
    },
  ]);

  assert.equal(report.totals.totalCollectedPaise, 20000);
  assert.equal(report.totals.onlineCollectedPaise, 15000);
  assert.equal(report.totals.onlineCardCollectedPaise, 3000);
  assert.equal(report.totals.onlineUpiCollectedPaise, 2000);
  assert.equal(report.totals.otherOnlineCollectedPaise, 10000);
  assert.equal(report.totals.cashCollectedPaise, 5000);
  assert.equal(report.totals.totalRefundsPaise, 1000);
  assert.equal(report.salesByDate.length, 1);
  assert.equal(report.salesByDate[0].date, "2026-11-05");
  assert.equal(report.salesByDate[0].onlineCardCollectedPaise, 3000);
  assert.equal(report.salesByDate[0].onlineUpiCollectedPaise, 2000);
});

test("uses inclusive India-local report dates and rejects invalid dates", () => {
  const range = getDateRange({ from: "2026-11-01", to: "2026-11-04" });
  assert.equal(range.from.toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(range.toExclusive.toISOString(), "2026-11-04T18:30:00.000Z");
  assert.equal(getDateRange({ to: "2026-01-10" }).fromDate, "2025-12-12");
  assert.throws(() => getDateRange({ from: "2026-02-30", to: "2026-03-01" }), /valid date/);
  assert.throws(() => getDateRange({ from: "2026-11-05", to: "2026-11-04" }), /on or before/);
});

test("summarizes payment, refund and cancellation events by method, day, and order", () => {
  const report = summarizeAnalyticsEvents([
    {
      id: "payment-1",
      type: "PAYMENT_CONFIRMED",
      status: "PAID",
      message: "Razorpay upi payment captured",
      amountPaise: 10000,
      paymentMethod: "RAZORPAY",
      paymentInstrument: "upi",
      createdAt: new Date("2026-11-04T20:00:00.000Z"),
      order: { id: "order-id", orderNumber: "MM-000001", recipientName: "Buyer", paymentId: "pay_1" },
    },
    {
      id: "cash-1",
      type: "COD_COLLECTED",
      status: "DELIVERED",
      message: "Cash on delivery of ₹50.00 recorded as collected.",
      paymentMethod: "COD",
      createdAt: new Date("2026-11-04T21:00:00.000Z"),
      order: { totalAmountPaise: 5000 },
    },
    {
      id: "refund-1",
      type: "REFUND_INITIATED",
      status: "PAID",
      message: "Admin initiated a refund of ₹10.00",
      amountPaise: 1000,
      paymentMethod: "RAZORPAY",
      paymentInstrument: "upi",
      createdAt: new Date("2026-11-05T05:00:00.000Z"),
      order: { id: "order-id", orderNumber: "MM-000001", recipientName: "Buyer" },
    },
    {
      id: "cancel-1",
      type: "ORDER_CANCELLED",
      status: "CANCELLED",
      message: "Order cancelled",
      createdAt: new Date("2026-11-05T06:00:00.000Z"),
      order: { totalAmountPaise: 7000 },
    },
  ]);
  assert.equal(report.totals.grossCollectedPaise, 15000);
  assert.equal(report.totals.cashPaise, 5000);
  assert.equal(report.totals.upiPaise, 10000);
  assert.equal(report.totals.refundedPaise, 1000);
  assert.equal(report.totals.cancelledPaise, 7000);
  assert.equal(report.totals.netCollectedPaise, 14000);
  assert.equal(report.transactions[0].order.orderNumber, "MM-000001");
  assert.equal(report.daily.length, 1);
  assert.equal(report.daily[0].date, "2026-11-05");
});

test("requires a customer session to change cart item quantity", async (t) => {
  const baseUrl = await listen(t);
  const response = await fetch(`${baseUrl}/v1/user/cart/64b000000000000000000001`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity: 2 }),
  });
  assert.equal(response.status, 401);
});

test("keeps Razorpay and Shiprocket routes unavailable when integrations are disabled", async (t) => {
  const baseUrl = await listen(t);
  const [paymentResponse, paymentWebhookResponse, shiprocketResponse, estimateResponse] =
    await Promise.all([
      fetch(`${baseUrl}/v1/user/checkout/create-order`, { method: "POST" }),
      fetch(`${baseUrl}/v1/webhooks/razorpay`, { method: "POST" }),
      fetch(`${baseUrl}/v1/admin/orders/64b000000000000000000001/ship`, { method: "POST" }),
      fetch(`${baseUrl}/v1/user/shipping/estimate`, { method: "POST" }),
    ]);

  assert.equal(paymentResponse.status, 404);
  assert.equal(paymentWebhookResponse.status, 404);
  assert.equal(shiprocketResponse.status, 404);
  assert.equal(estimateResponse.status, 401);
});

test("validates Razorpay webhook signatures using the raw request body when mounted", async (t) => {
  const previousSecret = config.razorpay.webhookSecret;
  config.razorpay.webhookSecret = "test-webhook-secret";
  t.after(() => {
    config.razorpay.webhookSecret = previousSecret;
  });
  const webhookApp = express();
  webhookApp.use(express.json({
    verify: (req, res, body) => {
      req.rawBody = Buffer.from(body);
    },
  }));
  webhookApp.use("/v1/webhooks", webhookRouter);
  const baseUrl = await listen(t, webhookApp);
  const body = JSON.stringify({ event: "order.paid" });
  const signature = crypto
    .createHmac("sha256", config.razorpay.webhookSecret)
    .update(body)
    .digest("hex");
  const response = await fetch(`${baseUrl}/v1/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": signature,
    },
    body,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, ignored: true });
});
