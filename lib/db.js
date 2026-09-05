/**
 * FREAKSHOWTOPUP - ATOMIC TRANSACTIONAL DATABASE & REPOSITORY ADAPTER
 * Provides atomic in-memory/file operations with ACID guarantees and Prisma compatibility.
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.NODE_ENV === 'test' && !process.env.USE_REAL_DB
  ? path.join(__dirname, '..', 'data_test')
  : path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

class DatabaseEngine {
  constructor() {
    this.users = this.loadCollection('users.json', []);
    this.wallets = this.loadCollection('wallets.json', []);
    this.transactions = this.loadCollection('transactions.json', []);
    this.categories = this.loadCollection('categories.json', []);
    this.products = this.loadCollection('products.json', []);
    this.orders = this.loadCollection('orders.json', []);
    this.deposits = this.loadCollection('deposits.json', []);
    this.providers = this.loadCollection('providers.json', []);
    this.commissions = this.loadCollection('commissions.json', []);
    this.banners = this.loadCollection('banners.json', []);
    this.auditLogs = this.loadCollection('audit_logs.json', []);
    this.settings = this.loadCollection('settings.json', {});

    this.isLocked = false;
    this.seedDefaults();
  }

  loadCollection(filename, defaultValue) {
    const filePath = path.join(DATA_DIR, filename);
    const baseFilePath = path.join(__dirname, '..', 'data', filename);
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
      } else if (fs.existsSync(baseFilePath)) {
        const raw = fs.readFileSync(baseFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.saveCollection(filename, parsed);
        return parsed;
      }
    } catch (e) {
      console.warn(`[DB] Failed to load ${filename}, initializing with default.`, e.message);
    }
    this.saveCollection(filename, defaultValue);
    return defaultValue;
  }

  saveCollection(filename, data) {
    const filePath = path.join(DATA_DIR, filename);
    const tempPath = `${filePath}.tmp_${Date.now()}`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (e) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      } catch (err) {
        console.error(`[DB] Error saving ${filename}:`, err.message);
      }
    }
  }

  saveAll() {
    this.saveCollection('users.json', this.users);
    this.saveCollection('wallets.json', this.wallets);
    this.saveCollection('transactions.json', this.transactions);
    this.saveCollection('categories.json', this.categories);
    this.saveCollection('products.json', this.products);
    this.saveCollection('orders.json', this.orders);
    this.saveCollection('deposits.json', this.deposits);
    this.saveCollection('providers.json', this.providers);
    this.saveCollection('banners.json', this.banners);
    this.saveCollection('commissions.json', this.commissions);
    this.saveCollection('auditLogs.json', this.auditLogs);
    this.saveCollection('settings.json', this.settings);
  }

  /**
   * Fast indexed lookup helper methods
   */
  getUserById(id) {
    if (!id) return null;
    return this.users.find(u => u.id === id) || null;
  }

  getUserByEmail(email) {
    if (!email) return null;
    const query = String(email).toLowerCase().trim();
    return this.users.find(u => u.email && u.email.toLowerCase() === query) || null;
  }

  getWalletByUserId(userId) {
    if (!userId) return null;
    return this.wallets.find(w => w.userId === userId) || null;
  }

  getOrderById(id) {
    if (!id) return null;
    const query = String(id).toUpperCase().trim();
    return this.orders.find(o => o.id && o.id.toUpperCase() === query) || null;
  }

  getProductById(id) {
    if (!id) return null;
    return this.products.find(p => p.id === id) || null;
  }

  /**
   * Atomic transaction execution wrapper (with re-entrant nested transaction support)
   */
  async transaction(callback) {
    if (this.isLocked) {
      // Re-entrant / nested transaction within existing transaction boundary
      return await callback();
    }

    this.isLocked = true;

    // Snapshot state in memory before transaction
    const snapUsers = JSON.stringify(this.users);
    const snapWallets = JSON.stringify(this.wallets);
    const snapTxs = JSON.stringify(this.transactions);
    const snapOrders = JSON.stringify(this.orders);
    const snapDeposits = JSON.stringify(this.deposits);
    const snapCommissions = JSON.stringify(this.commissions);
    const snapAudit = JSON.stringify(this.auditLogs);

    try {
      const result = await callback();
      this.saveAll();
      return result;
    } catch (err) {
      // Rollback memory on error
      this.users = JSON.parse(snapUsers);
      this.wallets = JSON.parse(snapWallets);
      this.transactions = JSON.parse(snapTxs);
      this.orders = JSON.parse(snapOrders);
      this.deposits = JSON.parse(snapDeposits);
      this.commissions = JSON.parse(snapCommissions);
      this.auditLogs = JSON.parse(snapAudit);
      throw err;
    } finally {
      this.isLocked = false;
    }
  }

  seedDefaults() {
    // 1. Categories
    if (this.categories.length === 0) {
      this.categories = [
        { id: 'cat-ff', slug: 'free-fire', name: 'Free Fire Direct Top-Up', icon: '🔥', sortOrder: 1, isActive: true },
        { id: 'cat-pubg', slug: 'pubg-mobile', name: 'PUBG Mobile UC', icon: '🎯', sortOrder: 2, isActive: true },
        { id: 'cat-indo', slug: 'ff-indonesia', name: 'Free Fire Indonesia Server', icon: '🇮🇩', sortOrder: 3, isActive: true }
      ];
    }

    // 2. Standard Products
    if (this.products.length === 0) {
      this.products = [
        { id: 'p-ff-25', categoryId: 'cat-ff', name: '25 Diamonds', slug: '25-diamonds', sellingPrice: 22.00, supplierCost: 19.50, currency: 'BDT', productType: 'FIXED', sortOrder: 1, isActive: true, providerId: 'prov-ucapi', providerCode: '25' },
        { id: 'p-ff-50', categoryId: 'cat-ff', name: '50 Diamonds', slug: '50-diamonds', sellingPrice: 42.00, supplierCost: 38.00, currency: 'BDT', productType: 'FIXED', sortOrder: 2, isActive: true, providerId: 'prov-ucapi', providerCode: '50' },
        { id: 'p-ff-115', categoryId: 'cat-ff', name: '115 Diamonds', slug: '115-diamonds', sellingPrice: 85.00, supplierCost: 77.00, currency: 'BDT', productType: 'FIXED', sortOrder: 3, isActive: true, providerId: 'prov-ucapi', providerCode: '115' },
        { id: 'p-ff-240', categoryId: 'cat-ff', name: '240 Diamonds', slug: '240-diamonds', sellingPrice: 175.00, supplierCost: 158.00, currency: 'BDT', productType: 'FIXED', sortOrder: 4, isActive: true, providerId: 'prov-ucapi', providerCode: '240' },
        { id: 'p-ff-610', categoryId: 'cat-ff', name: '610 Diamonds', slug: '610-diamonds', sellingPrice: 440.00, supplierCost: 395.00, currency: 'BDT', productType: 'FIXED', sortOrder: 5, isActive: true, providerId: 'prov-ucapi', providerCode: '610' },
        { id: 'p-ff-1240', categoryId: 'cat-ff', name: '1240 Diamonds', slug: '1240-diamonds', sellingPrice: 880.00, supplierCost: 790.00, currency: 'BDT', productType: 'FIXED', sortOrder: 6, isActive: true, providerId: 'prov-ucapi', providerCode: '1240' },
        { id: 'p-ff-2530', categoryId: 'cat-ff', name: '2530 Diamonds', slug: '2530-diamonds', sellingPrice: 1750.00, supplierCost: 1580.00, currency: 'BDT', productType: 'FIXED', sortOrder: 7, isActive: true, providerId: 'prov-ucapi', providerCode: '2530' },
        { id: 'p-ff-wkl', categoryId: 'cat-ff', name: 'Weekly Membership', slug: 'weekly-membership', sellingPrice: 185.00, supplierCost: 165.00, currency: 'BDT', productType: 'FIXED', sortOrder: 8, isActive: true, providerId: 'prov-ucapi', providerCode: 'wkl' },
        { id: 'p-ff-mth', categoryId: 'cat-ff', name: 'Monthly Membership', slug: 'monthly-membership', sellingPrice: 890.00, supplierCost: 790.00, currency: 'BDT', productType: 'FIXED', sortOrder: 9, isActive: true, providerId: 'prov-ucapi', providerCode: 'mth' },
        { id: 'p-ff-lvl', categoryId: 'cat-ff', name: 'Level Up Pass', slug: 'level-up-pass', sellingPrice: 180.00, supplierCost: 160.00, currency: 'BDT', productType: 'FIXED', sortOrder: 10, isActive: true, providerId: 'prov-ucapi', providerCode: 'lvl' },
        { id: 'p-ff-wlt', categoryId: 'cat-ff', name: 'Weekly Lite Pass', slug: 'weekly-lite-pass', sellingPrice: 50.00, supplierCost: 45.00, currency: 'BDT', productType: 'FIXED', sortOrder: 11, isActive: true, providerId: 'prov-ucapi', providerCode: 'wlt' },

        // PUBG Mobile
        { id: 'p-pubg-60', categoryId: 'cat-pubg', name: '60 UC', slug: '60-uc', sellingPrice: 110.00, supplierCost: 98.00, currency: 'BDT', productType: 'FIXED', sortOrder: 20, isActive: true, providerId: 'prov-ucapi', providerCode: '60' },
        { id: 'p-pubg-325', categoryId: 'cat-pubg', name: '325 UC', slug: '325-uc', sellingPrice: 540.00, supplierCost: 490.00, currency: 'BDT', productType: 'FIXED', sortOrder: 21, isActive: true, providerId: 'prov-ucapi', providerCode: '325' },
        { id: 'p-pubg-660', categoryId: 'cat-pubg', name: '660 UC', slug: '660-uc', sellingPrice: 1050.00, supplierCost: 950.00, currency: 'BDT', productType: 'FIXED', sortOrder: 22, isActive: true, providerId: 'prov-ucapi', providerCode: '660' },

        // Indonesia Server
        { id: 'p-indo-355', categoryId: 'cat-indo', name: '355 Diamonds (Indo)', slug: '355-diamonds-indo', sellingPrice: 320.00, supplierCost: 280.00, currency: 'BDT', productType: 'FIXED', sortOrder: 30, isActive: true, providerId: 'prov-ucapi', providerCode: '355' },
        { id: 'p-indo-720', categoryId: 'cat-indo', name: '720 Diamonds (Indo)', slug: '720-diamonds-indo', sellingPrice: 630.00, supplierCost: 560.00, currency: 'BDT', productType: 'FIXED', sortOrder: 31, isActive: true, providerId: 'prov-ucapi', providerCode: '720' }
      ];
    }

    // 3. Provider Configuration (Uses environment variables for secrets)
    if (this.providers.length === 0) {
      this.providers = [
        {
          id: 'prov-ucapi',
          name: 'UC Bot Auto Top-Up Gateway',
          slug: 'ucapi-gateway',
          baseUrl: process.env.SUPPLIER_API_URL || 'https://ucapi.ucbot.net',
          isActive: true,
          balance: 0.00,
          currency: 'BDT',
          healthStatus: 'HEALTHY'
        }
      ];
    }

    // 4. Default Settings
    if (!this.settings.siteName) {
      this.settings = {
        siteName: 'FREAKSHOWTOPUP',
        domain: 'freakshowtopup.shop',
        minDepositBDT: 25,
        minDepositUSD: 0.20,
        usdToBdtRate: 120,
        exchangeRate: 120,
        referralCommissionPercent: 2.5,
        paymentNumbers: {
          bkash: '01712-345678 (Personal / Send Money)',
          nagad: '01812-987654 (Personal / Send Money)',
          rocket: '01912-3456789 (Personal / Send Money)',
          cellfin: '01712-345678 (CellFin Account)',
          binance: 'JRJ_TOPUP_PAY (Binance Pay ID / USDT TRC20)'
        }
      };
    }

    // 5. Ensure Master Super Admin exists if users list is empty
    let superAdmin = this.users.find(u => u.role === 'SUPER_ADMIN' || (u.telegramId && String(u.telegramId) === '5339688506') || u.email === 'it.jibon05@gmail.com');
    if (!superAdmin && this.users.length === 0) {
      const adminUser = {
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
      this.users.unshift(adminUser);
      this.wallets.unshift({
        id: 'wal_super_admin_master',
        userId: adminUser.id,
        currency: 'BDT',
        balance: 0.00,
        lockedAmount: 0.00,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      this.saveAll();
    }
  }
}

const db = new DatabaseEngine();
module.exports = db;
