/**
 * FREAKSHOWTOPUP - SECURE AUTHENTICATION & RBAC ENGINE (PRODUCTION GRADE)
 * Implements bcrypt password hashing, JWT sessions, Google OAuth2/OIDC verification,
 * and server-side Role-Based Access Control (RBAC).
 */

const crypto = require('crypto');
const https = require('https');
const bcrypt = require('bcryptjs');
const db = require('./db');

const BCRYPT_ROUNDS = 12;
const JWT_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();

// Role Hierarchy & Permission Levels
const ROLE_HIERARCHY = {
  SUPER_ADMIN: 400,
  ADMIN: 300,
  MODERATOR: 200,
  USER: 100
};

/**
 * Check if an actor's role meets the minimum required role
 */
function hasRole(userRole, requiredRole) {
  const userLevel = ROLE_HIERARCHY[userRole] || 0;
  const requiredLevel = ROLE_HIERARCHY[requiredRole] || 100;
  return userLevel >= requiredLevel;
}

/**
 * Hash password securely with bcrypt
 */
async function hashPassword(plainPassword) {
  if (!plainPassword || typeof plainPassword !== 'string' || plainPassword.length < 6) {
    throw new Error('Password must be at least 6 characters long.');
  }
  return await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
}

/**
 * Verify password against stored bcrypt hash (with zero hardcoded fallbacks)
 */
async function verifyPassword(plainPassword, storedHash) {
  if (!plainPassword || !storedHash) return false;
  try {
    if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
      return await bcrypt.compare(plainPassword, storedHash);
    }
    // Legacy pbkdf2 format: salt:hash
    if (storedHash.includes(':')) {
      const [salt, hash] = storedHash.split(':');
      const testHash = crypto.pbkdf2Sync(plainPassword, salt, 10000, 64, 'sha512').toString('hex');
      const hashBuf = Buffer.from(hash);
      const testBuf = Buffer.from(testHash);
      if (hashBuf.length === testBuf.length && crypto.timingSafeEqual(hashBuf, testBuf)) {
        return true;
      }
    }
    return await bcrypt.compare(plainPassword, storedHash);
  } catch (err) {
    return false;
  }
}

/**
 * Sign secure JWT session token
 */
function signToken(payload, expiresInMinutes = 60 * 24 * 7) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + (expiresInMinutes * 60);
  const data = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
  return `${header}.${data}.${signature}`;
}

/**
 * Verify and decode JWT session token with timing-safe comparison
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, data, signature] = parts;

  const expectedSignature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
  
  // Timing-safe signature check
  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
  } catch (e) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null; // Expired
    }
    return payload;
  } catch (e) {
    return null;
  }
}

/**
 * Extract authenticated user from incoming HTTP request headers or cookies
 */
function authenticateRequest(req) {
  let token = null;

  // 1. Authorization header: Bearer <token>
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  // 2. Cookie fallback: token=<token>
  if (!token && req.headers['cookie']) {
    const cookies = req.headers['cookie'].split(';');
    for (const c of cookies) {
      const [k, v] = c.trim().split('=');
      if (k === 'auth_token' || k === 'token') {
        token = decodeURIComponent(v || '');
        break;
      }
    }
  }

  if (!token) return null;

  const payload = verifyToken(token);
  if (!payload || !payload.id) return null;

  const user = db.users.find(u => u.id === payload.id);
  if (!user || user.status === 'BANNED' || user.status === 'SUSPENDED') {
    return null;
  }

  return user;
}

/**
 * Verify Google ID Token (OIDC / OAuth2) securely with Google's tokeninfo service
 */
async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Google ID token is required.');
  }

  // Allow mock tokens during isolated unit tests
  if (process.env.NODE_ENV === 'test' && idToken.startsWith('mock_google_')) {
    const mockEmail = idToken.replace('mock_google_', '').toLowerCase();
    return {
      email: mockEmail,
      email_verified: true,
      name: 'Mock Google User',
      picture: null,
      sub: `mock_sub_${mockEmail}`
    };
  }

  return new Promise((resolve, reject) => {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode !== 200 || parsed.error || parsed.error_description) {
            return reject(new Error(parsed.error_description || 'Invalid Google token.'));
          }

          // Verify audience if configured in environment
          if (GOOGLE_CLIENT_ID && parsed.aud !== GOOGLE_CLIENT_ID) {
            return reject(new Error('Google token audience mismatch.'));
          }

          // Verify issuer
          const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
          if (!validIssuers.includes(parsed.iss)) {
            return reject(new Error('Invalid Google token issuer.'));
          }

          // Verify email verified
          if (parsed.email_verified !== 'true' && parsed.email_verified !== true) {
            return reject(new Error('Google account email is not verified.'));
          }

          resolve({
            email: parsed.email.toLowerCase().trim(),
            email_verified: true,
            name: parsed.name || parsed.given_name || 'Google Gamer',
            picture: parsed.picture || null,
            sub: parsed.sub
          });
        } catch (err) {
          reject(new Error('Failed to parse Google token verification response.'));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Google verification network error: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Google verification request timed out.'));
    });
  });
}

/**
 * Register a new user with standard credentials
 */
async function registerUser({ name, email, username, password, country = 'BD', currency = 'BDT', referralCode = null }) {
  if (!email || !name || !password) {
    throw new Error('Name, email, and password are required.');
  }

  email = email.toLowerCase().trim();
  if (!email.includes('@') || email.length > 100) {
    throw new Error('Invalid email address format.');
  }

  if (username) {
    username = username.replace(/^@/, '').toLowerCase().trim();
    if (!isValidUsername(username)) {
      throw new Error('Username must be 3-30 characters long and contain only letters, numbers, and underscores.');
    }
  }

  // Ensure unique email and username
  if (db.users.some(u => u.email === email)) {
    throw new Error('An account with this email already exists.');
  }
  if (username && isUsernameTaken(username)) {
    throw new Error('Username already taken. Please choose another username.');
  }

  // Validate currency & country
  currency = currency.toUpperCase() === 'USD' ? 'USD' : 'BDT';
  country = ['BD', 'NP', 'GLOBAL'].includes(country.toUpperCase()) ? country.toUpperCase() : 'BD';

  // Referral code attribution
  let referredById = null;
  if (referralCode) {
    const referrer = db.users.find(u => u.referralCode && u.referralCode.toUpperCase() === referralCode.trim().toUpperCase());
    if (referrer) {
      referredById = referrer.id;
    }
  }

  const userId = `usr_${crypto.randomBytes(8).toString('hex')}`;
  const userReferralCode = `FS${Math.floor(100000 + Math.random() * 900000)}`;

  // Super Admin is ONLY granted if explicitly matching SUPER_ADMIN_EMAIL from environment variables
  let role = 'USER';
  if (SUPER_ADMIN_EMAIL && email === SUPER_ADMIN_EMAIL) {
    role = 'SUPER_ADMIN';
  }

  const passwordHash = await hashPassword(password);

  const newUser = {
    id: userId,
    email,
    username: username || generateUniqueUsername(email.split('@')[0]),
    name: name.trim(),
    passwordHash,
    role,
    country,
    currency,
    currencyChangeUsed: false,
    referralCode: userReferralCode,
    referredById,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString()
  };

  // Initialize associated user wallet atomically
  const newWallet = {
    id: `wal_${crypto.randomBytes(8).toString('hex')}`,
    userId: newUser.id,
    currency: newUser.currency,
    balance: 0.00,
    lockedAmount: 0.00,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.users.push(newUser);
  db.wallets.push(newWallet);
  db.saveAll();

  const token = signToken({
    id: newUser.id,
    email: newUser.email,
    name: newUser.name,
    role: newUser.role,
    currency: newUser.currency
  });

  return { user: sanitizeUser(newUser), wallet: newWallet, token };
}

/**
 * Login user with email/username and password
 */
async function loginUser({ emailOrUsername, password }) {
  if (!emailOrUsername || !password) {
    throw new Error('Email/username and password are required.');
  }

  const query = emailOrUsername.toLowerCase().trim();
  const user = db.users.find(u => u.email === query || (u.username && u.username === query));

  if (!user) {
    throw new Error('Invalid email/username or password.');
  }

  if (user.status === 'BANNED' || user.status === 'SUSPENDED') {
    throw new Error('Your account is currently suspended. Please contact support.');
  }

  // Admin isolation guard: Admin emails can ONLY log in via /Admin-login
  if (user.email === 'it.jibon05@gmail.com' || ['SUPER_ADMIN', 'ADMIN'].includes(user.role)) {
    throw new Error('This is an Administrator account. Please use the Admin Portal (/Admin-login) to sign in.');
  }

  const isPasswordValid = await verifyPassword(password, user.passwordHash);
  if (!isPasswordValid) {
    throw new Error('Invalid email/username or password.');
  }

  // Update last login timestamp
  user.lastLoginAt = new Date().toISOString();
  user.updatedAt = new Date().toISOString();
  db.saveAll();

  let wallet = db.wallets.find(w => w.userId === user.id);
  if (!wallet) {
    wallet = {
      id: `wal_${crypto.randomBytes(8).toString('hex')}`,
      userId: user.id,
      currency: user.currency || 'BDT',
      balance: 0.00,
      lockedAmount: 0.00,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.wallets.push(wallet);
    db.saveAll();
  }

  const token = signToken({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    currency: user.currency
  });

  return { user: sanitizeUser(user), wallet, token };
}

/**
 * Authenticate or auto-register user via Google OAuth2 / OIDC ID token
 */
async function googleAuth({ credential, idToken, referralCode = null, country = 'BD', currency = 'BDT', isAdminLogin = false }) {
  const rawToken = credential || idToken;
  if (!rawToken) {
    throw new Error('Google credential or ID token is required.');
  }

  const gUser = await verifyGoogleIdToken(rawToken);
  const userEmail = gUser.email.toLowerCase().trim();

  let user = db.users.find(u => u.email && u.email.toLowerCase() === userEmail);

  if (user) {
    if (user.status === 'BANNED' || user.status === 'SUSPENDED') {
      throw new Error('Your account is currently suspended. Please contact support.');
    }
    const isConfiguredSuperAdmin = SUPER_ADMIN_EMAIL && userEmail === SUPER_ADMIN_EMAIL.toLowerCase().trim();
    if (isConfiguredSuperAdmin) {
      user.role = 'SUPER_ADMIN';
    } else if (!isAdminLogin && (user.email === 'it.jibon05@gmail.com' || ['SUPER_ADMIN', 'ADMIN'].includes(user.role))) {
      throw new Error('This is an Administrator account. Please use the Admin Portal (/Admin-login) to sign in.');
    }
    if (gUser.name && (!user.name || user.name.startsWith('gamer_'))) {
      user.name = gUser.name.trim();
    }
    if (gUser.picture) user.picture = gUser.picture;
    if (gUser.sub) user.googleId = gUser.sub;
    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();
  } else {
    currency = currency.toUpperCase() === 'USD' ? 'USD' : 'BDT';
    country = ['BD', 'NP', 'GLOBAL'].includes(country.toUpperCase()) ? country.toUpperCase() : 'BD';

    let referredById = null;
    if (referralCode) {
      const referrer = db.users.find(u => u.referralCode && u.referralCode.toUpperCase() === referralCode.trim().toUpperCase());
      if (referrer) {
        referredById = referrer.id;
      }
    }

    const userId = `usr_${crypto.randomBytes(8).toString('hex')}`;
    const userReferralCode = `FS${Math.floor(100000 + Math.random() * 900000)}`;
    const emailPrefix = userEmail.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 15);
    const username = `${emailPrefix}_${Math.floor(100 + Math.random() * 900)}`;

    let role = 'USER';
    if (SUPER_ADMIN_EMAIL && userEmail === SUPER_ADMIN_EMAIL.toLowerCase().trim()) {
      role = 'SUPER_ADMIN';
    }

    const randomPassword = crypto.randomBytes(24).toString('hex');
    const passwordHash = await hashPassword(randomPassword);

    user = {
      id: userId,
      email: userEmail,
      username,
      name: (gUser.name && gUser.name.trim()) || emailPrefix,
      picture: gUser.picture || null,
      googleId: gUser.sub || null,
      authProvider: 'GOOGLE',
      passwordHash,
      role,
      country,
      currency,
      currencyChangeUsed: false,
      referralCode: userReferralCode,
      referredById,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString()
    };

    const newWallet = {
      id: `wal_${crypto.randomBytes(8).toString('hex')}`,
      userId: user.id,
      currency: user.currency,
      balance: 0.00,
      lockedAmount: 0.00,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.users.push(user);
    db.wallets.push(newWallet);
  }

  db.saveAll();

  let wallet = db.wallets.find(w => w.userId === user.id);
  if (!wallet) {
    wallet = {
      id: `wal_${crypto.randomBytes(8).toString('hex')}`,
      userId: user.id,
      currency: user.currency || 'BDT',
      balance: 0.00,
      lockedAmount: 0.00,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.wallets.push(wallet);
    db.saveAll();
  }

  const token = signToken({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    currency: user.currency
  });

  return { user: sanitizeUser(user), wallet, token };
}

/**
 * Validate username format (3-30 chars, alphanumeric and underscore only)
 */
function isValidUsername(username) {
  if (!username || typeof username !== 'string') return false;
  const clean = username.replace(/^@/, '').trim();
  return /^[a-zA-Z0-9_]{3,30}$/.test(clean);
}

/**
 * Check if a username is already taken by another user
 */
function isUsernameTaken(username, excludeUserId = null) {
  if (!username) return false;
  const clean = String(username).replace(/^@/, '').toLowerCase().trim();
  return db.users.some(u => {
    if (excludeUserId && u.id === excludeUserId) return false;
    return u.username && u.username.toLowerCase().trim() === clean;
  });
}

/**
 * Generate a safe unique username based on a name or email hint
 */
function generateUniqueUsername(baseHint = 'gamer', excludeUserId = null) {
  let cleanBase = String(baseHint || 'gamer')
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .toLowerCase()
    .slice(0, 15);
  if (!cleanBase || cleanBase.length < 3) {
    cleanBase = `gamer_${Math.random().toString(36).slice(2, 7)}`;
  }
  let candidate = cleanBase;
  let counter = 1;
  while (isUsernameTaken(candidate, excludeUserId)) {
    candidate = `${cleanBase.slice(0, 14)}_${counter++}`;
  }
  return candidate;
}

/**
 * Safely ensure all existing users in the database have a unique username without breaking accounts
 */
function ensureUniqueUsernames() {
  const seenUsernames = new Set();
  let modified = false;

  for (const user of db.users) {
    let uName = (user.username || '').replace(/^@/, '').toLowerCase().trim();
    if (!uName || !isValidUsername(uName) || seenUsernames.has(uName)) {
      const hint = (user.email && user.email.includes('@') && !user.email.startsWith('@'))
        ? user.email.split('@')[0]
        : (user.name || user.id || 'gamer');
      
      let candidate = generateUniqueUsername(hint, user.id);
      user.username = candidate;
      seenUsernames.add(candidate);
      modified = true;
    } else {
      user.username = uName;
      seenUsernames.add(uName);
    }
  }

  if (modified) {
    db.saveAll();
  }
}

// Run username safety initialization
ensureUniqueUsernames();

/**
 * Update User Profile (Full Name, Unique Username, Profile Photo)
 * Strictly isolated: users can ONLY update their own name, username, and avatar.
 */
async function updateUserProfile({ userId, name, username, avatar }) {
  if (!userId) {
    throw new Error('User ID is required.');
  }

  return await db.transaction(async () => {
    const user = db.users.find(u => u.id === userId);
    if (!user) {
      throw new Error('User not found.');
    }

    if (user.status === 'BANNED' || user.status === 'SUSPENDED') {
      throw new Error('Your account is currently suspended.');
    }

    // 1. Update Full Name if provided
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('Full Name cannot be empty.');
      }
      const cleanName = name.trim();
      if (cleanName.length > 60) {
        throw new Error('Full Name cannot exceed 60 characters.');
      }
      user.name = cleanName;
    }

    // 2. Update Username if provided
    if (username !== undefined) {
      if (typeof username !== 'string' || !username.trim()) {
        throw new Error('Username cannot be empty.');
      }
      const cleanUsername = username.replace(/^@/, '').toLowerCase().trim();
      if (!isValidUsername(cleanUsername)) {
        throw new Error('Username must be 3-30 characters long and contain only letters, numbers, and underscores.');
      }

      // Check whether another user already owns it
      const isTaken = isUsernameTaken(cleanUsername, user.id);
      if (isTaken) {
        throw new Error('Username already taken. Please choose another username.');
      }

      user.username = cleanUsername;
    }

    // 3. Update Profile Photo (Avatar) if provided
    if (avatar !== undefined) {
      if (avatar === null || avatar === '') {
        user.avatar = null;
      } else if (typeof avatar === 'string') {
        if (avatar.startsWith('data:image/')) {
          const mimeMatch = avatar.match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i);
          if (!mimeMatch) {
            throw new Error('Invalid image format. Allowed formats: JPG, JPEG, PNG, WEBP.');
          }
          if (avatar.length > 100 * 1024 * 1.37) {
            throw new Error('Image size exceeds maximum limit (100 KB). / ছবির সাইজ সর্বোচ্চ ১০০ KB হতে পারবে।');
          }
          user.avatar = avatar;
        } else if (avatar.startsWith('/') || avatar.startsWith('http://') || avatar.startsWith('https://')) {
          if (/\.(php|phtml|sh|exe|pl|cgi|js|html)$/i.test(avatar)) {
            throw new Error('Invalid image file path.');
          }
          user.avatar = avatar;
        } else {
          throw new Error('Invalid image format. Allowed formats: JPG, JPEG, PNG, WEBP.');
        }
      }
    }

    user.updatedAt = new Date().toISOString();

    const token = signToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      currency: user.currency
    });

    return { user: sanitizeUser(user), token };
  });
}

/**
 * Remove sensitive credentials before returning user object to client
 * Prioritizes manual avatar over Google avatar over default initials
 */
function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safeUser } = user;
  
  // Prioritize manual avatar > Google picture > null
  const effectiveAvatar = user.avatar || user.picture || user.googleAvatar || null;
  
  return {
    ...safeUser,
    username: user.username || `gamer_${user.id ? user.id.slice(-5) : '001'}`,
    avatar: user.avatar || null,
    picture: user.picture || user.googleAvatar || null,
    googleAvatar: user.googleAvatar || user.picture || null,
    effectiveAvatar
  };
}

module.exports = {
  hasRole,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  authenticateRequest,
  verifyGoogleIdToken,
  registerUser,
  loginUser,
  googleAuth,
  sanitizeUser,
  isValidUsername,
  isUsernameTaken,
  generateUniqueUsername,
  ensureUniqueUsernames,
  updateUserProfile
};
