const Razorpay = require("razorpay");
const config = require("../src/config");
const { AppError } = require("../src/middleware/error");

let client;

function getRazorpay() {
  if (!config.razorpay.keyId || !config.razorpay.keySecret) {
    throw new AppError("Razorpay credentials are not configured", 503);
  }
  if (!client) {
    client = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
  }
  return client;
}

module.exports = { getRazorpay };
