const test = require("node:test");
const assert = require("node:assert/strict");
process.env.SHIPPING_CHARGE_PAISE = "9900";
process.env.COD_CHARGE_PAISE = "10000";
const { calculateCartAndTax } = require("../src/utils/gst");
const {
  validateShippingAddress,
  invoiceNumberFor,
  shippingChargeFor,
  calculateOrderTotalPaise,
  uncollectedCodOrderWhere,
  nextOrderNumber,
  createOrderItemInputs,
  setProductStock,
  reserveInventory,
  releaseInventory,
} = require("../src/utils/orderWorkflow");
const { AppError } = require("../src/middleware/error");
const { verifyOtp } = require("../src/utils/msg91");

const productA = {
  id: "64b000000000000000000001",
  name: "First",
  pricePaise: 1000,
  gstRate: 18,
  hsnCode: "9983",
};
const productB = {
  id: "64b000000000000000000002",
  name: "Second",
  pricePaise: 2000,
  gstRate: 5,
  hsnCode: "9983",
};

test("calculates GST for an intra-state order", () => {
  const result = calculateCartAndTax(
    [{ productId: productA.id, quantity: 1, product: productA }],
    null,
    require("../src/config").seller.state
  );

  assert.equal(result.totalAmountPaise, 1180);
  assert.equal(result.cgstPaise + result.sgstPaise, 180);
  assert.equal(result.igstPaise, 0);
});

test("allocates a product coupon only to eligible items", () => {
  const coupon = {
    isActive: true,
    type: "FLAT",
    value: 500,
    minOrderPaise: 0,
    maxDiscountPaise: null,
    usageLimit: null,
    usedCount: 0,
    productId: productA.id,
  };
  const result = calculateCartAndTax(
    [
      { productId: productA.id, quantity: 1, product: productA },
      { productId: productB.id, quantity: 1, product: productB },
    ],
    coupon,
    "OTHER"
  );

  assert.equal(result.discountPaise, 500);
  assert.equal(result.items[0].discountPaise, 500);
  assert.equal(result.items[1].discountPaise, 0);
});

test("applies NEW10 to the merchandise subtotal before GST and shipping", () => {
  const product = { ...productA, pricePaise: 10000 };
  const result = calculateCartAndTax(
    [{ productId: product.id, quantity: 1, product }],
    {
      isActive: true,
      type: "FLAT",
      value: 1000,
      minOrderPaise: 0,
      maxDiscountPaise: null,
      usageLimit: null,
      usedCount: 0,
      productId: null,
    }
  );

  assert.equal(result.subtotalPaise, 10000);
  assert.equal(result.discountPaise, 1000);
  assert.equal(result.taxableAmountPaise, 9000);
  assert.equal(result.totalGstPaise, 1620);
  assert.equal(result.totalAmountPaise + shippingChargeFor(result), 20520);
});

test("applies NEW20 to GST-inclusive product prices, recalculates GST, then shipping", () => {
  const result = calculateCartAndTax(
    [
      { productId: productA.id, quantity: 1, product: productA },
      { productId: productB.id, quantity: 1, product: productB },
    ],
    {
      isActive: true,
      type: "PERCENT",
      value: 20,
      minOrderPaise: 0,
      maxDiscountPaise: null,
      usageLimit: null,
      usedCount: 0,
      productId: null,
    },
    "OTHER"
  );

  assert.equal(result.subtotalPaise, 3000);
  assert.equal(result.discountPaise, 656);
  assert.equal(result.discountIncludesGst, true);
  assert.equal(result.items.reduce((sum, item) => sum + item.discountPaise, 0), 656);
  assert.equal(result.taxableAmountPaise, 2400);
  assert.equal(result.totalGstPaise, 224);
  assert.equal(shippingChargeFor(result), 9900);
  assert.equal(result.totalAmountPaise + shippingChargeFor(result), 12524);
});

test("requires a six-digit OTP before attempting verification", async () => {
  await assert.rejects(
    verifyOtp("9876543210", "12345"),
    (err) => err instanceof AppError && err.statusCode === 400
  );
});

test("validates Indian delivery address fields", () => {
  assert.deepEqual(
    validateShippingAddress({
      recipientName: "  Buyer  ",
      phone: "+91 9876543210",
      addressLine: "1 Main Road",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
    }),
    {
      recipientName: "Buyer",
      phone: "9876543210",
      addressLine: "1 Main Road",
      city: "Bengaluru",
      state: "KARNATAKA",
      pincode: "560001",
      buyerGstin: null,
    }
  );
  assert.throws(
    () => validateShippingAddress({ recipientName: "Buyer", pincode: "123" }),
    AppError
  );
});

test("uses a deterministic invoice number for an order", () => {
  assert.equal(invoiceNumberFor("64b000000000000000000001", new Date("2026-01-02")), "INV-2026-64B000000000000000000001");
  assert.equal(invoiceNumberFor("internal", new Date("2026-01-02"), "MM-000042"), "INV-2026-MM-000042");
});

test("applies the ₹99 delivery charge only below ₹999 after discount and before GST", () => {
  assert.equal(shippingChargeFor({ taxableAmountPaise: 99899 }), 9900);
  assert.equal(shippingChargeFor({ taxableAmountPaise: 99900 }), 0);
});

test("adds shipping and COD fees to the server-calculated payable total", () => {
  assert.equal(calculateOrderTotalPaise({ totalAmountPaise: 1180 }, 9900, 10000), 21080);
  assert.equal(calculateOrderTotalPaise({ totalAmountPaise: 1180 }, 9900, 0), 11080);
  assert.throws(
    () => calculateOrderTotalPaise({ totalAmountPaise: Number.MAX_SAFE_INTEGER }, 9900, 0),
    AppError
  );
});

test("matches uncollected COD orders with either null or absent paidAt fields", () => {
  assert.deepEqual(uncollectedCodOrderWhere(productA.id), {
    id: productA.id,
    status: "DELIVERED",
    paymentMethod: "COD",
    OR: [{ paidAt: null }, { paidAt: { isSet: false } }],
  });
});

test("hidden active coupons remain valid when redeemed manually", () => {
  const hiddenCoupon = {
    isActive: true,
    isVisible: false,
    type: "FLAT",
    value: 100,
    minOrderPaise: 0,
    maxDiscountPaise: null,
    usageLimit: null,
    usedCount: 0,
  };
  const result = calculateCartAndTax(
    [{ productId: productA.id, quantity: 1, product: productA }],
    hiddenCoupon
  );
  assert.equal(result.discountPaise, 100);
});

test("generates serial order numbers from an atomic database sequence", async () => {
  let query;
  const result = await nextOrderNumber({
    orderSequence: {
      upsert: async (value) => {
        query = value;
        return { value: 42 };
      },
    },
  });
  assert.equal(result, "MM-000042");
  assert.deepEqual(query.update, { value: { increment: 1 } });
});

test("connects nested order items to existing products and defaults missing HSN codes", () => {
  const [item] = createOrderItemInputs([{
    productId: productA.id,
    productName: productA.name,
    hsnCode: null,
    quantity: 2,
    unitPricePaise: 1000,
    gstRate: 18,
    discountPaise: 0,
    taxableValuePaise: 2000,
    cgstPaise: 180,
    sgstPaise: 180,
    igstPaise: 0,
    totalPaise: 2360,
  }]);

  assert.equal("productId" in item, false);
  assert.equal(item.hsnCode, "9983");
  assert.deepEqual(item.product, { connect: { id: productA.id } });
  assert.equal(item.productName, productA.name);
  assert.equal(item.quantity, 2);
});

test("reserves stock with an atomic conditional update", async () => {
  let where;
  let data;
  const tx = {
    product: {
      findUnique: async () => ({ ...productA, stock: 5, quantity: 8, isDeleted: false }),
      updateMany: async (query) => {
        where = query.where;
        data = query.data;
        return { count: 1 };
      },
    },
    productInventoryMovement: { create: async () => ({}) },
  };

  await reserveInventory(tx, [{ productId: productA.id, productName: "First", quantity: 2 }]);
  assert.deepEqual(where.stock, { gte: 2 });
  assert.deepEqual(data.stock, { decrement: 2 });
});

test("normalizes legacy quantity stock when reserving inventory", async () => {
  let where;
  let data;
  const tx = {
    product: {
      findUnique: async () => ({ ...productA, stock: null, quantity: 4, isDeleted: false }),
      updateMany: async (query) => {
        where = query.where;
        data = query.data;
        return { count: 1 };
      },
    },
    productInventoryMovement: { create: async () => ({}) },
  };

  await reserveInventory(tx, [{ productId: productA.id, productName: "First", quantity: 2 }]);
  assert.equal(where.quantity.gte, 2);
  assert.deepEqual(where.OR, [{ stock: null }, { stock: { isSet: false } }]);
  assert.equal(data.stock, 2);
});

test("restores reserved inventory on cancellation", async () => {
  let update;
  let movement;
  const tx = {
    product: {
      findUnique: async () => ({ ...productA, stock: 2, quantity: 2 }),
      updateMany: async (query) => {
        update = query;
        return { count: 1 };
      },
    },
    productInventoryMovement: {
      create: async (query) => {
        movement = query.data;
        return {};
      },
    },
  };
  await releaseInventory(tx, [
    { productId: productA.id, productName: "First", quantity: 3 },
  ], { orderId: "64b000000000000000000003", actor: "ADMIN" });
  assert.equal(update.data.stock, 5);
  assert.equal(movement.type, "CANCELLATION_RETURN");
  assert.equal(movement.stockBefore, 2);
  assert.equal(movement.stockAfter, 5);
  assert.equal(movement.actor, "ADMIN");
});

test("records an incoming inventory movement when setting stock", async () => {
  const movementEntries = [];
  const product = { ...productA, stock: 5 };
  const tx = {
    product: {
      findUnique: async () => product,
      updateMany: async () => ({ count: 1 }),
    },
    productInventoryMovement: {
      create: async ({ data }) => movementEntries.push(data),
    },
  };
  await setProductStock(tx, {
    productId: productA.id,
    stock: 8,
    actor: "admin-id",
    note: "Supplier delivery",
    reference: "INV-001",
    increaseType: "RESTOCK_IN",
  });
  assert.equal(movementEntries.length, 1);
  assert.equal(movementEntries[0].type, "RESTOCK_IN");
  assert.equal(movementEntries[0].quantity, 3);
  assert.equal(movementEntries[0].stockBefore, 5);
  assert.equal(movementEntries[0].stockAfter, 8);
  assert.equal(movementEntries[0].reference, "INV-001");
});

test("rejects checkout if stock changed before reservation", async () => {
  const tx = {
    product: {
      findUnique: async () => ({ ...productA, stock: 1, isDeleted: false }),
      updateMany: async () => ({ count: 0 }),
    },
  };
  await assert.rejects(
    reserveInventory(tx, [{ productId: productA.id, productName: "First", quantity: 2 }]),
    (err) => err instanceof AppError && err.statusCode === 409
  );
});
