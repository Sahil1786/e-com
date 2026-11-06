const express = require("express");
const prisma = require("../prisma");
const { authenticate } = require("../middleware/auth");
const { AppError } = require("../middleware/error");
const { isObjectId, validateShippingAddress } = require("../utils/orderWorkflow");
const { notifyEmailUpdated } = require("../utils/email");

const router = express.Router();
const addressSelect = {
  id: true,
  label: true,
  recipientName: true,
  phone: true,
  addressLine: true,
  city: true,
  state: true,
  pincode: true,
  buyerGstin: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
};

function parseAddress(body) {
  const address = validateShippingAddress(body);
  const label = typeof body.label === "string" ? body.label.trim() : "Home";
  if (!label || label.length > 40) throw new AppError("Address label must be 1–40 characters", 400);
  return {
    ...address,
    label,
    isDefault: body.isDefault === true,
  };
}

router.get("/addresses", authenticate, async (req, res, next) => {
  try {
    const addresses = await prisma.userAddress.findMany({
      where: { userId: req.user.id },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      select: addressSelect,
    });
    res.json({ success: true, addresses });
  } catch (error) {
    next(error);
  }
});

router.post("/addresses", authenticate, async (req, res, next) => {
  try {
    const data = parseAddress(req.body);
    const address = await prisma.$transaction(async (tx) => {
      const count = await tx.userAddress.count({ where: { userId: req.user.id } });
      if (count >= 10) throw new AppError("You can save up to 10 delivery addresses", 400);
      const makeDefault = data.isDefault === true || count === 0;
      if (makeDefault) {
        await tx.userAddress.updateMany({
          where: { userId: req.user.id, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.userAddress.create({
        data: { ...data, isDefault: makeDefault, userId: req.user.id },
        select: addressSelect,
      });
    });
    res.status(201).json({ success: true, address });
  } catch (error) {
    next(error);
  }
});

router.put("/addresses/:id", authenticate, async (req, res, next) => {
  try {
    if (!isObjectId(req.params.id)) throw new AppError("Invalid address ID", 400);
    const data = parseAddress(req.body);
    const current = await prisma.userAddress.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!current) throw new AppError("Address not found", 404);
    const address = await prisma.$transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx.userAddress.updateMany({
          where: { userId: req.user.id, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.userAddress.update({
        where: { id: current.id },
        data: { ...data, isDefault: data.isDefault === true || current.isDefault },
        select: addressSelect,
      });
    });
    res.json({ success: true, address });
  } catch (error) {
    next(error);
  }
});

router.patch("/addresses/:id/default", authenticate, async (req, res, next) => {
  try {
    if (!isObjectId(req.params.id)) throw new AppError("Invalid address ID", 400);
    const address = await prisma.$transaction(async (tx) => {
      const ownedAddress = await tx.userAddress.findFirst({
        where: { id: req.params.id, userId: req.user.id },
      });
      if (!ownedAddress) throw new AppError("Address not found", 404);
      await tx.userAddress.updateMany({
        where: { userId: req.user.id, isDefault: true },
        data: { isDefault: false },
      });
      return tx.userAddress.update({
        where: { id: ownedAddress.id },
        data: { isDefault: true },
        select: addressSelect,
      });
    });
    res.json({ success: true, address });
  } catch (error) {
    next(error);
  }
});

router.delete("/addresses/:id", authenticate, async (req, res, next) => {
  try {
    if (!isObjectId(req.params.id)) throw new AppError("Invalid address ID", 400);
    const address = await prisma.$transaction(async (tx) => {
      const existing = await tx.userAddress.findFirst({
        where: { id: req.params.id, userId: req.user.id },
      });
      if (!existing) throw new AppError("Address not found", 404);
      await tx.userAddress.delete({ where: { id: existing.id } });
      if (existing.isDefault) {
        const nextAddress = await tx.userAddress.findFirst({
          where: { userId: req.user.id },
          orderBy: { createdAt: "desc" },
        });
        if (nextAddress) {
          await tx.userAddress.update({
            where: { id: nextAddress.id },
            data: { isDefault: true },
          });
        }
      }
      return existing;
    });
    res.json({ success: true, addressId: address.id });
  } catch (error) {
    next(error);
  }
});

router.put("/profile/email", authenticate, async (req, res, next) => {
  try {
    const email = req.body.email == null ? null : String(req.body.email).trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError("A valid email address is required", 400);
    }
    if (email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing && existing.id !== req.user.id) throw new AppError("Email already registered", 409);
    }
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true },
    });
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { email },
      select: { id: true, name: true, mobile: true, email: true, role: true },
    });
    const emailNotificationSent = email && email !== currentUser?.email
      ? await notifyEmailUpdated(user)
      : null;
    res.json({ success: true, user, emailNotificationSent });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.parseAddress = parseAddress;
