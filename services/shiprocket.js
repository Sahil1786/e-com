// services/shiprocket.js
let cachedToken = null;
let tokenExpiresAt = 0;

const BASE_URL = "https://apiv2.shiprocket.in/v1/external";

// 1. Authenticate with Shiprocket (Token valid for 10 days, cached for 9 days)
async function getShiprocketToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.token) {
    throw new Error(data.message || "Shiprocket authentication failed");
  }

  cachedToken = data.token;
  tokenExpiresAt = Date.now() + 9 * 24 * 60 * 60 * 1000;
  return cachedToken;
}

// 2. Get Estimated Delivery Cost & ETA based on Pincodes, Weight & Dimensions
async function getShippingEstimate({
  pickupPincode = process.env.WAREHOUSE_PINCODE,
  deliveryPincode,
  weightKg,
  lengthCm = 10,
  breadthCm = 10,
  heightCm = 10,
  cod = 0, // 0 = Prepaid, 1 = COD
}) {
  const token = await getShiprocketToken();

  const params = new URLSearchParams({
    pickup_postcode: String(pickupPincode),
    delivery_postcode: String(deliveryPincode),
    weight: String(Math.max(weightKg, 0.5)), // Minimum 0.5kg
    length: String(lengthCm),
    breadth: String(breadthCm),
    height: String(heightCm),
    cod: String(cod),
  });

  const res = await fetch(`${BASE_URL}/courier/serviceability/?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await res.json();
  const couriers = data?.data?.available_courier_companies;

  if (!couriers || couriers.length === 0) {
    throw new Error("Delivery is not serviceable at this pincode");
  }

  // Sort couriers by cheapest shipping rate
  couriers.sort((a, b) => a.rate - b.rate);
  const bestCourier = couriers[0];

  return {
    serviceable: true,
    recommendedCourierId: bestCourier.courier_company_id,
    courierName: bestCourier.courier_name,
    estimatedCostRupees: Math.ceil(bestCourier.rate),
    estimatedCostPaise: Math.ceil(bestCourier.rate * 100),
    estimatedDeliveryDays: bestCourier.estimated_delivery_days,
    etd: bestCourier.etd, // Estimated Delivery Date string
    allCouriers: couriers.map((c) => ({
      courierId: c.courier_company_id,
      name: c.courier_name,
      rateRupees: Math.ceil(c.rate),
      etd: c.etd,
    })),
  };
}

// 3. Create Order in Shiprocket + Assign Courier (AWB) + Request Pickup
async function createAndAssignShipment(order, items, dimensions) {
  const token = await getShiprocketToken();

  const [firstName, ...restName] = order.recipientName.trim().split(" ");
  const lastName = restName.join(" ") || ".";

  const orderPayload = {
    order_id: order.id,
    order_date: new Date(order.createdAt).toISOString().slice(0, 16).replace("T", " "),
    pickup_location: process.env.WAREHOUSE_PICKUP_LOCATION || "Primary",
    billing_customer_name: firstName,
    billing_last_name: lastName,
    billing_address: order.addressLine,
    billing_city: order.city,
    billing_pincode: order.pincode,
    billing_state: order.state,
    billing_country: "India",
    billing_email: "customer@example.com",
    billing_phone: order.phone,
    shipping_is_billing: true,
    order_items: items.map((item) => ({
      name: item.productName,
      sku: item.productId,
      units: item.quantity,
      selling_price: Math.round(item.totalPaise / item.quantity / 100),
      hsn: Number(item.hsnCode) || 9983,
    })),
    payment_method: "Prepaid",
    sub_total: Math.round(order.totalAmountPaise / 100),
    length: dimensions.lengthCm,
    breadth: dimensions.breadthCm,
    height: dimensions.heightCm,
    weight: dimensions.weightKg,
  };

  // Step 3A: Create Order on Shiprocket
  const createRes = await fetch(`${BASE_URL}/orders/create/adhoc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(orderPayload),
  });

  const createData = await createRes.json();
  if (!createRes.ok || !createData.shipment_id) {
    throw new Error(createData.message || "Failed to create Shiprocket order");
  }

  // Step 3B: Assign AWB (Courier Tracking Number)
  const awbRes = await fetch(`${BASE_URL}/courier/assign/awb`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      shipment_id: createData.shipment_id,
    }),
  });

  const awbData = await awbRes.json();
  const awbInfo = awbData?.response?.data || {};

  // Step 3C: Schedule Courier Pickup
  await fetch(`${BASE_URL}/courier/generate/pickup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      shipment_id: [createData.shipment_id],
    }),
  });

  return {
    shiprocketOrderId: String(createData.order_id),
    shipmentId: String(createData.shipment_id),
    awbCode: awbInfo.awb_code || null,
    courierName: awbInfo.courier_name || null,
    trackingUrl: awbInfo.awb_code
      ? `https://shiprocket.co/tracking/${awbInfo.awb_code}`
      : null,
  };
}

// 4. Track Shipment by AWB Code
async function trackByAwb(awbCode) {
  const token = await getShiprocketToken();
  const res = await fetch(`${BASE_URL}/courier/track/awb/${awbCode}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

module.exports = {
  getShippingEstimate,
  createAndAssignShipment,
  trackByAwb,
};