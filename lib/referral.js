/**
 * FREAKSHOWTOPUP - REFERRAL & EARN ENGINE (ENTERPRISE GRADE)
 * Handles deposit-triggered commission lifecycle, anti-fraud verification,
 * configurable validity expiration, and immutable double-entry ledger integration.
 */

const crypto = require('crypto');
const db = require('./db');
const { recordAuditLog } = require('./audit');

/**
 * Retrieve or initialize wallet helper
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
 * Process Referral Commission when a Deposit reaches APPROVED status
 * @param {Object} deposit - The approved deposit record
 * @param {String} actorEmail - Admin or system email
 */
async function processDepositReferralCommission(deposit, actorEmail = null) {
  if (!deposit || deposit.status !== 'APPROVED') {
    return { success: false, eligible: false, reason: 'DEPOSIT_NOT_APPROVED' };
  }

  // 1. Check if Referral System is enabled globally
  const isEnabled = db.settings.referralSystemEnabled !== false;
  if (!isEnabled) {
    return { success: false, eligible: false, reason: 'REFERRAL_SYSTEM_DISABLED' };
  }

  // 2. Identify depositing customer
  const user = db.users.find(u => u.id === deposit.userId);
  if (!user || !user.referredById) {
    return { success: false, eligible: false, reason: 'NO_REFERRER' };
  }

  // 3. Identify referrer
  const referrer = db.users.find(u => u.id === user.referredById);
  if (!referrer) {
    return { success: false, eligible: false, reason: 'REFERRER_NOT_FOUND' };
  }

  // 4. Anti-Fraud Checks
  const antiFraud = db.settings.antiFraudEnabled !== false;
  if (antiFraud) {
    // Prevent self-referral
    if (referrer.id === user.id || (referrer.email && user.email && referrer.email.toLowerCase() === user.email.toLowerCase())) {
      recordAuditLog({
        actorId: user.id,
        actorEmail: user.email,
        role: 'USER',
        action: 'FRAUD_FLAGGED_SELF_REFERRAL',
        targetId: deposit.id,
        targetType: 'REFERRAL',
        before: { referrerId: referrer.id, userId: user.id },
        after: { blocked: true },
        reason: 'Self-referral attempt detected'
      });
      return { success: false, eligible: false, reason: 'SELF_REFERRAL_BLOCKED' };
    }
  }

  // 5. Commission Duplication Protection (Strict Idempotency)
  const existingComm = db.commissions.find(c => c.depositId === deposit.id && (c.status === 'PAID' || c.status === 'CREDITED'));
  if (existingComm) {
    return { success: false, eligible: false, reason: 'ALREADY_CREDITED', commission: existingComm };
  }

  // 6. Referral Expiry / Validity Check
  const validityDays = Number(db.settings.referralValidityDays !== undefined ? db.settings.referralValidityDays : 30);
  if (validityDays > 0) {
    const joinTime = new Date(user.createdAt || Date.now()).getTime();
    const elapsedDays = (Date.now() - joinTime) / (1000 * 60 * 60 * 24);
    if (elapsedDays > validityDays) {
      const expiredRecord = {
        id: `comm_${crypto.randomBytes(8).toString('hex')}`,
        referrerId: referrer.id,
        referrerName: referrer.name,
        referrerEmail: referrer.email,
        referrerCode: referrer.referralCode,
        originUserId: user.id,
        originUserName: user.name,
        originUserEmail: user.email,
        depositId: deposit.id,
        depositAmount: Number(deposit.amount),
        commissionRate: 0,
        amount: 0,
        currency: deposit.currency || 'BDT',
        status: 'EXPIRED',
        note: `Referral expired after ${validityDays} days (${elapsedDays.toFixed(1)} days elapsed)`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      db.commissions.unshift(expiredRecord);
      db.saveAll();
      return { success: false, eligible: false, reason: 'REFERRAL_VALIDITY_EXPIRED', commission: expiredRecord };
    }
  }

  // 7. Minimum Deposit Amount Check
  const minDeposit = Number(db.settings.minDepositForCommission || 0);
  if (minDeposit > 0 && Number(deposit.amount) < minDeposit) {
    return { success: false, eligible: false, reason: `DEPOSIT_BELOW_MINIMUM_${minDeposit}` };
  }

  // 8. First Deposit Only Check
  const firstOnly = Boolean(db.settings.firstDepositOnly);
  if (firstOnly) {
    const priorApproved = db.deposits.filter(d => d.userId === user.id && d.status === 'APPROVED' && d.id !== deposit.id);
    if (priorApproved.length > 0) {
      return { success: false, eligible: false, reason: 'NOT_FIRST_DEPOSIT' };
    }
  }

  // 9. Calculate Commission Percentage & Capping
  const rate = Number(db.settings.referralCommissionPercent !== undefined ? db.settings.referralCommissionPercent : 2.5);
  let commissionAmount = Number(((Number(deposit.amount) * rate) / 100).toFixed(2));

  const maxCap = Number(db.settings.maxCommissionPerDeposit || 0);
  if (maxCap > 0 && commissionAmount > maxCap) {
    commissionAmount = Number(maxCap.toFixed(2));
  }

  if (commissionAmount <= 0) {
    return { success: false, eligible: false, reason: 'COMMISSION_AMOUNT_ZERO' };
  }

  // 10. Atomic Balance Credit to Referrer's Main Wallet
  const referrerWallet = getUserWallet(referrer.id);
  const prevBalance = Number(referrerWallet.balance);
  const newBalance = Number((prevBalance + commissionAmount).toFixed(2));

  referrerWallet.balance = newBalance;
  referrerWallet.updatedAt = new Date().toISOString();

  // 11. Create Immutable Commission Record
  const commRecord = {
    id: `comm_${crypto.randomBytes(8).toString('hex')}`,
    referrerId: referrer.id,
    referrerName: referrer.name,
    referrerEmail: referrer.email,
    referrerCode: referrer.referralCode,
    originUserId: user.id,
    originUserName: user.name,
    originUserEmail: user.email,
    depositId: deposit.id,
    depositAmount: Number(deposit.amount),
    commissionRate: rate,
    rate: rate,
    amount: commissionAmount,
    currency: referrerWallet.currency,
    status: 'PAID',
    note: `Deposit #${deposit.id} via ${deposit.paymentMethod || 'Manual'}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.commissions.unshift(commRecord);

  // 12. Create Ledger Transaction Entry
  const ledgerTx = {
    id: `tx_${crypto.randomBytes(8).toString('hex')}`,
    walletId: referrerWallet.id,
    userId: referrer.id,
    type: 'REFERRAL_COMMISSION',
    amount: commissionAmount,
    previousBalance: prevBalance,
    newBalance,
    currency: referrerWallet.currency,
    status: 'COMPLETED',
    referenceId: `DEP_COMM_${deposit.id}`,
    description: `Referral Commission (${rate}%) from ${user.name} for Deposit #${deposit.id}`,
    depositId: deposit.id,
    orderId: null,
    adminId: deposit.reviewedByAdminId || null,
    createdAt: new Date().toISOString()
  };
  db.transactions.unshift(ledgerTx);
  db.saveAll();

  // 13. Audit Log Entry
  recordAuditLog({
    actorId: deposit.reviewedByAdminId || 'system',
    actorEmail,
    role: 'SYSTEM',
    action: 'REFERRAL_COMMISSION_CREDITED',
    targetId: commRecord.id,
    targetType: 'COMMISSION',
    before: { referrerBalance: prevBalance },
    after: { referrerBalance: newBalance, commissionAmount },
    reason: `Deposit #${deposit.id} approved`
  });

  return { success: true, commission: commRecord, transaction: ledgerTx };
}

/**
 * Reverses referral commission if a deposit is refunded or cancelled
 * @param {String} depositId - Deposit identifier
 * @param {String} actorEmail - Admin email
 */
async function reverseDepositReferralCommission(depositId, actorEmail = null) {
  const comm = db.commissions.find(c => c.depositId === depositId && (c.status === 'PAID' || c.status === 'CREDITED'));
  if (!comm) {
    return { success: false, reason: 'NO_COMMISSION_FOUND' };
  }

  const referrerWallet = getUserWallet(comm.referrerId);
  const prevBalance = Number(referrerWallet.balance);
  const revAmount = Number(comm.amount);
  const newBalance = Math.max(0, Number((prevBalance - revAmount).toFixed(2)));

  referrerWallet.balance = newBalance;
  referrerWallet.updatedAt = new Date().toISOString();

  comm.status = 'REVERSED';
  comm.updatedAt = new Date().toISOString();

  const ledgerTx = {
    id: `tx_${crypto.randomBytes(8).toString('hex')}`,
    walletId: referrerWallet.id,
    userId: comm.referrerId,
    type: 'REFERRAL_COMMISSION_REVERSAL',
    amount: -revAmount,
    previousBalance: prevBalance,
    newBalance,
    currency: referrerWallet.currency,
    status: 'REVERSED',
    referenceId: `REV_COMM_${comm.id}`,
    description: `Reversal of Referral Commission for Refunded Deposit #${depositId}`,
    depositId,
    orderId: null,
    adminId: null,
    createdAt: new Date().toISOString()
  };
  db.transactions.unshift(ledgerTx);
  db.saveAll();

  recordAuditLog({
    actorId: 'admin_reversal',
    actorEmail,
    role: 'ADMIN',
    action: 'REFERRAL_COMMISSION_REVERSED',
    targetId: comm.id,
    targetType: 'COMMISSION',
    before: { referrerBalance: prevBalance },
    after: { referrerBalance: newBalance, reversedAmount: revAmount },
    reason: `Deposit #${depositId} refunded/reversed`
  });

  return { success: true, reversedAmount: revAmount, commission: comm };
}

/**
 * Get full referral analytics and management data for Admin Panel
 */
function getAdminReferralOverview() {
  const allUsers = db.users || [];
  const allDeposits = db.deposits || [];
  const allCommissions = db.commissions || [];

  const referredUsers = allUsers.filter(u => Boolean(u.referredById));
  const activeReferrals = referredUsers.filter(u =>
    allDeposits.some(d => d.userId === u.id && d.status === 'APPROVED')
  );

  const totalDepositFromReferrals = allDeposits
    .filter(d => d.status === 'APPROVED' && referredUsers.some(u => u.id === d.userId))
    .reduce((acc, d) => acc + Number(d.amount || 0), 0);

  const paidCommissions = allCommissions.filter(c => c.status === 'PAID' || c.status === 'CREDITED');
  const totalCommissionPaid = paidCommissions.reduce((acc, c) => acc + Number(c.amount || 0), 0);

  const reversedCommissions = allCommissions.filter(c => c.status === 'REVERSED');
  const totalCommissionReversed = reversedCommissions.reduce((acc, c) => acc + Number(c.amount || 0), 0);

  // Pending deposits from referred users
  const pendingDeposits = allDeposits.filter(d => d.status === 'PENDING' && referredUsers.some(u => u.id === d.userId));
  const rate = Number(db.settings.referralCommissionPercent !== undefined ? db.settings.referralCommissionPercent : 2.5);
  const pendingCommissionAmount = pendingDeposits.reduce((acc, d) => acc + Number(((Number(d.amount || 0) * rate) / 100).toFixed(2)), 0);

  // Top Referrers Calculation
  const referrerMap = {};
  allUsers.forEach(u => {
    if (u.referralCode) {
      referrerMap[u.id] = {
        userId: u.id,
        name: u.name,
        email: u.email,
        referralCode: u.referralCode,
        referralsCount: 0,
        activeCount: 0,
        totalDepositAmount: 0,
        totalCommissionEarned: 0
      };
    }
  });

  referredUsers.forEach(u => {
    if (referrerMap[u.referredById]) {
      referrerMap[u.referredById].referralsCount += 1;
      const userApprovedDeposits = allDeposits.filter(d => d.userId === u.id && d.status === 'APPROVED');
      if (userApprovedDeposits.length > 0) {
        referrerMap[u.referredById].activeCount += 1;
        const sumDep = userApprovedDeposits.reduce((a, b) => a + Number(b.amount || 0), 0);
        referrerMap[u.referredById].totalDepositAmount += sumDep;
      }
    }
  });

  paidCommissions.forEach(c => {
    if (referrerMap[c.referrerId]) {
      referrerMap[c.referrerId].totalCommissionEarned += Number(c.amount || 0);
    }
  });

  const topReferrers = Object.values(referrerMap)
    .filter(r => r.referralsCount > 0 || r.totalCommissionEarned > 0)
    .sort((a, b) => b.totalCommissionEarned - a.totalCommissionEarned || b.referralsCount - a.referralsCount);

  // Referrals table items
  const referralsList = referredUsers.map(u => {
    const ref = allUsers.find(r => r.id === u.referredById);
    const userDeposits = allDeposits.filter(d => d.userId === u.id);
    const approvedDeposits = userDeposits.filter(d => d.status === 'APPROVED');
    const totalDeposited = approvedDeposits.reduce((a, b) => a + Number(b.amount || 0), 0);
    const userComms = allCommissions.filter(c => c.originUserId === u.id && (c.status === 'PAID' || c.status === 'CREDITED'));
    const commTotal = userComms.reduce((a, b) => a + Number(b.amount || 0), 0);

    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      joinedAt: u.createdAt,
      referrerId: ref ? ref.id : null,
      referrerName: ref ? ref.name : 'Unknown',
      referrerEmail: ref ? ref.email : 'N/A',
      referrerCode: ref ? ref.referralCode : 'N/A',
      depositCount: approvedDeposits.length,
      totalDeposited: Number(totalDeposited.toFixed(2)),
      commissionGenerated: Number(commTotal.toFixed(2)),
      status: approvedDeposits.length > 0 ? 'ACTIVE' : 'INACTIVE'
    };
  });

  // Fraud detection logs (audit logs of type FRAUD_FLAGGED)
  const auditLogs = (db.auditLogs && db.auditLogs.logs) || [];
  const fraudLogs = auditLogs.filter(l => l.action && l.action.includes('FRAUD'));

  return {
    stats: {
      totalReferrals: referredUsers.length,
      activeReferrals: activeReferrals.length,
      totalDepositFromReferrals: Number(totalDepositFromReferrals.toFixed(2)),
      totalCommissionPaid: Number(totalCommissionPaid.toFixed(2)),
      pendingCommission: Number(pendingCommissionAmount.toFixed(2)),
      reversedCommission: Number(totalCommissionReversed.toFixed(2))
    },
    settings: {
      referralSystemEnabled: db.settings.referralSystemEnabled !== false,
      referralCommissionPercent: Number(db.settings.referralCommissionPercent !== undefined ? db.settings.referralCommissionPercent : 2.5),
      minDepositForCommission: Number(db.settings.minDepositForCommission || 0),
      maxCommissionPerDeposit: Number(db.settings.maxCommissionPerDeposit || 0),
      firstDepositOnly: Boolean(db.settings.firstDepositOnly),
      referralValidityDays: Number(db.settings.referralValidityDays !== undefined ? db.settings.referralValidityDays : 30),
      antiFraudEnabled: db.settings.antiFraudEnabled !== false,
      newUserBonusEnabled: Boolean(db.settings.newUserBonusEnabled)
    },
    topReferrers,
    referralsList,
    commissionsHistory: allCommissions,
    pendingDeposits,
    reversedCommissions,
    fraudLogs
  };
}

/**
 * Get individual customer referral overview for frontend modal
 */
function getUserReferralDashboard(userId) {
  const user = db.users.find(u => u.id === userId);
  if (!user) return null;

  const domain = db.settings.domain || 'freakshowtopup.shop';
  const referralCode = user.referralCode || `FS${Math.floor(100000 + Math.random() * 900000)}`;
  if (!user.referralCode) {
    user.referralCode = referralCode;
    db.saveAll();
  }

  const referralLink = `https://${domain}?ref=${referralCode}`;
  const myReferrals = db.users.filter(u => u.referredById === userId);
  const activeCount = myReferrals.filter(u =>
    db.deposits.some(d => d.userId === u.id && d.status === 'APPROVED')
  ).length;

  const myApprovedDeposits = db.deposits.filter(d =>
    d.status === 'APPROVED' && myReferrals.some(u => u.id === d.userId)
  );
  const totalDepositFromReferrals = myApprovedDeposits.reduce((acc, d) => acc + Number(d.amount || 0), 0);

  const myCommissions = (db.commissions || []).filter(c => c.referrerId === userId);
  const totalEarned = myCommissions
    .filter(c => c.status === 'PAID' || c.status === 'CREDITED')
    .reduce((acc, c) => acc + Number(c.amount || 0), 0);

  // Pending deposits from my referrals
  const rate = Number(db.settings.referralCommissionPercent !== undefined ? db.settings.referralCommissionPercent : 2.5);
  const pendingDeposits = db.deposits.filter(d => d.status === 'PENDING' && myReferrals.some(u => u.id === d.userId));
  const pendingCommission = pendingDeposits.reduce((acc, d) => acc + Number(((Number(d.amount || 0) * rate) / 100).toFixed(2)), 0);

  return {
    referralCode,
    referralLink,
    commissionRate: `${rate}%`,
    totalReferrals: myReferrals.length,
    activeReferrals: activeCount,
    totalDepositFromReferrals: Number(totalDepositFromReferrals.toFixed(2)),
    totalEarned: Number(totalEarned.toFixed(2)),
    pendingCommission: Number(pendingCommission.toFixed(2)),
    referralHistory: myCommissions.slice(0, 50),
    referralsList: myReferrals.map(u => ({
      name: u.name,
      joinedAt: u.createdAt,
      hasDeposited: db.deposits.some(d => d.userId === u.id && d.status === 'APPROVED')
    }))
  };
}

module.exports = {
  processDepositReferralCommission,
  reverseDepositReferralCommission,
  getAdminReferralOverview,
  getUserReferralDashboard
};
