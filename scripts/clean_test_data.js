/**
 * FREAKSHOWTOPUP - PRODUCTION DATABASE CLEANUP & RESET SCRIPT
 * 
 * Safely removes all test/mock data before production launch:
 * - Wipes all test users (preserves Master Super Admin account)
 * - Wipes test wallets (preserves Master Super Admin wallet with 0.00 balance)
 * - Wipes test orders, deposits, transactions, commissions, and audit logs
 * - Preserves all game categories, products, prices, providers, banners, and settings
 * - Cleans up all dangling .tmp_* files
 * - Automatically creates a complete backup in ./backups/ before modifying anything
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const BACKUP_ROOT = path.join(ROOT_DIR, 'backups');

function createTimestamp() {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-');
}

function safeReadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.warn(`[WARN] Failed to read ${filePath}: ${e.message}`);
  }
  return fallback;
}

function safeWriteJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function cleanTestData() {
  console.log('========================================================');
  console.log('🚀 FREAKSHOWTOPUP - PRODUCTION DATABASE CLEANUP UTILITY');
  console.log('========================================================\n');

  if (!fs.existsSync(DATA_DIR)) {
    console.error(`❌ Data directory not found at: ${DATA_DIR}`);
    process.exit(1);
  }

  // 1. CREATE COMPREHENSIVE BACKUP FIRST
  const backupDir = path.join(BACKUP_ROOT, `pre_production_cleanup_${createTimestamp()}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const allDataFiles = fs.readdirSync(DATA_DIR);
  let backupCount = 0;
  for (const file of allDataFiles) {
    const srcPath = path.join(DATA_DIR, file);
    const destPath = path.join(backupDir, file);
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, destPath);
      backupCount++;
    }
  }
  console.log(`📦 [BACKUP CREATED] ${backupCount} files backed up to:\n   ${backupDir}\n`);

  // 2. LOAD EXISTING COLLECTIONS FOR METRICS
  const usersPath = path.join(DATA_DIR, 'users.json');
  const walletsPath = path.join(DATA_DIR, 'wallets.json');
  const ordersPath = path.join(DATA_DIR, 'orders.json');
  const depositsPath = path.join(DATA_DIR, 'deposits.json');
  const txPath = path.join(DATA_DIR, 'transactions.json');
  const commPath = path.join(DATA_DIR, 'commissions.json');
  const auditPath = path.join(DATA_DIR, 'auditLogs.json');
  const auditAltPath = path.join(DATA_DIR, 'audit_logs.json');

  const users = safeReadJson(usersPath, []);
  const wallets = safeReadJson(walletsPath, []);
  const orders = safeReadJson(ordersPath, []);
  const deposits = safeReadJson(depositsPath, []);
  const transactions = safeReadJson(txPath, []);
  const commissions = safeReadJson(commPath, []);
  const auditLogs = safeReadJson(auditPath, []);

  // 3. IDENTIFY & PRESERVE MASTER SUPER ADMIN ACCOUNT
  let superAdmin = users.find(u => 
    u.role === 'SUPER_ADMIN' || 
    u.email === 'it.jibon05@gmail.com' || 
    (u.telegramId && String(u.telegramId) === '5339688506')
  );

  if (!superAdmin) {
    console.log('⚠️ No existing Super Admin found in users.json. Creating fresh Super Admin...');
    const bcrypt = require('bcryptjs');
    superAdmin = {
      id: 'usr_super_admin_master',
      email: 'it.jibon05@gmail.com',
      username: 'jrjjibon',
      name: 'JRJ JIBON',
      telegramId: '5339688506',
      passwordHash: bcrypt.hashSync('Admin123456!', 12),
      role: 'SUPER_ADMIN',
      country: 'BD',
      currency: 'BDT',
      currencyChangeUsed: true,
      referralCode: 'FSADMIN01',
      referredById: null,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString()
    };
  }

  // Preserve Super Admin Wallet (reset balance to 0.00)
  let adminWallet = wallets.find(w => w.userId === superAdmin.id);
  if (!adminWallet) {
    adminWallet = {
      id: `wal_${superAdmin.id}`,
      userId: superAdmin.id,
      currency: superAdmin.currency || 'BDT',
      balance: 0.00,
      lockedAmount: 0.00,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  } else {
    adminWallet.balance = 0.00;
    adminWallet.lockedAmount = 0.00;
    adminWallet.updatedAt = new Date().toISOString();
  }

  // 4. WRITE CLEANED DATA COLLECTIONS
  safeWriteJson(usersPath, [superAdmin]);
  safeWriteJson(walletsPath, [adminWallet]);
  safeWriteJson(ordersPath, []);
  safeWriteJson(depositsPath, []);
  safeWriteJson(txPath, []);
  safeWriteJson(commPath, []);
  safeWriteJson(auditPath, []);
  if (fs.existsSync(auditAltPath)) {
    safeWriteJson(auditAltPath, []);
  }

  // 5. REMOVE ALL DANGLING .tmp_* FILES
  let tmpCleaned = 0;
  for (const file of fs.readdirSync(DATA_DIR)) {
    if (file.includes('.tmp_')) {
      try {
        fs.unlinkSync(path.join(DATA_DIR, file));
        tmpCleaned++;
      } catch (e) { }
    }
  }

  console.log('--------------------------------------------------------');
  console.log('📊 CLEANUP SUMMARY & PRODUCTION METRICS:');
  console.log('--------------------------------------------------------');
  console.log(`👤 Users:        ${users.length} ➔ 1 (Super Admin Preserved: ${superAdmin.email} | @${superAdmin.username})`);
  console.log(`💳 Wallets:      ${wallets.length} ➔ 1 (Admin Wallet Reset to ৳0.00 BDT)`);
  console.log(`📦 Orders:       ${orders.length} ➔ 0 (Empty array [])`);
  console.log(`💰 Deposits:     ${deposits.length} ➔ 0 (Empty array [])`);
  console.log(`🧾 Transactions: ${transactions.length} ➔ 0 (Empty array [])`);
  console.log(`🎁 Commissions:  ${commissions.length} ➔ 0 (Empty array [])`);
  console.log(`🛡️ Audit Logs:   ${auditLogs.length} ➔ 0 (Empty array [])`);
  console.log(`🧹 Temp Files:   ${tmpCleaned} stale .tmp files safely deleted`);
  console.log('--------------------------------------------------------');
  console.log('✅ PRESERVED BUSINESS STRUCTURES:');
  console.log('   • Game Categories (categories.json): Intact');
  console.log('   • Products & Diamond Packages (products.json): Intact');
  console.log('   • Payment Settings & Rate (settings.json): Intact (1 USD = 120 BDT)');
  console.log('   • Supplier Provider Adapter (providers.json): Intact');
  console.log('   • Promotional Banners (banners.json): Intact');
  console.log('========================================================');
  console.log('🎉 PRODUCTION CLEANUP COMPLETED SUCCESSFULLY!');
  console.log('========================================================\n');
}

cleanTestData().catch(err => {
  console.error('❌ Error during cleanup:', err);
  process.exit(1);
});
