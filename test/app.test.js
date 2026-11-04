const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
process.env.ENABLE_RAZORPAY = "false";
process.env.ENABLE_SHIPROCKET = "false";
const { app } = require("../app");
const config = require("../src/config");
const { webhookRouter } = require("../src/controllers/payment");

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
