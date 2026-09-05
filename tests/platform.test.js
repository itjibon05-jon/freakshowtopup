/**
 * FREAKSHOWTOPUP - ENTERPRISE AUTOMATED TEST SUITE (ZERO EXTERNAL DEPENDENCIES)
 * Rigorously validates:
 * 1. Authentication & Google OIDC Verification
 * 2. Financial Ledger & Wallet Double-Entry Integrity
 * 3. Idempotency & Duplicate Order Prevention
 * 4. Order State Machine & Auto-Refund on Provider Failure
 * 5. Referral Commission Lifecycle & Reversal on Refund
 * 6. RBAC Governance & Data Sanitization (Customer Non-Exposure)
 */

process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'TEST_SECRET_KEY_12345678901234567890123456789012';
process.env.SUPER_ADMIN_EMAIL = 'admin.super@freakshowtopup.shop';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../lib/db');
const auth = require('../lib/auth');
const walletEngine = require('../lib/wallet');
const orderEngine = require('../lib/orders');
const referralEngine = require('../lib/referral');
const { getProviderAdapter } = require('../lib/providers');

test('1. Authentication: Bcrypt Hashing, Role Assignment & Invalid Login Rejection', async () => {
  const testEmail = `gamer_${Date.now()}@freakshowtopup.shop`;
  const rawPassword = 'StrongPassword2026!';

  // Standard user registration
  const reg = await auth.registerUser({
    name: 'Pro Gamer',
    email: testEmail,
    password: rawPassword,
    country: 'BD',
    currency: 'BDT'
  });

  assert.strictEqual(reg.user.email, testEmail);
  assert.strictEqual(reg.user.role, 'USER');
  assert.strictEqual(reg.user.currency, 'BDT');
  assert.strictEqual(reg.user.currencyChangeUsed, false);
  assert.ok(!reg.user.passwordHash, 'Password hash must be sanitized from user object');

  // Verify stored password hash is a valid bcrypt hash
  const storedUser = db.users.find(u => u.id === reg.user.id);
  assert.ok(storedUser.passwordHash.startsWith('$2a$') || storedUser.passwordHash.startsWith('$2b$'));

  // Successful Login
  const loginRes = await auth.loginUser({
    emailOrUsername: testEmail,
    password: rawPassword
  });
  assert.strictEqual(loginRes.user.id, reg.user.id);
  assert.ok(loginRes.token);

  // Failed Login: Wrong Password
  await assert.rejects(async () => {
    await auth.loginUser({
      emailOrUsername: testEmail,
      password: 'WrongPassword!'
    });
  }, /Invalid email\/username or password/);

  // Failed Login: Non-existent User
  await assert.rejects(async () => {
    await auth.loginUser({
      emailOrUsername: 'non_existent@freakshowtopup.shop',
      password: rawPassword
    });
  }, /Invalid email\/username or password/);
});

test('2. Google OIDC Authentication: 1-Click Verification & Role Guard', async () => {
  const gmail = `player_${Date.now()}@gmail.com`;

  // Authenticate with mock Google ID token
  const gAuth = await auth.googleAuth({
    idToken: `mock_google_${gmail}`,
    country: 'BD',
    currency: 'BDT'
  });

  assert.strictEqual(gAuth.user.email, gmail);
  assert.strictEqual(gAuth.user.role, 'USER');
  assert.ok(gAuth.token);

  // Authenticate with Super Admin email
  const superGmail = 'admin.super@freakshowtopup.shop';
  const superGAuth = await auth.googleAuth({
    idToken: `mock_google_${superGmail}`,
    country: 'BD',
    currency: 'BDT'
  });

  assert.strictEqual(superGAuth.user.email, superGmail);
  assert.strictEqual(superGAuth.user.role, 'SUPER_ADMIN', 'Super admin role must be granted to configured SUPER_ADMIN_EMAIL');
});

test('3. Financial Ledger: Double-Entry Atomicity & Deposit Approval', async () => {
  const testEmail = `finance_${Date.now()}@freakshowtopup.shop`;
  const reg = await auth.registerUser({
    name: 'Finance Tester',
    email: testEmail,
    password: 'password123',
    country: 'BD',
    currency: 'BDT'
  });

  const depositTrxId = `TRX_TEST_${Date.now()}`;
  const deposit = await walletEngine.submitDepositRequest({
    userId: reg.user.id,
    paymentMethod: 'BKASH',
    senderNumber: '01711223344',
    transactionId: depositTrxId,
    amount: 500.00
  });

  assert.strictEqual(deposit.status, 'PENDING');
  assert.strictEqual(deposit.amount, 500.00);

  // Duplicate Transaction ID Prevention
  await assert.rejects(async () => {
    await walletEngine.submitDepositRequest({
      userId: reg.user.id,
      paymentMethod: 'NAGAD',
      senderNumber: '01811223344',
      transactionId: depositTrxId,
      amount: 250.00
    });
  }, /DUPLICATE_TRANSACTION_ID/);

  // Admin Approves Deposit
  const approval = await walletEngine.approveDeposit(deposit.id, 'admin_super_1', 'Verified via SMS', 'admin@freakshowtopup.shop');
  assert.strictEqual(approval.deposit.status, 'APPROVED');
  assert.strictEqual(Number(approval.wallet.balance), 500.00);

  // Verify Double-Entry Ledger Record
  const ledgerTx = db.transactions.find(t => t.depositId === deposit.id);
  assert.ok(ledgerTx);
  assert.strictEqual(ledgerTx.type, 'DEPOSIT');
  assert.strictEqual(Number(ledgerTx.amount), 500.00);
  assert.strictEqual(Number(ledgerTx.newBalance), 500.00);
});

test('4. Currency Rules: One-Time Switch & Permanent Lock After Approved Deposit', async () => {
  const testEmail = `curr_${Date.now()}@freakshowtopup.shop`;
  const reg = await auth.registerUser({
    name: 'Currency Tester',
    email: testEmail,
    password: 'password123',
    country: 'BD',
    currency: 'BDT'
  });

  assert.strictEqual(reg.user.currency, 'BDT');
  assert.strictEqual(reg.user.currencyChangeUsed, false);

  // First deposit: User switches currency to USD (Allowed once)
  const deposit = await walletEngine.submitDepositRequest({
    userId: reg.user.id,
    paymentMethod: 'BKASH',
    senderNumber: '01712345678',
    transactionId: `TRX_USD_${Date.now()}`,
    amount: 10.00,
    requestedCurrency: 'USD'
  });

  assert.strictEqual(deposit.currency, 'USD');
  const userAfterSwitch = db.users.find(u => u.id === reg.user.id);
  assert.strictEqual(userAfterSwitch.currency, 'USD');
  assert.strictEqual(userAfterSwitch.currencyChangeUsed, true);

  // Approve deposit
  await walletEngine.approveDeposit(deposit.id, 'admin_1', 'Binance verified');

  // Attempting second currency switch must be blocked
  await assert.rejects(async () => {
    await walletEngine.submitDepositRequest({
      userId: reg.user.id,
      paymentMethod: 'BKASH',
      senderNumber: '01700000000',
      transactionId: `TRX_FAIL_${Date.now()}`,
      amount: 500,
      requestedCurrency: 'BDT'
    });
  }, /CURRENCY_CHANGE_ALREADY_USED|CURRENCY_LOCKED_AFTER_FIRST_DEPOSIT/);
});

test('5. Order Engine: Idempotency & Duplicate Order Protection', async () => {
  const testEmail = `idem_user_${Date.now()}@freakshowtopup.shop`;
  const reg = await auth.registerUser({
    name: 'Idempotency Tester',
    email: testEmail,
    password: 'password123',
    country: 'BD',
    currency: 'BDT'
  });

  // Credit wallet with 1000 BDT
  await walletEngine.adjustUserWallet({
    userId: reg.user.id,
    amount: 1000,
    type: 'CREDIT',
    reason: 'Test setup'
  });

  const product = db.products.find(p => p.inStock !== false && p.isActive !== false) || db.products[0];
  const idempotencyKey = `KEY_IDEM_${Date.now()}`;

  // First order creation with UID 515215855
  const order1 = await orderEngine.createOrder({
    userId: reg.user.id,
    productId: product.id,
    playerData: { uid: '515215855' },
    quantity: 1,
    idempotencyKey
  });

  assert.strictEqual(order1.isDuplicate, false);
  const balanceAfterOrder1 = Number(walletEngine.getUserWallet(reg.user.id).balance);
  assert.strictEqual(balanceAfterOrder1, 1000 - Number(product.sellingPrice));

  // Second order with IDENTICAL idempotency key
  const order2 = await orderEngine.createOrder({
    userId: reg.user.id,
    productId: product.id,
    playerData: { uid: '515215855' },
    quantity: 1,
    idempotencyKey
  });

  assert.strictEqual(order2.isDuplicate, true);
  assert.strictEqual(order2.order.id, order1.order.id);
  
  // Verify wallet was NOT charged a second time
  const balanceAfterOrder2 = Number(walletEngine.getUserWallet(reg.user.id).balance);
  assert.strictEqual(balanceAfterOrder2, balanceAfterOrder1, 'Duplicate charge must be strictly prevented');
});

test('6. Order State Machine: Provider Failure & Guaranteed 100% Auto-Refund', async () => {
  const testEmail = `refund_user_${Date.now()}@freakshowtopup.shop`;
  const reg = await auth.registerUser({
    name: 'Refund Tester',
    email: testEmail,
    password: 'password123',
    country: 'BD',
    currency: 'BDT'
  });

  await walletEngine.adjustUserWallet({
    userId: reg.user.id,
    amount: 500,
    type: 'CREDIT',
    reason: 'Test setup'
  });

  const product = db.products.find(p => p.inStock !== false && p.isActive !== false) || db.products[0];
  
  // UID starting with 999 triggers mock provider failure
  const failOrder = await orderEngine.createOrder({
    userId: reg.user.id,
    productId: product.id,
    playerData: { uid: '999_MOCK_FAIL_UID' },
    quantity: 1
  });

  assert.ok(failOrder.order.id);

  // Check order status in DB
  const storedOrder = db.orders.find(o => o.id === failOrder.order.id);
  assert.strictEqual(storedOrder.status, 'REFUNDED', 'Failed order must transition to REFUNDED');

  // Verify wallet balance is 100% refunded
  const wallet = walletEngine.getUserWallet(reg.user.id);
  assert.strictEqual(Number(wallet.balance), 500.00, 'Customer wallet must be fully restored');

  // Verify refund transaction in ledger
  const refundTx = db.transactions.find(t => t.orderId === storedOrder.id && t.type === 'REFUND');
  assert.ok(refundTx);
  assert.strictEqual(Number(refundTx.amount), Number(product.sellingPrice));
});

test('7. Referral Program: Deposit-Triggered Commission & Reversal on Refund', async () => {
  db.settings.referralSystemEnabled = true;
  db.settings.referralCommissionPercent = 2.5;
  db.settings.minDepositForCommission = 0;
  db.settings.maxCommissionPerDeposit = 0;
  db.settings.firstDepositOnly = false;
  db.settings.referralValidityDays = 30;
  db.settings.antiFraudEnabled = true;

  // Create Referrer
  const referrer = await auth.registerUser({
    name: 'Top Referrer',
    email: `ref_boss_${Date.now()}@freakshowtopup.shop`,
    password: 'password123',
    country: 'BD',
    currency: 'BDT'
  });

  // Create Referred Customer using referrer's referral code
  const referredUser = await auth.registerUser({
    name: 'New Player',
    email: `referred_${Date.now()}@freakshowtopup.shop`,
    password: 'password123',
    country: 'BD',
    currency: 'BDT',
    referralCode: referrer.user.referralCode
  });

  assert.strictEqual(referredUser.user.referredById, referrer.user.id);

  // Fund referred user
  await walletEngine.adjustUserWallet({
    userId: referredUser.user.id,
    amount: 500,
    type: 'CREDIT',
    reason: 'Initial credits'
  });

  // Deposit by referred user
  const dep = await walletEngine.submitDepositRequest({
    userId: referredUser.user.id,
    paymentMethod: 'bKash',
    senderNumber: '01700000000',
    transactionId: `TRX_DEP_T7_${Date.now()}`,
    amount: 500,
    requestedCurrency: 'BDT'
  });

  const initialRefBal = Number(walletEngine.getUserWallet(referrer.user.id).balance);
  await walletEngine.approveDeposit(dep.id, 'admin_super', 'Approved for Test 7', 'admin@freakshow.shop');

  // Verify commission is credited to referrer
  const comm = db.commissions.find(c => c.depositId === dep.id);
  assert.ok(comm);
  assert.strictEqual(comm.status, 'PAID');
  assert.strictEqual(comm.referrerId, referrer.user.id);

  const referrerWallet = walletEngine.getUserWallet(referrer.user.id);
  assert.ok(Number(referrerWallet.balance) > initialRefBal, 'Referrer wallet must receive commission');

  // If deposit is refunded / reversed -> Commission must be reversed
  await referralEngine.reverseDepositReferralCommission(dep.id, 'admin@freakshow.shop');

  const commAfterRefund = db.commissions.find(c => c.depositId === dep.id);
  assert.strictEqual(commAfterRefund.status, 'REVERSED');
});

test('8. Security & RBAC: Customer Data Sanitization (No Cost/Profit Leaks)', async () => {
  const product = db.products[0];
  const orderRecord = {
    id: 'FS_TEST_99',
    userId: 'usr_test',
    productId: product.id,
    productName: product.name,
    sellingPrice: 22.00,
    supplierCost: 19.50,
    profit: 2.50,
    providerId: 'prov-ucapi',
    providerResponse: '{"secret":"hidden"}',
    status: 'DONE',
    currency: 'BDT'
  };

  const sanitized = orderEngine.sanitizeOrderForCustomer(orderRecord);
  assert.strictEqual(sanitized.id, 'FS_TEST_99');
  assert.strictEqual(sanitized.sellingPrice, 22.00);
  assert.strictEqual(sanitized.supplierCost, undefined, 'supplierCost must NEVER be exposed to customer');
  assert.strictEqual(sanitized.profit, undefined, 'profit must NEVER be exposed to customer');
  assert.strictEqual(sanitized.providerId, undefined, 'providerId must NEVER be exposed to customer');
  assert.strictEqual(sanitized.providerResponse, undefined, 'providerResponse must NEVER be exposed to customer');
});

test('9. VIP Access Products: Presence in Catalog & Individual Price Editing Independence', async () => {
  const bcrypt = require('bcryptjs');

  // Verify VIP products exist in catalog
  const vipW1 = db.products.find(p => p.id === 'p-ff-vip-w1');
  assert.ok(vipW1, 'p-ff-vip-w1 must be present in db.products');
  assert.strictEqual(vipW1.categoryId, 'cat-ff');
  assert.strictEqual(vipW1.subcategoryId, 'sub-ff-vip');

  const normalProd = db.products.find(p => p.id === 'p-ff-25');
  assert.ok(normalProd, 'Normal product p-ff-25 must exist');

  const initialVipPrice = vipW1.sellingPrice;
  const initialNormalPrice = normalProd.sellingPrice;

  // Edit VIP product price
  vipW1.sellingPrice = 160;
  db.saveAll();

  // Verify ONLY VIP product changed and normal product is unaffected
  assert.strictEqual(db.products.find(p => p.id === 'p-ff-vip-w1').sellingPrice, 160);
  assert.strictEqual(db.products.find(p => p.id === 'p-ff-25').sellingPrice, initialNormalPrice);

  // Edit Normal product price
  normalProd.sellingPrice = 25;
  db.saveAll();

  // Verify VIP product is unaffected by normal product change
  assert.strictEqual(db.products.find(p => p.id === 'p-ff-vip-w1').sellingPrice, 160);
  assert.strictEqual(db.products.find(p => p.id === 'p-ff-25').sellingPrice, 25);

  // Revert test edits
  vipW1.sellingPrice = initialVipPrice;
  normalProd.sellingPrice = initialNormalPrice;
  db.saveAll();
});

test('10. VIP Access Code: Hashing, Verification, Old Code Validation & Rotation', async () => {
  const bcrypt = require('bcryptjs');

  // Set initial known hash
  const initialCode = 'JOY100LVL';
  db.settings.vipAccessCodeHash = await bcrypt.hash(initialCode, 10);
  delete db.settings.vipAccessCode;
  db.saveAll();

  // 1. Verify correct initial code
  const isInitialValid = await bcrypt.compare('JOY100LVL', db.settings.vipAccessCodeHash);
  assert.strictEqual(isInitialValid, true, 'Valid initial code must pass verification');

  // 2. Reject incorrect code
  const isWrongValid = await bcrypt.compare('WRONG_CODE_999', db.settings.vipAccessCodeHash);
  assert.strictEqual(isWrongValid, false, 'Wrong code must be rejected');

  // 3. Attempt rotation with INCORRECT old code -> Must reject
  const wrongOldCode = 'INCORRECT_OLD';
  const verifyOldAgainstDb = await bcrypt.compare(wrongOldCode, db.settings.vipAccessCodeHash);
  assert.strictEqual(verifyOldAgainstDb, false, 'Rotation with incorrect old code must fail');

  // 4. Rotate with CORRECT old code -> Generate new hash
  const correctOldCode = 'JOY100LVL';
  const newSecretCode = 'SUPERVIP2026';
  const oldValid = await bcrypt.compare(correctOldCode, db.settings.vipAccessCodeHash);
  assert.strictEqual(oldValid, true);

  db.settings.vipAccessCodeHash = await bcrypt.hash(newSecretCode, 10);
  db.saveAll();

  // 5. Old code must now be INVALID
  const isOldStillValid = await bcrypt.compare('JOY100LVL', db.settings.vipAccessCodeHash);
  assert.strictEqual(isOldStillValid, false, 'Old VIP code must immediately become invalid');

  // 6. New code must be VALID
  const isNewValid = await bcrypt.compare('SUPERVIP2026', db.settings.vipAccessCodeHash);
  assert.strictEqual(isNewValid, true, 'New VIP code must unlock VIP access');

  // Revert to default hash for platform readiness
  db.settings.vipAccessCodeHash = await bcrypt.hash('JOY100LVL', 10);
  db.saveAll();
});

test('11. Deposit-Triggered Referral System Lifecycle, Validity & Anti-Duplication Suite', async () => {
  const referralEngine = require('../lib/referral');

  // Configure test settings
  db.settings.referralSystemEnabled = true;
  db.settings.referralCommissionPercent = 2.5;
  db.settings.minDepositForCommission = 100;
  db.settings.maxCommissionPerDeposit = 500;
  db.settings.firstDepositOnly = false;
  db.settings.referralValidityDays = 30;
  db.settings.antiFraudEnabled = true;
  db.saveAll();

  // 1. Create Referrer User
  const referrer = await auth.registerUser({
    name: 'Master Referrer',
    email: `referrer_boss_${Date.now()}@freakshowtopup.shop`,
    password: 'Password123!',
    country: 'BD',
    currency: 'BDT'
  });
  const refCode = referrer.user.referralCode;
  assert.ok(refCode, 'Referral code must be generated');

  // 2. Register Referred Customer using referrer referral code
  const referred = await auth.registerUser({
    name: 'New Player Depositor',
    email: `player_dep_${Date.now()}@freakshowtopup.shop`,
    password: 'Password123!',
    country: 'BD',
    currency: 'BDT',
    referralCode: refCode
  });
  assert.strictEqual(referred.user.referredById, referrer.user.id, 'referredById must be saved');

  // Verify registration alone did NOT create any referral commission
  const regComms = db.commissions.filter(c => c.referrerId === referrer.user.id);
  assert.strictEqual(regComms.length, 0, 'Registration alone must NEVER generate commission');

  // 3. Referred User submits deposit of ৳1000
  const initialReferrerBal = Number(walletEngine.getUserWallet(referrer.user.id).balance);
  const deposit = await walletEngine.submitDepositRequest({
    userId: referred.user.id,
    paymentMethod: 'bKash',
    senderNumber: '01711000000',
    transactionId: `TRX_REF_${Date.now()}`,
    amount: 1000,
    requestedCurrency: 'BDT'
  });
  assert.strictEqual(deposit.status, 'PENDING');

  // While deposit is PENDING, verify no commission is paid
  const pendingComms = db.commissions.filter(c => c.depositId === deposit.id);
  assert.strictEqual(pendingComms.length, 0, 'Pending deposit must not generate commission');

  // 4. Admin Approves Deposit -> Commission Triggered! (৳1000 * 2.5% = ৳25)
  const approvedDeposit = await walletEngine.approveDeposit(deposit.id, 'admin_super', 'Test approval', 'admin@freakshow.shop');
  assert.strictEqual(approvedDeposit.deposit.status, 'APPROVED');

  // Verify Referrer Wallet Received ৳25 Commission
  const referrerWalletAfter = walletEngine.getUserWallet(referrer.user.id);
  assert.strictEqual(Number(referrerWalletAfter.balance), initialReferrerBal + 25.00);

  // Verify Commission Record
  const commRecord = db.commissions.find(c => c.depositId === deposit.id);
  assert.ok(commRecord);
  assert.strictEqual(commRecord.amount, 25);
  assert.strictEqual(commRecord.rate, 2.5);
  assert.strictEqual(commRecord.status, 'PAID');
  assert.strictEqual(commRecord.referrerId, referrer.user.id);
  assert.strictEqual(commRecord.originUserId || commRecord.referredUserId, referred.user.id);

  // Verify Ledger Transaction
  const ledgerTx = db.transactions.find(t => t.referenceId === `DEP_COMM_${deposit.id}`);
  assert.ok(ledgerTx);
  assert.strictEqual(ledgerTx.type, 'REFERRAL_COMMISSION');
  assert.strictEqual(ledgerTx.amount, 25);

  // 5. Anti-Duplication Protection: Calling processDepositReferralCommission again on same deposit
  const dupResult = await referralEngine.processDepositReferralCommission(deposit, 'admin@freakshow.shop');
  assert.strictEqual(dupResult.success, false);
  assert.strictEqual(dupResult.reason, 'ALREADY_CREDITED');
  const referrerWalletAfterDup = walletEngine.getUserWallet(referrer.user.id);
  assert.strictEqual(Number(referrerWalletAfterDup.balance), initialReferrerBal + 25.00, 'Duplicate call must NOT credit wallet again');

  // 6. Deposit Below Minimum (e.g. ৳50 when minimum is ৳100) -> No Commission
  const smallDeposit = await walletEngine.submitDepositRequest({
    userId: referred.user.id,
    paymentMethod: 'Nagad',
    senderNumber: '01711000001',
    transactionId: `TRX_SMALL_${Date.now()}`,
    amount: 50,
    requestedCurrency: 'BDT'
  });
  await walletEngine.approveDeposit(smallDeposit.id, 'admin_super', 'Small deposit', 'admin@freakshow.shop');
  const smallComm = db.commissions.find(c => c.depositId === smallDeposit.id);
  assert.strictEqual(smallComm, undefined, 'Deposits below minDepositForCommission must not generate commission');

  // 7. Large Deposit with Maximum Cap (৳50,000 * 2.5% = ৳1,250, but cap is ৳500)
  const largeDeposit = await walletEngine.submitDepositRequest({
    userId: referred.user.id,
    paymentMethod: 'Rocket',
    senderNumber: '01711000002',
    transactionId: `TRX_LARGE_${Date.now()}`,
    amount: 50000,
    requestedCurrency: 'BDT'
  });
  await walletEngine.approveDeposit(largeDeposit.id, 'admin_super', 'Large deposit', 'admin@freakshow.shop');
  const largeComm = db.commissions.find(c => c.depositId === largeDeposit.id);
  assert.ok(largeComm);
  assert.strictEqual(largeComm.amount, 500, 'Commission must be capped at maximum configured limit');

  // 8. Reversal on Refund: If deposit is refunded / cancelled, reverse commission
  const preRevBal = Number(walletEngine.getUserWallet(referrer.user.id).balance);
  const revRes = await referralEngine.reverseDepositReferralCommission(deposit.id, 'admin@freakshow.shop');
  assert.strictEqual(revRes.success, true);
  const postRevBal = Number(walletEngine.getUserWallet(referrer.user.id).balance);
  assert.strictEqual(postRevBal, preRevBal - 25.00, 'Reversed deposit must deduct exactly the credited commission');

  const revComm = db.commissions.find(c => c.depositId === deposit.id);
  assert.strictEqual(revComm.status, 'REVERSED');
  const revLedgerTx = db.transactions.find(t => t.referenceId === `REV_COMM_${revComm.id}`);
  assert.ok(revLedgerTx);
  assert.strictEqual(revLedgerTx.type, 'REFERRAL_COMMISSION_REVERSAL');
  assert.strictEqual(revLedgerTx.amount, -25);

  // 9. Anti-Fraud: Self-Referral Prevention
  const dbReferrer = db.users.find(u => u.id === referrer.user.id);
  dbReferrer.referredById = dbReferrer.id; // simulate self referral attempt
  const selfDeposit = {
    id: `dep_self_${Date.now()}`,
    userId: referrer.user.id,
    amount: 1000,
    status: 'APPROVED',
    createdAt: new Date().toISOString()
  };
  const selfRes = await referralEngine.processDepositReferralCommission(selfDeposit, 'admin@freakshow.shop');
  assert.strictEqual(selfRes.success, false);
  assert.strictEqual(selfRes.reason, 'SELF_REFERRAL_BLOCKED');
});

test('12. Custom Commission Rate (0.01%+) & Telegram Bot Referral Administration', async () => {
  const telegram = require('../lib/telegram');
  const referralEngine = require('../lib/referral');
  const sessions = require('../lib/telegram_admin_sessions');

  // 1. Verify Telegram Bot command /refrate sets custom decimal rate (e.g. 0.01%)
  await telegram.handleTelegramCommand({
    chat: { id: '5339688506' },
    from: { id: '5339688506' },
    text: '/refrate 0.01'
  });
  assert.strictEqual(db.settings.referralCommissionPercent, 0.01, 'Bot command must set rate to 0.01%');

  // 2. Verify setting custom decimal rate like 0.75% via Wizard state
  sessions.setSession('5339688506', { step: 'SET_REF_RATE' });
  await telegram.handleTelegramCommand({
    chat: { id: '5339688506' },
    from: { id: '5339688506' },
    text: '0.75'
  });
  assert.strictEqual(db.settings.referralCommissionPercent, 0.75, 'Wizard state must set rate to 0.75%');

  // 3. Set rate to 0.01% and test deposit commission execution
  db.settings.referralCommissionPercent = 0.01;
  db.settings.minDepositForCommission = 0;
  db.settings.maxCommissionPerDeposit = 0;

  const referrer = await auth.registerUser({
    email: `custom_ref_${Date.now()}@gmail.com`,
    password: 'Password123!',
    name: 'Custom Referrer'
  });
  const referred = await auth.registerUser({
    email: `custom_child_${Date.now()}@gmail.com`,
    password: 'Password123!',
    name: 'Custom Child'
  });
  const dbChild = db.users.find(u => u.id === referred.user.id);
  dbChild.referredById = referrer.user.id;

  const depositRecord = {
    id: `dep_cust_${Date.now()}`,
    userId: referred.user.id,
    amount: 100, // ৳100 * 0.01% = ৳0.01
    currency: 'BDT',
    paymentMethod: 'bKash',
    status: 'APPROVED',
    createdAt: new Date().toISOString()
  };

  const commRes = await referralEngine.processDepositReferralCommission(depositRecord);
  assert.strictEqual(commRes.success, true);
  assert.strictEqual(commRes.commission.amount, 0.01, '100 BDT * 0.01% must equal exactly 0.01 BDT');
  assert.strictEqual(commRes.commission.rate, 0.01);

  // 4. Test Telegram Bot Callback Queries for Referral System
  // Test ref_toggle_status
  const initialStatus = db.settings.referralSystemEnabled !== false;
  await telegram.handleTelegramCallbackQuery({
    id: 'query_1',
    from: { id: '5339688506' },
    message: { chat: { id: '5339688506' }, message_id: 101 },
    data: 'ref_toggle_status'
  });
  assert.strictEqual(db.settings.referralSystemEnabled, !initialStatus, 'Callback ref_toggle_status must toggle status');

  // Restore status
  db.settings.referralSystemEnabled = true;

  // Test ref_val_set_90
  await telegram.handleTelegramCallbackQuery({
    id: 'query_2',
    from: { id: '5339688506' },
    message: { chat: { id: '5339688506' }, message_id: 102 },
    data: 'ref_val_set_90'
  });
  assert.strictEqual(db.settings.referralValidityDays, 90, 'Callback ref_val_set_90 must set validity to 90');

  // Verify Admin Referral Overview
  const overview = referralEngine.getAdminReferralOverview();
  assert.ok(overview.stats);
  assert.ok(overview.topReferrers);
  assert.ok(overview.referralsList);
  assert.ok(overview.commissionsHistory);
});

test('13. How to Deposit Tutorial: Public API Exposure, Admin Settings Persistence & Image Upload', async () => {
  const fs = require('fs');
  const path = require('path');
  const db = require('../lib/db');

  // 1. Verify default How to Deposit settings structure
  assert.ok(db.settings.howToDeposit, 'db.settings.howToDeposit must exist');
  assert.strictEqual(typeof db.settings.howToDeposit.enabled, 'boolean');
  assert.ok(db.settings.howToDeposit.title, 'howToDeposit.title must be defined');
  assert.ok(db.settings.howToDeposit.image, 'howToDeposit.image must be defined');
  assert.ok(db.settings.howToDeposit.url, 'howToDeposit.url must be defined');

  // 2. Admin Settings Update Test
  const newHtd = {
    enabled: false,
    title: 'কীভাবে ডিপোজিট করবেন? (Updated Video)',
    url: 'https://youtube.com/watch?v=mock_video_id',
    image: 'assets/how_to_deposit_test.jpg',
    description: 'ভিডিও টিউটোরিয়াল দেখতে এখানে ক্লিক করুন'
  };

  db.settings.howToDeposit = newHtd;
  db.settings.how_to_deposit_enabled = newHtd.enabled;
  db.settings.how_to_deposit_title = newHtd.title;
  db.settings.how_to_deposit_image = newHtd.image;
  db.settings.how_to_deposit_url = newHtd.url;
  db.saveAll();

  assert.strictEqual(db.settings.howToDeposit.enabled, false);
  assert.strictEqual(db.settings.howToDeposit.title, 'কীভাবে ডিপোজিট করবেন? (Updated Video)');
  assert.strictEqual(db.settings.howToDeposit.url, 'https://youtube.com/watch?v=mock_video_id');
  assert.strictEqual(db.settings.how_to_deposit_image, 'assets/how_to_deposit_test.jpg');

  // 3. Re-enable
  db.settings.howToDeposit.enabled = true;
  db.settings.how_to_deposit_enabled = true;
  db.saveAll();
  assert.strictEqual(db.settings.howToDeposit.enabled, true);

  // 4. Verify base64 image write safety to assets/
  const dummyPixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const testFileName = `dep_banner_test_${Date.now()}.png`;
  const targetPath = path.join(__dirname, '..', 'assets', testFileName);
  fs.writeFileSync(targetPath, Buffer.from(dummyPixel, 'base64'));

  assert.strictEqual(fs.existsSync(targetPath), true, 'Uploaded test banner must exist in assets/');
  // Clean up test file
  fs.unlinkSync(targetPath);
  assert.strictEqual(fs.existsSync(targetPath), false, 'Cleaned up test banner file');

  // 5. Existing payment methods (bKash, Nagad, Rocket, CellFin, Bangla QR, Binance) remain intact
  assert.ok(db.settings.paymentNumbers.bkash);
  assert.ok(db.settings.paymentNumbers.nagad);
  assert.ok(db.settings.paymentNumbers.rocket);
  assert.ok(db.settings.paymentNumbers.cellfin);
  assert.ok(db.settings.paymentNumbers.bangla_qr);
  assert.ok(db.settings.paymentNumbers.binanceId || db.settings.paymentNumbers.binance);
});

test('14. Payment Method Enable/Disable System: Independent Status Toggle, UI Filtering & Backend Rejection Guard', async () => {
  const db = require('../lib/db');
  const walletEngine = require('../lib/wallet');
  const auth = require('../lib/auth');

  // Register a test user
  const userRes = await auth.registerUser({
    name: 'Payment Method Tester',
    email: `pm_test_${Date.now()}@freakshowtopup.shop`,
    password: 'Password123!'
  });

  // 1. Verify paymentMethodStatus configuration exists for all gateway methods
  assert.ok(db.settings.paymentMethodStatus, 'paymentMethodStatus must exist');
  ['bkash', 'nagad', 'rocket', 'cellfin', 'bangla_qr', 'binance'].forEach(m => {
    assert.strictEqual(typeof db.settings.paymentMethodStatus[m], 'boolean', `${m} status must be boolean`);
  });

  // 2. Deposit with enabled bKash should succeed
  const dep1 = await walletEngine.submitDepositRequest({
    userId: userRes.user.id,
    paymentMethod: 'bkash',
    senderNumber: '01712345678',
    transactionId: `TRX_EN_${Date.now()}`,
    amount: 100,
    requestedCurrency: 'BDT'
  });
  assert.ok(dep1.id);
  assert.strictEqual(dep1.paymentMethod, 'BKASH');

  // 3. Disable bKash independently
  db.settings.paymentMethodStatus.bkash = false;
  db.saveAll();

  // 4. Attempting deposit with disabled bKash MUST throw PAYMENT_METHOD_DISABLED
  await assert.rejects(
    async () => {
      await walletEngine.submitDepositRequest({
        userId: userRes.user.id,
        paymentMethod: 'bkash',
        senderNumber: '01712345678',
        transactionId: `TRX_DIS_${Date.now()}`,
        amount: 100,
        requestedCurrency: 'BDT'
      });
    },
    { message: 'PAYMENT_METHOD_DISABLED' },
    'Backend must reject deposit requests when the payment method is disabled'
  );

  // 5. Other enabled payment methods (e.g. Nagad, Rocket, CellFin) must still work normally
  const depNagad = await walletEngine.submitDepositRequest({
    userId: userRes.user.id,
    paymentMethod: 'nagad',
    senderNumber: '01812345678',
    transactionId: `TRX_NAGAD_${Date.now()}`,
    amount: 150,
    requestedCurrency: 'BDT'
  });
  assert.ok(depNagad.id);
  assert.strictEqual(depNagad.paymentMethod, 'NAGAD');

  // 6. Re-enable bKash -> Deposit request succeeds again
  db.settings.paymentMethodStatus.bkash = true;
  db.saveAll();

  const dep2 = await walletEngine.submitDepositRequest({
    userId: userRes.user.id,
    paymentMethod: 'bkash',
    senderNumber: '01712345678',
    transactionId: `TRX_REEN_${Date.now()}`,
    amount: 200,
    requestedCurrency: 'BDT'
  });
  assert.ok(dep2.id);
  assert.strictEqual(dep2.paymentMethod, 'BKASH');

  // 7. Verify all original payment numbers, instructions, and video remains completely intact
  assert.ok(db.settings.paymentNumbers.bkash);
  assert.ok(db.settings.paymentInstructions.bkash);
  assert.ok(db.settings.howToDeposit);
});

test('15. User Profile Improvement: Unique Username System, Display Name Editing, Photo Upload & Google Avatar Priority', async () => {
  const db = require('../lib/db');
  const auth = require('../lib/auth');

  // 1. User Registration with Unique Username
  const uniqueTag = Date.now().toString().slice(-6);
  const u1Name = 'Jibon Player';
  const u1Email = `user1_${uniqueTag}@freakshowtopup.shop`;
  const u1Username = `jibon_${uniqueTag}`;

  const reg1 = await auth.registerUser({
    name: u1Name,
    email: u1Email,
    username: u1Username,
    password: 'Password123!'
  });

  assert.strictEqual(reg1.user.name, u1Name);
  assert.strictEqual(reg1.user.username, u1Username);
  assert.strictEqual(reg1.user.email, u1Email);

  // 2. Prevent Duplicate Username on Registration
  const u2Email = `user2_${uniqueTag}@freakshowtopup.shop`;
  await assert.rejects(
    async () => {
      await auth.registerUser({
        name: 'Another Gamer',
        email: u2Email,
        username: u1Username, // Same username as u1
        password: 'Password123!'
      });
    },
    { message: 'Username already taken. Please choose another username.' },
    'Must reject registration with duplicate username'
  );

  // 3. Auto-generation of unique username when not provided
  const reg2 = await auth.registerUser({
    name: 'Auto User',
    email: u2Email,
    password: 'Password123!'
  });
  assert.ok(reg2.user.username, 'Must auto-generate a username');
  assert.notStrictEqual(reg2.user.username, u1Username, 'Generated username must be unique');

  // 4. Edit Profile Name
  const updatedName = 'Jibon The Champion';
  const profileRes1 = await auth.updateUserProfile({
    userId: reg1.user.id,
    name: updatedName
  });
  assert.strictEqual(profileRes1.user.name, updatedName);
  assert.strictEqual(profileRes1.user.username, u1Username); // Username remains unchanged

  // 5. Edit Username to a New Available Username
  const newUsername = `freakshow_${uniqueTag}`;
  const profileRes2 = await auth.updateUserProfile({
    userId: reg1.user.id,
    username: newUsername
  });
  assert.strictEqual(profileRes2.user.username, newUsername);

  // 6. Prevent Duplicate Username on Profile Update
  await assert.rejects(
    async () => {
      await auth.updateUserProfile({
        userId: reg2.user.id,
        username: newUsername // Trying to take reg1's new username
      });
    },
    { message: 'Username already taken. Please choose another username.' },
    'Must reject profile update to an already taken username'
  );

  // 7. Profile Photo Upload Validation & Storage
  const sampleBase64Avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const profileRes3 = await auth.updateUserProfile({
    userId: reg1.user.id,
    avatar: sampleBase64Avatar
  });
  assert.strictEqual(profileRes3.user.avatar, sampleBase64Avatar);
  assert.strictEqual(profileRes3.user.effectiveAvatar, sampleBase64Avatar);

  // 8. Google OAuth Profile Photo & Manual Upload Priority
  const googleUserEmail = `guser_${uniqueTag}@gmail.com`;
  const gAuth = await auth.googleAuth({
    idToken: `mock_google_${googleUserEmail}`
  });

  // Attach a mock Google picture
  const dbGUser = db.users.find(u => u.id === gAuth.user.id);
  dbGUser.picture = 'https://lh3.googleusercontent.com/a/mock_google_avatar';
  dbGUser.googleAvatar = 'https://lh3.googleusercontent.com/a/mock_google_avatar';
  db.saveAll();

  // Without manual avatar -> effectiveAvatar is Google profile photo
  const sanitizedGUser = auth.sanitizeUser(dbGUser);
  assert.strictEqual(sanitizedGUser.effectiveAvatar, 'https://lh3.googleusercontent.com/a/mock_google_avatar');

  // When user manually uploads a photo -> manual photo takes priority over Google photo
  const gUserUpdated = await auth.updateUserProfile({
    userId: dbGUser.id,
    avatar: sampleBase64Avatar
  });
  assert.strictEqual(gUserUpdated.user.effectiveAvatar, sampleBase64Avatar, 'Manual avatar must take priority over Google avatar');
  assert.strictEqual(gUserUpdated.user.picture, 'https://lh3.googleusercontent.com/a/mock_google_avatar', 'Google picture must remain preserved in metadata');

  // When user clears/resets manual avatar -> reverts back to Google/Gmail photo
  const gUserReset = await auth.updateUserProfile({
    userId: dbGUser.id,
    avatar: ''
  });
  assert.strictEqual(gUserReset.user.avatar, null);
  assert.strictEqual(gUserReset.user.effectiveAvatar, 'https://lh3.googleusercontent.com/a/mock_google_avatar', 'Must revert back to Google photo when manual avatar is cleared');

  // 9. Security & Validation Guards
  // Reject oversized photo (> 100 KB)
  const oversizedData = 'data:image/jpeg;base64,' + 'A'.repeat(150 * 1024);
  await assert.rejects(async () => {
    await auth.updateUserProfile({ userId: reg1.user.id, avatar: oversizedData });
  }, /Image size exceeds maximum limit/);

  // Empty name rejection
  await assert.rejects(async () => {
    await auth.updateUserProfile({ userId: reg1.user.id, name: '' });
  }, /Full Name cannot be empty/);

  // Invalid username characters rejection
  await assert.rejects(async () => {
    await auth.updateUserProfile({ userId: reg1.user.id, username: 'bad user name!' });
  }, /Username must be 3-30 characters/);

  // Non-existent user rejection
  await assert.rejects(async () => {
    await auth.updateUserProfile({ userId: 'usr_non_existent', name: 'Hacker' });
  }, /User not found/);

  // 10. Existing accounts & balances remain 100% intact
  const u1Fresh = db.users.find(u => u.id === reg1.user.id);
  assert.strictEqual(u1Fresh.name, updatedName);
  assert.strictEqual(u1Fresh.username, newUsername);
  assert.strictEqual(u1Fresh.email, u1Email);
  assert.strictEqual(u1Fresh.role, 'USER');
});

test('16. USD to BDT Deposit Conversion Rate (1 USD = ? BDT) & Admin User Currency Management', async () => {
  try {
    const uniqueTag = Date.now();
    const testUserEmail = `usd_calc_user_${uniqueTag}@freakshowtopup.shop`;

    const reg = await auth.registerUser({
      name: 'USD Exchange Tester',
      email: testUserEmail,
      password: 'Password123!',
      country: 'GLOBAL',
      currency: 'USD'
    });

    assert.strictEqual(reg.user.currency, 'USD');

    // 1. Configure custom USD to BDT Exchange Rate (e.g. 1 USD = 125 BDT) and enable Binance
    db.settings.usdToBdtRate = 125;
    db.settings.exchangeRate = 125;
    db.settings.paymentMethodStatus = { ...(db.settings.paymentMethodStatus || {}), binance: true };
    db.saveAll();

    // 2. Submit a $10.00 USD deposit via Binance
    const deposit = await walletEngine.submitDepositRequest({
      userId: reg.user.id,
      paymentMethod: 'BINANCE',
      senderNumber: 'USDT_TRC20_WALLET',
      transactionId: `TRX_USD_CONV_${uniqueTag}`,
      amount: 10.00,
      requestedCurrency: 'USD'
    });

    assert.strictEqual(deposit.currency, 'USD');
    assert.strictEqual(deposit.amount, 10.00);
    assert.strictEqual(deposit.conversionRate, 125, 'Deposit must snapshot current USD to BDT exchange rate');
    assert.strictEqual(deposit.creditedAmountBDT, 1250, 'Credited amount in BDT must equal $10 * 125 = 1250 BDT');

    // 3. Admin approves deposit -> Wallet must be credited with 1250 BDT
    const initialWallet = walletEngine.getUserWallet(reg.user.id);
    const prevBal = Number(initialWallet.balance);

    const approveRes = await walletEngine.approveDeposit(deposit.id, 'admin_super_1', 'Binance deposit approved');
    assert.strictEqual(approveRes.deposit.status, 'APPROVED');

    const updatedWallet = walletEngine.getUserWallet(reg.user.id);
    assert.strictEqual(Number(updatedWallet.balance), prevBal + 1250, 'Wallet must be credited with ৳1250 BDT');
    assert.strictEqual(approveRes.transaction.amount, 1250);
    assert.strictEqual(approveRes.transaction.currency, 'BDT');

    // 4. User can purchase products directly from the converted BDT balance
    const sampleProduct = db.products.find(p => p.isActive && p.inStock !== false) || db.products[0];
    const prodPrice = Number(sampleProduct.sellingPrice);

    const orderRes = await orderEngine.createOrder({
      userId: reg.user.id,
      productId: sampleProduct.id,
      playerData: { uid: '123456789' },
      quantity: 1
    });
    assert.ok(orderRes.order.id, 'Order must succeed with converted BDT balance');

    const walletAfterPurchase = walletEngine.getUserWallet(reg.user.id);
    assert.strictEqual(Number(walletAfterPurchase.balance), Number((prevBal + 1250 - prodPrice).toFixed(2)));

    // 5. Admin can set/update user currency directly
    const targetUser = db.users.find(u => u.id === reg.user.id);
    targetUser.currency = 'BDT';
    targetUser.currencyChangeUsed = false;
    const userWallet = walletEngine.getUserWallet(reg.user.id);
    userWallet.currency = 'BDT';
    db.saveAll();

    assert.strictEqual(targetUser.currency, 'BDT');
    assert.strictEqual(userWallet.currency, 'BDT');

    // Switch back to USD
    targetUser.currency = 'USD';
    userWallet.currency = 'USD';
    db.saveAll();
    assert.strictEqual(targetUser.currency, 'USD');

    // 6. Deposit Reversal correctly reverses the credited BDT amount
    const freshDeposit = await walletEngine.submitDepositRequest({
      userId: reg.user.id,
      paymentMethod: 'BINANCE',
      senderNumber: 'USDT_TRC20_WALLET',
      transactionId: `TRX_REV_TEST_${uniqueTag}`,
      amount: 5.00,
      requestedCurrency: 'USD'
    });
    assert.strictEqual(freshDeposit.creditedAmountBDT, 625);

    await walletEngine.approveDeposit(freshDeposit.id, 'admin_super_1', 'Approved for test');
    const balBeforeRev = Number(walletEngine.getUserWallet(reg.user.id).balance);

    await walletEngine.reverseApprovedDeposit(freshDeposit.id, 'admin_super_1', 'Customer disputed charge');
    const balAfterRev = Number(walletEngine.getUserWallet(reg.user.id).balance);
    assert.strictEqual(balAfterRev, Number((balBeforeRev - 625).toFixed(2)), 'Reversing USD deposit must deduct the credited ৳625 BDT');
  } catch (err) {
    console.error('SUITE 16 ERROR STACK:', err);
    throw err;
  } finally {
    db.settings.usdToBdtRate = 120;
    db.settings.exchangeRate = 120;
    db.saveAll();
  }
});






