/**
 * FREAKSHOWTOPUP - ORDER PROCESSING & AUTO TOP-UP ENGINE (PRODUCTION GRADE)
 * Implements strict state machine, duplicate charge idempotency, atomic wallet deductions,
 * fail-safe auto-refunds, and referral commission lifecycle.
 */

const crypto = require('crypto');
const db = require('./db');
const { getProviderAdapter } = require('./providers');
const { getUserWallet } = require('./wallet');
const telegram = require('./telegram');
const { recordAuditLog } = require('./audit');

/**
 * Valid order state machine transitions
 */
const VALID_TRANSITIONS = {
  PENDING: ['PROCESSING', 'CANCELLED', 'FAILED'],
  PROCESSING: ['DONE', 'FAILED', 'REFUNDED'],
  DONE: ['REFUNDED'],
  FAILED: ['REFUNDED'],
  REFUNDED: [],
  CANCELLED: []
};

/**
 * Create top-up order with atomic balance deduction, authoritative pricing, and idempotency
 */
async function createOrder({
  userId,
  productId,
  playerData,
  quantity = 1,
  customAmount = null,
  idempotencyKey = null,
  ipAddress = '127.0.0.1'
}) {
  const user = db.users.find(u => u.id === userId);
  if (!user) throw new Error('USER_NOT_FOUND');

  // Idempotency: Check if an order with this key already exists
  const finalIdempotencyKey = idempotencyKey || `IDEM_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const existingOrder = db.orders.find(o => o.idempotencyKey === finalIdempotencyKey);
  if (existingOrder) {
    return { order: sanitizeOrderForCustomer(existingOrder), isDuplicate: true };
  }

  // 1. Authoritative Product & Pricing Resolution
  const product = db.products.find(p => p.id === productId && p.isActive);
  if (!product) throw new Error('PRODUCT_NOT_AVAILABLE');
  if (product.inStock === false) {
    throw new Error('This product is currently out of stock. / পণ্যটি বর্তমানে স্টকে নেই।');
  }

  let unitSellingPrice = Number(product.sellingPrice);
  let unitSupplierCost = Number(product.supplierCost || unitSellingPrice * 0.90);

  // Dynamic Product Calculation if applicable
  if (product.productType === 'DYNAMIC') {
    const customVal = parseFloat(customAmount);
    if (isNaN(customVal) || customVal < (product.minAmount || 10) || customVal > (product.maxAmount || 50000)) {
      throw new Error(`INVALID_CUSTOM_AMOUNT_${product.minAmount}_TO_${product.maxAmount}`);
    }
    unitSellingPrice = customVal;
    unitSupplierCost = Number((customVal * 0.90).toFixed(2));
  }

  const cleanQuantity = Math.max(1, parseInt(quantity, 10) || 1);
  const totalSellingPrice = Number((unitSellingPrice * cleanQuantity).toFixed(2));
  const totalSupplierCost = Number((unitSupplierCost * cleanQuantity).toFixed(2));
  const totalProfit = Number((totalSellingPrice - totalSupplierCost).toFixed(2));

  // 2. Validate Player Data (Numeric UID requirement)
  let parsedPlayerData = {};
  if (typeof playerData === 'object' && playerData !== null) {
    parsedPlayerData = playerData;
  } else if (typeof playerData === 'string') {
    try { parsedPlayerData = JSON.parse(playerData); } catch (e) { parsedPlayerData = { uid: playerData }; }
  }
  const isCodeDelivery = product.deliveryType === 'CODE Delivery' || product.productType === 'CODE DELIVERY';
  const isGmailDelivery = product.deliveryType === 'Gmail Delivery' || product.productType === 'GMAIL DELIVERY';
  
  let playerUid = String(parsedPlayerData.uid || parsedPlayerData.playerId || parsedPlayerData.email || parsedPlayerData.account || '').trim();
  if (isCodeDelivery && !playerUid) {
    playerUid = 'DIGITAL_PIN_DELIVERY';
  } else if (isGmailDelivery && !playerUid) {
    playerUid = user.email || 'CUSTOMER_GMAIL';
  }
  
  if (!playerUid && !isCodeDelivery) {
    throw new Error('PLAYER_UID_OR_ACCOUNT_REQUIRED');
  }

  // 3. Atomic Wallet Deduction & Order Creation
  const orderId = `FS${Math.floor(1000 + Math.random() * 9000)}`;

  return await db.transaction(async () => {
    const wallet = getUserWallet(userId);
    const prevBalance = Number(wallet.balance);

    if (prevBalance < totalSellingPrice) {
      throw new Error('INSUFFICIENT_WALLET_BALANCE');
    }

    // Deduct wallet balance atomically
    const newBalance = Number((prevBalance - totalSellingPrice).toFixed(2));
    wallet.balance = newBalance;
    wallet.updatedAt = new Date().toISOString();

    // Create Purchase Ledger Transaction
    const ledgerTx = {
      id: `tx_${crypto.randomBytes(8).toString('hex')}`,
      walletId: wallet.id,
      userId,
      type: 'PURCHASE',
      amount: -totalSellingPrice,
      previousBalance: prevBalance,
      newBalance,
      currency: wallet.currency,
      status: 'COMPLETED',
      referenceId: `ORD_PURCHASE_${orderId}`,
      description: `Purchase: ${product.name} (UID: ${playerUid})`,
      orderId,
      depositId: null,
      adminId: null,
      createdAt: new Date().toISOString()
    };
    db.transactions.unshift(ledgerTx);

    // Create Initial Order Record (State: PROCESSING)
    const orderRecord = {
      id: orderId,
      userId,
      userName: user.name,
      userEmail: user.email,
      productId: product.id,
      productName: product.name,
      categorySlug: product.categoryId,
      playerData: JSON.stringify(parsedPlayerData),
      playerUid,
      playerName: parsedPlayerData.name || null,
      quantity: cleanQuantity,
      sellingPrice: totalSellingPrice,
      supplierCost: totalSupplierCost,
      profit: totalProfit,
      currency: user.currency,
      status: 'PROCESSING',
      idempotencyKey: finalIdempotencyKey,
      providerId: product.providerId || 'prov-ucapi',
      providerOrderId: null,
      providerResponse: null,
      errorMessage: null,
      refunded: false,
      ipAddress,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.orders.unshift(orderRecord);

    // Send Telegram Order Alert
    try {
      telegram.sendOrderAlert(orderRecord);
    } catch (err) {
      console.warn('[TELEGRAM ORDER ALERT ERROR]', err.message);
    }

    // 4. Dispatch based on delivery type (UID Auto, CODE Delivery, Gmail Delivery)
    const isCodeDelivery = product.deliveryType === 'CODE Delivery' || product.productType === 'CODE DELIVERY';
    const isGmailDelivery = product.deliveryType === 'Gmail Delivery' || product.productType === 'GMAIL DELIVERY';
    
    if (isCodeDelivery) {
      // CODE Delivery: Call Supplier API to get real voucher PIN code
      try {
        await processProviderTopUp(orderRecord);
      } catch (err) {
        console.error('[VOUCHER DISPATCH ERROR]', err.message);
      }
    } else if (isGmailDelivery) {
      // Gmail Delivery: Customer drops Gmail, Admin manually completes + Telegram Bot sends alert
      orderRecord.status = 'PENDING';
      orderRecord.updatedAt = new Date().toISOString();
      db.saveAll();
    } else {
      // UID Auto: Instant automated supplier API dispatch
      try {
        await processProviderTopUp(orderRecord);
      } catch (err) {
        console.error('[PROVIDER DISPATCH ERROR]', err.message);
      }
    }

    return { order: sanitizeOrderForCustomer(orderRecord), isDuplicate: false };
  });
}

/**
 * Execute supplier top-up and update order state safely
 */
async function processProviderTopUp(order) {
  const activeProvider = db.providers.find(p => p.isActive && p.id === order.providerId) || 
                         db.providers.find(p => p.isActive) || 
                         db.providers[0];
  const adapter = getProviderAdapter(activeProvider);
  const product = db.products.find(p => p.id === order.productId) || {};

  try {
    const result = await adapter.createTopUp({
      orderId: order.id,
      productCode: product.command || product.providerCode || order.productId,
      productName: order.productName,
      playerData: order.playerData,
      quantity: order.quantity,
      idempotencyKey: order.idempotencyKey,
      categorySlug: order.categorySlug
    });

    if (result.success && result.status === 'SUCCESS') {
      order.status = 'DONE';
      order.providerOrderId = result.providerOrderId || order.providerOrderId;
      order.providerResponse = JSON.stringify(result.rawResponse || {});
      if (result.username) {
        order.playerName = result.username;
      }
      
      const isVoucherOrder = Boolean(
        order.deliveryType === 'CODE Delivery' ||
        order.playerUid === 'CODE_DELIVERY' ||
        order.playerUid === 'DIGITAL_PIN_DELIVERY' ||
        order.categorySlug === 'cat-vouchers' ||
        order.subcategoryId === 'sub-vouchers' ||
        order.subcategoryId === 'sub-ff-unipin' ||
        (order.productName && (order.productName.toLowerCase().includes('voucher') || order.productName.toLowerCase().includes('garena shell')))
      );

      if (isVoucherOrder && result.code) {
        order.codeDelivered = result.code;
        order.voucherCode = result.code;
      } else {
        delete order.codeDelivered;
        delete order.voucherCode;
      }
      order.updatedAt = new Date().toISOString();

      // Process Referral Commission for completed order
      await creditReferralCommission(order);
      db.saveAll();

      // Dispatch Telegram delivery DM to customer if linked
      try {
        telegram.notifyUserOrder(order);
      } catch (e) {}
      return;
    }

    if (result.status === 'PROCESSING') {
      order.status = 'PROCESSING';
      order.providerOrderId = result.providerOrderId || order.providerOrderId;
      order.providerResponse = JSON.stringify(result.rawResponse || {});
      order.updatedAt = new Date().toISOString();
      db.saveAll();
      return;
    }

    // Provider explicitly returned FAILED -> Trigger Auto Refund
    console.log(`[ORDER FAILED AT PROVIDER] Order ${order.id}: ${result.errorMessage || 'Provider failed'}`);
    order.status = 'FAILED';
    order.errorMessage = result.errorMessage || 'Provider execution failed';
    order.providerResponse = JSON.stringify(result.rawResponse || {});
    order.updatedAt = new Date().toISOString();
    
    await executeAutoRefund(order.id, result.errorMessage || 'Provider delivery failure');
  } catch (err) {
    console.error(`[PROVIDER EXCEPTION] Order ${order.id}:`, err.message);
    order.status = 'FAILED';
    order.errorMessage = err.message;
    order.updatedAt = new Date().toISOString();
    
    await executeAutoRefund(order.id, `Provider connection exception: ${err.message}`);
  }
}

/**
 * Execute automatic 100% wallet refund exactly once
 */
async function executeAutoRefund(orderId, reason = 'Automated refund on supplier failure') {
  return await db.transaction(async () => {
    const order = db.orders.find(o => o.id === orderId);
    if (!order) return null;
    if (order.refunded || order.status === 'REFUNDED') return order;

    const wallet = getUserWallet(order.userId);
    const prevBalance = Number(wallet.balance);
    const refundAmount = Number(order.sellingPrice);
    const newBalance = Number((prevBalance + refundAmount).toFixed(2));

    // Credit refund to wallet
    wallet.balance = newBalance;
    wallet.updatedAt = new Date().toISOString();

    // Mark order as refunded
    order.status = 'REFUNDED';
    order.refunded = true;
    order.updatedAt = new Date().toISOString();

    // Create Refund Ledger Transaction
    const ledgerTx = {
      id: `tx_${crypto.randomBytes(8).toString('hex')}`,
      walletId: wallet.id,
      userId: order.userId,
      type: 'REFUND',
      amount: refundAmount,
      previousBalance: prevBalance,
      newBalance,
      currency: wallet.currency,
      status: 'COMPLETED',
      referenceId: `ORD_REFUND_${order.id}`,
      description: `Auto-Refund for failed Order #${order.id} (${reason})`,
      orderId: order.id,
      depositId: null,
      adminId: 'system_auto_refund',
      createdAt: new Date().toISOString()
    };
    db.transactions.unshift(ledgerTx);

    // Revert referral commission if previously credited
    await reverseReferralCommission(order.id);

    // Send Telegram refund alert to admin and customer
    try {
      telegram.sendOrderRefundAlert(order, refundAmount, reason);
      telegram.notifyUserOrder(order);
    } catch (e) {}

    recordAuditLog({
      actorId: 'system',
      role: 'SYSTEM',
      action: 'ORDER_REFUNDED',
      targetId: order.id,
      targetType: 'ORDER',
      before: { status: 'FAILED' },
      after: { status: 'REFUNDED', refundedAmount: refundAmount },
      reason
    });

    return order;
  });
}

/**
 * Credit referral commission when an order reaches DONE status
 */
async function creditReferralCommission(order) {
  const user = db.users.find(u => u.id === order.userId);
  if (!user || !user.referredById) return;

  const referrer = db.users.find(u => u.id === user.referredById);
  if (!referrer) return;

  // Check if commission already generated for this order
  const existingComm = db.commissions.find(c => c.orderId === order.id);
  if (existingComm) return;

  const rate = db.settings.referralCommissionPercent || 2.5;
  const commissionAmount = Number(((Number(order.sellingPrice) * rate) / 100).toFixed(2));
  if (commissionAmount <= 0) return;

  const referrerWallet = getUserWallet(referrer.id);
  const prevBalance = Number(referrerWallet.balance);
  const newBalance = Number((prevBalance + commissionAmount).toFixed(2));

  referrerWallet.balance = newBalance;
  referrerWallet.updatedAt = new Date().toISOString();

  const commRecord = {
    id: `comm_${crypto.randomBytes(8).toString('hex')}`,
    referrerId: referrer.id,
    originUserId: user.id,
    orderId: order.id,
    amount: commissionAmount,
    currency: referrerWallet.currency,
    status: 'CREDITED',
    createdAt: new Date().toISOString()
  };
  db.commissions.unshift(commRecord);

  // Record referral transaction in wallet ledger
  db.transactions.unshift({
    id: `tx_${crypto.randomBytes(8).toString('hex')}`,
    walletId: referrerWallet.id,
    userId: referrer.id,
    type: 'REFERRAL_COMMISSION',
    amount: commissionAmount,
    previousBalance: prevBalance,
    newBalance,
    currency: referrerWallet.currency,
    status: 'COMPLETED',
    referenceId: `COMM_REF_${commRecord.id}`,
    description: `Referral Commission from ${user.name} (Order #${order.id})`,
    orderId: order.id,
    depositId: null,
    adminId: null,
    createdAt: new Date().toISOString()
  });
}

/**
 * Reverse referral commission safely if an order is refunded
 */
async function reverseReferralCommission(orderId) {
  const comm = db.commissions.find(c => c.orderId === orderId && c.status === 'CREDITED');
  if (!comm) return;

  const referrerWallet = getUserWallet(comm.referrerId);
  const prevBalance = Number(referrerWallet.balance);
  const revAmount = Number(comm.amount);
  const newBalance = Math.max(0, Number((prevBalance - revAmount).toFixed(2)));

  referrerWallet.balance = newBalance;
  referrerWallet.updatedAt = new Date().toISOString();
  comm.status = 'REVERSED';

  db.transactions.unshift({
    id: `tx_${crypto.randomBytes(8).toString('hex')}`,
    walletId: referrerWallet.id,
    userId: comm.referrerId,
    type: 'REFERRAL_COMMISSION',
    amount: -revAmount,
    previousBalance: prevBalance,
    newBalance,
    currency: referrerWallet.currency,
    status: 'REVERSED',
    referenceId: `COMM_REV_${comm.id}`,
    description: `Reversal of Referral Commission for Refunded Order #${orderId}`,
    orderId,
    depositId: null,
    adminId: null,
    createdAt: new Date().toISOString()
  });
}

/**
 * Extract delivered voucher or digital code from order or provider response
 */
function extractDeliveredCode(order) {
  if (!order) return null;

  // STRICT CHECK: Only extract voucher code if order is genuinely a CODE / Voucher delivery
  const isVoucherOrder = Boolean(
    order.deliveryType === 'CODE Delivery' ||
    order.playerUid === 'CODE_DELIVERY' ||
    order.playerUid === 'DIGITAL_PIN_DELIVERY' ||
    order.categorySlug === 'cat-vouchers' ||
    order.subcategoryId === 'sub-vouchers' ||
    order.subcategoryId === 'sub-ff-unipin' ||
    (order.productName && (order.productName.toLowerCase().includes('voucher') || order.productName.toLowerCase().includes('garena shell')))
  );

  if (!isVoucherOrder) {
    return null; // UID Auto Top-Ups should never expose internal redeemed bot voucher
  }

  if (order.codeDelivered) return order.codeDelivered;
  if (order.voucherCode) return order.voucherCode;
  if (order.deliveryCode) return order.deliveryCode;
  if (order.providerResponse) {
    try {
      const parsed = typeof order.providerResponse === 'string' ? JSON.parse(order.providerResponse) : order.providerResponse;
      if (parsed.uc_list && Array.isArray(parsed.uc_list) && parsed.uc_list.length > 0) {
        return parsed.uc_list.join('\n');
      }
      if (parsed.batch && Array.isArray(parsed.batch) && parsed.batch.length > 0) {
        return parsed.batch.map(b => b.uc || b.code || b.voucher || b.pin).filter(Boolean).join('\n');
      }
      if (parsed.vouchers && Array.isArray(parsed.vouchers) && parsed.vouchers.length > 0) {
        return parsed.vouchers.join('\n');
      }
      if (parsed.pins && Array.isArray(parsed.pins) && parsed.pins.length > 0) {
        return parsed.pins.join('\n');
      }
      if (parsed.cards && Array.isArray(parsed.cards) && parsed.cards.length > 0) {
        return parsed.cards.join('\n');
      }
      if (parsed.code) return parsed.code;
      if (parsed.uc) return parsed.uc;
      if (parsed.voucher) return parsed.voucher;
      if (parsed.pin) return parsed.pin;
    } catch (e) {}
  }
  return null;
}

/**
 * Sanitize order to ensure customers never see internal costs, profit, or supplier details,
 * while safely exposing delivered vouchers/PINs to the customer and preserving in-game player name.
 */
function sanitizeOrderForCustomer(order) {
  if (!order) return null;
  const { supplierCost, profit, providerId, providerResponse, ...safeOrder } = order;
  
  // Extract in-game player name if present in provider response
  if (!safeOrder.playerName && providerResponse) {
    try {
      const parsed = typeof providerResponse === 'string' ? JSON.parse(providerResponse) : providerResponse;
      safeOrder.playerName = parsed.username || (parsed.batch && parsed.batch[0] && parsed.batch[0].username) || parsed.player_name || null;
    } catch (e) {}
  }

  const code = extractDeliveredCode(order);
  if (code) {
    safeOrder.codeDelivered = code;
    safeOrder.voucherCode = code;
    safeOrder.code = code;
  } else {
    delete safeOrder.codeDelivered;
    delete safeOrder.voucherCode;
    delete safeOrder.code;
  }
  return safeOrder;
}

module.exports = {
  VALID_TRANSITIONS,
  createOrder,
  processProviderTopUp,
  executeAutoRefund,
  sanitizeOrderForCustomer,
  extractDeliveredCode
};
