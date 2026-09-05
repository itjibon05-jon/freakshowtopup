/**
 * FREAKSHOWTOPUP - SUPPLIER PROVIDER ABSTRACTION ARCHITECTURE (PRODUCTION GRADE)
 * Implements clean SupplierService abstraction, secure HTTP adapter with environment variable keys,
 * and reliable Mock adapter for isolated automated unit tests.
 */

const https = require('https');
const http = require('http');

/**
 * Base Abstract Provider Adapter
 */
class BaseProviderAdapter {
  constructor(providerRecord) {
    this.provider = providerRecord || {};
  }

  async getBalance() {
    throw new Error('getBalance() must be implemented by adapter subclass.');
  }

  async createTopUp(params) {
    throw new Error('createTopUp() must be implemented by adapter subclass.');
  }

  async getOrderStatus(providerOrderId) {
    throw new Error('getOrderStatus() must be implemented by adapter subclass.');
  }

  async getHistory() {
    throw new Error('getHistory() must be implemented by adapter subclass.');
  }
}

/**
 * 1. MOCK PROVIDER ADAPTER (Isolated Testing & Zero-Dependency Offline Dev)
 */
class MockProviderAdapter extends BaseProviderAdapter {
  async getBalance() {
    return {
      success: true,
      balance: 50000.00,
      currency: 'BDT',
      status: 'OK'
    };
  }

  async createTopUp({ orderId, productCode, playerData, quantity, idempotencyKey, categorySlug }) {
    await new Promise(r => setTimeout(r, 50)); // Fast micro-delay

    let parsed = {};
    if (typeof playerData === 'object') {
      parsed = playerData;
    } else {
      try { parsed = JSON.parse(playerData || '{}'); } catch (e) { parsed = { uid: playerData }; }
    }

    const uid = String(parsed.uid || parsed.playerId || '').trim();

    // Simulated Provider Failure for UID starting with 999
    if (uid.startsWith('999')) {
      return {
        success: false,
        status: 'FAILED',
        providerOrderId: `MOCK_FAIL_${Date.now()}`,
        message: 'Invalid Player UID or Region Mismatch from Provider',
        rawResponse: { status: 'error', error: 'PLAYER_NOT_FOUND' }
      };
    }

    // Simulated Queued/Processing State for UID starting with 888
    if (uid.startsWith('888')) {
      return {
        success: true,
        status: 'PROCESSING',
        providerOrderId: `MOCK_PROC_${Date.now()}`,
        message: 'Supplier order queued for manual processing',
        rawResponse: { status: 'queued', code: 202 }
      };
    }

    // Standard Success Response
    return {
      success: true,
      status: 'SUCCESS',
      providerOrderId: `MOCK_TX_${Math.floor(100000 + Math.random() * 900000)}`,
      username: parsed.username || 'Verified Pro Gamer',
      message: 'Direct Top-Up delivered successfully to game server',
      rawResponse: { status: 'success', deliveredAt: new Date().toISOString() }
    };
  }

  async getOrderStatus(providerOrderId) {
    if (providerOrderId && providerOrderId.includes('FAIL')) {
      return { status: 'FAILED', message: 'Order failed at provider' };
    }
    return { status: 'SUCCESS', message: 'Delivered' };
  }

  async getHistory() {
    return { success: true, history: [] };
  }
}

/**
 * 2. HTTP REST SUPPLIER API ADAPTER (ucapi.ucbot.net Gateway)
 */
class HttpSupplierAdapter extends BaseProviderAdapter {
  constructor(providerRecord) {
    super(providerRecord);
    this.baseUrl = process.env.SUPPLIER_API_URL || providerRecord.baseUrl || 'https://ucapi.ucbot.net';
    this.apiKey = process.env.SUPPLIER_API_KEY || providerRecord.apiKeyEnc || '';
  }

  async request(endpoint, method = 'GET', body = null) {
    if (!this.apiKey) {
      throw new Error('SUPPLIER_API_KEY is not configured in server environment variables.');
    }

    const url = new URL(endpoint, this.baseUrl);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'authorization': this.apiKey
    };

    return new Promise((resolve, reject) => {
      const req = client.request(url, { method, headers, timeout: 25000 }, (res) => {
        let rawData = '';
        res.on('data', chunk => rawData += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(rawData);
            resolve({ statusCode: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: rawData });
          }
        });
      });

      req.on('error', (err) => reject(new Error(`Supplier Network Error: ${err.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('SUPPLIER_TIMEOUT'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async getBalance() {
    try {
      const res = await this.request('/api/balance', 'GET');
      if (res.statusCode === 200 && res.data) {
        const wallet = Number(res.data.wallet || 0);
        const dueLimit = Number(res.data.due_limit || 0);
        const dueConsumed = Number(res.data.due || 0);
        const dueLeft = Number(res.data.due_left !== undefined ? res.data.due_left : (res.data.balance || 0));
        
        // Exact balance available for new top-ups
        const balanceAvailable = wallet + dueLeft;
        // Total loaded / credit limit
        const totalLimit = dueLimit > 0 ? (dueLimit + wallet) : (balanceAvailable + dueConsumed);

        return {
          success: true,
          balance: Number(balanceAvailable.toFixed(2)),
          totalLimit: Number(totalLimit.toFixed(2)),
          consumed: Number(dueConsumed.toFixed(2)),
          wallet,
          dueLimit,
          dueConsumed,
          dueLeft,
          currency: 'BDT',
          raw: res.data,
          status: 'OK'
        };
      }
      return { success: false, balance: 0.00, totalLimit: 0.00, consumed: 0.00, message: res.data ? res.data.message : 'Failed to query balance' };
    } catch (err) {
      return { success: false, balance: 0.00, totalLimit: 0.00, consumed: 0.00, message: err.message };
    }
  }

  async createTopUp({ orderId, productCode, productName, playerData, quantity = 1, categorySlug = 'cat-ff' }) {
    let parsedPlayerData = {};
    if (typeof playerData === 'object') {
      parsedPlayerData = playerData;
    } else {
      try { parsedPlayerData = JSON.parse(playerData || '{}'); } catch (e) { parsedPlayerData = { uid: playerData }; }
    }

    const uid = String(parsedPlayerData.uid || parsedPlayerData.playerId || '').trim();

    // Map to official supplier endpoint based on game category
    let endpoint = '/api/topup';
    const isIndo = (categorySlug && (categorySlug.includes('indo') || categorySlug === 'ff-indonesia')) ||
                   (productName && (productName.toUpperCase().includes('INDO') || productName.toUpperCase().includes('INDONESIA'))) ||
                   (productCode && String(productCode).toLowerCase().includes('indo'));

    const isPubg = (categorySlug && categorySlug.includes('pubg')) ||
                   (productName && productName.toUpperCase().includes('UC')) ||
                   (productCode && String(productCode).toLowerCase().includes('pubg'));

    if (isPubg) {
      endpoint = '/api/uc';
    } else if (isIndo) {
      endpoint = '/api/indo';
    }

    // 1. Authoritative Item Code & Quantity Resolution (Ktp / Kbaki / Klike Engine)
    let rawCode = String(productCode || '').toLowerCase()
      .replace(/^ktp\s+uid\s+/i, '')
      .replace(/^kbaki\s+/i, '')
      .replace(/^klikesub\s*(uid|\{uid\}|[0-9]+)?\s*/i, 'klikesub ')
      .replace(/^klike200\s*(uid|\{uid\}|[0-9]+)?/i, 'like200')
      .replace(/^klike\s*(uid|\{uid\}|[0-9]+)?/i, 'like100')
      .replace(/^\/topup\s+(\{uid\}|[0-9]+)?\s*/i, '')
      .trim();
    let itemCode = rawCode;
    let finalQty = parseInt(quantity, 10) || 1;

    // A. Unipin Voucher (Kbaki Engine - Code Delivery)
    const isUnipin = rawCode.includes('unipin') || rawCode.includes('voucher') || rawCode.includes('kbaki') || (productName && productName.toLowerCase().includes('unipin'));
    if (isUnipin) {
      endpoint = '/api/uc';
      const unipinMap = {
        '25': '20',
        '50': '36',
        '115': '80',
        '240': '160',
        '610': '405',
        '1240': '810',
        '2530': '1625',
        'weekly': '161',
        'monthly': '800',
        '2000': '2000'
      };

      if (rawCode.includes('weekly')) itemCode = unipinMap['weekly'];
      else if (rawCode.includes('monthly')) itemCode = unipinMap['monthly'];
      else if (rawCode.includes('2530')) itemCode = unipinMap['2530'];
      else if (rawCode.includes('1240')) itemCode = unipinMap['1240'];
      else if (rawCode.includes('610')) itemCode = unipinMap['610'];
      else if (rawCode.includes('240')) itemCode = unipinMap['240'];
      else if (rawCode.includes('115')) itemCode = unipinMap['115'];
      else if (rawCode.includes('50')) itemCode = unipinMap['50'];
      else if (rawCode.includes('25')) itemCode = unipinMap['25'];
      else if (rawCode.includes('2000')) itemCode = unipinMap['2000'];
      else {
        itemCode = '20';
      }
      finalQty = Math.min(5, Math.max(1, finalQty));
    }
    // B. Level Up Pass (lvl6, lvl10, lvl15, lvl20, lvl25, lvl30, lvlall)
    else if (rawCode.includes('lvl') || rawCode.includes('level')) {
      if (rawCode.includes('lvl-6') || rawCode.includes('lvl_6') || rawCode === 'lvl6' || rawCode.includes('level-6')) itemCode = 'lvl6';
      else if (rawCode.includes('lvl-10') || rawCode.includes('lvl_10') || rawCode === 'lvl10' || rawCode.includes('level-10')) itemCode = 'lvl10';
      else if (rawCode.includes('lvl-15') || rawCode.includes('lvl_15') || rawCode === 'lvl15' || rawCode.includes('level-15')) itemCode = 'lvl15';
      else if (rawCode.includes('lvl-20') || rawCode.includes('lvl_20') || rawCode === 'lvl20' || rawCode.includes('level-20')) itemCode = 'lvl20';
      else if (rawCode.includes('lvl-25') || rawCode.includes('lvl_25') || rawCode === 'lvl25' || rawCode.includes('level-25')) itemCode = 'lvl25';
      else if (rawCode.includes('lvl-30') || rawCode.includes('lvl_30') || rawCode === 'lvl30' || rawCode.includes('level-30')) itemCode = 'lvl30';
      else if (rawCode.includes('full') || rawCode.includes('all') || rawCode === 'lvlall') itemCode = 'lvlall';
      else itemCode = 'lvlall';
    }
    // C. Like Booster & Subscriptions (Klike, Klike200, Klikesub 3/5/7/15/30 days)
    else if (rawCode.includes('like')) {
      if (rawCode.includes('sub') || rawCode.includes('klikesub')) {
        const subMatch = rawCode.match(/(\d+)\s+(\d+)/) || rawCode.match(/_(\d+)_(\d+)/);
        if (subMatch) {
          const days = subMatch[1];
          const likes = subMatch[2];
          itemCode = `likesub_${days}_${likes}`;
        } else if (rawCode.includes('200')) {
          itemCode = 'likesub_30_200';
        } else {
          itemCode = 'likesub_30_100';
        }
      } else if (rawCode.includes('200') || rawCode === 'klike200' || rawCode === 'like200') {
        itemCode = 'like200';
      } else {
        itemCode = 'like100';
      }
    }
    // D. Booyah Pass & Special Events
    else if (rawCode.includes('booyah')) {
      itemCode = 'booyah';
    }
    // D.2 LESS IS MORE (ktp uid less)
    else if (rawCode.includes('less')) {
      itemCode = 'less';
      finalQty = 1;
    }
    // E. Weekly Lite Pass (lite 1, 2, 3, 5, 10)
    else if (rawCode.includes('wl-') || rawCode.includes('weekly-lite') || rawCode === 'lite' || rawCode === 'wlt') {
      if (rawCode === 'p-ff-wl-1') finalQty = 1;
      else if (rawCode === 'p-ff-wl-2') finalQty = 2;
      else if (rawCode === 'p-ff-wl-3') finalQty = 3;
      else if (rawCode === 'p-ff-wl-5') finalQty = 5;
      else if (rawCode === 'p-ff-wl-10') finalQty = 5;
      itemCode = 'lite';
    }
    // F. Weekly & Monthly Memberships (weekly, monthly - up to 5x)
    else if (rawCode.includes('wm-') || rawCode.includes('vip-') || rawCode.includes('std-') || rawCode.includes('weekly') || rawCode.includes('monthly') || rawCode === 'wkl' || rawCode === 'mth' || rawCode === '161' || rawCode === '800') {
      if (rawCode.includes('m5') || rawCode.includes('monthly 5') || rawCode.includes('monthly5') || rawCode.includes('monthly-5')) {
        itemCode = 'monthly';
        finalQty = 5;
      } else if (rawCode.includes('m3') || rawCode.includes('monthly 3') || rawCode.includes('monthly3') || rawCode.includes('monthly-3')) {
        itemCode = 'monthly';
        finalQty = 3;
      } else if (rawCode.includes('m2') || rawCode.includes('monthly 2') || rawCode.includes('monthly2') || rawCode.includes('monthly-2')) {
        itemCode = 'monthly';
        finalQty = 2;
      } else if (rawCode.includes('m1') || rawCode === 'monthly' || rawCode === 'mth' || rawCode === '800' || rawCode.includes('monthly 1')) {
        itemCode = 'monthly';
        finalQty = 1;
      } else if (rawCode.includes('w5') || rawCode.includes('weekly 5') || rawCode.includes('weekly5') || rawCode.includes('weekly-5')) {
        itemCode = 'weekly';
        finalQty = 5;
      } else if (rawCode.includes('w3') || rawCode.includes('weekly 3') || rawCode.includes('weekly3') || rawCode.includes('weekly-3')) {
        itemCode = 'weekly';
        finalQty = 3;
      } else if (rawCode.includes('w2') || rawCode.includes('weekly 2') || rawCode.includes('weekly2') || rawCode.includes('weekly-2')) {
        itemCode = 'weekly';
        finalQty = 2;
      } else {
        itemCode = 'weekly';
        if (quantity) finalQty = parseInt(quantity, 10) || 1;
      }
    }
    // G. Large Packs (5060 = 2530 x 2, 10120 = 2530 x 4)
    else if (rawCode.includes('5060')) {
      itemCode = '2530';
      finalQty = 2;
    }
    else if (rawCode.includes('10120')) {
      itemCode = '2530';
      finalQty = 4;
    }
    // H. Standard Diamond packs (25, 50, 115, 240, 610, 1240, 2530, etc.)
    else {
      itemCode = rawCode.replace('p-ff-', '').replace('p-pubg-', '').replace('p-indo-', '');
      if (itemCode === '50') {
        endpoint = '/api/indo';
      }
    }

    const payload = {
      item: itemCode,
      qty: finalQty
    };

    if (endpoint !== '/api/uc' && uid && uid !== 'CODE_DELIVERY' && uid !== 'DIGITAL_PIN_DELIVERY') {
      payload.uid = uid;
    }

    console.log(`[SUPPLIER DISPATCH] POST ${endpoint}:`, JSON.stringify(payload));

    const res = await this.request(endpoint, 'POST', payload);
    console.log(`[SUPPLIER RESPONSE] Status ${res.statusCode}:`, JSON.stringify(res.data || res.raw));

    if (res.statusCode === 200 && res.data) {
      const isSuccess = res.data.status === 'success' || res.data.status === 'ok' || res.data.success === true;
      const isProcessing = res.data.status === 'processing' || res.data.status === 'pending';

      if (isSuccess) {
        let deliveredCode = null;
        if (res.data.uc_list && Array.isArray(res.data.uc_list) && res.data.uc_list.length > 0) {
          deliveredCode = res.data.uc_list.join('\n');
        } else if (res.data.batch && Array.isArray(res.data.batch) && res.data.batch.length > 0) {
          deliveredCode = res.data.batch.map(b => b.uc || b.code || b.voucher || b.pin).filter(Boolean).join('\n');
        } else if (res.data.vouchers && Array.isArray(res.data.vouchers) && res.data.vouchers.length > 0) {
          deliveredCode = res.data.vouchers.join('\n');
        } else if (res.data.pins && Array.isArray(res.data.pins) && res.data.pins.length > 0) {
          deliveredCode = res.data.pins.join('\n');
        } else if (res.data.cards && Array.isArray(res.data.cards) && res.data.cards.length > 0) {
          deliveredCode = res.data.cards.join('\n');
        } else if (res.data.uc) {
          deliveredCode = res.data.uc;
        } else if (res.data.code) {
          deliveredCode = res.data.code;
        } else if (res.data.voucher) {
          deliveredCode = res.data.voucher;
        } else if (res.data.pin) {
          deliveredCode = res.data.pin;
        }

        return {
          success: true,
          status: 'SUCCESS',
          providerOrderId: res.data.order_id || res.data.transaction_id || res.data.request_id || `TP-${Date.now()}`,
          username: res.data.username || (res.data.batch && res.data.batch[0] && res.data.batch[0].username) || null,
          code: deliveredCode,
          rawResponse: res.data,
          message: 'Top-Up delivered successfully'
        };
      }

      if (isProcessing) {
        return {
          success: true,
          status: 'PROCESSING',
          providerOrderId: res.data.order_id || res.data.request_id || `PROC-${Date.now()}`,
          rawResponse: res.data,
          message: 'Order is processing with supplier'
        };
      }

      // Explicit Failure
      return {
        success: false,
        status: 'FAILED',
        providerOrderId: res.data.order_id || null,
        errorMessage: res.data.error || res.data.message || 'Provider rejected top-up request',
        rawResponse: res.data
      };
    }

    return {
      success: false,
      status: 'FAILED',
      errorMessage: `Provider returned HTTP ${res.statusCode}: ${JSON.stringify(res.data || res.raw)}`,
      rawResponse: res.data || res.raw
    };
  }

  async getOrderStatus(providerOrderId) {
    if (!providerOrderId) return { status: 'UNKNOWN' };
    try {
      const res = await this.request(`/api/status?order_id=${encodeURIComponent(providerOrderId)}`, 'GET');
      if (res.statusCode === 200 && res.data) {
        return {
          status: res.data.status === 'success' ? 'SUCCESS' : (res.data.status === 'processing' ? 'PROCESSING' : 'FAILED'),
          raw: res.data
        };
      }
    } catch (e) {}
    return { status: 'UNKNOWN' };
  }

  async getHistory() {
    try {
      const res = await this.request('/api/history', 'GET');
      return { success: true, history: res.data || [] };
    } catch (e) {
      return { success: false, history: [] };
    }
  }
}

/**
 * Factory to instantiate the appropriate adapter
 */
function getProviderAdapter(providerRecord = {}) {
  // Use mock adapter during test mode or if supplier key is absent
  if (process.env.NODE_ENV === 'test' || (!process.env.SUPPLIER_API_KEY && !providerRecord.apiKeyEnc)) {
    return new MockProviderAdapter(providerRecord);
  }
  return new HttpSupplierAdapter(providerRecord);
}

module.exports = {
  BaseProviderAdapter,
  MockProviderAdapter,
  HttpSupplierAdapter,
  getProviderAdapter
};
