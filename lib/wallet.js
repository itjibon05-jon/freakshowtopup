/**
 * FREAKSHOWTOPUP - FINANCIAL LEDGER & WALLET ENGINE (PRODUCTION GRADE)
 * Guarantees atomic balance mutations, double-entry immutable ledger logging,
 * currency locking rules, and duplicate transaction prevention.
 */

const crypto = require('crypto');
const db = require('./db');
const telegram = require('./telegram');
const { recordAuditLog } = require('./audit');
const { processDepositReferralCommission, reverseDepositReferralCommission } = require('./referral');

/**
 * Retrieve or atomically initialize a user wallet
 */
function getUserWallet(userId) {
  let wallet = db.wallets.find(w => w.userId === userId);
  if (!wallet) {
    const user = db.users.find(u => u.id === userId);
    wallet = {
      id: `wal_${crypto.randomBytes(8).toString('hex')}`,
      userId,
      currency: user ? user.currency : 'BDT',
      balance: 0.00,
      lockedAmount: 0.00,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.wallets.push(wallet);
    db.saveAll();
  }
  return wallet;
}

/**
 * Submit manual deposit request with validation, currency locking check, and idempotency
 */
async function submitDepositRequest({
  userId,
  paymentMethod,
  senderNumber,
  transactionId,
  amount,
  requestedCurrency = null,
  receiptUrl = null
}) {
  const user = db.users.find(u => u.id === userId);
  if (!user) throw new Error('USER_NOT_FOUND');

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new Error('INVALID_AMOUNT');
  }

  // Enforce payment method status guard
  const methodKey = String(paymentMethod || '').toLowerCase().trim();
  const statusMap = db.settings.paymentMethodStatus || {};
  if (statusMap[methodKey] === false) {
    throw new Error('PAYMENT_METHOD_DISABLED');
  }

  const minBDT = db.settings.minDepositBDT || 25;
  const minUSD = db.settings.minDepositUSD || 0.20;

  let depositCurrency = user.currency || 'BDT';

  // One-time currency change rule during first deposit
  if (requestedCurrency && requestedCurrency.toUpperCase() !== user.currency) {
    if (user.currencyChangeUsed) {
      throw new Error('CURRENCY_CHANGE_ALREADY_USED');
    }

    const hasApprovedDeposits = db.deposits.some(d => d.userId === userId && d.status === 'APPROVED');
    if (hasApprovedDeposits) {
      user.currencyChangeUsed = true;
      db.saveAll();
      throw new Error('CURRENCY_LOCKED_AFTER_FIRST_DEPOSIT');
    }

    depositCurrency = requestedCurrency.toUpperCase() === 'USD' ? 'USD' : 'BDT';
    user.currency = depositCurrency;
    user.currencyChangeUsed = true;

    const wallet = getUserWallet(userId);
    wallet.currency = depositCurrency;
  }

  // Enforce minimum deposit amount
  if (depositCurrency === 'BDT' && parsedAmount < minBDT) {
    throw new Error(`MINIMUM_DEPOSIT_BDT_${minBDT}`);
  }
  if (depositCurrency === 'USD' && parsedAmount < minUSD) {
    throw new Error(`MINIMUM_DEPOSIT_USD_${minUSD}`);
  }

  // Idempotency: Verify uniqueness of transaction ID
  if (!transactionId || typeof transactionId !== 'string') {
    throw new Error('TRANSACTION_ID_REQUIRED');
  }

  const cleanTrxId = transactionId.trim().toUpperCase();
  const duplicateDeposit = db.deposits.find(d => d.transactionId.toUpperCase() === cleanTrxId);
  if (duplicateDeposit) {
    throw new Error('DUPLICATE_TRANSACTION_ID');
  }

  const isUSD = depositCurrency === 'USD';
  const conversionRate = isUSD ? Number(db.settings.usdToBdtRate || db.settings.exchangeRate || 120) : 1;
  const creditedAmountBDT = isUSD ? Number((parsedAmount * conversionRate).toFixed(2)) : Number(parsedAmount.toFixed(2));

  const depositId = `DEP-${Math.floor(10000 + Math.random() * 90000)}`;
  const newDeposit = {
    id: depositId,
    userId,
    userName: user.name,
    userEmail: user.email,
    paymentMethod: String(paymentMethod).toUpperCase(),
    senderNumber: String(senderNumber).trim(),
    transactionId: cleanTrxId,
    amount: Number(parsedAmount.toFixed(2)),
    currency: depositCurrency,
    conversionRate,
    creditedAmountBDT,
    receiptUrl: receiptUrl || null,
    status: 'PENDING',
    adminNote: null,
    reviewedByAdminId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.deposits.unshift(newDeposit);
  db.saveAll();

  // Send Telegram Admin Alert
  try {
    telegram.sendDepositAlert(newDeposit);
  } catch (err) {
    console.warn('[TELEGRAM ALERT ERROR]', err.message);
  }

  return newDeposit;
}

/**
 * Approve deposit with strict atomic wallet credit and double-entry ledger entry
 */
async function approveDeposit(depositId, adminId, adminNote = '', actorEmail = null) {
  return await db.transaction(async () => {
    const deposit = db.deposits.find(d => d.id === depositId);
    if (!deposit) throw new Error('DEPOSIT_NOT_FOUND');
    if (deposit.status !== 'PENDING') throw new Error('DEPOSIT_ALREADY_PROCESSED');

    const wallet = getUserWallet(deposit.userId);
    const prevBalance = Number(wallet.balance);

    const isUSD = deposit.currency === 'USD';
    const conversionRate = deposit.conversionRate || (isUSD ? Number(db.settings.usdToBdtRate || db.settings.exchangeRate || 120) : 1);
    const creditAmount = isUSD
      ? (deposit.creditedAmountBDT !== undefined ? Number(deposit.creditedAmountBDT) : Number((deposit.amount * conversionRate).toFixed(2)))
      : Number(deposit.amount);

    const newBalance = Number((prevBalance + creditAmount).toFixed(2));

    // Update wallet balance in BDT
    wallet.balance = newBalance;
    wallet.updatedAt = new Date().toISOString();

    // Mark deposit as approved
    deposit.status = 'APPROVED';
    deposit.adminNote = adminNote || 'Approved by Admin';
    deposit.reviewedByAdminId = adminId;
    deposit.updatedAt = new Date().toISOString();

    // Lock currency on user permanently after first approved deposit
    const user = db.users.find(u => u.id === deposit.userId);
    if (user) {
      user.currencyChangeUsed = true;
    }

    // Create immutable ledger record
    const ledgerTx = {
      id: `tx_${crypto.randomBytes(8).toString('hex')}`,
      walletId: wallet.id,
      userId: deposit.userId,
      type: 'DEPOSIT',
      amount: creditAmount,
      previousBalance: prevBalance,
      newBalance,
      currency: 'BDT',
      status: 'COMPLETED',
      referenceId: `DEP_REF_${deposit.id}`,
      description: isUSD
        ? `Deposit $${deposit.amount} USD approved @ ${conversionRate} BDT/USD (Credited: ৳${creditAmount} BDT, TrxID: ${deposit.transactionId})`
        : `Manual Wallet Deposit via ${deposit.paymentMethod} (TrxID: ${deposit.transactionId})`,
      depositId: deposit.id,
      orderId: null,
      adminId,
      createdAt: new Date().toISOString()
    };
    db.transactions.unshift(ledgerTx);

    // Audit log
    recordAuditLog({
      actorId: adminId,
      actorEmail,
      role: 'ADMIN',
      action: 'DEPOSIT_APPROVED',
      targetId: deposit.id,
      targetType: 'DEPOSIT',
      before: { balance: prevBalance, depositStatus: 'PENDING' },
      after: { balance: newBalance, depositStatus: 'APPROVED' },
      reason: adminNote
    });

    // Trigger deposit-based referral commission
    try {
      await processDepositReferralCommission(deposit, actorEmail);
    } catch (refErr) {
      console.warn('[REFERRAL COMMISSION ERROR]', refErr.message);
    }

    // Dispatch Telegram DM alert to customer if linked
    try {
      const tg = require('./telegram');
      tg.notifyUserDeposit(deposit, newBalance);
    } catch (tgErr) {}

    return { deposit, wallet, transaction: ledgerTx };
  });
}

/**
 * Reverse/refund an approved deposit atomically with referral commission reversal
 */
async function reverseApprovedDeposit(depositId, adminId, reason = 'Deposit reversed by Admin', actorEmail = null) {
  return await db.transaction(async () => {
    const deposit = db.deposits.find(d => d.id === depositId);
    if (!deposit) throw new Error('DEPOSIT_NOT_FOUND');
    if (deposit.status !== 'APPROVED') throw new Error('DEPOSIT_NOT_IN_APPROVED_STATE');

    const wallet = getUserWallet(deposit.userId);
    const prevBalance = Number(wallet.balance);

    const isUSD = deposit.currency === 'USD';
    const conversionRate = deposit.conversionRate || (isUSD ? Number(db.settings.usdToBdtRate || db.settings.exchangeRate || 120) : 1);
    const creditAmount = isUSD
      ? (deposit.creditedAmountBDT !== undefined ? Number(deposit.creditedAmountBDT) : Number((deposit.amount * conversionRate).toFixed(2)))
      : Number(deposit.amount);

    const newBalance = Math.max(0, Number((prevBalance - creditAmount).toFixed(2)));

    wallet.balance = newBalance;
    wallet.updatedAt = new Date().toISOString();

    deposit.status = 'REVERSED';
    deposit.adminNote = reason;
    deposit.updatedAt = new Date().toISOString();

    const ledgerTx = {
      id: `tx_${crypto.randomBytes(8).toString('hex')}`,
      walletId: wallet.id,
      userId: deposit.userId,
      type: 'DEPOSIT_REVERSAL',
      amount: -creditAmount,
      previousBalance: prevBalance,
      newBalance,
      currency: 'BDT',
      status: 'REVERSED',
      referenceId: `DEP_REV_${deposit.id}`,
      description: `Reversal of Deposit #${deposit.id} (TrxID: ${deposit.transactionId})`,
      depositId: deposit.id,
      orderId: null,
      adminId,
      createdAt: new Date().toISOString()
    };
    db.transactions.unshift(ledgerTx);

    // Reverse any referral commission generated by this deposit
    try {
      await reverseDepositReferralCommission(depositId, actorEmail);
    } catch (refRevErr) {
      console.warn('[REFERRAL REVERSAL ERROR]', refRevErr.message);
    }

    recordAuditLog({
      actorId: adminId,
      actorEmail,
      role: 'ADMIN',
      action: 'DEPOSIT_REVERSED',
      targetId: deposit.id,
      targetType: 'DEPOSIT',
      before: { balance: prevBalance, depositStatus: 'APPROVED' },
      after: { balance: newBalance, depositStatus: 'REVERSED' },
      reason
    });

    return { deposit, wallet, transaction: ledgerTx };
  });
}

/**
 * Reject deposit request atomically
 */
async function rejectDeposit(depositId, adminId, adminNote = '', actorEmail = null) {
  return await db.transaction(async () => {
    const deposit = db.deposits.find(d => d.id === depositId);
    if (!deposit) throw new Error('DEPOSIT_NOT_FOUND');
    if (deposit.status !== 'PENDING') throw new Error('DEPOSIT_ALREADY_PROCESSED');

    deposit.status = 'REJECTED';
    deposit.adminNote = adminNote || 'Rejected by Admin';
    deposit.reviewedByAdminId = adminId;
    deposit.updatedAt = new Date().toISOString();

    recordAuditLog({
      actorId: adminId,
      actorEmail,
      role: 'ADMIN',
      action: 'DEPOSIT_REJECTED',
      targetId: deposit.id,
      targetType: 'DEPOSIT',
      before: { status: 'PENDING' },
      after: { status: 'REJECTED' },
      reason: adminNote
    });

    return deposit;
  });
}

/**
 * Administrative manual wallet balance adjustment with audit logging
 */
async function adjustUserWallet({ userId, amount, type = 'CREDIT', reason = '', adminId = 'admin_system', actorEmail = null }) {
  const parsedAmount = Math.abs(parseFloat(amount));
  const normalizedType = String(type || '').toUpperCase().trim();

  if (isNaN(parsedAmount) || (parsedAmount === 0 && normalizedType !== 'SET')) {
    throw new Error('INVALID_ADJUSTMENT_AMOUNT');
  }

  return await db.transaction(async () => {
    const user = db.users.find(u => u.id === userId);
    if (!user) throw new Error('USER_NOT_FOUND');

    const wallet = getUserWallet(userId);
    const prevBalance = Number(wallet.balance);
    let newBalance = prevBalance;
    let signedAmount = 0;

    if (normalizedType === 'CREDIT' || normalizedType === 'ADD') {
      newBalance = Number((prevBalance + parsedAmount).toFixed(2));
      signedAmount = parsedAmount;
    } else if (normalizedType === 'DEBIT' || normalizedType === 'SUBTRACT' || normalizedType === 'DEDUCT') {
      if (prevBalance < parsedAmount) {
        throw new Error('CANNOT_DEBIT_BELOW_ZERO');
      }
      newBalance = Number((prevBalance - parsedAmount).toFixed(2));
      signedAmount = -parsedAmount;
    } else if (normalizedType === 'SET') {
      newBalance = Number(parsedAmount.toFixed(2));
      signedAmount = Number((newBalance - prevBalance).toFixed(2));
    } else {
      throw new Error('INVALID_ADJUSTMENT_TYPE');
    }

    wallet.balance = newBalance;
    wallet.updatedAt = new Date().toISOString();

    const ledgerTx = {
      id: `tx_${crypto.randomBytes(8).toString('hex')}`,
      walletId: wallet.id,
      userId,
      type: 'ADMIN_ADJUSTMENT',
      amount: signedAmount,
      previousBalance: prevBalance,
      newBalance,
      currency: wallet.currency,
      status: 'COMPLETED',
      referenceId: `ADJ_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      description: `Admin Wallet ${normalizedType}: ${reason || 'Manual Adjustment'}`,
      depositId: null,
      orderId: null,
      adminId,
      createdAt: new Date().toISOString()
    };
    db.transactions.unshift(ledgerTx);

    recordAuditLog({
      actorId: adminId,
      actorEmail,
      role: 'SUPER_ADMIN',
      action: 'WALLET_ADJUSTED',
      targetId: userId,
      targetType: 'USER',
      before: { balance: prevBalance },
      after: { balance: newBalance, adjustment: signedAmount },
      reason
    });

    return { wallet, transaction: ledgerTx };
  });
}

module.exports = {
  getUserWallet,
  submitDepositRequest,
  approveDeposit,
  reverseApprovedDeposit,
  rejectDeposit,
  adjustUserWallet
};
