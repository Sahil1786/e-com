const config = require("../src/config");
const { AppError } = require("../src/middleware/error");

const BASE_URL = "https://apiv2.shiprocket.in/v1/external";
let cachedToken;
let tokenExpiresAt = 0;

function assertConfigured() {
  if (!config.shiprocket.email || !config.shiprocket.password || !config.shiprocket.warehousePincode) {
    throw new AppError("Shiprocket credentials and warehouse pincode must be configured", 503);
  }
}

async function getShiprocketToken() {
  assertConfigured();
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const response = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: config.shiprocket.email,
      password: config.shiprocket.password,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok || !data.token) {
    throw new AppError(data.message || "Shiprocket authentication failed", 502);
  }

  cachedToken = data.token;
  tokenExpiresAt = Date.now() + 9 * 24 * 60 * 60 * 1000;
  return cachedToken;
}

async function shiprocketRequest(path, token, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new AppError(data.message || "Shiprocket request failed", 502);
  }
  return data;
}

function calculatePackageMetrics(items) {
  let totalWeightGrams = 0;
  let lengthCm = 10;
  let breadthCm = 10;
  let heightCm = 0;

  for (const item of items) {
    const product = item.product || {};
    const quantity = item.quantity || 1;
    totalWeightGrams += (product.weightGrams || 500) * quantity;
    lengthCm = Math.max(lengthCm, product.lengthCm || 10);
    breadthCm = Math.max(breadthCm, product.breadthCm || 10);
    heightCm += (product.heightCm || 5) * quantity;
  }

  return {
    weightKg: Math.max(totalWeightGrams / 1000, 0.5),
    lengthCm,
    breadthCm,
    heightCm: Math.max(heightCm, 10),
  };
}

async function getShippingEstimate({
  deliveryPincode,
  weightKg,
  lengthCm = 10,
  breadthCm = 10,
  heightCm = 10,
  cod = 0,
}) {
  const token = await getShiprocketToken();
  const params = new URLSearchParams({
    pickup_postcode: config.shiprocket.warehousePincode,
    delivery_postcode: String(deliveryPincode),
    weight: String(Math.max(weightKg, 0.5)),
    length: String(lengthCm),
    breadth: String(breadthCm),
    height: String(heightCm),
    cod: String(cod),
  });
  const data = await shiprocketRequest(`/courier/serviceability/?${params}`, token);
  const couriers = data?.data?.available_courier_companies;
  if (!Array.isArray(couriers) || couriers.length === 0) {
    throw new AppError("Delivery is not serviceable at this pincode", 422);
  }

  couriers.sort((a, b) => Number(a.rate) - Number(b.rate));
  const recommended = couriers[0];
  const costPaise = Math.ceil(Number(recommended.rate) * 100);
  if (!Number.isSafeInteger(costPaise) || costPaise < 0) {
    throw new AppError("Shiprocket returned an invalid shipping price", 502);
  }

  return {
    serviceable: true,
    recommendedCourierId: recommended.courier_company_id,
    courierName: recommended.courier_name,
    estimatedCostPaise: costPaise,
    estimatedCostRupees: costPaise / 100,
    estimatedDeliveryDays: recommended.estimated_delivery_days,
    etd: recommended.etd,
  };
}

async function createAndAssignShipment(order, items, dimensions) {
  const token = await getShiprocketToken();
  const firstName = order.recipientName.trim().split(/\s+/)[0];
  const lastName = order.recipientName.trim().split(/\s+/).slice(1).join(" ") || ".";
  const subtotalPaise = order.totalAmountPaise - order.shippingChargePaise;
  const orderPayload = {
    order_id: order.id,
    order_date: new Date(order.createdAt).toISOString().slice(0, 16).replace("T", " "),
    pickup_location: config.shiprocket.pickupLocation,
    billing_customer_name: firstName,
    billing_last_name: lastName,
    billing_address: order.addressLine,
    billing_city: order.city,
    billing_pincode: order.pincode,
    billing_state: order.state,
    billing_country: "India",
    billing_email: order.user?.email || config.shiprocket.email,
    billing_phone: order.phone,
    shipping_is_billing: true,
    order_items: items.map((item) => ({
      name: item.productName,
      sku: item.productId,
      units: item.quantity,
      selling_price: Number((item.totalPaise / item.quantity / 100).toFixed(2)),
      hsn: Number(item.hsnCode) || 9983,
    })),
    payment_method: order.paymentMethod === "COD" ? "COD" : "Prepaid",
    sub_total: Number((subtotalPaise / 100).toFixed(2)),
    shipping_charges: Number((order.shippingChargePaise / 100).toFixed(2)),
    length: dimensions.lengthCm,
    breadth: dimensions.breadthCm,
    height: dimensions.heightCm,
    weight: dimensions.weightKg,
  };

  const created = await shiprocketRequest("/orders/create/adhoc", token, {
    method: "POST",
    body: JSON.stringify(orderPayload),
  });
  if (!created.shipment_id) {
    throw new AppError(created.message || "Shiprocket did not return a shipment ID", 502);
  }

  const assigned = await shiprocketRequest("/courier/assign/awb", token, {
    method: "POST",
    body: JSON.stringify({ shipment_id: created.shipment_id }),
  });
  const awb = assigned?.response?.data || {};
  if (!awb.awb_code) {
    throw new AppError(assigned.message || "Shiprocket did not assign an AWB", 502);
  }

  await shiprocketRequest("/courier/generate/pickup", token, {
    method: "POST",
    body: JSON.stringify({ shipment_id: [created.shipment_id] }),
  });

  return {
    shiprocketOrderId: String(created.order_id),
    shipmentId: String(created.shipment_id),
    awbCode: String(awb.awb_code),
    courierName: awb.courier_name || null,
    trackingUrl: `https://shiprocket.co/tracking/${encodeURIComponent(awb.awb_code)}`,
  };
}

async function trackByAwb(awbCode) {
  const token = await getShiprocketToken();
  return shiprocketRequest(`/courier/track/awb/${encodeURIComponent(awbCode)}`, token);
}

module.exports = {
  calculatePackageMetrics,
  getShippingEstimate,
  createAndAssignShipment,
  trackByAwb,
};
