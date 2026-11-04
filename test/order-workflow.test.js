const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateCartAndTax } = require("../src/utils/gst");
const {
  validateShippingAddress,
  invoiceNumberFor,
  reserveInventory,
  releaseInventory,
} = require("../src/utils/orderWorkflow");
const { AppError } = require("../src/middleware/error");

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
  };

  await reserveInventory(tx, [{ productId: productA.id, productName: "First", quantity: 2 }]);
  assert.equal(where.quantity.gte, 2);
  assert.deepEqual(where.OR, [{ stock: null }, { stock: { isSet: false } }]);
  assert.equal(data.stock, 2);
});

test("restores reserved inventory on cancellation", async () => {
  let update;
  const tx = {
    product: {
      updateMany: async (query) => {
        update = query;
        return { count: 1 };
      },
    },
  };
  await releaseInventory(tx, [
    { productId: productA.id, productName: "First", quantity: 3 },
  ]);
  assert.deepEqual(update.data.stock, { increment: 3 });
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
