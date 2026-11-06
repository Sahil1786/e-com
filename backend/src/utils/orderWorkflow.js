const { AppError } = require("../middleware/error");
const config = require("../config");

const isObjectId = (value) => /^[0-9a-fA-F]{24}$/.test(String(value || ""));

function validateShippingAddress(address = {}) {
  const required = ["recipientName", "phone", "addressLine", "city", "state", "pincode"];
  for (const field of required) {
    if (typeof address[field] !== "string" || !address[field].trim()) {
      throw new AppError(`${field} is required`, 400);
    }
  }
  if (!/^[+\d\s()-]+$/.test(address.phone)) {
    throw new AppError("Phone number contains invalid characters", 400);
  }
  if (!/^[6-9]\d{9}$/.test(address.phone.replace(/\D/g, "").slice(-10))) {
    throw new AppError("A valid 10-digit Indian phone number is required", 400);
  }
  if (!/^[1-9]\d{5}$/.test(address.pincode.trim())) {
    throw new AppError("A valid 6-digit Indian pincode is required", 400);
  }
  for (const field of required) {
    if (address[field].trim().length > 200) {
      throw new AppError(`${field} is too long`, 400);
    }
  }
  if (address.buyerGstin !== undefined && address.buyerGstin !== null &&
      typeof address.buyerGstin !== "string") {
    throw new AppError("buyerGstin must be a string", 400);
  }
  const buyerGstin = address.buyerGstin?.trim().toUpperCase();
  if (buyerGstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(buyerGstin)) {
    throw new AppError("Invalid buyer GSTIN", 400);
  }
  return {
    recipientName: address.recipientName.trim(),
    phone: address.phone.replace(/\D/g, "").slice(-10),
    addressLine: address.addressLine.trim(),
    city: address.city.trim(),
    state: address.state.trim().toUpperCase(),
    pincode: address.pincode.trim(),
    buyerGstin: buyerGstin || null,
  };
}

function invoiceNumberFor(orderId, date = new Date(), orderNumber) {
  return `INV-${date.getFullYear()}-${(orderNumber || orderId).toUpperCase()}`;
}

function shippingChargeFor(summary, settings = config) {
  return summary.taxableAmountPaise < config.freeShippingThresholdPaise
    ? settings.shippingChargePaise
    : 0;
}

function calculateOrderTotalPaise(summary, shippingChargePaise, codChargePaise = 0) {
  const totalAmountPaise = summary.totalAmountPaise + shippingChargePaise + codChargePaise;
  if (!Number.isSafeInteger(totalAmountPaise) || totalAmountPaise < 100 ||
      totalAmountPaise > 2_147_483_647) {
    throw new AppError("Minimum order payable amount must be at least ₹1", 400);
  }
  return totalAmountPaise;
}

function uncollectedCodOrderWhere(orderId) {
  return {
    id: orderId,
    status: "DELIVERED",
    paymentMethod: "COD",
    OR: [{ paidAt: null }, { paidAt: { isSet: false } }],
  };
}

async function nextOrderNumber(tx) {
  const sequence = await tx.orderSequence.upsert({
    where: { id: "orders" },
    create: { id: "orders", value: 1 },
    update: { value: { increment: 1 } },
  });
  return `MM-${String(sequence.value).padStart(6, "0")}`;
}

async function recordOrderEvent(tx, {
  orderId,
  type,
  status,
  message,
  actor = "SYSTEM",
  amountPaise,
  paymentMethod,
  paymentInstrument,
}) {
  return tx.orderEvent.create({
    data: {
      orderId,
      type,
      status,
      message,
      actor,
      ...(amountPaise !== undefined ? { amountPaise } : {}),
      ...(paymentMethod ? { paymentMethod } : {}),
      ...(paymentInstrument ? { paymentInstrument } : {}),
    },
  });
}

function createOrderItemInputs(items) {
  return items.map(({ productId, hsnCode, ...item }) => ({
    ...item,
    hsnCode: hsnCode || "9983",
    product: { connect: { id: productId } },
  }));
}

async function recordInventoryMovement(tx, {
  productId,
  orderId,
  type,
  quantity,
  stockBefore,
  stockAfter,
  reference,
  note,
  actor = "SYSTEM",
}) {
  return tx.productInventoryMovement.create({
    data: {
      product: { connect: { id: productId } },
      ...(orderId ? { order: { connect: { id: orderId } } } : {}),
      type,
      quantity,
      stockBefore,
      stockAfter,
      ...(reference ? { reference } : {}),
      ...(note ? { note } : {}),
      actor,
    },
  });
}

async function setProductStock(tx, {
  productId,
  stock,
  actor,
  note,
  reference,
  increaseType = "MANUAL_IN",
  decreaseType = "MANUAL_OUT",
}) {
  const product = await tx.product.findUnique({ where: { id: productId } });
  if (!product) throw new AppError("Product not found", 404);
  const stockBefore = product.stock ?? product.quantity ?? 0;
  const change = stock - stockBefore;
  if (!Number.isSafeInteger(stock) || stock < 0 || stock > 2_147_483_647) {
    throw new AppError("Stock must be a non-negative whole number within the supported range", 400);
  }
  const where = product.stock === null || product.stock === undefined
    ? {
        id: product.id,
        quantity: stockBefore,
        OR: [{ stock: null }, { stock: { isSet: false } }],
      }
    : { id: product.id, stock: product.stock };
  const updated = await tx.product.updateMany({
    where,
    data: { stock },
  });
  if (updated.count !== 1) {
    throw new AppError("Stock changed while this update was being saved; refresh and retry", 409);
  }
  if (change !== 0) {
    await recordInventoryMovement(tx, {
      productId,
      type: change > 0 ? increaseType : decreaseType,
      quantity: Math.abs(change),
      stockBefore,
      stockAfter: stock,
      reference,
      note,
      actor,
    });
  }
  return tx.product.findUnique({ where: { id: productId } });
}

async function reserveInventory(tx, items, { orderId, actor = "SYSTEM" } = {}) {
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new AppError("Invalid item quantity in order", 400);
    }

    const product = await tx.product.findUnique({ where: { id: item.productId } });
    const availableStock = product?.stock ?? product?.quantity ?? 0;
    if (!product || product.isDeleted === true || availableStock < item.quantity) {
      throw new AppError(
        `Insufficient stock for "${item.productName}". Available: ${availableStock}`,
        409
      );
    }

    const where = product.stock === null || product.stock === undefined
      ? {
          id: product.id,
          quantity: { gte: item.quantity },
          OR: [{ stock: null }, { stock: { isSet: false } }],
        }
      : { id: product.id, stock: { gte: item.quantity } };
    const data = product.stock === null || product.stock === undefined
      ? { stock: availableStock - item.quantity }
      : { stock: { decrement: item.quantity } };
    const updated = await tx.product.updateMany({ where, data });

    if (updated.count !== 1) {
      throw new AppError(`Stock changed for "${item.productName}". Please retry checkout.`, 409);
    }
    await recordInventoryMovement(tx, {
      productId: product.id,
      orderId,
      type: "ORDER_OUT",
      quantity: item.quantity,
      stockBefore: availableStock,
      stockAfter: availableStock - item.quantity,
      reference: orderId,
      note: "Inventory reserved for confirmed order.",
      actor,
    });
  }
}

async function releaseInventory(tx, items, { orderId, actor = "SYSTEM" } = {}) {
  for (const item of items) {
    const product = await tx.product.findUnique({ where: { id: item.productId } });
    if (!product) throw new AppError(`Unable to restore inventory for "${item.productName}"`, 500);
    const stockBefore = product.stock ?? product.quantity ?? 0;
    const stockAfter = stockBefore + item.quantity;
    if (!Number.isSafeInteger(stockAfter) || stockAfter > 2_147_483_647) {
      throw new AppError(`Unable to restore inventory for "${item.productName}"`, 500);
    }
    const where = product.stock === null || product.stock === undefined
      ? {
          id: product.id,
          quantity: stockBefore,
          OR: [{ stock: null }, { stock: { isSet: false } }],
        }
      : { id: product.id, stock: product.stock };
    const result = await tx.product.updateMany({
      where,
      data: { stock: stockAfter },
    });
    if (result.count !== 1) {
      throw new AppError(`Unable to restore inventory for "${item.productName}"`, 500);
    }
    await recordInventoryMovement(tx, {
      productId: product.id,
      orderId,
      type: "CANCELLATION_RETURN",
      quantity: item.quantity,
      stockBefore,
      stockAfter,
      reference: orderId,
      note: "Reserved inventory returned after order cancellation.",
      actor,
    });
  }
}

module.exports = {
  isObjectId,
  validateShippingAddress,
  invoiceNumberFor,
  shippingChargeFor,
  calculateOrderTotalPaise,
  uncollectedCodOrderWhere,
  nextOrderNumber,
  recordOrderEvent,
  createOrderItemInputs,
  recordInventoryMovement,
  setProductStock,
  reserveInventory,
  releaseInventory,
};
