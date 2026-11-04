const config = require('../config');
const { AppError } = require('../middleware/error');

function validateCoupon(coupon, cartItems, subtotalPaise) {
  if (!coupon || !coupon.isActive) throw new AppError('Invalid or inactive coupon', 400);
  if (coupon.expiresAt && new Date() > new Date(coupon.expiresAt)) {
    throw new AppError('Coupon has expired', 400);
  }
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    throw new AppError('Coupon usage limit reached', 400);
  }
  if (subtotalPaise < coupon.minOrderPaise) {
    throw new AppError(
      `Minimum order of ₹${(coupon.minOrderPaise / 100).toFixed(2)} required for this coupon`,
      400
    );
  }
  if (coupon.productId) {
    const hasProduct = cartItems.some((item) => item.productId === coupon.productId);
    if (!hasProduct) throw new AppError('Coupon is not applicable to items in your cart', 400);
  }
}

function calculateCartAndTax(cartItems, coupon = null, buyerState = config.seller.state) {
  const normalizedBuyerState = (buyerState || config.seller.state).trim().toUpperCase();
  const isIntraState = normalizedBuyerState === config.seller.state;

  const subtotalPaise = cartItems.reduce(
    (sum, item) => sum + item.product.pricePaise * item.quantity,
    0
  );

  let totalDiscountPaise = 0;
  if (coupon) {
    validateCoupon(coupon, cartItems, subtotalPaise);

    const eligibleSubtotal = coupon.productId
      ? cartItems
          .filter((i) => i.productId === coupon.productId)
          .reduce((s, i) => s + i.product.pricePaise * i.quantity, 0)
      : subtotalPaise;

    if (coupon.type === 'PERCENT') {
      totalDiscountPaise = Math.round((eligibleSubtotal * coupon.value) / 100);
    } else {
      totalDiscountPaise = Math.min(coupon.value, eligibleSubtotal);
    }

    if (coupon.maxDiscountPaise !== null) {
      totalDiscountPaise = Math.min(totalDiscountPaise, coupon.maxDiscountPaise);
    }
  }

  let remainingDiscount = totalDiscountPaise;
  const eligibleTotal = coupon?.productId
    ? cartItems
        .filter((i) => i.productId === coupon.productId)
        .reduce((s, i) => s + i.product.pricePaise * i.quantity, 0)
    : subtotalPaise;

  let totalTaxablePaise = 0;
  let totalCgstPaise = 0;
  let totalSgstPaise = 0;
  let totalIgstPaise = 0;

  const computedItems = cartItems.map((item, idx) => {
    const lineBase = item.product.pricePaise * item.quantity;
    let itemDiscount = 0;

    const isEligible = !coupon?.productId || coupon.productId === item.productId;
    if (totalDiscountPaise > 0 && isEligible && eligibleTotal > 0) {
      if (idx === cartItems.length - 1) {
        itemDiscount = Math.min(lineBase, remainingDiscount);
      } else {
        itemDiscount = Math.round((lineBase / eligibleTotal) * totalDiscountPaise);
        remainingDiscount -= itemDiscount;
      }
    }

    const taxableValuePaise = Math.max(0, lineBase - itemDiscount);
    const totalItemGst = Math.round((taxableValuePaise * item.product.gstRate) / 100);

    let cgstPaise = 0;
    let sgstPaise = 0;
    let igstPaise = 0;

    if (isIntraState) {
      cgstPaise = Math.floor(totalItemGst / 2);
      sgstPaise = totalItemGst - cgstPaise;
    } else {
      igstPaise = totalItemGst;
    }

    const totalPaise = taxableValuePaise + cgstPaise + sgstPaise + igstPaise;

    totalTaxablePaise += taxableValuePaise;
    totalCgstPaise += cgstPaise;
    totalSgstPaise += sgstPaise;
    totalIgstPaise += igstPaise;

    return {
      productId: item.product.id,
      productName: item.product.name,
      hsnCode: item.product.hsnCode,
      quantity: item.quantity,
      unitPricePaise: item.product.pricePaise,
      gstRate: item.product.gstRate,
      discountPaise: itemDiscount,
      taxableValuePaise,
      cgstPaise,
      sgstPaise,
      igstPaise,
      totalPaise,
    };
  });

  const totalGstPaise = totalCgstPaise + totalSgstPaise + totalIgstPaise;
  const totalAmountPaise = totalTaxablePaise + totalGstPaise;

  return {
    isIntraState,
    subtotalPaise,
    discountPaise: totalDiscountPaise,
    taxableAmountPaise: totalTaxablePaise,
    cgstPaise: totalCgstPaise,
    sgstPaise: totalSgstPaise,
    igstPaise: totalIgstPaise,
    totalGstPaise,
    totalAmountPaise,
    items: computedItems,
  };
}

module.exports = { calculateCartAndTax, validateCoupon };