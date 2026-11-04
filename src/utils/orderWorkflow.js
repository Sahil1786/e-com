const { AppError } = require("../middleware/error");

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

function invoiceNumberFor(orderId, date = new Date()) {
  return `INV-${date.getFullYear()}-${orderId.toUpperCase()}`;
}

async function reserveInventory(tx, items) {
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
  }
}

async function releaseInventory(tx, items) {
  for (const item of items) {
    const result = await tx.product.updateMany({
      where: { id: item.productId },
      data: { stock: { increment: item.quantity } },
    });
    if (result.count !== 1) {
      throw new AppError(`Unable to restore inventory for "${item.productName}"`, 500);
    }
  }
}

module.exports = {
  isObjectId,
  validateShippingAddress,
  invoiceNumberFor,
  reserveInventory,
  releaseInventory,
};
