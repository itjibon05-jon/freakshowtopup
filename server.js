/**
 * FREAKSHOWTOPUP - PRODUCTION FULL-STACK REST API & WEB SERVER (ENTERPRISE GRADE)
 * Domain: freakshowtopup.shop
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Automatically load .env into process.env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const db = require('./lib/db');
const auth = require('./lib/auth');
const walletEngine = require('./lib/wallet');
const orderEngine = require('./lib/orders');
const telegram = require('./lib/telegram');
const { getProviderAdapter } = require('./lib/providers');
const { getAuditLogs, recordAuditLog } = require('./lib/audit');
const referralEngine = require('./lib/referral');

const PORT = process.env.PORT || 5000;
const PUBLIC_DIR = path.join(__dirname);
const ALLOWED_ORIGINS = new Set([
  'https://freakshowtopup.shop',
  'https://www.freakshowtopup.shop',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  'http://localhost:3000',
  (process.env.CORS_ORIGIN || '').trim()
].filter(Boolean));

// -------------------------------------------------------------
// IN-MEMORY SLIDING-WINDOW RATE LIMITER (Phase 18)
// -------------------------------------------------------------
const rateLimits = new Map();

function checkRateLimit(ip, category = 'general', limit = 100, windowMs = 60000) {
  const now = Date.now();
  const key = `${ip}:${category}`;
  let bucket = rateLimits.get(key);

  if (!bucket || now - bucket.startTime > windowMs) {
    bucket = { count: 1, startTime: now };
    rateLimits.set(key, bucket);
    return { allowed: true, remaining: limit - 1 };
  }

  bucket.count++;
  if (bucket.count > limit) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: limit - bucket.count };
}

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimits.entries()) {
    if (now - bucket.startTime > 60000) {
      rateLimits.delete(key);
    }
  }
}, 300000);

// Sanitize inputs against prototype pollution
function sanitizeInput(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeInput);
  const clean = Object.create(null);
  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    clean[key] = sanitizeInput(obj[key]);
  }
  return clean;
}

// Helper for parsing JSON body with 1MB payload limit & prototype pollution sanitization
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const MAX_SIZE = 1024 * 1024; // 1MB

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_SIZE) {
        req.destroy();
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(sanitizeInput(parsed));
      } catch (e) {
        resolve({});
      }
    });

    req.on('error', (err) => reject(err));
  });
}

// High-performance gzip/deflate response compression
function compressAndSend(req, res, statusCode, headers, buffer) {
  const acceptEncoding = (req && req.headers && req.headers['accept-encoding']) || '';
  
  if (buffer.length > 512) {
    if (/\bgzip\b/i.test(acceptEncoding)) {
      headers['Content-Encoding'] = 'gzip';
      delete headers['Content-Length'];
      zlib.gzip(buffer, (err, compressed) => {
        if (err || !compressed) {
          headers['Content-Length'] = Buffer.byteLength(buffer);
          delete headers['Content-Encoding'];
          res.writeHead(statusCode, headers);
          res.end(buffer);
        } else {
          headers['Content-Length'] = compressed.length;
          res.writeHead(statusCode, headers);
          res.end(compressed);
        }
      });
      return;
    } else if (/\bdeflate\b/i.test(acceptEncoding)) {
      headers['Content-Encoding'] = 'deflate';
      delete headers['Content-Length'];
      zlib.deflate(buffer, (err, compressed) => {
        if (err || !compressed) {
          headers['Content-Length'] = Buffer.byteLength(buffer);
          delete headers['Content-Encoding'];
          res.writeHead(statusCode, headers);
          res.end(buffer);
        } else {
          headers['Content-Length'] = compressed.length;
          res.writeHead(statusCode, headers);
          res.end(compressed);
        }
      });
      return;
    }
  }

  headers['Content-Length'] = Buffer.byteLength(buffer);
  res.writeHead(statusCode, headers);
  res.end(buffer);
}

function sendJson(res, statusCode, data, req = null) {
  const origin = req && req.headers ? (req.headers.origin || '') : '';
  const corsHeader = ALLOWED_ORIGINS.has(origin) ? origin : 'https://freakshowtopup.shop';
  const jsonBuf = Buffer.from(JSON.stringify(data), 'utf8');

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': corsHeader,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Auth, X-Idempotency-Key',
    'Access-Control-Allow-Credentials': 'true',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  };

  compressAndSend(req, res, statusCode, headers, jsonBuf);
}

// Request Router
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();

  // Handle CORS Preflight
  if (method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true }, req);
  }

  try {
    // -------------------------------------------------------------
    // API ROUTES
    // -------------------------------------------------------------

    // 1. AUTHENTICATION & SECURITY
    if (pathname === '/api/auth/register' && method === 'POST') {
      const rl = checkRateLimit(clientIp, 'auth', 15, 60000);
      if (!rl.allowed) return sendJson(res, 429, { success: false, message: 'Too many registration attempts. Please try again later.' }, req);

      const body = await parseBody(req);
      try {
        const result = await auth.registerUser(body);
        return sendJson(res, 201, { success: true, ...result }, req);
      } catch (err) {
        return sendJson(res, 400, { success: false, message: err.message }, req);
      }
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      const rl = checkRateLimit(clientIp, 'auth', 20, 60000);
      if (!rl.allowed) return sendJson(res, 429, { success: false, message: 'Too many login attempts. Please wait 1 minute.' }, req);

      const body = await parseBody(req);
      try {
        const result = await auth.loginUser(body);
        return sendJson(res, 200, { success: true, ...result }, req);
      } catch (err) {
        return sendJson(res, 400, { success: false, message: err.message }, req);
      }
    }

    if (pathname === '/api/auth/google' && method === 'POST') {
      const rl = checkRateLimit(clientIp, 'auth', 25, 60000);
      if (!rl.allowed) return sendJson(res, 429, { success: false, message: 'Too many authentication attempts.' }, req);

      const body = await parseBody(req);
      try {
        const result = await auth.googleAuth(body);
        return sendJson(res, 200, { success: true, ...result }, req);
      } catch (err) {
        return sendJson(res, 400, { success: false, message: err.message }, req);
      }
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const user = auth.authenticateRequest(req);
      if (!user) return sendJson(res, 401, { success: false, message: 'Unauthorized' }, req);
      const wallet = walletEngine.getUserWallet(user.id);
      return sendJson(res, 200, { success: true, user: auth.sanitizeUser(user), wallet }, req);
    }

    // 1.1 USER PROFILE MANAGEMENT (Strictly isolated to authenticated user's own profile)
    if ((pathname === '/api/user/profile' || pathname === '/api/auth/profile') && (method === 'PUT' || method === 'POST')) {
      const rl = checkRateLimit(clientIp, 'profile_update', 30, 60000);
      if (!rl.allowed) return sendJson(res, 429, { success: false, message: 'Too many profile updates. Please try again in a moment.' }, req);

      const user = auth.authenticateRequest(req);
      if (!user) return sendJson(res, 401, { success: false, message: 'Unauthorized' }, req);

      const body = await parseBody(req);
      try {
        const { name, username, avatar } = body;
        const result = await auth.updateUserProfile({
          userId: user.id,
          name,
          username,
          avatar
        });
        return sendJson(res, 200, { success: true, ...result, message: 'Profile updated successfully!' }, req);
      } catch (err) {
        return sendJson(res, 400, { success: false, message: err.message }, req);
      }
    }

    if (pathname === '/api/user/check-username' && method === 'GET') {
      const target = (parsedUrl.query.username || '').replace(/^@/, '').toLowerCase().trim();
      if (!target || !auth.isValidUsername(target)) {
        return sendJson(res, 200, { available: false, message: 'Username must be 3-30 characters (letters, numbers, underscores).' }, req);
      }
      const authUser = auth.authenticateRequest(req);
      const isTaken = auth.isUsernameTaken(target, authUser ? authUser.id : null);
      return sendJson(res, 200, {
        available: !isTaken,
        message: isTaken ? 'Username already taken. Please choose another username.' : 'Username available!'
      }, req);
    }

    // 1.2 TELEGRAM ACCOUNT LINKING
    if (pathname === '/api/user/telegram/generate-link' && method === 'POST') {
      const rl = checkRateLimit(clientIp, 'tg_link', 20, 60000);
      if (!rl.allowed) return sendJson(res, 429, { success: false, message: 'Too many link requests. Please wait.' }, req);

      const user = auth.authenticateRequest(req);
      if (!user) return sendJson(res, 401, { success: false, message: 'Unauthorized' }, req);

      const linkInfo = telegram.generateTelegramLinkToken(user.id);
      return sendJson(res, 200, {
        success: true,
        ...linkInfo,
        message: 'Telegram deep-link generated. Click or open to connect!'
      }, req);
    }

    if (pathname === '/api/user/telegram/unlink' && method === 'POST') {
      const user = auth.authenticateRequest(req);
      if (!user) return sendJson(res, 401, { success: false, message: 'Unauthorized' }, req);

      const result = telegram.unlinkTelegramAccount(user.id);
      return sendJson(res, 200, result, req);
    }

    // 2. PRODUCTS & CATEGORIES
    if (pathname === '/api/products' && method === 'GET') {
      const user = auth.authenticateRequest(req);
      const isAdmin = user && ['SUPER_ADMIN', 'ADMIN'].includes(user.role);

      let list = db.products.filter(p => p.isActive).map(p => ({
        ...p,
        inStock: p.inStock !== false
      }));
      if (!isAdmin) {
        // Strip supplier costs and internal provider keys for customers
        list = list.map(p => {
          const { supplierCost, providerId, ...safe } = p;
          return safe;
        });
      }
      return sendJson(res, 200, { success: true, products: list, categories: db.categories }, req);
    }

    // 3. WALLET & TRANSACTIONS
    if (pathname === '/api/wallet' && method === 'GET') {
      const user = auth.authenticateRequest(req);
      if (!user) return sendJson(res, 401, { success: false, message: 'Unauthorized' }, req);
      
      const wallet = walletEngine.getUserWallet(user.id);
      const userTransactions = db.transactions.filter(t => t.userId === user.id);
      return sendJson(res, 200, { success: true, wallet, transactions: userTransactions }, req);
    }

    // 4. DEPOSIT SYSTEM
    if (pathname === '/api/deposits' && method === 'POST') {
      const rl = checkRateLimit(clientIp, 'deposit', 10, 60000);
      if (!rl.allowed) return sendJson(res, 429, { success: false, message: 'Deposit submission rate limit reached. Please wait.' }, req);

      const user = auth.authenticateRequest(req);
      if (!user) return sendJson(res, 401, { success: false, message: 'Unauthorized' }, req);

      const body = await parseBody(req);
      try {
        const deposit = await walletEngine.submitDepositRequest({
          userId: user.id,
          paymentMethod: body.paymentMethod,
          senderNumber: body.senderNumber,
          transactionId: body.transactionId,
          amount: body.amount,
          requestedCurrency: body.currency,
          receiptUrl: body.receiptUrl
        });
        return sendJson(res, 201, { success: true, deposit, message: 'Deposit request submitted successfully' }, req);
      } catch (err) {
        if (err.message === 'PAYMENT_METHOD_DISABLED') {
          return sendJson(res, 400, { success: false, message: 'This payment method is currently unavailable. Please select another payment method.' }, req);
        }
        return sendJson(res, 400, { success: false, message: err.message }, req);
      }
    }

    if (pathname === '/api/deposits' && method === 'GET') {
      const user = auth.authenticateRequest(req);
      if (!user) return sendJson(res, 401, { success: false, message: 'Unauthorized' }, req);

      const userDeposits = db.deposits.filter(d => d.userId === user.id);
      return sendJson(res, 200, { success: true, deposits: userDeposits }, req);
    }

    // VIP ACCESS VERIFICATION (Secure One-Way Hash Comparison)
    if (pathname === '/api/vip/verify' && method === 'POST') {
      const rl = checkRateLimit(clientIp, 'vip_verify', 20, 60000);
      if (!rl.allowed) return sendJson(res, 429, { success: false, message: 'Too many verification attempts. Please wait.' }, req);

      const body = await parseBody(req);
      const inputCode = String(body.code || '').trim().toUpperCase();
      if (!inputCode) {
        return sendJson(res, 400, { success: false, message: 'VIP Access Code is required.' }, req);
      }

      let isValid = false;
      if (db.settings.vipAccessCodeHash) {
        isValid = await bcrypt.compare(inputCode, db.settings.vipAccessCodeHash);
      } else if (db.settings.vipAccessCode) {
        isValid = inputCode === String(db.settings.vipAccessCode).trim().toUpperCase();
        if (isValid) {
          db.settings.vipAccessCodeHash = await bcrypt.hash(inputCode, 12);
          delete db.settings.vipAccessCode;
          db.saveAll();
        }
      } else {
        isValid = inputCode === 'JOY100LVL';
      }

      if (isValid) {
        const currentVer = Number(db.settings.vipCodeVersion || 1);
        const authUser = auth.authenticateRequest(req);
        if (authUser) {
          authUser.vipCodeVersion = currentVer;
          authUser.hasVipAccess = true;
          authUser.vipUnlocked = true;
          authUser.vipUnlockedAt = new Date().toISOString();
          db.saveAll();
        }

        return sendJson(res, 200, {
          success: true,
          message: 'VIP Access Granted!',
          vipCodeVersion: currentVer
        }, req);
      }
      return sendJson(res, 400, { success: false, message: 'Invalid VIP Access Code. Contact admin for secret code.' }, req);
    }

    // 5. ORDERS & TOP-UP ENGINE
    if (pathname === '/api/orders' && method === 'POST') {
      const rl = checkRateLimit(clientIp, 'orders', 25, 60000);
      if (!rl.allowed) return sendJson(res, 429, { success: false, message: 'Order submission rate limit exceeded.' }, req);

      const user = auth.authenticateRequest(req);
      if (!user) return sendJson(res, 401, { success: false, message: 'Unauthorized' }, req);

      const body = await parseBody(req);
      const idempotencyKey = req.headers['x-idempotency-key'] || body.idempotencyKey;

      const targetProd = db.products.find(p => p.id === body.productId);
      if (targetProd && targetProd.inStock === false) {
        return sendJson(res, 400, { success: false, message: 'This product is currently out of stock. / পণ্যটি বর্তমানে স্টকে নেই।' }, req);
      }

      try {
        const result = await orderEngine.createOrder({
          userId: user.id,
          productId: body.productId,
          playerData: body.playerData,
          quantity: body.quantity,
          customAmount: body.customAmount,
          idempotencyKey,
          ipAddress: clientIp
        });
        return sendJson(res, result.isDuplicate ? 200 : 201, { success: true, ...result }, req);
      } catch (err) {
        return sendJson(res, 400, { success: false, message: err.message }, req);
      }
    }

    if (pathname === '/api/orders' && method === 'GET') {
      const user = auth.authenticateRequest(req);
      if (!user) return sendJson(res, 401, { success: false, message: 'Unauthorized' }, req);

      const userOrders = db.orders.filter(o => o.userId === user.id).map(orderEngine.sanitizeOrderForCustomer);
      return sendJson(res, 200, { success: true, orders: userOrders }, req);
    }

    if (pathname === '/api/orders/track' && method === 'GET') {
      const query = (parsedUrl.query.query || parsedUrl.query.id || parsedUrl.query.uid || '').trim().toUpperCase();
      if (!query) return sendJson(res, 400, { success: false, message: 'Query is required' }, req);

      const order = db.orders.find(o => 
        o.id.toUpperCase() === query || 
        (o.playerUid && o.playerUid.toUpperCase() === query)
      );

      if (!order) return sendJson(res, 404, { success: false, message: 'Order not found' }, req);
      return sendJson(res, 200, { success: true, order: orderEngine.sanitizeOrderForCustomer(order) }, req);
    }

    // Free Fire Nickname Lookup (proxy to external API to avoid CORS)
    if (pathname === '/api/ff/nickname' && method === 'GET') {
      const uid = (parsedUrl.query.uid || '').trim();
      const region = (parsedUrl.query.region || 'bd').trim().toLowerCase();

      if (!uid || !/^\d{5,15}$/.test(uid)) {
        return sendJson(res, 400, { success: false, message: 'Invalid UID. Must be numeric.' }, req);
      }

      const rl = checkRateLimit(clientIp, 'ff_nickname', 25, 60000);
      if (!rl.allowed) {
        return sendJson(res, 429, { success: false, message: 'Too many requests. Try again in 1 minute.' }, req);
      }

      try {
        const https = require('https');
        const apiKey = process.env.FF_NICKNAME_API_KEY || 'tkBAueh5RMhzUgBPvYawX9Eeg1n2gYuh';
        const apiUrl = `https://public.ggwhitehawk.site/nickname?uid=${encodeURIComponent(uid)}&region=${encodeURIComponent(region)}&key=${apiKey}`;

        console.log(`[FF NICKNAME] Requesting: https://public.ggwhitehawk.site/nickname?uid=${uid}&region=${region}&key=***`);

        const result = await new Promise((resolve, reject) => {
          https.get(apiUrl, { timeout: 10000 }, (apiRes) => {
            let body = '';
            apiRes.on('data', chunk => body += chunk);
            apiRes.on('end', () => {
              try {
                const parsed = JSON.parse(body);
                console.log(`[FF NICKNAME] Provider Response (${apiRes.statusCode}):`, parsed);
                resolve({ statusCode: apiRes.statusCode, data: parsed });
              } catch (e) {
                console.error('[FF NICKNAME] Invalid JSON from provider:', body);
                reject(new Error('Invalid JSON response from provider'));
              }
            });
          }).on('error', (err) => {
            console.error('[FF NICKNAME] Network error:', err.message);
            reject(err);
          }).on('timeout', () => {
            console.error('[FF NICKNAME] Request timed out (10s)');
            reject(new Error('Nickname API request timed out'));
          });
        });

        if (result.data && result.data.success) {
          return sendJson(res, 200, {
            success: true,
            name: result.data.nickname,
            nickname: result.data.nickname,
            level: result.data.level,
            likes: result.data.likes,
            player_id: result.data.player_id || uid,
            uid: result.data.player_id || uid,
            region: result.data.region || region,
            api_usage: result.data.api_usage
          }, req);
        } else {
          const errMsg = (result.data && (result.data.error || result.data.message)) || 'Player not found. Check your UID and region.';
          return sendJson(res, 404, { success: false, message: errMsg }, req);
        }
      } catch (err) {
        console.error('[FF NICKNAME API ERROR]', err.message);
        return sendJson(res, 503, { success: false, message: 'Could not reach verification server. ' + err.message }, req);
      }
    }

    // /api/player/check — alias used by all wizard & tool functions in app.js
    if (pathname === '/api/player/check' && method === 'GET') {
      const uid = (parsedUrl.query.uid || '').trim();
      const region = (parsedUrl.query.region || 'bd').trim().toLowerCase();

      if (!uid || uid.length < 5 || !/^\d+$/.test(uid)) {
        return sendJson(res, 400, { success: false, message: 'Invalid UID. Must be numeric.' }, req);
      }

      const rl = checkRateLimit(clientIp, 'ff_nickname', 25, 60000);
      if (!rl.allowed) {
        return sendJson(res, 429, { success: false, message: 'Too many requests. Try again in 1 minute.' }, req);
      }

      try {
        const https = require('https');
        const apiKey = process.env.FF_NICKNAME_API_KEY || 'tkBAueh5RMhzUgBPvYawX9Eeg1n2gYuh';
        const apiUrl = `https://public.ggwhitehawk.site/nickname?uid=${encodeURIComponent(uid)}&region=${encodeURIComponent(region)}&key=${apiKey}`;

        console.log(`[PLAYER CHECK] Requesting: https://public.ggwhitehawk.site/nickname?uid=${uid}&region=${region}&key=***`);

        const result = await new Promise((resolve, reject) => {
          https.get(apiUrl, { timeout: 10000 }, (apiRes) => {
            let body = '';
            apiRes.on('data', chunk => body += chunk);
            apiRes.on('end', () => {
              try {
                const parsed = JSON.parse(body);
                console.log(`[PLAYER CHECK] Provider Response (${apiRes.statusCode}):`, parsed);
                resolve({ statusCode: apiRes.statusCode, data: parsed });
              } catch (e) {
                console.error('[PLAYER CHECK] Invalid JSON from provider:', body);
                reject(new Error('Invalid JSON response from provider'));
              }
            });
          }).on('error', (err) => {
            console.error('[PLAYER CHECK] Network error:', err.message);
            reject(err);
          }).on('timeout', () => {
            console.error('[PLAYER CHECK] Request timed out (10s)');
            reject(new Error('Player check API request timed out'));
          });
        });

        if (result.data && result.data.success) {
          return sendJson(res, 200, {
            success: true,
            name: result.data.nickname,
            nickname: result.data.nickname,
            level: result.data.level,
            likes: result.data.likes,
            player_id: result.data.player_id || uid,
            uid: result.data.player_id || uid,
            region: result.data.region || region,
            api_usage: result.data.api_usage
          }, req);
        } else {
          const errMsg = (result.data && (result.data.error || result.data.message)) || 'Player not found. Check your UID.';
          return sendJson(res, 404, { success: false, message: errMsg }, req);
        }
      } catch (err) {
        console.error('[PLAYER CHECK ERROR]', err.message);
        return sendJson(res, 503, { success: false, message: 'Verification server unreachable. ' + err.message }, req);
      }
    }

    if (pathname === '/api/orders/recent' && method === 'GET') {
      const successfulOrders = db.orders.filter(o => o.status === 'DONE' || o.status === 'SUCCESS' || o.status === 'PROCESSING');
      const sorted = [...successfulOrders].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      const recent = sorted.slice(0, 5).map(o => {
        const custName = o.userName || (o.userEmail ? o.userEmail.split('@')[0] : 'Verified Gamer');
        const prodName = o.productName || 'Free Fire Diamonds';
        return {
          id: o.id,
          customer: custName,
          userName: custName,
          item: prodName,
          productName: prodName,
          quantity: o.quantity || 1,
          status: (o.status === 'DONE' || o.status === 'SUCCESS') ? 'Done' : (o.status === 'PROCESSING' ? 'Processing' : o.status),
          createdAt: o.createdAt
        };
      });
      return sendJson(res, 200, { success: true, orders: recent }, req);
    }

    // 6. REFERRAL PROGRAM (CUSTOMER DASHBOARD)
    if (pathname === '/api/referral' && method === 'GET') {
      const user = auth.authenticateRequest(req);
      if (!user) return sendJson(res, 401, { success: false, message: 'Unauthorized' }, req);

      const dashboard = referralEngine.getUserReferralDashboard(user.id);
      if (!dashboard) return sendJson(res, 404, { success: false, message: 'User not found' }, req);

      return sendJson(res, 200, {
        success: true,
        ...dashboard,
        referralsCount: dashboard.totalReferrals,
        totalCommissions: dashboard.totalEarned,
        commissions: dashboard.referralHistory
      }, req);
    }

    // 7. PUBLIC SETTINGS & ANNOUNCEMENTS
    if (pathname === '/api/settings/public' && method === 'GET') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      const activeBanners = (db.banners || []).filter(b => b && b.status === 'ACTIVE');
      const primaryBanner = activeBanners.length > 0 ? activeBanners[0] : null;
      const isPopupOn = primaryBanner ? (primaryBanner.isPopupEnabled !== false && primaryBanner.isPopupEnabled !== 'false' && primaryBanner.isPopupEnabled !== 'OFF' && primaryBanner.isPopupEnabled !== 'off') : false;

      return sendJson(res, 200, {
        success: true,
        siteName: db.settings.siteName || 'FREAKSHOW',
        siteTagline: db.settings.siteTagline || 'FASTEST GAMING HUB',
        siteLogo: db.settings.siteLogo || 'assets/logo.jpg',
        domain: db.settings.domain || 'freakshowtopup.shop',
        minDepositBDT: db.settings.minDepositBDT || 25,
        minDepositUSD: db.settings.minDepositUSD || 0.20,
        usdToBdtRate: Number(db.settings.usdToBdtRate || db.settings.exchangeRate || 120),
        exchangeRate: Number(db.settings.usdToBdtRate || db.settings.exchangeRate || 120),
        telegramUsername: db.settings.telegramUsername || 'freakshowtopup',
        telegramLink: db.settings.telegramLink || 'https://t.me/freakshowtopup',
        whatsappNumber: db.settings.whatsappNumber || '+8801641625723',
        whatsappLink: db.settings.whatsappLink || 'https://wa.me/8801641625723',
        supportEmail: db.settings.supportEmail || db.settings.adminEmail || 'admin.freakshow@gmail.com',
        adminEmail: db.settings.adminEmail || 'admin.freakshow@gmail.com',
        footerAbout: db.settings.footerAbout || 'The most trusted & fastest automated gaming top-up platform in Bangladesh & Globally. Instant Free Fire Diamonds, VIP Passes, and Gaming Vouchers at wholesale rates.',
        footerCopyright: db.settings.footerCopyright || '© 2026 FREAKSHOWTOPUP (freakshowtopup.shop). All Rights Reserved.',
        voucherRedeemUrl: db.settings.voucherRedeemUrl || 'https://shop.garena.my/',
        voucherRedeemText: db.settings.voucherRedeemText || 'Redeem at shop.garena.my',
        shellRedeemUrl: db.settings.shellRedeemUrl || 'https://bdgamesbazar.com/',
        shellRedeemText: db.settings.shellRedeemText || 'Redeem at bdgamesbazar.com',
        failedRefundMessage: db.settings.failedRefundMessage || 'কোনো সমস্যার কারণে অর্ডারটি সম্পন্ন করা যায়নি। আপনার পরিশোধিত টাকা সম্পূর্ণ ওয়ালেট ব্যালেন্সে ইনস্ট্যান্ট ফেরত (Auto-Refund) দেওয়া হয়েছে।',
        uidSuccessMessage: db.settings.uidSuccessMessage || 'আপনার ফ্রি ফায়ার একাউন্টে সরাসরি টপ-আপ সফলভাবে সম্পন্ন হয়েছে!',
        outOfStockMessage: db.settings.outOfStockMessage || 'সাময়িকভাবে এই প্যাকেজের স্টক শেষ / সার্ভার আপডেটের কাজ চলছে। খুব দ্রুতই স্টক যোগ করা হবে!',
        heroBannerImage: db.settings.heroBannerImage || 'assets/hero_banner.jpg',
        heroBadge: db.settings.heroBadge || '🔥 #1 Game Top-Up Platform',
        heroTitle: db.settings.heroTitle || 'Instant Game Diamonds & VIP Passes',
        heroDesc: db.settings.heroDesc || 'Recharge your Free Fire, PUBG & MLBB accounts in seconds. 100% automated delivery with bKash, Nagad, Rocket, or Wallet Balance.',
        heroSideCard1Image: db.settings.heroSideCard1Image || 'assets/ff_membership_v2.jpg',
        heroSideCard1Title: db.settings.heroSideCard1Title || 'Weekly & Monthly Pass',
        heroSideCard1Desc: db.settings.heroSideCard1Desc || 'Claim up to 2600 Diamonds with maximum savings',
        heroSideCard2Image: db.settings.heroSideCard2Image || 'assets/ff_levelup.jpg',
        heroSideCard2Title: db.settings.heroSideCard2Title || 'Level Up Pass (802 💎)',
        heroSideCard2Desc: db.settings.heroSideCard2Desc || 'Instant 802 Diamonds upon level progression',
        paymentNumbers: db.settings.paymentNumbers || {},
        paymentInstructions: db.settings.paymentInstructions || {},
        paymentMethodStatus: db.settings.paymentMethodStatus || {
          bkash: true,
          nagad: true,
          rocket: true,
          cellfin: true,
          bangla_qr: true,
          binance: true
        },
        recentOrdersSectionEnabled: db.settings.recentOrdersSectionEnabled !== false,
        vipCodeVersion: Number(db.settings.vipCodeVersion || 1),
        announcement: db.settings.announcement || '',
        banners: activeBanners,
        activeBanner: primaryBanner,
        popupDisabled: !isPopupOn,
        popupOffer: primaryBanner ? {
          enabled: isPopupOn,
          id: primaryBanner.id,
          title: primaryBanner.title || 'Special Gaming Offer',
          description: primaryBanner.description || '',
          imageUrl: primaryBanner.image || 'assets/offer_banner.jpg',
          buttonText: primaryBanner.buttonText || 'Recharge Now 🚀',
          link: primaryBanner.destinationUrl || '#freefire-section',
          isPopupEnabled: isPopupOn,
          status: 'ACTIVE'
        } : null,
        howToDeposit: db.settings.howToDeposit || {
          enabled: db.settings.how_to_deposit_enabled !== undefined ? Boolean(db.settings.how_to_deposit_enabled) : true,
          title: db.settings.how_to_deposit_title || 'কীভাবে টাকা Deposit করবেন?',
          image: db.settings.how_to_deposit_image || 'assets/how_to_deposit.jpg',
          url: db.settings.how_to_deposit_url || 'https://youtube.com',
          description: 'ভিডিও টিউটোরিয়াল দেখতে এখানে ক্লিক করুন'
        },
        how_to_deposit_enabled: db.settings.how_to_deposit_enabled !== undefined ? Boolean(db.settings.how_to_deposit_enabled) : (db.settings.howToDeposit ? db.settings.howToDeposit.enabled : true),
        how_to_deposit_title: db.settings.how_to_deposit_title || (db.settings.howToDeposit ? db.settings.howToDeposit.title : 'কীভাবে টাকা Deposit করবেন?'),
        how_to_deposit_image: db.settings.how_to_deposit_image || (db.settings.howToDeposit ? db.settings.howToDeposit.image : 'assets/how_to_deposit.jpg'),
        how_to_deposit_url: db.settings.how_to_deposit_url || (db.settings.howToDeposit ? db.settings.howToDeposit.url : 'https://youtube.com')
      }, req);
    }

    // Public active banners list
    if (pathname === '/api/banners' && method === 'GET') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      const activeBanners = (db.banners || []).filter(b => b && b.status === 'ACTIVE');
      return sendJson(res, 200, { success: true, banners: activeBanners }, req);
    }

    // -------------------------------------------------------------
    // ADMIN AUTHENTICATION & LOGIN (No RBAC Required for Login)
    // -------------------------------------------------------------
    if (pathname === '/api/admin/auth/login' && method === 'POST') {
      const rl = checkRateLimit(clientIp, 'admin_auth', 10, 60000);
      if (!rl.allowed) return sendJson(res, 429, { success: false, message: 'Too many admin login attempts. Please wait 1 minute.' }, req);

      const body = await parseBody(req);
      const email = (body.email || body.identifier || '').toLowerCase().trim();
      const password = body.password || '';

      const targetUser = db.users.find(u => 
        (u.email && u.email.toLowerCase() === email) || 
        (u.username && u.username.toLowerCase() === email) ||
        (u.telegramId && String(u.telegramId) === email)
      );

      if (!targetUser) {
        return sendJson(res, 401, { success: false, message: 'Invalid admin credentials.' }, req);
      }

      if (!['SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'].includes(targetUser.role)) {
        return sendJson(res, 403, { success: false, message: 'Access Denied: Account lacks administrative privileges.' }, req);
      }

      const isValidPassword = await auth.verifyPassword(password, targetUser.passwordHash);
      if (!isValidPassword) {
        return sendJson(res, 401, { success: false, message: 'Invalid secret password.' }, req);
      }

      const token = auth.signToken({
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
        role: targetUser.role,
        currency: targetUser.currency || 'BDT'
      });
      recordAuditLog({
        actorId: targetUser.id,
        action: 'ADMIN_WEB_LOGIN',
        targetId: targetUser.id,
        reason: `Admin logged in from IP: ${clientIp}`
      });

      return sendJson(res, 200, {
        success: true,
        token,
        user: auth.sanitizeUser(targetUser),
        message: 'Admin authentication successful.'
      }, req);
    }

    if (pathname === '/api/admin/auth/verify' && method === 'GET') {
      const user = auth.authenticateRequest(req);
      if (!user || !['SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'].includes(user.role)) {
        return sendJson(res, 401, { success: false, message: 'Unauthorized admin session' }, req);
      }
      return sendJson(res, 200, { success: true, user: auth.sanitizeUser(user) }, req);
    }

    // -------------------------------------------------------------
    // ADMIN DASHBOARD & GOVERNANCE ROUTES (RBAC Protected)
    // -------------------------------------------------------------
    if (pathname.startsWith('/api/admin/')) {
      const user = auth.authenticateRequest(req);
      if (!user || !['SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'].includes(user.role)) {
        return sendJson(res, 403, { success: false, message: 'Forbidden: Admin privileges required' }, req);
      }

      // Master Data Bundle for Fast Dashboard Loading
      if (pathname === '/api/admin/data/all' && method === 'GET') {
        const todayDate = new Date().toISOString().split('T')[0];
        
        // Compute today's metrics
        const todayDoneOrders = db.orders.filter(o => (o.status === 'DONE' || o.status === 'SUCCESS') && o.createdAt && o.createdAt.startsWith(todayDate));
        const todaySales = todayDoneOrders.reduce((acc, o) => acc + Number(o.sellingPrice || 0), 0);
        const todayCost = todayDoneOrders.reduce((acc, o) => acc + Number(o.supplierCost || o.sellingPrice * 0.90), 0);
        const todayProfit = Math.max(0, todaySales - todayCost);
        
        const pendingDepositsCount = db.deposits.filter(d => d.status === 'PENDING').length;
        const pendingOrdersCount = db.orders.filter(o => o.status === 'PENDING' || o.status === 'PROCESSING').length;
        const customerTotalBalance = db.wallets.reduce((acc, w) => acc + Number(w.balance || 0), 0);

        // Fetch supplier live balance (with 2.5s fast timeout fallback)
        let supplierBalanceLeft = 0;
        let supplierBalanceConsumed = 0;
        let supplierTotalLimit = 0;
        try {
          const activeProv = db.providers.find(p => p.isActive) || db.providers[0];
          if (activeProv) {
            const adapter = getProviderAdapter(activeProv);
            const balPromise = adapter.getBalance();
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 2500));
            const balRes = await Promise.race([balPromise, timeoutPromise]);
            if (balRes && balRes.success) {
              supplierBalanceLeft = balRes.balance;
              supplierBalanceConsumed = balRes.consumed;
              supplierTotalLimit = balRes.totalLimit;
            }
          }
        } catch (e) {}

        const usersWithBalances = db.users.map(u => {
          const wallet = db.wallets.find(w => w.userId === u.id);
          return {
            ...auth.sanitizeUser(u),
            walletBalance: wallet ? Number(wallet.balance) : 0
          };
        });

        const logs = getAuditLogs({ limit: 100, offset: 0 });

        return sendJson(res, 200, {
          success: true,
          stats: {
            todaySales: Number(todaySales.toFixed(2)),
            todayOrdersCount: todayDoneOrders.length,
            todayProfit: Number(todayProfit.toFixed(2)),
            supplierBalanceLeft: Number(supplierBalanceLeft.toFixed(2)),
            supplierBalanceConsumed: Number(supplierBalanceConsumed.toFixed(2)),
            supplierTotalLimit: Number(supplierTotalLimit.toFixed(2)),
            customerTotalBalance: Number(customerTotalBalance.toFixed(2)),
            pendingDepositsCount,
            pendingOrdersCount,
            totalUsersCount: db.users.length
          },
          users: usersWithBalances,
          deposits: db.deposits,
          orders: db.orders,
          categories: db.categories,
          products: db.products,
          banners: db.banners || [],
          commissions: db.commissions || [],
          settings: {
            ...db.settings,
            vipAccessCode: undefined,
            vipAccessCodeHash: undefined
          },
          auditLogs: logs.logs || []
        }, req);
      }

      // 1. User Management CRUD
      if (pathname === '/api/admin/users' && method === 'POST') {
        const body = await parseBody(req);
        try {
          const regResult = await auth.registerUser({
            name: body.name,
            email: body.email,
            password: body.password,
            country: 'BD',
            currency: 'BDT'
          });

          if (body.initialBalance && Number(body.initialBalance) > 0) {
            await walletEngine.adjustUserWallet({
              userId: regResult.user.id,
              amount: Number(body.initialBalance),
              type: 'ADD',
              reason: 'Initial balance on registration by Admin',
              adminId: user.id,
              actorEmail: user.email
            });
          }

          if (body.role && user.role === 'SUPER_ADMIN') {
            const created = db.users.find(u => u.id === regResult.user.id);
            if (created) {
              created.role = body.role;
              db.saveAll();
            }
          }

          return sendJson(res, 201, { success: true, user: regResult.user }, req);
        } catch (err) {
          return sendJson(res, 400, { success: false, message: err.message }, req);
        }
      }

      if (pathname.startsWith('/api/admin/users/') && pathname.endsWith('/status') && method === 'PUT') {
        const userId = pathname.split('/')[4];
        const body = await parseBody(req);
        const target = db.users.find(u => u.id === userId);
        if (!target) return sendJson(res, 404, { success: false, message: 'User not found' }, req);

        target.status = body.status === 'BANNED' ? 'BANNED' : 'ACTIVE';
        target.updatedAt = new Date().toISOString();
        db.saveAll();

        recordAuditLog({
          actorId: user.id,
          action: target.status === 'BANNED' ? 'BAN_USER' : 'UNBAN_USER',
          targetId: target.id,
          reason: `Status changed to ${target.status} by ${user.name || user.email}`
        });

        return sendJson(res, 200, { success: true, user: auth.sanitizeUser(target) }, req);
      }

      if (pathname.startsWith('/api/admin/users/') && pathname.endsWith('/currency') && method === 'PUT') {
        const userId = pathname.split('/')[4];
        const body = await parseBody(req);
        const target = db.users.find(u => u.id === userId);
        if (!target) return sendJson(res, 404, { success: false, message: 'User not found' }, req);

        const newCurrency = String(body.currency || 'BDT').toUpperCase() === 'USD' ? 'USD' : 'BDT';
        const prevCurrency = target.currency || 'BDT';
        target.currency = newCurrency;
        target.currencyChangeUsed = false;
        target.updatedAt = new Date().toISOString();

        const wallet = walletEngine.getUserWallet(userId);
        if (wallet) {
          wallet.currency = newCurrency;
          wallet.updatedAt = new Date().toISOString();
        }
        db.saveAll();

        recordAuditLog({
          actorId: user.id,
          action: 'CHANGE_USER_CURRENCY',
          targetId: target.id,
          reason: `User currency changed from ${prevCurrency} to ${newCurrency} by ${user.name || user.email}`
        });

        return sendJson(res, 200, { success: true, user: auth.sanitizeUser(target), wallet }, req);
      }

      if (pathname.startsWith('/api/admin/users/') && method === 'DELETE') {
        if (user.role !== 'SUPER_ADMIN') {
          return sendJson(res, 403, { success: false, message: 'Super Admin privileges required to delete users.' }, req);
        }
        const userId = pathname.split('/')[4];
        const idx = db.users.findIndex(u => u.id === userId);
        if (idx === -1) return sendJson(res, 404, { success: false, message: 'User not found' }, req);

        const deleted = db.users.splice(idx, 1)[0];
        db.saveAll();

        recordAuditLog({
          actorId: user.id,
          action: 'DELETE_USER',
          targetId: userId,
          reason: `User deleted by ${user.name || user.email}`
        });

        return sendJson(res, 200, { success: true, message: 'User deleted successfully' }, req);
      }

      // 2. Wallet Adjustments
      if (pathname === '/api/admin/wallet/adjust' && method === 'POST') {
        const body = await parseBody(req);
        try {
          const result = await walletEngine.adjustUserWallet({
            userId: body.userId,
            amount: Number(body.amount),
            type: body.type,
            reason: body.reason,
            adminId: user.id,
            actorEmail: user.email
          });
          return sendJson(res, 200, { success: true, ...result }, req);
        } catch (err) {
          return sendJson(res, 400, { success: false, message: err.message }, req);
        }
      }

      // 3. Deposit Approvals & Rejections
      if (pathname.startsWith('/api/admin/deposits/') && pathname.endsWith('/approve') && method === 'POST') {
        const depositId = pathname.split('/')[4];
        const body = await parseBody(req);
        try {
          const result = await walletEngine.approveDeposit(depositId, user.id, body.adminNote, user.email);
          return sendJson(res, 200, { success: true, ...result }, req);
        } catch (err) {
          return sendJson(res, 400, { success: false, message: err.message }, req);
        }
      }

      if (pathname.startsWith('/api/admin/deposits/') && pathname.endsWith('/reject') && method === 'POST') {
        const depositId = pathname.split('/')[4];
        const body = await parseBody(req);
        try {
          const deposit = await walletEngine.rejectDeposit(depositId, user.id, body.reason, user.email);
          return sendJson(res, 200, { success: true, deposit }, req);
        } catch (err) {
          return sendJson(res, 400, { success: false, message: err.message }, req);
        }
      }

      // 3.1 Telegram Admin Broadcast to All Linked Users
      if (pathname === '/api/admin/telegram/broadcast' && method === 'POST') {
        const body = await parseBody(req);
        const msg = String(body.message || '').trim();
        if (!msg) {
          return sendJson(res, 400, { success: false, message: 'Broadcast message content is required.' }, req);
        }
        const stats = await telegram.sendBroadcastToUsers(msg);
        return sendJson(res, 200, {
          success: true,
          ...stats,
          message: `Broadcast successfully dispatched to ${stats.successful} users (Failed: ${stats.failed}).`
        }, req);
      }

      // 4. Categories & Subcategories CRUD
      const ALLOWED_PRODUCT_TYPES = ['AUTO TOP-UP', 'CODE DELIVERY', 'GMAIL DELIVERY', 'ADMIN DELIVERY', 'FIXED', 'AUTO_TOPUP', 'CODE', 'GMAIL', 'SUBSCRIPTION', 'ADMIN', 'MANUAL'];

      if (pathname === '/api/admin/categories' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.name || !body.name.trim()) {
          return sendJson(res, 400, { success: false, message: 'Category name is required' }, req);
        }
        const name = body.name.trim();
        const slug = (body.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        
        // Check duplicate category name
        if (db.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
          return sendJson(res, 400, { success: false, message: 'A category with this name already exists' }, req);
        }

        const newCat = {
          id: `cat-${slug || Date.now().toString(36)}`,
          slug,
          name,
          icon: body.icon || 'assets/ff_diamond.jpg',
          sortOrder: Number(body.sortOrder) || db.categories.length + 1,
          position: (body.position === 'TOP') ? 'TOP' : 'BOTTOM',
          isActive: body.isActive !== false,
          subcategories: Array.isArray(body.subcategories) ? body.subcategories : []
        };
        db.categories.push(newCat);
        db.saveAll();
        return sendJson(res, 201, { success: true, category: newCat }, req);
      }

      if (pathname.match(/^\/api\/admin\/categories\/[^\/]+\/status$/) && method === 'PUT') {
        const catId = pathname.split('/')[4];
        const body = await parseBody(req);
        const cat = db.categories.find(c => c.id === catId);
        if (!cat) return sendJson(res, 404, { success: false, message: 'Category not found' }, req);
        cat.isActive = Boolean(body.isActive);
        db.saveAll();
        return sendJson(res, 200, { success: true, category: cat }, req);
      }

      // Add Subcategory under Main Category
      if (pathname.startsWith('/api/admin/categories/') && pathname.endsWith('/subcategories') && method === 'POST') {
        const catId = pathname.split('/')[4];
        const body = await parseBody(req);
        const cat = db.categories.find(c => c.id === catId);
        if (!cat) return sendJson(res, 404, { success: false, message: 'Main Category not found' }, req);
        if (!body.name || !body.name.trim()) {
          return sendJson(res, 400, { success: false, message: 'Subcategory name is required' }, req);
        }
        if (!Array.isArray(cat.subcategories)) cat.subcategories = [];
        const subName = body.name.trim();
        const subSlug = (body.slug || subName).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        
        // Prevent duplicate subcategory names under same Main Category
        if (cat.subcategories.some(s => s.name.toLowerCase() === subName.toLowerCase())) {
          return sendJson(res, 400, { success: false, message: 'A subcategory with this name already exists in this category' }, req);
        }

        const newSub = {
          id: `sub-${cat.id.replace('cat-', '')}-${subSlug || Date.now().toString(36)}`,
          categoryId: cat.id,
          name: subName,
          slug: subSlug,
          icon: body.icon || cat.icon || 'assets/ff_diamond.jpg',
          badge: body.badge || 'Instant ⚡',
          deliveryType: body.deliveryType || 'UID Auto',
          sortOrder: Number(body.sortOrder) || cat.subcategories.length + 1,
          isActive: body.isActive !== false
        };
        cat.subcategories.push(newSub);
        db.saveAll();
        return sendJson(res, 201, { success: true, subcategory: newSub, category: cat }, req);
      }

      // Update Subcategory
      if (pathname.match(/^\/api\/admin\/categories\/[^\/]+\/subcategories\/[^\/]+$/) && method === 'PUT') {
        const parts = pathname.split('/');
        const catId = parts[4];
        const subId = parts[6];
        const body = await parseBody(req);
        const cat = db.categories.find(c => c.id === catId);
        if (!cat || !Array.isArray(cat.subcategories)) return sendJson(res, 404, { success: false, message: 'Category not found' }, req);
        const sub = cat.subcategories.find(s => s.id === subId);
        if (!sub) return sendJson(res, 404, { success: false, message: 'Subcategory not found' }, req);

        if (body.name) sub.name = body.name.trim();
        if (body.slug) sub.slug = body.slug.trim();
        if (body.icon) sub.icon = body.icon.trim();
        if (body.badge) sub.badge = body.badge.trim();
        if (body.deliveryType) sub.deliveryType = body.deliveryType.trim();
        if (body.sortOrder !== undefined) sub.sortOrder = Number(body.sortOrder);
        if (body.isActive !== undefined) sub.isActive = Boolean(body.isActive);
        db.saveAll();
        return sendJson(res, 200, { success: true, subcategory: sub, category: cat }, req);
      }

      // Toggle Subcategory Status
      if (pathname.match(/^\/api\/admin\/categories\/[^\/]+\/subcategories\/[^\/]+\/status$/) && method === 'PUT') {
        const parts = pathname.split('/');
        const catId = parts[4];
        const subId = parts[6];
        const body = await parseBody(req);
        const cat = db.categories.find(c => c.id === catId);
        if (!cat || !Array.isArray(cat.subcategories)) return sendJson(res, 404, { success: false, message: 'Category not found' }, req);
        const sub = cat.subcategories.find(s => s.id === subId);
        if (!sub) return sendJson(res, 404, { success: false, message: 'Subcategory not found' }, req);
        sub.isActive = Boolean(body.isActive);
        db.saveAll();
        return sendJson(res, 200, { success: true, subcategory: sub }, req);
      }

      // Delete Subcategory
      if (pathname.match(/^\/api\/admin\/categories\/[^\/]+\/subcategories\/[^\/]+$/) && method === 'DELETE') {
        const parts = pathname.split('/');
        const catId = parts[4];
        const subId = parts[6];
        const cat = db.categories.find(c => c.id === catId);
        if (!cat || !Array.isArray(cat.subcategories)) return sendJson(res, 404, { success: false, message: 'Category not found' }, req);
        const subIdx = cat.subcategories.findIndex(s => s.id === subId);
        if (subIdx !== -1) {
          cat.subcategories.splice(subIdx, 1);
          // Hide active products under this subcategory from active catalog
          db.products.filter(p => p.subcategoryId === subId).forEach(p => p.isActive = false);
          db.saveAll();
        }
        return sendJson(res, 200, { success: true, message: 'Subcategory removed' }, req);
      }

      // Update Main Category
      if (pathname.match(/^\/api\/admin\/categories\/[^\/]+$/) && method === 'PUT') {
        const catId = pathname.split('/')[4];
        const body = await parseBody(req);
        const cat = db.categories.find(c => c.id === catId);
        if (!cat) return sendJson(res, 404, { success: false, message: 'Category not found' }, req);

        if (body.name) cat.name = body.name.trim();
        if (body.slug) cat.slug = body.slug.trim();
        if (body.icon) cat.icon = body.icon.trim();
        if (body.sortOrder !== undefined) cat.sortOrder = Number(body.sortOrder);
        if (body.position !== undefined) cat.position = body.position === 'TOP' ? 'TOP' : 'BOTTOM';
        if (body.isActive !== undefined) cat.isActive = Boolean(body.isActive);
        db.saveAll();
        return sendJson(res, 200, { success: true, category: cat }, req);
      }

      // Delete Main Category (Soft-delete / catalog removal preserving all historical orders & transactions)
      if (pathname.match(/^\/api\/admin\/categories\/[^\/]+$/) && method === 'DELETE') {
        const catId = pathname.split('/')[4];
        const idx = db.categories.findIndex(c => c.id === catId);
        if (idx !== -1) {
          // Remove from active category list
          db.categories.splice(idx, 1);
          // Deactivate products under this category from active customer website
          db.products.filter(p => p.categoryId === catId).forEach(p => p.isActive = false);
          db.saveAll();
        }
        return sendJson(res, 200, { success: true, message: 'Category removed from active catalog' }, req);
      }

      // 5. Products CRUD
      if (pathname === '/api/admin/products' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.name || !body.name.trim()) return sendJson(res, 400, { success: false, message: 'Product name is required' }, req);
        if (body.sellingPrice === undefined || isNaN(Number(body.sellingPrice))) return sendJson(res, 400, { success: false, message: 'Valid selling price is required' }, req);

        const categoryId = body.categoryId || 'cat-ff';
        const targetCat = db.categories.find(c => c.id === categoryId);
        if (!targetCat) return sendJson(res, 400, { success: false, message: 'Invalid category selected' }, req);

        // Server-side validation: if subcategoryId is provided, ensure it belongs strictly to categoryId
        let subcategoryId = body.subcategoryId || null;
        if (subcategoryId) {
          const validSub = (targetCat.subcategories || []).find(s => s.id === subcategoryId);
          if (!validSub) {
            return sendJson(res, 400, { success: false, message: 'Selected subcategory does not belong to the chosen category' }, req);
          }
        }

        // Validate product type & delivery type strictly according to requirement
        const VALID_PRODUCT_TYPES = ['AUTO TOP-UP', 'CODE DELIVERY', 'GMAIL DELIVERY', 'ADMIN DELIVERY'];
        let productType = (body.productType || 'AUTO TOP-UP').toUpperCase().trim();
        if (!VALID_PRODUCT_TYPES.includes(productType)) {
          if (body.deliveryType === 'CODE Delivery') productType = 'CODE DELIVERY';
          else if (body.deliveryType === 'Gmail Delivery') productType = 'GMAIL DELIVERY';
          else if (body.deliveryType === 'Admin Delivery') productType = 'ADMIN DELIVERY';
          else productType = 'AUTO TOP-UP';
        }
        const deliveryType = body.deliveryType || (
          productType === 'CODE DELIVERY' ? 'CODE Delivery' : 
          productType === 'GMAIL DELIVERY' ? 'Gmail Delivery' : 
          productType === 'ADMIN DELIVERY' ? 'Admin Delivery' : 'UID Auto'
        );
        
        const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        let newProdId = body.id || `p-${slug || 'item'}`;
        if (!body.id && db.products.some(p => p.id === newProdId)) {
          newProdId = `p-${slug || 'item'}-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`;
        }
        const newProd = {
          id: newProdId,
          categoryId,
          subcategoryId,
          name: body.name.trim(),
          slug,
          icon: body.icon || 'assets/ff_diamond.jpg',
          sellingPrice: Number(body.sellingPrice),
          supplierCost: Number(body.supplierCost || 0),
          providerCode: body.providerCode || '',
          command: body.command !== undefined ? body.command : (body.providerCode ? (body.providerCode.startsWith('/') ? body.providerCode : `/topup {uid} ${body.providerCode}`) : ''),
          deliveryType,
          productType,
          currency: 'BDT',
          bonusTag: body.bonusTag || '',
          sortOrder: db.products.length + 1,
          isActive: body.isActive !== false,
          inStock: body.inStock !== false
        };
        db.products.push(newProd);
        db.saveAll();
        return sendJson(res, 201, { success: true, product: newProd }, req);
      }

      if (pathname.match(/^\/api\/admin\/products\/[^\/]+\/toggle-stock$/) && (method === 'POST' || method === 'PATCH')) {
        const prodId = pathname.split('/')[4];
        const prod = db.products.find(p => p.id === prodId);
        if (!prod) return sendJson(res, 404, { success: false, message: 'Product not found' }, req);
        const currentStock = prod.inStock !== false;
        prod.inStock = !currentStock;
        db.saveAll();
        return sendJson(res, 200, { success: true, product: prod, inStock: prod.inStock }, req);
      }

      if (pathname.startsWith('/api/admin/products/') && method === 'PUT') {
        const prodId = pathname.split('/')[4];
        const body = await parseBody(req);
        const prod = db.products.find(p => p.id === prodId);
        if (!prod) return sendJson(res, 404, { success: false, message: 'Product not found' }, req);

        if (body.categoryId) {
          const targetCat = db.categories.find(c => c.id === body.categoryId);
          if (!targetCat) return sendJson(res, 400, { success: false, message: 'Invalid category selected' }, req);
          prod.categoryId = body.categoryId;
        }

        if (body.subcategoryId !== undefined) {
          if (body.subcategoryId) {
            const currentCatId = body.categoryId || prod.categoryId;
            const targetCat = db.categories.find(c => c.id === currentCatId);
            const validSub = (targetCat && targetCat.subcategories || []).find(s => s.id === body.subcategoryId);
            if (!validSub) {
              return sendJson(res, 400, { success: false, message: 'Selected subcategory does not belong to the chosen category' }, req);
            }
          }
          prod.subcategoryId = body.subcategoryId || null;
        }

        if (body.name) prod.name = body.name.trim();
        if (body.sellingPrice !== undefined) prod.sellingPrice = Number(body.sellingPrice);
        if (body.supplierCost !== undefined) prod.supplierCost = Number(body.supplierCost);
        if (body.providerCode !== undefined) prod.providerCode = body.providerCode;
        if (body.command !== undefined) prod.command = body.command;
        if (body.icon) prod.icon = body.icon;
        if (body.bonusTag !== undefined) prod.bonusTag = body.bonusTag;
        
        if (body.productType) {
          const validTypes = ['AUTO TOP-UP', 'CODE DELIVERY', 'GMAIL DELIVERY', 'ADMIN DELIVERY'];
          const normType = body.productType.toUpperCase().trim();
          if (validTypes.includes(normType)) {
            prod.productType = normType;
            if (!body.deliveryType) {
              prod.deliveryType = normType === 'CODE DELIVERY' ? 'CODE Delivery' : (normType === 'GMAIL DELIVERY' ? 'Gmail Delivery' : (normType === 'ADMIN DELIVERY' ? 'Admin Delivery' : 'UID Auto'));
            }
          }
        }
        if (body.deliveryType) {
          prod.deliveryType = body.deliveryType;
          if (!body.productType) {
            prod.productType = body.deliveryType === 'CODE Delivery' ? 'CODE DELIVERY' : (body.deliveryType === 'Gmail Delivery' ? 'GMAIL DELIVERY' : (body.deliveryType === 'Admin Delivery' ? 'ADMIN DELIVERY' : 'AUTO TOP-UP'));
          }
        }
        if (body.isActive !== undefined) prod.isActive = Boolean(body.isActive);
        if (body.inStock !== undefined) prod.inStock = Boolean(body.inStock);
        db.saveAll();
        return sendJson(res, 200, { success: true, product: prod }, req);
      }

      if (pathname.startsWith('/api/admin/products/') && method === 'DELETE') {
        const prodId = pathname.split('/')[4];
        const idx = db.products.findIndex(p => p.id === prodId);
        if (idx !== -1) {
          db.products.splice(idx, 1);
          db.saveAll();
        }
        return sendJson(res, 200, { success: true }, req);
      }

      // Order Status Update & Gmail Delivery Bot Alert
      if (pathname.match(/^\/api\/admin\/orders\/[^\/]+\/status$/) && method === 'POST') {
        const orderId = pathname.split('/')[4];
        const body = await parseBody(req);
        const order = db.orders.find(o => o.id === orderId);
        if (!order) return sendJson(res, 404, { success: false, message: 'Order not found' }, req);

        const newStatus = body.status; // 'DONE', 'FAILED', 'REFUNDED'
        order.status = newStatus;
        if (body.adminNote) order.adminNote = body.adminNote;
        order.updatedAt = new Date().toISOString();

        if (newStatus === 'DONE') {
          // If Gmail Delivery or other, trigger bot alert if configured
          try {
            const botAlertMsg = `🎉 <b>[FREAKSHOW] Order Delivered!</b>\n\n📋 Order ID: <code>${order.id}</code>\n📦 Product: <b>${order.productName}</b>\n📧 Customer Gmail/UID: <code>${order.playerUid || order.userEmail}</code>\n💰 Amount: ৳${order.sellingPrice}\n👤 Customer: ${order.userName || order.userEmail}\n\n✅ Delivered by Admin: ${user.name || user.email}`;
            telegram.sendAdminBroadcast(botAlertMsg);
          } catch(e) {}
        } else if (newStatus === 'REFUNDED' || newStatus === 'FAILED') {
          await orderEngine.executeAutoRefund(order.id, body.reason || 'Admin manual refund');
        }

        db.saveAll();
        return sendJson(res, 200, { success: true, order }, req);
      }

      // 6. Banners CRUD
      if (pathname === '/api/admin/banners' && method === 'POST') {
        const body = await parseBody(req);
        const isPopupOn = body.isPopupEnabled !== false && body.isPopupEnabled !== 'false' && body.isPopupEnabled !== 'OFF' && body.isPopupEnabled !== 'off';
        const newBan = {
          id: `ban_${Date.now().toString(36)}`,
          title: body.title || '',
          description: body.description || '',
          buttonText: body.buttonText || 'Recharge Now 🚀',
          destinationUrl: body.destinationUrl || '#freefire-section',
          image: body.image || 'assets/freefire_special_offer.jpg',
          displayFrequency: body.displayFrequency || 'ONCE_PER_SESSION',
          status: (body.status === 'INACTIVE') ? 'INACTIVE' : 'ACTIVE',
          isPopupEnabled: isPopupOn,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        db.banners.push(newBan);
        db.saveAll();
        return sendJson(res, 201, { success: true, banner: newBan }, req);
      }

      if (pathname.startsWith('/api/admin/banners/') && method === 'PUT') {
        const banId = pathname.split('/')[4];
        const body = await parseBody(req);
        const ban = db.banners.find(b => b.id === banId);
        if (!ban) return sendJson(res, 404, { success: false, message: 'Banner not found' }, req);

        if (body.title !== undefined) ban.title = body.title;
        if (body.description !== undefined) ban.description = body.description;
        if (body.buttonText !== undefined) ban.buttonText = body.buttonText;
        if (body.destinationUrl !== undefined) ban.destinationUrl = body.destinationUrl;
        if (body.image !== undefined) ban.image = body.image;
        if (body.displayFrequency !== undefined) ban.displayFrequency = body.displayFrequency;
        if (body.status !== undefined) ban.status = (body.status === 'INACTIVE') ? 'INACTIVE' : 'ACTIVE';
        if (body.isPopupEnabled !== undefined) {
          ban.isPopupEnabled = body.isPopupEnabled !== false && body.isPopupEnabled !== 'false' && body.isPopupEnabled !== 'OFF' && body.isPopupEnabled !== 'off';
        }
        ban.updatedAt = new Date().toISOString();
        db.saveAll();
        return sendJson(res, 200, { success: true, banner: ban }, req);
      }

      if (pathname.startsWith('/api/admin/banners/') && method === 'DELETE') {
        const banId = pathname.split('/')[4];
        const idx = db.banners.findIndex(b => b.id === banId);
        if (idx !== -1) {
          db.banners.splice(idx, 1);
          db.saveAll();
        }
        return sendJson(res, 200, { success: true }, req);
      }

      // 7. Payment Settings & Platform Config
      if (pathname === '/api/admin/payment-settings' && method === 'PUT') {
        const body = await parseBody(req);
        if (body.paymentNumbers) {
          db.settings.paymentNumbers = { ...db.settings.paymentNumbers, ...body.paymentNumbers };
          if (body.paymentNumbers.binanceId && !body.paymentNumbers.binance) {
            db.settings.paymentNumbers.binance = body.paymentNumbers.binanceId;
          }
        }
        if (body.paymentInstructions) {
          db.settings.paymentInstructions = { ...(db.settings.paymentInstructions || {}), ...body.paymentInstructions };
        }
        if (body.paymentMethodStatus) {
          db.settings.paymentMethodStatus = {
            bkash: body.paymentMethodStatus.bkash !== false,
            nagad: body.paymentMethodStatus.nagad !== false,
            rocket: body.paymentMethodStatus.rocket !== false,
            cellfin: body.paymentMethodStatus.cellfin !== false,
            bangla_qr: body.paymentMethodStatus.bangla_qr !== false,
            binance: body.paymentMethodStatus.binance !== false,
            ...(body.paymentMethodStatus || {})
          };
        }
        if (body.minDepositBDT !== undefined) db.settings.minDepositBDT = Number(body.minDepositBDT);
        if (body.minDepositUSD !== undefined) db.settings.minDepositUSD = Number(body.minDepositUSD);
        if (body.usdToBdtRate !== undefined && !isNaN(Number(body.usdToBdtRate)) && Number(body.usdToBdtRate) > 0) {
          db.settings.usdToBdtRate = Number(body.usdToBdtRate);
          db.settings.exchangeRate = Number(body.usdToBdtRate);
        } else if (body.exchangeRate !== undefined && !isNaN(Number(body.exchangeRate)) && Number(body.exchangeRate) > 0) {
          db.settings.usdToBdtRate = Number(body.exchangeRate);
          db.settings.exchangeRate = Number(body.exchangeRate);
        }

        // How to Deposit settings handler
        if (body.howToDeposit) {
          db.settings.howToDeposit = {
            enabled: body.howToDeposit.enabled !== false,
            title: body.howToDeposit.title || 'কীভাবে টাকা Deposit করবেন?',
            image: body.howToDeposit.image || 'assets/how_to_deposit.jpg',
            url: body.howToDeposit.url || 'https://youtube.com',
            description: body.howToDeposit.description || 'ভিডিও টিউটোরিয়াল দেখতে এখানে ক্লিক করুন'
          };
          db.settings.how_to_deposit_enabled = db.settings.howToDeposit.enabled;
          db.settings.how_to_deposit_title = db.settings.howToDeposit.title;
          db.settings.how_to_deposit_image = db.settings.howToDeposit.image;
          db.settings.how_to_deposit_url = db.settings.howToDeposit.url;
        } else if (body.how_to_deposit_enabled !== undefined || body.how_to_deposit_title !== undefined || body.how_to_deposit_image !== undefined || body.how_to_deposit_url !== undefined) {
          const enabled = body.how_to_deposit_enabled !== undefined ? Boolean(body.how_to_deposit_enabled) : true;
          const title = body.how_to_deposit_title || 'কীভাবে টাকা Deposit করবেন?';
          const image = body.how_to_deposit_image || 'assets/how_to_deposit.jpg';
          const url = body.how_to_deposit_url || 'https://youtube.com';
          db.settings.how_to_deposit_enabled = enabled;
          db.settings.how_to_deposit_title = title;
          db.settings.how_to_deposit_image = image;
          db.settings.how_to_deposit_url = url;
          db.settings.howToDeposit = {
            enabled,
            title,
            image,
            url,
            description: 'ভিডিও টিউটোরিয়াল দেখতে এখানে ক্লিক করুন'
          };
        }

        db.saveAll();
        return sendJson(res, 200, { success: true, settings: db.settings }, req);
      }

      // Secure Image Upload for Admin
      if (pathname === '/api/admin/upload' && method === 'POST') {
        const body = await parseBody(req);
        const { imageBase64, filename } = body;
        if (!imageBase64 || typeof imageBase64 !== 'string') {
          return sendJson(res, 400, { success: false, message: 'Image data is required.' }, req);
        }

        const matches = imageBase64.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
        let ext = 'jpg';
        let base64Data = imageBase64;
        if (matches) {
          const mimeExt = matches[1].toLowerCase();
          ext = mimeExt === 'jpeg' ? 'jpg' : (mimeExt === 'png' ? 'png' : (mimeExt === 'webp' ? 'webp' : 'jpg'));
          base64Data = matches[2];
        } else if (filename && filename.includes('.')) {
          const rawExt = filename.split('.').pop().toLowerCase();
          if (['jpg', 'jpeg', 'png', 'webp'].includes(rawExt)) {
            ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
          }
        }

        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length > 5 * 1024 * 1024) {
          return sendJson(res, 400, { success: false, message: 'Image size exceeds 5MB limit.' }, req);
        }

        const safeFileName = `dep_banner_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const targetPath = path.join(PUBLIC_DIR, 'assets', safeFileName);
        fs.writeFileSync(targetPath, buffer);

        return sendJson(res, 200, {
          success: true,
          url: `assets/${safeFileName}`,
          filename: safeFileName
        }, req);
      }

      if (pathname === '/api/admin/settings' && method === 'GET') {
        const safeSettings = { ...db.settings, vipAccessCode: undefined, vipAccessCodeHash: undefined };
        return sendJson(res, 200, { success: true, settings: safeSettings }, req);
      }

      if (pathname === '/api/admin/settings' && method === 'PUT') {
        const body = await parseBody(req);
        // Prevent overwriting hashed VIP code through generic settings update
        const { vipAccessCode, vipAccessCodeHash, ...allowedSettings } = body;
        if (allowedSettings.usdToBdtRate !== undefined && !isNaN(Number(allowedSettings.usdToBdtRate)) && Number(allowedSettings.usdToBdtRate) > 0) {
          allowedSettings.usdToBdtRate = Number(allowedSettings.usdToBdtRate);
          allowedSettings.exchangeRate = Number(allowedSettings.usdToBdtRate);
        } else if (allowedSettings.exchangeRate !== undefined && !isNaN(Number(allowedSettings.exchangeRate)) && Number(allowedSettings.exchangeRate) > 0) {
          allowedSettings.usdToBdtRate = Number(allowedSettings.exchangeRate);
          allowedSettings.exchangeRate = Number(allowedSettings.exchangeRate);
        }
        db.settings = { ...db.settings, ...allowedSettings };
        db.saveAll();
        const safeSettings = { ...db.settings, vipAccessCode: undefined, vipAccessCodeHash: undefined };
        return sendJson(res, 200, { success: true, settings: safeSettings }, req);
      }

      // 8. Secure VIP Access Code Management
      if (pathname === '/api/admin/vip-code' && method === 'GET') {
        const currentCode = db.settings.currentVipCode || db.settings.vipAccessCode || 'JOY100LVL';
        return sendJson(res, 200, {
          success: true,
          currentVipCode: currentCode,
          vipCodeVersion: db.settings.vipCodeVersion || 1
        }, req);
      }

      if (pathname === '/api/admin/vip-code' && method === 'PUT') {
        const body = await parseBody(req);
        const oldCode = String(body.oldCode || '').trim().toUpperCase();
        const newCode = String(body.newCode || '').trim().toUpperCase();
        const confirmCode = String(body.confirmCode || '').trim().toUpperCase();

        if (!oldCode) {
          return sendJson(res, 400, { success: false, message: 'Old VIP Access Code is required.' }, req);
        }
        if (!newCode || newCode.length < 4) {
          return sendJson(res, 400, { success: false, message: 'New VIP Access Code must be at least 4 characters.' }, req);
        }
        if (newCode !== confirmCode) {
          return sendJson(res, 400, { success: false, message: 'New VIP Access Code and confirmation do not match.' }, req);
        }

        // 1. Verify Old Code against stored bcrypt hash, legacy string, or currentVipCode
        let isOldValid = false;
        if (db.settings.vipAccessCodeHash) {
          isOldValid = await bcrypt.compare(oldCode, db.settings.vipAccessCodeHash);
        } else if (db.settings.currentVipCode || db.settings.vipAccessCode) {
          isOldValid = oldCode === String(db.settings.currentVipCode || db.settings.vipAccessCode).trim().toUpperCase();
        } else {
          isOldValid = oldCode === 'JOY100LVL';
        }

        if (!isOldValid) {
          return sendJson(res, 400, { success: false, message: 'Incorrect current VIP Access Code.' }, req);
        }

        // 2. Hash New Code with bcrypt & Update Version to immediately invalidate previous sessions
        const newHash = await bcrypt.hash(newCode, 12);
        db.settings.currentVipCode = newCode;
        db.settings.vipAccessCode = newCode;
        db.settings.vipAccessCodeHash = newHash;
        db.settings.vipCodeVersion = Date.now();

        // 3. Invalidate/revoke VIP status across all users in database
        if (Array.isArray(db.users)) {
          db.users.forEach(u => {
            if (u.isVip) u.isVip = false;
            if (u.vipUnlocked) u.vipUnlocked = false;
            if (u.vipUnlockedAt) delete u.vipUnlockedAt;
            if (u.vipCodeVersion) delete u.vipCodeVersion;
          });
        }
        db.saveAll();

        // 4. Record Audit Log (CRITICAL: NEVER logging old or new secret code values)
        recordAuditLog({
          actorId: user.id,
          action: 'VIP_ACCESS_CODE_CHANGED',
          targetId: 'settings.vipAccessCode',
          reason: `VIP Access Code changed by Admin: ${user.name || user.email}. All existing VIP customer sessions revoked.`
        });

        return sendJson(res, 200, {
          success: true,
          message: 'VIP Access Code updated and all existing VIP sessions revoked successfully!',
          vipCodeVersion: db.settings.vipCodeVersion
        }, req);
      }

      // 8.1 1-Click VIP Access Code Reset & Generation
      if (pathname === '/api/admin/vip-code/reset' && method === 'POST') {
        const body = await parseBody(req);
        // Optional custom new code or generate random 8-character alphanumeric code
        let newSecret = String(body.newCode || '').trim().toUpperCase();
        if (!newSecret) {
          const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
          let gen = 'FSVIP-';
          for (let i = 0; i < 6; i++) {
            gen += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          newSecret = gen;
        }

        const newHash = await bcrypt.hash(newSecret, 12);
        db.settings.currentVipCode = newSecret;
        db.settings.vipAccessCode = newSecret;
        db.settings.vipAccessCodeHash = newHash;
        db.settings.vipCodeVersion = Date.now();

        if (Array.isArray(db.users)) {
          db.users.forEach(u => {
            if (u.isVip) u.isVip = false;
            if (u.vipUnlocked) u.vipUnlocked = false;
            if (u.vipUnlockedAt) delete u.vipUnlockedAt;
            if (u.vipCodeVersion) delete u.vipCodeVersion;
          });
        }
        db.saveAll();

        recordAuditLog({
          actorId: user.id,
          action: 'VIP_ACCESS_CODE_RESET',
          targetId: 'settings.vipAccessCode',
          reason: `VIP Access Code reset by Admin: ${user.name || user.email}. All previous VIP accesses revoked.`
        });

        return sendJson(res, 200, {
          success: true,
          message: 'VIP Access Code has been reset and all previous VIP accesses revoked!',
          newVipCode: newSecret,
          vipCodeVersion: db.settings.vipCodeVersion
        }, req);
      }

      // 7.5 Referral Admin System Management
      if (pathname === '/api/admin/referral' && method === 'GET') {
        const overview = referralEngine.getAdminReferralOverview();
        return sendJson(res, 200, { success: true, ...overview }, req);
      }

      if (pathname === '/api/admin/referral/settings' && method === 'PUT') {
        const body = await parseBody(req);
        if (body.referralSystemEnabled !== undefined) db.settings.referralSystemEnabled = Boolean(body.referralSystemEnabled);
        if (body.referralCommissionPercent !== undefined && !isNaN(parseFloat(body.referralCommissionPercent))) {
          db.settings.referralCommissionPercent = Number(parseFloat(body.referralCommissionPercent).toFixed(4));
        }
        if (body.minDepositForCommission !== undefined) db.settings.minDepositForCommission = Number(parseFloat(body.minDepositForCommission) || 0);
        if (body.maxCommissionPerDeposit !== undefined) db.settings.maxCommissionPerDeposit = Number(parseFloat(body.maxCommissionPerDeposit) || 0);
        if (body.firstDepositOnly !== undefined) db.settings.firstDepositOnly = Boolean(body.firstDepositOnly);
        if (body.referralValidityDays !== undefined) db.settings.referralValidityDays = Number(parseInt(body.referralValidityDays, 10) || 0);
        if (body.antiFraudEnabled !== undefined) db.settings.antiFraudEnabled = Boolean(body.antiFraudEnabled);
        if (body.newUserBonusEnabled !== undefined) db.settings.newUserBonusEnabled = Boolean(body.newUserBonusEnabled);

        db.saveAll();

        recordAuditLog({
          actorId: user.id,
          actorEmail: user.email,
          role: user.role,
          action: 'UPDATE_REFERRAL_SETTINGS',
          targetId: 'settings.referral',
          reason: `Referral settings updated by ${user.name || user.email}`
        });

        return sendJson(res, 200, {
          success: true,
          message: 'Referral settings updated successfully',
          settings: {
            referralSystemEnabled: db.settings.referralSystemEnabled !== false,
            referralCommissionPercent: db.settings.referralCommissionPercent,
            minDepositForCommission: db.settings.minDepositForCommission,
            maxCommissionPerDeposit: db.settings.maxCommissionPerDeposit,
            firstDepositOnly: db.settings.firstDepositOnly,
            referralValidityDays: db.settings.referralValidityDays,
            antiFraudEnabled: db.settings.antiFraudEnabled,
            newUserBonusEnabled: db.settings.newUserBonusEnabled
          }
        }, req);
      }

      // Retry Failed Order (re-dispatch to supplier)
      if (pathname.match(/^\/api\/admin\/orders\/[^\/]+\/retry$/) && method === 'POST') {
        const orderId = pathname.split('/')[4];
        const order = db.orders.find(o => o.id === orderId);
        if (!order) return sendJson(res, 404, { success: false, message: 'Order not found' }, req);
        if (order.status !== 'FAILED') {
          return sendJson(res, 400, { success: false, message: 'Only FAILED orders can be retried.' }, req);
        }

        try {
          order.status = 'PROCESSING';
          order.retryCount = (order.retryCount || 0) + 1;
          order.retryAt = new Date().toISOString();
          db.saveAll();

          // Re-dispatch to order engine
          const result = await orderEngine.processOrder(order.id);
          db.saveAll();

          return sendJson(res, 200, { success: true, order: db.orders.find(o => o.id === orderId), result }, req);
        } catch (err) {
          order.status = 'FAILED';
          order.failReason = err.message;
          db.saveAll();
          return sendJson(res, 500, { success: false, message: 'Retry failed: ' + err.message }, req);
        }
      }

      // 8. Staff / Admins Authorization (Master Owner Only)
      if (pathname === '/api/admin/admins' && method === 'POST') {
        if (user.role !== 'SUPER_ADMIN') {
          return sendJson(res, 403, { success: false, message: 'Master Owner authority required.' }, req);
        }
        const body = await parseBody(req);
        const query = (body.identifier || '').toLowerCase().trim();
        const target = db.users.find(u => 
          (u.email && u.email.toLowerCase() === query) || 
          (u.username && u.username.toLowerCase() === query) ||
          u.id === query
        );

        if (!target) return sendJson(res, 404, { success: false, message: 'User account not found' }, req);

        target.role = body.role || 'SUB_ADMIN';
        if (body.telegramId) target.telegramId = body.telegramId.trim();
        target.updatedAt = new Date().toISOString();
        db.saveAll();

        recordAuditLog({
          actorId: user.id,
          action: 'AUTHORIZE_STAFF',
          targetId: target.id,
          reason: `Promoted to ${target.role} by ${user.name || user.email}`
        });

        return sendJson(res, 200, { success: true, user: auth.sanitizeUser(target) }, req);
      }

      if (pathname.startsWith('/api/admin/admins/') && method === 'DELETE') {
        if (user.role !== 'SUPER_ADMIN') {
          return sendJson(res, 403, { success: false, message: 'Master Owner authority required.' }, req);
        }
        const adminUserId = pathname.split('/')[4];
        const target = db.users.find(u => u.id === adminUserId);
        if (!target) return sendJson(res, 404, { success: false, message: 'Admin not found' }, req);

        target.role = 'USER';
        target.updatedAt = new Date().toISOString();
        db.saveAll();

        return sendJson(res, 200, { success: true, message: 'Admin access revoked' }, req);
      }
    }

    // 6. PUBLIC CATALOG & CATEGORIES APIS
    if (pathname === '/api/categories' && method === 'GET') {
      const activeCats = db.categories
        .filter(c => c.isActive !== false && !c.isDeleted)
        .map(c => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          icon: c.icon || 'assets/ff_diamond.jpg',
          sortOrder: c.sortOrder || 1,
          isActive: c.isActive !== false,
          productCount: db.products.filter(p => p.categoryId === c.id && p.isActive !== false).length,
          subcategories: (c.subcategories || [])
            .filter(s => s.isActive !== false && !s.isDeleted)
            .map(s => ({
              id: s.id,
              categoryId: s.categoryId || c.id,
              name: s.name,
              slug: s.slug,
              sortOrder: s.sortOrder || 1,
              isActive: s.isActive !== false,
              productCount: db.products.filter(p => p.subcategoryId === s.id && p.isActive !== false).length
            }))
        }));
      return sendJson(res, 200, { success: true, categories: activeCats }, req);
    }

    if (pathname === '/api/products' && method === 'GET') {
      const activeProds = db.products.filter(p => p.isActive !== false);
      const activeCats = db.categories
        .filter(c => c.isActive !== false && !c.isDeleted)
        .map(c => ({
          ...c,
          subcategories: (c.subcategories || []).filter(s => s.isActive !== false && !s.isDeleted)
        }));
      return sendJson(res, 200, { success: true, products: activeProds, categories: activeCats }, req);
    }

    // -------------------------------------------------------------
    // STATIC FILE SERVING WITH SECURITY HEADERS
    // -------------------------------------------------------------
    // Strip query string — only the real path matters for file lookup
    const cleanPath = pathname.split('?')[0];
    let filePath;

    if (cleanPath === '/' || cleanPath === '/index.html') {
      filePath = path.join(PUBLIC_DIR, 'INDEX.HTML');
    } else if (cleanPath === '/favicon.ico') {
      filePath = path.join(PUBLIC_DIR, 'assets', 'logo.jpg');
    } else if (cleanPath.toLowerCase() === '/admin-login' || cleanPath.toLowerCase() === '/admin-login.html') {
      filePath = path.join(PUBLIC_DIR, 'admin-login.html');
    } else if (cleanPath.startsWith('/admin/assets/')) {
      filePath = path.join(PUBLIC_DIR, 'assets', cleanPath.replace('/admin/assets/', ''));
    } else if (cleanPath === '/admin' || cleanPath.startsWith('/admin/')) {
      filePath = path.join(PUBLIC_DIR, 'admin.html');
    } else {
      filePath = path.join(PUBLIC_DIR, cleanPath);
    }

    // Prevent directory traversal attacks
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // Block direct browser access to sensitive backend directories
    if (cleanPath.startsWith('/lib') || cleanPath.startsWith('/data') || cleanPath.startsWith('/api') || cleanPath.startsWith('/tests') || cleanPath.includes('.env')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // Fallback to index for client routing
        filePath = path.join(PUBLIC_DIR, 'INDEX.HTML');
      }

      fs.stat(filePath, (statErr, finalStats) => {
        if (statErr || !finalStats.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.webp': 'image/webp',
          '.ico': 'image/x-icon',
          '.woff2': 'font/woff2',
          '.woff': 'font/woff',
          '.ttf': 'font/ttf',
          '.xml': 'application/xml; charset=utf-8',
          '.txt': 'text/plain; charset=utf-8'
        };

        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const etag = `W/"${finalStats.size.toString(16)}-${finalStats.mtime.getTime().toString(16)}"`;
        const lastModified = finalStats.mtime.toUTCString();

        // Check conditional headers (ETag / If-Modified-Since) for 304 Not Modified
        const ifNoneMatch = req.headers['if-none-match'];
        const ifModifiedSince = req.headers['if-modified-since'];

        if (ifNoneMatch === etag || (ifModifiedSince && new Date(ifModifiedSince) >= finalStats.mtime)) {
          res.writeHead(304, {
            'ETag': etag,
            'Last-Modified': lastModified,
            'Cache-Control': (ext === '.html' || ext === '.js' || ext === '.css') ? 'no-cache, must-revalidate' : 'public, max-age=86400, stale-while-revalidate=604800'
          });
          res.end();
          return;
        }

        let cacheControl = 'public, max-age=86400, stale-while-revalidate=604800';
        if (ext === '.html' || ext === '.js' || ext === '.css') {
          cacheControl = 'no-cache, must-revalidate';
        } else if (['.jpg', '.jpeg', '.png', '.webp', '.svg', '.ico', '.woff2'].includes(ext)) {
          cacheControl = 'public, max-age=2592000, immutable'; // 30 days for static assets
        }

        const securityHeaders = {
          'Content-Type': contentType,
          'ETag': etag,
          'Last-Modified': lastModified,
          'Cache-Control': cacheControl,
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
        };

        // Apply Content-Security-Policy on HTML documents
        if (ext === '.html') {
          securityHeaders['Content-Security-Policy'] = "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; img-src 'self' https: data: blob:; font-src 'self' https: data:; frame-ancestors 'self';";
        }

        // For compressible static files (HTML, JS, CSS, JSON, SVG, XML, TXT), compress and send
        if (['.html', '.js', '.css', '.json', '.svg', '.xml', '.txt'].includes(ext)) {
          fs.readFile(filePath, (readErr, fileData) => {
            if (readErr) {
              res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Error loading file');
              return;
            }
            compressAndSend(req, res, 200, securityHeaders, fileData);
          });
        } else {
          // Stream binary files (images, audio, etc.)
          securityHeaders['Content-Length'] = finalStats.size;
          res.writeHead(200, securityHeaders);
          fs.createReadStream(filePath).pipe(res);
        }
      });
    });

  } catch (serverErr) {
    console.error('[UNCAUGHT SERVER ERROR]', serverErr);
    return sendJson(res, 500, { success: false, message: 'An internal server error occurred.' }, req);
  }
});

// Start Server and Telegram Poller
server.listen(PORT, () => {
  console.log(`
======================================================
🎮 FREAKSHOWTOPUP PLATFORM ACTIVE (ENTERPRISE GRADE)
🌐 URL: http://localhost:${PORT}
🚀 Domain: freakshowtopup.shop
🛡️ Security: CSP, HSTS, Rate Limiter & RBAC Active
======================================================
  `);

  if (process.env.NODE_ENV !== 'test') {
    telegram.startTelegramPolling();
  }
});

module.exports = server;
