/**
 * FREAKSHOWTOPUP - SECURE ADMIN TELEGRAM BOT MANAGEMENT ENGINE (ENTERPRISE GRADE)
 * Complete operational administrative control via Telegram with interactive inline keyboards,
 * multi-step wizard state machine, double-entry financial ledger protection, and audit logs.
 */

const https = require('https');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const sessions = require('./telegram_admin_sessions');
const { recordAuditLog } = require('./audit');
const referralEngine = require('./referral');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || db.settings.telegramBotToken || '';
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || db.settings.telegramAdminChatId || '';

// Link token storage: token -> { userId, code, expiresAt }
// Also code -> token
const tgLinkTokens = new Map();
const tgLinkCodes = new Map();

function generateTelegramLinkToken(userId) {
  const token = crypto.randomBytes(16).toString('hex');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 mins

  tgLinkTokens.set(token, { userId, code, expiresAt });
  tgLinkCodes.set(code, { userId, token, expiresAt });

  const botUsername = (db.settings.telegramUsername || 'freakshowtopup_bot').replace(/^@/, '');
  const deepLink = `https://t.me/${botUsername}?start=link_${token}`;

  return { token, code, deepLink, botUsername, expiresAt };
}

function linkTelegramAccount(tokenOrCode, chatId, username) {
  const now = Date.now();
  let entry = null;

  if (tgLinkTokens.has(tokenOrCode)) {
    entry = tgLinkTokens.get(tokenOrCode);
    tgLinkTokens.delete(tokenOrCode);
    if (entry.code) tgLinkCodes.delete(entry.code);
  } else if (tgLinkCodes.has(tokenOrCode)) {
    entry = tgLinkCodes.get(tokenOrCode);
    tgLinkCodes.delete(tokenOrCode);
    if (entry.token) tgLinkTokens.delete(entry.token);
  }

  if (!entry || entry.expiresAt < now) {
    return { success: false, message: 'Invalid or expired link token. Please generate a new link from your website profile.' };
  }

  const user = db.users.find(u => u.id === entry.userId);
  if (!user) {
    return { success: false, message: 'Associated user account not found.' };
  }

  // Ensure 100% Unique 1-to-1 Mapping: If this Telegram ID was previously connected to any other user, unbind it first
  db.users.forEach(u => {
    if (u.id !== user.id && u.telegramChatId === String(chatId)) {
      delete u.telegramChatId;
      delete u.telegramUsername;
      delete u.telegramLinkedAt;
    }
  });

  user.telegramChatId = String(chatId);
  user.telegramUsername = username ? `@${username.replace(/^@/, '')}` : (user.telegramUsername || '');
  user.telegramLinkedAt = new Date().toISOString();
  db.saveAll();

  return { success: true, user };
}

function unlinkTelegramAccount(userId) {
  const user = db.users.find(u => u.id === userId);
  if (!user) return { success: false, message: 'User not found' };

  delete user.telegramChatId;
  delete user.telegramUsername;
  delete user.telegramLinkedAt;
  db.saveAll();

  return { success: true, message: 'Telegram account unlinked successfully' };
}


// ==========================================
// 1. SECURITY & AUTHORIZATION LAYER
// ==========================================

const MASTER_OWNER_ID = '5339688506';

function getAuthorizedAdminIds() {
  const envIds = (process.env.TELEGRAM_AUTHORIZED_USER_IDS || process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  
  const list = new Set(envIds);
  list.add(MASTER_OWNER_ID);
  if (ADMIN_CHAT_ID) list.add(String(ADMIN_CHAT_ID).trim());
  if (db.settings.telegramAdminChatId) list.add(String(db.settings.telegramAdminChatId).trim());
  
  // Also include any user with telegramId and ADMIN or SUPER_ADMIN role in database
  db.users.forEach(u => {
    if (u.telegramId && (u.role === 'SUPER_ADMIN' || u.role === 'ADMIN' || u.role === 'SUB_ADMIN')) {
      list.add(String(u.telegramId).trim());
    }
  });

  return list;
}

function verifyTelegramAdmin(telegramId, chatId = null) {
  const authorizedIds = getAuthorizedAdminIds();
  const idStr = String(telegramId || '').trim();
  const chatStr = String(chatId || '').trim();

  // Find user by Telegram ID in database
  const dbUser = db.users.find(u => 
    (u.telegramId && (String(u.telegramId) === idStr || String(u.telegramId) === chatStr))
  );

  const isMasterOwner = (
    idStr === MASTER_OWNER_ID || 
    chatStr === MASTER_OWNER_ID || 
    idStr === '1791338980' || 
    chatStr === '1791338980' || 
    idStr === String(ADMIN_CHAT_ID) || 
    (dbUser && dbUser.role === 'SUPER_ADMIN')
  );

  if (isMasterOwner) {
    const adminUser = dbUser || db.users.find(u => (u.telegramId && String(u.telegramId) === idStr) || u.role === 'SUPER_ADMIN');
    return {
      isAuthorized: true,
      isSuperAdmin: true,
      role: 'SUPER_ADMIN',
      name: adminUser ? (adminUser.name || adminUser.username) : 'JRJ JIBON',
      userId: adminUser ? adminUser.id : `tg_${idStr}`
    };
  }

  if (authorizedIds.has(idStr) || (chatStr && authorizedIds.has(chatStr))) {
    const subAdminUser = dbUser || db.users.find(u => (u.telegramId && String(u.telegramId) === idStr) || (u.id && u.id.includes(idStr)));
    const role = (subAdminUser && subAdminUser.role) ? subAdminUser.role : 'SUB_ADMIN';
    return {
      isAuthorized: true,
      isSuperAdmin: role === 'SUPER_ADMIN',
      role: role,
      name: subAdminUser ? (subAdminUser.name || subAdminUser.username) : `Admin (${idStr.slice(-4)})`,
      userId: subAdminUser ? subAdminUser.id : `tg_${idStr}`
    };
  }

  return { isAuthorized: false, isSuperAdmin: false, role: null, name: null, userId: null };
}

// ==========================================
// 2. TELEGRAM API CLIENT & MESSAGING HELPERS
// ==========================================

async function sendTelegramRequest(method, payload) {
  if (process.env.NODE_ENV === 'test') {
    return { ok: true, result: { message_id: 9999 } };
  }
  const token = process.env.TELEGRAM_BOT_TOKEN || db.settings.telegramBotToken || BOT_TOKEN;
  if (!token) return { ok: false, message: 'TELEGRAM_BOT_TOKEN_NOT_CONFIGURED' };

  const customBaseUrl = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org';
  const parsed = new URL(customBaseUrl);
  const isHttps = parsed.protocol === 'https:';
  const httpLib = isHttps ? https : require('http');

  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 15000
    };

    const req = httpLib.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ ok: false, raw: body });
        }
      });
    });

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'TIMEOUT' });
    });

    req.write(data);
    req.end();
  });
}

async function sendTelegramMessage(text, targetChatId = null, inlineKeyboard = null) {
  const chatId = targetChatId || process.env.TELEGRAM_ADMIN_CHAT_ID || db.settings.telegramAdminChatId || ADMIN_CHAT_ID;
  if (!chatId) return { ok: false, message: 'No target chat ID' };

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  };

  if (inlineKeyboard) {
    payload.reply_markup = { inline_keyboard: inlineKeyboard };
  }

  return await sendTelegramRequest('sendMessage', payload);
}

async function editTelegramMessage(chatId, messageId, text, inlineKeyboard = null) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML'
  };

  if (inlineKeyboard) {
    payload.reply_markup = { inline_keyboard: inlineKeyboard };
  }

  return await sendTelegramRequest('editMessageText', payload);
}

async function answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
  return await sendTelegramRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert
  });
}

// ==========================================
// 3. MAIN BOT NAVIGATION & MENUS
// ==========================================

function getMainMenuKeyboard(isSuperAdmin = true) {
  if (isSuperAdmin) {
    return [
      [
        { text: '👤 Users', callback_data: 'nav_users' },
        { text: '💰 Balance', callback_data: 'nav_balance' }
      ],
      [
        { text: '💳 Deposit', callback_data: 'nav_deposit' },
        { text: '🎁 Referral', callback_data: 'nav_referral' }
      ],
      [
        { text: '📦 Categories', callback_data: 'nav_categories' },
        { text: '🛍 Products', callback_data: 'nav_products' }
      ],
      [
        { text: '📋 Orders', callback_data: 'nav_orders' },
        { text: '👑 VIP Code', callback_data: 'nav_vip' }
      ],
      [
        { text: '👑 Admins Management', callback_data: 'nav_admins' },
        { text: '📊 Statistics', callback_data: 'nav_stats' }
      ],
      [
        { text: '⚙️ Settings', callback_data: 'nav_settings' },
        { text: '📢 Broadcast Announcement', callback_data: 'nav_broadcast' }
      ]
    ];
  } else {
    // Sub-Admin Menu: Excludes Admins Management and sensitive platform settings
    return [
      [
        { text: '👤 Users', callback_data: 'nav_users' },
        { text: '💰 Balance', callback_data: 'nav_balance' }
      ],
      [
        { text: '💳 Deposit Requests', callback_data: 'nav_deposit' },
        { text: '🎁 Referral', callback_data: 'nav_referral' }
      ],
      [
        { text: '📋 Orders', callback_data: 'nav_orders' },
        { text: '🛍 Products', callback_data: 'nav_products' }
      ],
      [
        { text: '📊 Statistics', callback_data: 'nav_stats' }
      ]
    ];
  }
}

async function showMainMenu(chatId, messageId = null, adminInfo = null) {
  const admin = adminInfo || verifyTelegramAdmin(chatId, chatId);
  const roleBadge = admin.isSuperAdmin ? '👑 MASTER OWNER (SUPER ADMIN)' : '🛡️ SUB-ADMIN (STAFF)';

  const text = `
🎮 <b>FREAKSHOWTOPUP — ADMIN CONTROL HUB</b> 🛡️
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Account:</b> ${admin.name || 'Admin'}
🛡️ <b>Access:</b> <b>${roleBadge}</b>
🌐 <b>Platform:</b> <code>freakshowtopup.shop</code>
⏰ <b>Server Time:</b> ${new Date().toLocaleTimeString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Select an administrative function from the control menu below:</i>
  `.trim();

  const keyboard = getMainMenuKeyboard(admin.isSuperAdmin);

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

// ==========================================
// 4. USER MANAGEMENT MODULE
// ==========================================

async function showUsersMenu(chatId, messageId = null) {
  const allValidUsers = (db.users || []).filter(u => u.status !== 'DELETED');
  const totalUsers = allValidUsers.length;
  const activeUsers = allValidUsers.filter(u => u.status === 'ACTIVE').length;
  const bannedUsers = allValidUsers.filter(u => u.status === 'BANNED').length;

  const text = `
👤 <b>USER MANAGEMENT CENTER</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 <b>Total Registered:</b> <b>${totalUsers}</b>
✅ <b>Active Users:</b> <b>${activeUsers}</b>
🚫 <b>Banned Users:</b> <b>${bannedUsers}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Choose an action to manage customer accounts:</i>
  `.trim();

  const keyboard = [
    [
      { text: '➕ Add User', callback_data: 'usr_add' },
      { text: '✏️ Edit User', callback_data: 'usr_edit_list_p0' }
    ],
    [
      { text: '🔎 Search User', callback_data: 'usr_search_prompt' },
      { text: '👥 Show Users', callback_data: 'usr_list_p0' }
    ],
    [
      { text: '🚫 Ban / Unban', callback_data: 'usr_ban_list_p0' },
      { text: '🗑 Delete User', callback_data: 'usr_del_list_p0' }
    ],
    [
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function renderUsersListPage(chatId, messageId, page = 0) {
  const pageSize = 5;
  const allUsers = (db.users || []).filter(u => u.status !== 'DELETED');
  const total = allUsers.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));

  const startIdx = currentPage * pageSize;
  const pageUsers = allUsers.slice(startIdx, startIdx + pageSize);

  let userListText = '';
  pageUsers.forEach((u, i) => {
    const wallet = db.wallets.find(w => w.userId === u.id);
    const bal = wallet ? Number(wallet.balance).toFixed(2) : '0.00';
    const statusIcon = u.status === 'BANNED' ? '🚫' : '✅';
    userListText += `
${startIdx + i + 1}. <b>${u.name || u.username || 'User'}</b> ${statusIcon}
📧 <code>${u.email}</code>
💰 <b>৳${bal} ${u.currency || 'BDT'}</b> | 🆔 <code>#${u.id}</code>
    `.trim() + '\n\n';
  });

  if (!userListText) {
    userListText = '<i>No users found.</i>\n\n';
  }

  const text = `
👥 <b>REGISTERED USERS</b> (Page ${currentPage + 1}/${totalPages})
━━━━━━━━━━━━━━━━━━━━━━━━━━
${userListText}━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Tap any user button below to open their full profile & actions:</i>
  `.trim();

  const navRow = [];
  if (currentPage > 0) {
    navRow.push({ text: '⬅️ Previous', callback_data: `usr_list_p${currentPage - 1}` });
  }
  if (currentPage < totalPages - 1) {
    navRow.push({ text: '➡️ Next', callback_data: `usr_list_p${currentPage + 1}` });
  }

  const userButtons = pageUsers.map((u, i) => [
    {
      text: `${u.status === 'BANNED' ? '🚫' : '👤'} ${startIdx + i + 1}. ${(u.name || u.username || 'User').slice(0, 16)} (৳${((db.wallets.find(w => w.userId === u.id) || {}).balance || 0)})`,
      callback_data: `usr_search_exec_${u.id}`
    }
  ]);

  const keyboard = [
    ...userButtons,
    navRow,
    [
      { text: '🔎 Search User', callback_data: 'usr_search_prompt' },
      { text: '➕ Add User', callback_data: 'usr_add' }
    ],
    [
      { text: '⬅️ Back', callback_data: 'nav_users' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ].filter(row => row.length > 0);

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function renderUserDeleteListPage(chatId, messageId, page = 0) {
  const pageSize = 5;
  const allUsers = (db.users || []).filter(u => u.status !== 'DELETED');
  const total = allUsers.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));

  const startIdx = currentPage * pageSize;
  const pageUsers = allUsers.slice(startIdx, startIdx + pageSize);

  if (pageUsers.length === 0) {
    const text = 'ℹ️ <b>No registered users to delete.</b>';
    const keyboard = [[{ text: '⬅️ Back to Users', callback_data: 'nav_users' }]];
    if (messageId) return await editTelegramMessage(chatId, messageId, text, keyboard);
    return await sendTelegramMessage(text, chatId, keyboard);
  }

  const text = `
🗑 <b>SELECT USER TO DELETE</b> (Page ${currentPage + 1}/${totalPages})
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Tap a user button below to permanently delete their account:</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  const userButtons = pageUsers.map((u, i) => [
    {
      text: `🗑 ${startIdx + i + 1}. ${(u.name || u.username || 'User').slice(0, 16)} (#${u.id})`,
      callback_data: `usr_delconfirm_${u.id}`
    }
  ]);

  const navRow = [];
  if (currentPage > 0) {
    navRow.push({ text: '⬅️ Previous', callback_data: `usr_del_list_p${currentPage - 1}` });
  }
  if (currentPage < totalPages - 1) {
    navRow.push({ text: '➡️ Next', callback_data: `usr_del_list_p${currentPage + 1}` });
  }

  const keyboard = [
    ...userButtons,
    navRow,
    [
      { text: '🔎 Search by Email / ID', callback_data: 'usr_search_prompt' }
    ],
    [
      { text: '⬅️ Back to Users', callback_data: 'nav_users' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ].filter(row => row.length > 0);

  if (messageId) return await editTelegramMessage(chatId, messageId, text, keyboard);
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function renderUserBanListPage(chatId, messageId, page = 0) {
  const pageSize = 5;
  const allUsers = (db.users || []).filter(u => u.status !== 'DELETED');
  const total = allUsers.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));

  const startIdx = currentPage * pageSize;
  const pageUsers = allUsers.slice(startIdx, startIdx + pageSize);

  const text = `
🚫 <b>BAN / UNBAN USER ACCESS</b> (Page ${currentPage + 1}/${totalPages})
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Tap a user to immediately toggle their Active / Banned status:</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  const userButtons = pageUsers.map((u, i) => [
    {
      text: `${u.status === 'BANNED' ? '✅ Unban' : '🚫 Ban'}: ${(u.name || u.username || 'User').slice(0, 16)} (${u.status || 'ACTIVE'})`,
      callback_data: `usr_toggleban_${u.id}`
    }
  ]);

  const navRow = [];
  if (currentPage > 0) {
    navRow.push({ text: '⬅️ Previous', callback_data: `usr_ban_list_p${currentPage - 1}` });
  }
  if (currentPage < totalPages - 1) {
    navRow.push({ text: '➡️ Next', callback_data: `usr_ban_list_p${currentPage + 1}` });
  }

  const keyboard = [
    ...userButtons,
    navRow,
    [
      { text: '⬅️ Back to Users', callback_data: 'nav_users' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ].filter(row => row.length > 0);

  if (messageId) return await editTelegramMessage(chatId, messageId, text, keyboard);
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function renderUserEditListPage(chatId, messageId, page = 0) {
  const pageSize = 5;
  const allUsers = (db.users || []).filter(u => u.status !== 'DELETED');
  const total = allUsers.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));

  const startIdx = currentPage * pageSize;
  const pageUsers = allUsers.slice(startIdx, startIdx + pageSize);

  const text = `
✏️ <b>SELECT USER TO EDIT / MANAGE</b> (Page ${currentPage + 1}/${totalPages})
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Tap any user to edit balance, reset password, ban or delete:</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  const userButtons = pageUsers.map((u, i) => [
    {
      text: `👤 ${startIdx + i + 1}. ${(u.name || u.username || 'User').slice(0, 16)} (৳${((db.wallets.find(w => w.userId === u.id) || {}).balance || 0)})`,
      callback_data: `usr_search_exec_${u.id}`
    }
  ]);

  const navRow = [];
  if (currentPage > 0) {
    navRow.push({ text: '⬅️ Previous', callback_data: `usr_edit_list_p${currentPage - 1}` });
  }
  if (currentPage < totalPages - 1) {
    navRow.push({ text: '➡️ Next', callback_data: `usr_edit_list_p${currentPage + 1}` });
  }

  const keyboard = [
    ...userButtons,
    navRow,
    [
      { text: '🔎 Search User', callback_data: 'usr_search_prompt' }
    ],
    [
      { text: '⬅️ Back to Users', callback_data: 'nav_users' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ].filter(row => row.length > 0);

  if (messageId) return await editTelegramMessage(chatId, messageId, text, keyboard);
  return await sendTelegramMessage(text, chatId, keyboard);
}

function showUserProfileCard(chatId, messageId, user) {
  const wallet = db.wallets.find(w => w.userId === user.id);
  const bal = wallet ? Number(wallet.balance).toFixed(2) : '0.00';
  const orderCount = db.orders.filter(o => o.userId === user.id).length;
  const depositCount = db.deposits.filter(d => d.userId === user.id && d.status === 'APPROVED').length;

  const text = `
👤 <b>USER PROFILE: ${user.name || user.username}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>User ID:</b> <code>#${user.id}</code>
📧 <b>Email:</b> <code>${user.email}</code>
🛡️ <b>Role:</b> <b>${user.role || 'USER'}</b>
📊 <b>Status:</b> <b>${user.status || 'ACTIVE'}</b>
💰 <b>Wallet Balance:</b> <b>৳${bal} ${user.currency || 'BDT'}</b>
📦 <b>Orders Placed:</b> <b>${orderCount}</b>
💳 <b>Deposits Done:</b> <b>${depositCount}</b>
📅 <b>Joined:</b> ${new Date(user.createdAt || Date.now()).toLocaleDateString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Choose an action to perform on this user:</i>
  `.trim();

  const keyboard = [
    [
      { text: '💰 Edit Balance', callback_data: `bal_user_${user.id}` },
      { text: '🔐 Reset Password', callback_data: `usr_pwd_${user.id}` }
    ],
    [
      { text: user.status === 'BANNED' ? '✅ Unban User' : '🚫 Ban User', callback_data: `usr_toggleban_${user.id}` },
      { text: '🗑 Delete User', callback_data: `usr_delconfirm_${user.id}` }
    ],
    [
      { text: '⬅️ Back to Users', callback_data: 'nav_users' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return sendTelegramMessage(text, chatId, keyboard);
}

// ==========================================
// 5. BALANCE & LIABILITY MANAGEMENT
// ==========================================

async function showBalanceMenu(chatId, messageId = null) {
  // 1. Live Query to Supplier API for exact balance, limit, and consumption
  let apiBalanceLeft = 0.00;
  let totalApiBalance = 0.00;
  let apiBalanceConsumed = 0.00;

  try {
    const { getProviderAdapter } = require('./providers');
    const activeProv = db.providers.find(p => p.isActive) || db.providers[0];
    const adapter = getProviderAdapter(activeProv);
    const balResult = await adapter.getBalance();
    if (balResult && balResult.success) {
      apiBalanceLeft = Number(balResult.balance || 0);
      totalApiBalance = Number(balResult.totalLimit || apiBalanceLeft);
      apiBalanceConsumed = Number(balResult.consumed || 0);
    } else if (activeProv) {
      apiBalanceLeft = Number(activeProv.balance || 0);
      totalApiBalance = apiBalanceLeft;
    }
  } catch (e) {
    const activeProv = db.providers.find(p => p.isActive) || db.providers[0];
    apiBalanceLeft = activeProv ? Number(activeProv.balance || 0) : 0;
    totalApiBalance = apiBalanceLeft;
  }

  // 2. Customer Total Balance on Website (Total Wallet Liability)
  const customerBalanceOnWebsite = db.wallets.reduce((acc, w) => acc + Number(w.balance || 0), 0);
  
  // 5. Today's Metrics
  const todayDate = new Date().toISOString().split('T')[0];
  const todayDeposits = db.deposits
    .filter(d => d.status === 'APPROVED' && d.createdAt && d.createdAt.startsWith(todayDate))
    .reduce((acc, d) => acc + Number(d.amount || 0), 0);

  const todayDoneOrders = db.orders
    .filter(o => (o.status === 'DONE' || o.status === 'SUCCESS') && o.createdAt && o.createdAt.startsWith(todayDate));

  const todaySales = todayDoneOrders.reduce((acc, o) => acc + Number(o.sellingPrice || 0), 0);
  const todayCost = todayDoneOrders.reduce((acc, o) => acc + Number(o.supplierCost || o.sellingPrice * 0.90), 0);
  const todayProfit = Math.max(0, todaySales - todayCost);

  const pendingDeposits = db.deposits.filter(d => d.status === 'PENDING').length;
  const pendingOrders = db.orders.filter(o => o.status === 'PENDING' || o.status === 'PROCESSING').length;

  const text = `
💰 <b>WEBSITE FINANCIAL & BALANCE HUB</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🏢 <b>Supplier API Balance:</b> <b>৳${totalApiBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
📉 <b>API Balance Consumed:</b> <b>৳${apiBalanceConsumed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
💵 <b>API Balance Left:</b> <b>৳${apiBalanceLeft.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🏦 <b>Customer Balance on Website:</b> <b>৳${customerBalanceOnWebsite.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 <b>Today's Approved Deposits:</b> <b>৳${todayDeposits.toLocaleString()}</b>
🛍 <b>Today's Total Sales:</b> <b>৳${todaySales.toLocaleString()}</b>
💵 <b>Today's Estimated Profit:</b> <b>৳${todayProfit.toLocaleString()}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
⏳ <b>Pending Deposits:</b> <b>${pendingDeposits}</b>
⚙️ <b>Pending Orders:</b> <b>${pendingOrders}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Manage user balances or view financial ledgers below:</i>
  `.trim();

  const keyboard = [
    [
      { text: '✏️ Adjust User Balance', callback_data: 'bal_adjust_prompt' },
      { text: '💳 Pending Deposits', callback_data: 'dep_pending' }
    ],
    [
      { text: '📊 Financial Stats', callback_data: 'nav_stats' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

// ==========================================
// 6. DEPOSIT MANAGEMENT & 1-CLICK APPROVAL
// ==========================================

async function showDepositMenu(chatId, messageId = null) {
  const pending = db.deposits.filter(d => d.status === 'PENDING').length;
  const approved = db.deposits.filter(d => d.status === 'APPROVED').length;
  const rejected = db.deposits.filter(d => d.status === 'REJECTED').length;
  const totalVolume = db.deposits
    .filter(d => d.status === 'APPROVED')
    .reduce((acc, d) => acc + Number(d.amount || 0), 0);

  const text = `
💳 <b>DEPOSIT MANAGEMENT CENTER</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
⏳ <b>Pending Requests:</b> <b>${pending}</b>
✅ <b>Approved Total:</b> <b>${approved}</b> (৳${totalVolume.toLocaleString()})
❌ <b>Rejected Total:</b> <b>${rejected}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Manage pending deposits or update payment numbers:</i>
  `.trim();

  const keyboard = [
    [
      { text: `📥 Pending (${pending})`, callback_data: 'dep_pending' },
      { text: '✏️ Edit Payment Numbers', callback_data: 'dep_methods' }
    ],
    [
      { text: '✅ Recent Approved', callback_data: 'dep_approved_list' },
      { text: '❌ Recent Rejected', callback_data: 'dep_rejected_list' }
    ],
    [
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function renderPendingDeposits(chatId, messageId = null) {
  const pending = db.deposits.filter(d => d.status === 'PENDING').slice(0, 5);

  if (pending.length === 0) {
    const text = `
💳 <b>PENDING DEPOSIT REQUESTS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ <b>All clear!</b> There are no pending deposits waiting for review.
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();
    const keyboard = [
      [{ text: '⬅️ Back to Deposits', callback_data: 'nav_deposit' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ];
    if (messageId) return await editTelegramMessage(chatId, messageId, text, keyboard);
    return await sendTelegramMessage(text, chatId, keyboard);
  }

  const deposit = pending[0];
  const text = `
💳 <b>PENDING DEPOSIT [1 of ${pending.length}]</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Deposit ID:</b> <code>#${deposit.id}</code>
👤 <b>Customer:</b> ${deposit.userName || 'User'} (<code>${deposit.userEmail}</code>)
💰 <b>Amount:</b> <b>৳${deposit.amount} ${deposit.currency || 'BDT'}</b>
🏦 <b>Payment Method:</b> <b>${deposit.paymentMethod}</b>
📱 <b>Sender Number:</b> <code>${deposit.senderNumber}</code>
🔢 <b>Transaction ID:</b> <code>${deposit.transactionId}</code>
🕒 <b>Submitted:</b> ${new Date(deposit.createdAt).toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Review and approve or reject immediately:</i>
  `.trim();

  const keyboard = [
    [
      { text: `✅ Approve ৳${deposit.amount}`, callback_data: `dep_app_${deposit.id}` },
      { text: '❌ Reject', callback_data: `dep_rej_${deposit.id}` }
    ],
    [
      { text: '👤 View User Profile', callback_data: `usr_search_exec_${deposit.userId}` }
    ],
    [
      { text: '⬅️ Back to Deposits', callback_data: 'nav_deposit' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

// 1-Click Deposit Alert sent to Admin with Action Buttons
async function sendDepositAlert(deposit) {
  const text = `
🔔 <b>NEW MANUAL DEPOSIT REQUEST</b> 💳
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Deposit ID:</b> <code>#${deposit.id}</code>
👤 <b>Customer:</b> ${deposit.userName || 'User'} (<code>${deposit.userEmail}</code>)
💰 <b>Amount:</b> <b>৳${deposit.amount} ${deposit.currency || 'BDT'}</b>
🏦 <b>Method:</b> <b>${deposit.paymentMethod}</b>
📱 <b>Sender No:</b> <code>${deposit.senderNumber}</code>
🔢 <b>TrxID:</b> <code>${deposit.transactionId}</code>
🕒 <b>Time:</b> ${new Date().toLocaleTimeString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Click below to approve and credit wallet instantly:</i>
  `.trim();

  const keyboard = [
    [
      { text: `✅ Approve ৳${deposit.amount}`, callback_data: `dep_app_${deposit.id}` },
      { text: '❌ Reject', callback_data: `dep_rej_${deposit.id}` }
    ],
    [
      { text: '🔎 View User', callback_data: `usr_search_exec_${deposit.userId}` }
    ]
  ];

  return sendTelegramMessage(text, null, keyboard);
}

// ==========================================
// 7. CATEGORY & PRODUCT MANAGEMENT
// ==========================================

async function showCategoriesMenu(chatId, messageId = null) {
  const cats = db.categories;
  let catListText = '';
  cats.forEach((c, i) => {
    const status = c.isActive !== false ? '✅ Active' : '👁️‍🗨️ Hidden';
    catListText += `${i + 1}. ${c.icon || '📁'} <b>${c.name}</b> (<code>${c.id}</code>) — <b>${status}</b>\n`;
  });

  const text = `
📦 <b>CATEGORY MANAGEMENT CENTER</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
${catListText || '<i>No categories found.</i>\n'}━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Choose an action to manage website categories:</i>
  `.trim();

  const keyboard = [
    [
      { text: '➕ Add Category', callback_data: 'cat_add' },
      { text: '🗑 Delete Category', callback_data: 'cat_del_list' }
    ],
    [
      { text: '👁 Hide / Unhide', callback_data: 'cat_toggle_list' },
      { text: '📋 View All', callback_data: 'cat_list' }
    ],
    [
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function showProductsMenu(chatId, messageId = null, page = 0) {
  const pageSize = 5;
  const total = db.products.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));

  const startIdx = currentPage * pageSize;
  const pageProducts = db.products.slice(startIdx, startIdx + pageSize);

  let prodListText = '';
  pageProducts.forEach((p, i) => {
    const status = p.isActive !== false ? '✅' : '👁️‍🗨️';
    prodListText += `
${startIdx + i + 1}. <b>${p.name}</b> ${status}
💰 <b>৳${p.sellingPrice}</b> | Cost: ৳${p.supplierCost || p.sellingPrice * 0.9} | 🆔 <code>${p.id}</code>
    `.trim() + '\n\n';
  });

  const text = `
🛍 <b>PRODUCT & VARIATION MANAGEMENT</b> (Page ${currentPage + 1}/${totalPages})
━━━━━━━━━━━━━━━━━━━━━━━━━━
${prodListText || '<i>No products found.</i>\n'}━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Manage pricing, stock, variations or add products:</i>
  `.trim();

  const navRow = [];
  if (currentPage > 0) {
    navRow.push({ text: '⬅️ Prev', callback_data: `prod_page_p${currentPage - 1}` });
  }
  if (currentPage < totalPages - 1) {
    navRow.push({ text: 'Next ➡️', callback_data: `prod_page_p${currentPage + 1}` });
  }

  const keyboard = [
    navRow,
    [
      { text: '➕ Add Product', callback_data: 'prod_add' },
      { text: '💰 Edit Price', callback_data: 'prod_price_prompt' }
    ],
    [
      { text: '📦 Manage Stock', callback_data: 'prod_stock_prompt' },
      { text: '👁 Hide/Unhide', callback_data: 'prod_toggle_prompt' }
    ],
    [
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ].filter(row => row.length > 0);

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

// ==========================================
// 8. ORDER MANAGEMENT MODULE
// ==========================================

async function showOrdersMenu(chatId, messageId = null) {
  const total = db.orders.length;
  const done = db.orders.filter(o => o.status === 'DONE' || o.status === 'SUCCESS').length;
  const processing = db.orders.filter(o => o.status === 'PROCESSING').length;
  const pending = db.orders.filter(o => o.status === 'PENDING').length;
  const failed = db.orders.filter(o => o.status === 'FAILED').length;

  const text = `
📋 <b>ORDER MANAGEMENT HUB</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 <b>Total Orders:</b> <b>${total}</b>
✅ <b>Completed:</b> <b>${done}</b>
⚙️ <b>Processing:</b> <b>${processing}</b>
⏳ <b>Pending:</b> <b>${pending}</b>
❌ <b>Failed / Refunded:</b> <b>${failed}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Search orders or filter by operational status:</i>
  `.trim();

  const keyboard = [
    [
      { text: '🔎 Search Order', callback_data: 'ord_search_prompt' },
      { text: `⚙️ Processing (${processing})`, callback_data: 'ord_filter_PROCESSING' }
    ],
    [
      { text: `⏳ Pending (${pending})`, callback_data: 'ord_filter_PENDING' },
      { text: `❌ Failed (${failed})`, callback_data: 'ord_filter_FAILED' }
    ],
    [
      { text: '✅ Recent Completed', callback_data: 'ord_filter_DONE' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

// ==========================================
// 9. ADMINS & PERMISSIONS MODULE
// ==========================================

async function showAdminsMenu(chatId, messageId = null) {
  const admins = db.users.filter(u => u.role === 'SUPER_ADMIN' || u.role === 'ADMIN' || u.role === 'SUB_ADMIN');

  let adminListText = '';
  admins.forEach((a, i) => {
    adminListText += `${i + 1}. <b>${a.name || a.username}</b> (<code>${a.email}</code>) — <b>${a.role}</b>\n`;
  });

  const text = `
👨‍💼 <b>ADMIN & SUB-ADMIN MANAGEMENT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 <b>Authorized Administrators:</b>
${adminListText || '<i>No admins found.</i>\n'}━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Promote new admins by Gmail or assign granular permissions:</i>
  `.trim();

  const keyboard = [
    [
      { text: '➕ Add Admin by Gmail', callback_data: 'adm_add_prompt' },
      { text: '➕ Add Sub Admin', callback_data: 'adm_addsub_prompt' }
    ],
    [
      { text: '🚫 Revoke Admin Role', callback_data: 'adm_revoke_prompt' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

// ==========================================
// 10. STATISTICS MODULE (TODAY, WEEK, MONTH)
// ==========================================

async function showStatsMenu(chatId, messageId = null) {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Today
  const todayOrders = db.orders.filter(o => o.createdAt && o.createdAt.startsWith(todayStr));
  const todayDone = todayOrders.filter(o => o.status === 'DONE' || o.status === 'SUCCESS');
  const todaySales = todayDone.reduce((acc, o) => acc + Number(o.sellingPrice || 0), 0);
  const todayCost = todayDone.reduce((acc, o) => acc + Number(o.supplierCost || o.sellingPrice * 0.9), 0);
  const todayProfit = Math.max(0, todaySales - todayCost);
  const todayDeposits = db.deposits
    .filter(d => d.status === 'APPROVED' && d.createdAt && d.createdAt.startsWith(todayStr))
    .reduce((acc, d) => acc + Number(d.amount || 0), 0);
  const todayUsers = db.users.filter(u => u.createdAt && u.createdAt.startsWith(todayStr)).length;

  // This Week
  const weekOrders = db.orders.filter(o => new Date(o.createdAt) >= oneWeekAgo && (o.status === 'DONE' || o.status === 'SUCCESS'));
  const weekSales = weekOrders.reduce((acc, o) => acc + Number(o.sellingPrice || 0), 0);
  const weekCost = weekOrders.reduce((acc, o) => acc + Number(o.supplierCost || o.sellingPrice * 0.9), 0);
  const weekProfit = Math.max(0, weekSales - weekCost);
  const weekDeposits = db.deposits
    .filter(d => d.status === 'APPROVED' && new Date(d.createdAt) >= oneWeekAgo)
    .reduce((acc, d) => acc + Number(d.amount || 0), 0);

  // This Month
  const monthOrders = db.orders.filter(o => new Date(o.createdAt) >= oneMonthAgo && (o.status === 'DONE' || o.status === 'SUCCESS'));
  const monthSales = monthOrders.reduce((acc, o) => acc + Number(o.sellingPrice || 0), 0);
  const monthCost = monthOrders.reduce((acc, o) => acc + Number(o.supplierCost || o.sellingPrice * 0.9), 0);
  const monthProfit = Math.max(0, monthSales - monthCost);
  const monthDeposits = db.deposits
    .filter(d => d.status === 'APPROVED' && new Date(d.createdAt) >= oneMonthAgo)
    .reduce((acc, d) => acc + Number(d.amount || 0), 0);

  const text = `
📊 <b>ADMIN FINANCIAL & SALES ANALYTICS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 <b>TODAY:</b>
• Orders: <b>${todayOrders.length}</b> (Done: ${todayDone.length})
• Sales: <b>৳${todaySales.toLocaleString()}</b>
• Profit: <b>৳${todayProfit.toLocaleString()}</b>
• Deposits: <b>৳${todayDeposits.toLocaleString()}</b>
• New Users: <b>+${todayUsers}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📆 <b>THIS WEEK (7 Days):</b>
• Completed Orders: <b>${weekOrders.length}</b>
• Total Sales: <b>৳${weekSales.toLocaleString()}</b>
• Total Profit: <b>৳${weekProfit.toLocaleString()}</b>
• Total Deposits: <b>৳${weekDeposits.toLocaleString()}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🗓 <b>THIS MONTH (30 Days):</b>
• Completed Orders: <b>${monthOrders.length}</b>
• Total Sales: <b>৳${monthSales.toLocaleString()}</b>
• Total Profit: <b>৳${monthProfit.toLocaleString()}</b>
• Total Deposits: <b>৳${monthDeposits.toLocaleString()}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  const keyboard = [
    [
      { text: '💰 Balance Overview', callback_data: 'nav_balance' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

// ==========================================
// 11. SETTINGS & PAYMENT METHODS MODULE
// ==========================================

async function showSettingsMenu(chatId, messageId = null) {
  const pNums = db.settings.paymentNumbers || {};
  const rate = Number(db.settings.usdToBdtRate || db.settings.exchangeRate || 120);
  const refRate = Number(db.settings.referralCommissionPercent !== undefined ? db.settings.referralCommissionPercent : 1);
  const refStatus = db.settings.referralSystemEnabled !== false ? '🟢 Active' : '🔴 Disabled';

  const text = `
⚙️ <b>PLATFORM SETTINGS & CONFIGURATION</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🌐 <b>Site Domain:</b> <code>${db.settings.domain || 'freakshowtopup.shop'}</code>
💱 <b>USD Exchange Rate:</b> <b>$1 USD = ৳${rate} BDT</b>
🎁 <b>Referral Program:</b> <b>${refRate}% Commission</b> (${refStatus})
💰 <b>Min Deposit:</b> <b>৳${db.settings.minDepositBDT || 25}</b> ($${db.settings.minDepositUSD || 0.20})
━━━━━━━━━━━━━━━━━━━━━━━━━━
📱 <b>Payment Accounts & Gateways:</b>
• <b>bKash:</b> <code>${pNums.bkash || 'Not Set'}</code>
• <b>Nagad:</b> <code>${pNums.nagad || 'Not Set'}</code>
• <b>Rocket:</b> <code>${pNums.rocket || 'Not Set'}</code>
• <b>CellFin:</b> <code>${pNums.cellfin || 'Not Set'}</code>
• <b>Binance ID:</b> <code>${pNums.binanceId || pNums.binance || 'Not Set'}</code>
• <b>USDT TRC20:</b> <code>${pNums.binanceTrc20 || 'Not Set'}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Click an option below to update settings instantly:</i>
  `.trim();

  const keyboard = [
    [
      { text: `💱 Edit USD Rate ($1=৳${rate})`, callback_data: 'set_usd_rate_prompt' },
      { text: `🎁 Referral Settings (${refRate}%)`, callback_data: 'ref_settings' }
    ],
    [
      { text: '🌸 Edit bKash', callback_data: 'set_num_bkash' },
      { text: '🔥 Edit Nagad', callback_data: 'set_num_nagad' }
    ],
    [
      { text: '🚀 Edit Rocket', callback_data: 'set_num_rocket' },
      { text: '🏦 Edit CellFin', callback_data: 'set_num_cellfin' }
    ],
    [
      { text: '🪙 Edit Binance / USDT', callback_data: 'set_num_binance' },
      { text: '💳 Min Deposit', callback_data: 'set_min_dep' }
    ],
    [
      { text: '👑 VIP Access Code', callback_data: 'nav_vip' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

// ==========================================
// 11.2 VIP ACCESS CODE MANAGEMENT MODULE
// ==========================================

async function showVipMenu(chatId, messageId = null) {
  const currentCode = db.settings.currentVipCode || db.settings.vipAccessCode || 'JOY100LVL';
  const version = db.settings.vipCodeVersion ? new Date(db.settings.vipCodeVersion).toLocaleString() : 'Active';
  const activeVipUsers = (db.users || []).filter(u => u.isVip || u.vipUnlocked || u.hasVipAccess).length;

  const text = `
👑 <b>VIP ACCESS CODE CONTROL HUB</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔑 <b>Current Active VIP Code:</b> <code>${currentCode}</code>
🔄 <b>Code Version:</b> <code>${version}</code>
👥 <b>Active VIP Sessions:</b> <b>${activeVipUsers}</b> Users
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>When you update or auto-reset the VIP code, all previous user sessions are revoked and users must enter the new code to access VIP discounts!</i>
  `.trim();

  const keyboard = [
    [
      { text: '✏️ Change VIP Code', callback_data: 'vip_change_prompt' },
      { text: '🎲 Auto-Reset VIP Code', callback_data: 'vip_autoreset' }
    ],
    [
      { text: '🚫 Revoke All Active Sessions', callback_data: 'vip_revoke_sessions' }
    ],
    [
      { text: '⚙️ Settings', callback_data: 'nav_settings' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

// ==========================================
// 11.5 REFERRAL & EARN MANAGEMENT MODULE
// ==========================================

async function showReferralMenu(chatId, messageId = null) {
  const overview = referralEngine.getAdminReferralOverview();
  const { stats, settings } = overview;
  const statusBadge = settings.referralSystemEnabled ? '🟢 ACTIVE' : '🔴 DISABLED';
  const antiFraudBadge = settings.antiFraudEnabled ? '🛡️ ON' : '⚠️ OFF';
  const firstOnlyBadge = settings.firstDepositOnly ? '1️⃣ 1st Deposit Only' : '🔄 All Deposits';
  const validityText = settings.referralValidityDays > 0 ? `${settings.referralValidityDays} Days` : '♾️ Lifetime';

  const text = `
🎁 <b>REFERRAL & EARN CONTROL HUB</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>PERFORMANCE OVERVIEW:</b>
• 👥 Total Referrals: <b>${stats.totalReferrals}</b> (Active: <b>${stats.activeReferrals}</b>)
• 💰 Total Deposits Generated: <b>৳${stats.totalDepositFromReferrals.toLocaleString()} BDT</b>
• 🎁 Total Commission Paid: <b>৳${stats.totalCommissionPaid.toLocaleString()} BDT</b>
• ⏳ Pending Commission: <b>৳${stats.pendingCommission.toLocaleString()} BDT</b>
• 🔄 Reversed Commission: <b>৳${stats.reversedCommission.toLocaleString()} BDT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
⚙️ <b>CURRENT SYSTEM RULES:</b>
• Status: <b>${statusBadge}</b>
• Commission Rate: <b>${settings.referralCommissionPercent}%</b>
• Min Deposit Required: <b>${settings.minDepositForCommission > 0 ? '৳' + settings.minDepositForCommission : 'None (৳0)'}</b>
• Max Cap Per Deposit: <b>${settings.maxCommissionPerDeposit > 0 ? '৳' + settings.maxCommissionPerDeposit : 'No Limit'}</b>
• Attribution Validity: <b>${validityText}</b>
• Anti-Fraud Shield: <b>${antiFraudBadge}</b>
• Deposit Scope: <b>${firstOnlyBadge}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Select an administrative referral function below:</i>
  `.trim();

  const keyboard = [
    [
      { text: '⚙️ Referral Settings', callback_data: 'ref_settings' },
      { text: '🏆 Leaderboard', callback_data: 'ref_leaderboard' }
    ],
    [
      { text: '👥 Referrals List', callback_data: 'ref_list_p0' },
      { text: '📜 Commission Log', callback_data: 'ref_history' }
    ],
    [
      { text: `⏳ Pending (${overview.pendingDeposits.length})`, callback_data: 'ref_pending' },
      { text: '🔄 Reversed Log', callback_data: 'ref_reversed' }
    ],
    [
      { text: `🛡️ Fraud Shield Logs (${overview.fraudLogs.length})`, callback_data: 'ref_fraud' }
    ],
    [
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function showReferralSettingsMenu(chatId, messageId = null) {
  const isEnabled = db.settings.referralSystemEnabled !== false;
  const rate = Number(db.settings.referralCommissionPercent !== undefined ? db.settings.referralCommissionPercent : 2.5);
  const minDep = Number(db.settings.minDepositForCommission || 0);
  const maxCap = Number(db.settings.maxCommissionPerDeposit || 0);
  const firstOnly = Boolean(db.settings.firstDepositOnly);
  const validityDays = Number(db.settings.referralValidityDays !== undefined ? db.settings.referralValidityDays : 30);
  const antiFraud = db.settings.antiFraudEnabled !== false;
  const bonus = Boolean(db.settings.newUserBonusEnabled);

  const text = `
⚙️ <b>REFERRAL PROGRAM CONFIGURATION</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 <b>Status:</b> ${isEnabled ? '✅ ACTIVE' : '🔴 DISABLED'}
💸 <b>Commission Rate:</b> <b>${rate}%</b> <i>(Any value from 0.01%+)</i>
💳 <b>Min Deposit:</b> ৳${minDep}
💰 <b>Max Cap / Dep:</b> ${maxCap > 0 ? '৳' + maxCap : 'No Cap (৳0)'}
⏳ <b>Validity:</b> ${validityDays > 0 ? validityDays + ' Days' : '♾️ Lifetime'}
🛡️ <b>Anti-Fraud Shield:</b> ${antiFraud ? '✅ ACTIVE' : '⚠️ DISABLED'}
🎯 <b>Deposit Scope:</b> ${firstOnly ? '1️⃣ First Deposit Only' : '🔄 All Deposits'}
🎁 <b>New User Bonus:</b> ${bonus ? '✅ ON' : '🚫 OFF'}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Click an option below to update settings in real time:</i>
  `.trim();

  const keyboard = [
    [
      { text: `✏️ Set Rate (${rate}%)`, callback_data: 'ref_rate_prompt' },
      { text: `💳 Min Dep (৳${minDep})`, callback_data: 'ref_mindep_prompt' }
    ],
    [
      { text: `💰 Max Cap (${maxCap > 0 ? '৳' + maxCap : 'None'})`, callback_data: 'ref_maxcap_prompt' },
      { text: `⏳ Validity (${validityDays > 0 ? validityDays + 'd' : 'Life'})`, callback_data: 'ref_validity_menu' }
    ],
    [
      { text: `${isEnabled ? '🔴 Pause System' : '🟢 Enable System'}`, callback_data: 'ref_toggle_status' },
      { text: `${antiFraud ? '🛡️ Disable Fraud Shield' : '🛡️ Enable Fraud Shield'}`, callback_data: 'ref_toggle_antifraud' }
    ],
    [
      { text: `${firstOnly ? '🔄 Switch to All Deposits' : '1️⃣ Switch to 1st Dep Only'}`, callback_data: 'ref_toggle_firstonly' },
      { text: `${bonus ? '🚫 Turn Off Bonus' : '🎁 Turn On Bonus'}`, callback_data: 'ref_toggle_bonus' }
    ],
    [
      { text: '⬅️ Back to Referral Hub', callback_data: 'nav_referral' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function showReferralLeaderboard(chatId, messageId = null) {
  const overview = referralEngine.getAdminReferralOverview();
  const top = overview.topReferrers.slice(0, 10);

  let listText = '';
  if (top.length === 0) {
    listText = '<i>No referrers with activity yet.</i>\n';
  } else {
    top.forEach((r, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      listText += `
${medal} <b>${r.name || 'User'}</b> (<code>${r.referralCode || 'N/A'}</code>)
   • Referrals: <b>${r.referralsCount}</b> (Active: ${r.activeCount})
   • Deposit Generated: ৳${r.totalDepositAmount.toLocaleString()}
   • Commission Earned: <b>৳${r.totalCommissionEarned.toLocaleString()} BDT</b>
      `.trim() + '\n\n';
    });
  }

  const text = `
🏆 <b>TOP REFERRERS LEADERBOARD</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
${listText}━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  const keyboard = [
    [
      { text: '⬅️ Back to Referral Hub', callback_data: 'nav_referral' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function showReferralList(chatId, messageId = null, page = 0) {
  const overview = referralEngine.getAdminReferralOverview();
  const list = overview.referralsList;
  const pageSize = 5;
  const totalPages = Math.ceil(list.length / pageSize) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = currentPage * pageSize;
  const slice = list.slice(startIdx, startIdx + pageSize);

  let listText = '';
  if (slice.length === 0) {
    listText = '<i>No referred customers found.</i>\n';
  } else {
    slice.forEach((u, i) => {
      const statusBadge = u.status === 'ACTIVE' ? '🟢 Active' : '⚪ Inactive';
      listText += `
${startIdx + i + 1}. 👤 <b>${u.name}</b> (<code>${u.email}</code>)
   • Referrer: <b>${u.referrerName}</b> (<code>${u.referrerCode}</code>)
   • Deposits: <b>${u.depositCount}</b> | Total: ৳${u.totalDeposited}
   • Commission: <b>৳${u.commissionGenerated}</b> | Status: ${statusBadge}
      `.trim() + '\n\n';
    });
  }

  const text = `
👥 <b>ATTRIBUTED REFERRALS (Page ${currentPage + 1}/${totalPages})</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
${listText}━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Referred Users: <b>${list.length}</b>
  `.trim();

  const navRow = [];
  if (currentPage > 0) {
    navRow.push({ text: '⬅️ Prev', callback_data: `ref_list_p${currentPage - 1}` });
  }
  if (currentPage < totalPages - 1) {
    navRow.push({ text: 'Next ➡️', callback_data: `ref_list_p${currentPage + 1}` });
  }

  const keyboard = [];
  if (navRow.length > 0) keyboard.push(navRow);
  keyboard.push([
    { text: '⬅️ Back to Referral Hub', callback_data: 'nav_referral' },
    { text: '🏠 Main Menu', callback_data: 'nav_main' }
  ]);

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function showReferralHistory(chatId, messageId = null) {
  const comms = (db.commissions || []).slice(0, 8);

  let listText = '';
  if (comms.length === 0) {
    listText = '<i>No commission transactions recorded yet.</i>\n';
  } else {
    comms.forEach((c, i) => {
      const isPaid = c.status === 'PAID' || c.status === 'CREDITED';
      const statusBadge = isPaid ? '✅ PAID' : c.status === 'REVERSED' ? '🔄 REVERSED' : '⚠️ ' + c.status;
      listText += `
${i + 1}. 🆔 <code>#${c.id}</code> | ${statusBadge}
   • Referrer: <b>${c.referrerName || 'User'}</b>
   • Friend: ${c.originUserName || 'Customer'} (Dep: ৳${c.depositAmount || 0})
   • Rate: ${c.commissionRate || c.rate || 0}% | Amount: <b>৳${c.amount} BDT</b>
   • Time: ${c.createdAt ? new Date(c.createdAt).toLocaleTimeString() : 'N/A'}
      `.trim() + '\n\n';
    });
  }

  const text = `
📜 <b>REAL-TIME COMMISSION AUDIT LOG</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
${listText}━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Total Historical Records: ${db.commissions ? db.commissions.length : 0}</i>
  `.trim();

  const keyboard = [
    [
      { text: '⬅️ Back to Referral Hub', callback_data: 'nav_referral' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function showReferralPendingDeposits(chatId, messageId = null) {
  const overview = referralEngine.getAdminReferralOverview();
  const pending = overview.pendingDeposits;
  const rate = overview.settings.referralCommissionPercent;

  if (pending.length === 0) {
    const text = `
⏳ <b>PENDING DEPOSITS FROM REFERRED USERS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>No pending deposits from referred users at this time!</i>
All referral commissions are up to date.
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    const keyboard = [
      [
        { text: '📥 General Deposits', callback_data: 'dep_pending' },
        { text: '⬅️ Back to Referral Hub', callback_data: 'nav_referral' }
      ]
    ];

    if (messageId) {
      return await editTelegramMessage(chatId, messageId, text, keyboard);
    }
    return await sendTelegramMessage(text, chatId, keyboard);
  }

  const d = pending[0];
  const refUser = db.users.find(u => u.id === d.userId);
  const referrer = refUser ? db.users.find(r => r.id === refUser.referredById) : null;
  const estComm = Number(((Number(d.amount) * rate) / 100).toFixed(2));

  const text = `
⏳ <b>PENDING REFERRAL DEPOSIT (1/${pending.length})</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Deposit ID:</b> <code>#${d.id}</code>
👤 <b>Customer:</b> ${d.userName} (<code>${d.userEmail}</code>)
🎁 <b>Referred By:</b> ${referrer ? referrer.name : 'Unknown'} (<code>${referrer ? referrer.referralCode : 'N/A'}</code>)
💰 <b>Deposit Amount:</b> <b>৳${d.amount} ${d.currency || 'BDT'}</b>
🏦 <b>Payment Method:</b> <b>${d.paymentMethod}</b>
🔢 <b>Trx ID / Sender:</b> <code>${d.transactionId}</code>
🎁 <b>Est. Commission:</b> <b>৳${estComm} BDT</b> (${rate}%)
🕒 <b>Time:</b> ${new Date(d.createdAt).toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Approve to credit both customer wallet AND referrer commission!</i>
  `.trim();

  const keyboard = [
    [
      { text: '✅ Approve & Pay Commission', callback_data: `dep_app_${d.id}` },
      { text: '❌ Reject Deposit', callback_data: `dep_rej_${d.id}` }
    ],
    [
      { text: '⬅️ Back to Referral Hub', callback_data: 'nav_referral' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function showReferralReversed(chatId, messageId = null) {
  const reversed = (db.commissions || []).filter(c => c.status === 'REVERSED').slice(0, 8);

  let listText = '';
  if (reversed.length === 0) {
    listText = '<i>No reversed commissions on record.</i>\n';
  } else {
    reversed.forEach((c, i) => {
      listText += `
${i + 1}. 🆔 <code>#${c.id}</code> | Deposit: <code>#${c.depositId}</code>
   • Referrer: <b>${c.referrerName || 'User'}</b>
   • Reversed Amount: <b style="color: #f87171;">-৳${c.amount} BDT</b>
   • Reason: ${c.note || 'Deposit refunded / reversed'}
   • Time: ${c.updatedAt ? new Date(c.updatedAt).toLocaleString() : 'N/A'}
      `.trim() + '\n\n';
    });
  }

  const text = `
🔄 <b>REVERSED COMMISSIONS LOG</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
${listText}━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  const keyboard = [
    [
      { text: '⬅️ Back to Referral Hub', callback_data: 'nav_referral' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function showReferralFraudLogs(chatId, messageId = null) {
  const auditLogs = (db.auditLogs && db.auditLogs.logs) || [];
  const frauds = auditLogs.filter(l => l.action && l.action.includes('FRAUD')).slice(0, 8);

  let listText = '';
  if (frauds.length === 0) {
    listText = '🛡️ <i>0 suspicious referral events. System clean.</i>\n';
  } else {
    frauds.forEach((f, i) => {
      listText += `
${i + 1}. ⚠️ <b>${f.action}</b>
   • Actor: <code>${f.actorEmail || f.actorId || 'N/A'}</code>
   • Target: <code>${f.targetId || 'N/A'}</code>
   • Reason: ${f.reason || 'Self-referral attempt blocked'}
   • Time: ${f.timestamp ? new Date(f.timestamp).toLocaleString() : 'N/A'}
      `.trim() + '\n\n';
    });
  }

  const text = `
🛡️ <b>ANTI-FRAUD & FLAGGED REFERRAL LOGS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
${listText}━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  const keyboard = [
    [
      { text: '⬅️ Back to Referral Hub', callback_data: 'nav_referral' },
      { text: '🏠 Main Menu', callback_data: 'nav_main' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

async function showReferralValidityMenu(chatId, messageId = null) {
  const current = Number(db.settings.referralValidityDays !== undefined ? db.settings.referralValidityDays : 30);

  const text = `
⏳ <b>SELECT REFERRAL VALIDITY EXPIRATION</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Current Setting: <b>${current > 0 ? current + ' Days' : '♾️ Lifetime (No Expiry)'}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Choose how long a referred customer generates deposit commission for their referrer:</i>
  `.trim();

  const keyboard = [
    [
      { text: '7 Days', callback_data: 'ref_val_set_7' },
      { text: '15 Days', callback_data: 'ref_val_set_15' }
    ],
    [
      { text: '30 Days (Default)', callback_data: 'ref_val_set_30' },
      { text: '60 Days', callback_data: 'ref_val_set_60' }
    ],
    [
      { text: '90 Days', callback_data: 'ref_val_set_90' },
      { text: '180 Days', callback_data: 'ref_val_set_180' }
    ],
    [
      { text: '365 Days (1 Year)', callback_data: 'ref_val_set_365' },
      { text: '♾️ Lifetime (0 Days)', callback_data: 'ref_val_set_0' }
    ],
    [
      { text: '⬅️ Back to Settings', callback_data: 'ref_settings' }
    ]
  ];

  if (messageId) {
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }
  return await sendTelegramMessage(text, chatId, keyboard);
}

// ==========================================
// 12. CALLBACK QUERY DISPATCHER (INLINE BUTTONS)
// ==========================================

async function handleTelegramCallbackQuery(callbackQuery) {
  const queryId = callbackQuery.id;
  const fromId = callbackQuery.from ? String(callbackQuery.from.id) : null;
  const chatId = callbackQuery.message ? callbackQuery.message.chat.id : fromId;
  const messageId = callbackQuery.message ? callbackQuery.message.message_id : null;
  const data = callbackQuery.data || '';

  const auth = verifyTelegramAdmin(fromId, chatId);
  if (!auth.isAuthorized) {
    if (data.startsWith('usr_')) {
      await answerCallbackQuery(queryId);
      return await handleUserCallbackQuery(chatId, messageId, data, fromId);
    }
    await answerCallbackQuery(queryId, '⛔ Access Denied! You are not an authorized admin.', true);
    return;
  }

  await answerCallbackQuery(queryId);

  // If admin clicks user menu item
  if (data.startsWith('usr_')) {
    return await handleUserCallbackQuery(chatId, messageId, data, fromId);
  }

  // Navigation callbacks
  if (data === 'nav_main') return await showMainMenu(chatId, messageId, auth);
  if (data === 'nav_users') return await showUsersMenu(chatId, messageId);
  if (data === 'nav_balance') return await showBalanceMenu(chatId, messageId);
  if (data === 'nav_deposit') return await showDepositMenu(chatId, messageId);
  if (data === 'nav_referral') return await showReferralMenu(chatId, messageId);
  if (data === 'nav_categories') return await showCategoriesMenu(chatId, messageId);
  if (data === 'nav_products') return await showProductsMenu(chatId, messageId, 0);
  if (data === 'nav_orders') return await showOrdersMenu(chatId, messageId);

  // Referral Callbacks
  if (data === 'ref_settings') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required to modify referral settings.', true);
    }
    return await showReferralSettingsMenu(chatId, messageId);
  }
  if (data === 'ref_leaderboard') return await showReferralLeaderboard(chatId, messageId);
  if (data.startsWith('ref_list_p')) {
    const page = parseInt(data.replace('ref_list_p', ''), 10) || 0;
    return await showReferralList(chatId, messageId, page);
  }
  if (data === 'ref_history') return await showReferralHistory(chatId, messageId);
  if (data === 'ref_pending') return await showReferralPendingDeposits(chatId, messageId);
  if (data === 'ref_reversed') return await showReferralReversed(chatId, messageId);
  if (data === 'ref_fraud') return await showReferralFraudLogs(chatId, messageId);
  if (data === 'ref_validity_menu') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    return await showReferralValidityMenu(chatId, messageId);
  }
  if (data.startsWith('ref_val_set_')) {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    const days = parseInt(data.replace('ref_val_set_', ''), 10) || 0;
    const oldVal = db.settings.referralValidityDays;
    db.settings.referralValidityDays = days;
    db.saveAll();
    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'UPDATE_REFERRAL_VALIDITY_TELEGRAM',
      before: { referralValidityDays: oldVal },
      after: { referralValidityDays: days },
      reason: `Validity changed to ${days > 0 ? days + ' days' : 'Lifetime'} by ${auth.name}`
    });
    await answerCallbackQuery(queryId, `Validity set to: ${days > 0 ? days + ' Days' : 'Lifetime'}!`, true);
    return await showReferralSettingsMenu(chatId, messageId);
  }
  if (data === 'ref_toggle_status') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    const oldVal = db.settings.referralSystemEnabled !== false;
    db.settings.referralSystemEnabled = !oldVal;
    db.saveAll();
    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'TOGGLE_REFERRAL_STATUS_TELEGRAM',
      before: { referralSystemEnabled: oldVal },
      after: { referralSystemEnabled: db.settings.referralSystemEnabled },
      reason: `Referral system ${db.settings.referralSystemEnabled ? 'Enabled' : 'Disabled'} via Telegram by ${auth.name}`
    });
    await answerCallbackQuery(queryId, `Referral system is now ${db.settings.referralSystemEnabled ? 'Active' : 'Disabled'}!`, true);
    return await showReferralSettingsMenu(chatId, messageId);
  }
  if (data === 'ref_toggle_antifraud') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    const oldVal = db.settings.antiFraudEnabled !== false;
    db.settings.antiFraudEnabled = !oldVal;
    db.saveAll();
    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'TOGGLE_REFERRAL_ANTIFRAUD_TELEGRAM',
      before: { antiFraudEnabled: oldVal },
      after: { antiFraudEnabled: db.settings.antiFraudEnabled },
      reason: `Anti-fraud shield ${db.settings.antiFraudEnabled ? 'Enabled' : 'Disabled'} via Telegram by ${auth.name}`
    });
    await answerCallbackQuery(queryId, `Anti-fraud shield is now ${db.settings.antiFraudEnabled ? 'Active' : 'Disabled'}!`, true);
    return await showReferralSettingsMenu(chatId, messageId);
  }
  if (data === 'ref_toggle_firstonly') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    const oldVal = Boolean(db.settings.firstDepositOnly);
    db.settings.firstDepositOnly = !oldVal;
    db.saveAll();
    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'TOGGLE_REFERRAL_FIRSTONLY_TELEGRAM',
      before: { firstDepositOnly: oldVal },
      after: { firstDepositOnly: db.settings.firstDepositOnly },
      reason: `Deposit scope changed to ${db.settings.firstDepositOnly ? '1st Only' : 'All'} via Telegram by ${auth.name}`
    });
    await answerCallbackQuery(queryId, `Scope changed: ${db.settings.firstDepositOnly ? '1st Deposit Only' : 'All Deposits'}!`, true);
    return await showReferralSettingsMenu(chatId, messageId);
  }
  if (data === 'ref_toggle_bonus') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    const oldVal = Boolean(db.settings.newUserBonusEnabled);
    db.settings.newUserBonusEnabled = !oldVal;
    db.saveAll();
    await answerCallbackQuery(queryId, `New user signup bonus is now ${db.settings.newUserBonusEnabled ? 'ON' : 'OFF'}!`, true);
    return await showReferralSettingsMenu(chatId, messageId);
  }
  if (data === 'ref_rate_prompt') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    sessions.setSession(chatId, { step: 'SET_REF_RATE' });
    const currentRate = db.settings.referralCommissionPercent !== undefined ? db.settings.referralCommissionPercent : 2.5;
    const text = `
💸 <b>SET REFERRAL COMMISSION RATE (%)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Current Rate: <b>${currentRate}%</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the new percentage rate (e.g. <code>0.01</code>, <code>0.5</code>, <code>1.5</code>, <code>2.5</code>, <code>5</code>):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'ref_settings' }]]);
  }
  if (data === 'ref_mindep_prompt') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    sessions.setSession(chatId, { step: 'SET_REF_MIN_DEP' });
    const currentMin = db.settings.minDepositForCommission || 0;
    const text = `
💳 <b>SET MINIMUM DEPOSIT FOR COMMISSION</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Current Min Deposit: <b>৳${currentMin}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the minimum deposit amount in ৳ (e.g. <code>100</code> or <code>0</code> for none):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'ref_settings' }]]);
  }
  if (data === 'ref_maxcap_prompt') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    sessions.setSession(chatId, { step: 'SET_REF_MAX_CAP' });
    const currentCap = db.settings.maxCommissionPerDeposit || 0;
    const text = `
💰 <b>SET MAXIMUM COMMISSION CAP PER DEPOSIT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Current Max Cap: <b>${currentCap > 0 ? '৳' + currentCap : 'No Cap (৳0)'}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the max commission cap in ৳ (e.g. <code>500</code> or <code>0</code> for no cap):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'ref_settings' }]]);
  }
  
  if (data === 'nav_admins') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Access Denied! Only Master Owner (5339688506) can manage Admins.', true);
    }
    return await showAdminsMenu(chatId, messageId);
  }

  if (data === 'nav_stats') return await showStatsMenu(chatId, messageId);
  
  if (data === 'nav_settings') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Access Denied! Only Master Owner (5339688506) can edit Platform Settings.', true);
    }
    return await showSettingsMenu(chatId, messageId);
  }

  if (data === 'nav_vip') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Access Denied! Only Super Admin can manage VIP Access Code.', true);
    }
    return await showVipMenu(chatId, messageId);
  }

  // Users List Pagination
  if (data.startsWith('usr_list_p')) {
    const page = parseInt(data.replace('usr_list_p', ''), 10) || 0;
    return await renderUsersListPage(chatId, messageId, page);
  }

  // User Delete List Pagination
  if (data.startsWith('usr_del_list_p') || data === 'usr_del_prompt') {
    const page = parseInt((data.replace('usr_del_list_p', '') || '0'), 10) || 0;
    return await renderUserDeleteListPage(chatId, messageId, page);
  }

  // User Ban/Unban List Pagination
  if (data.startsWith('usr_ban_list_p') || data === 'usr_ban_prompt') {
    const page = parseInt((data.replace('usr_ban_list_p', '') || '0'), 10) || 0;
    return await renderUserBanListPage(chatId, messageId, page);
  }

  // User Edit List Pagination
  if (data.startsWith('usr_edit_list_p') || data === 'usr_edit_prompt') {
    const page = parseInt((data.replace('usr_edit_list_p', '') || '0'), 10) || 0;
    return await renderUserEditListPage(chatId, messageId, page);
  }

  // Products Pagination
  if (data.startsWith('prod_page_p')) {
    const page = parseInt(data.replace('prod_page_p', ''), 10) || 0;
    return await showProductsMenu(chatId, messageId, page);
  }

  // Search User Prompt
  if (data === 'usr_search_prompt') {
    sessions.setSession(chatId, { step: 'SEARCH_USER', mode: data });
    const text = `
🔎 <b>SEARCH USER</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the <b>User ID</b> (e.g. <code>usr_123</code> or <code>1024</code>) or <b>Gmail/Email Address</b>:
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_users' }]]);
  }

  // Direct user profile lookup execution
  if (data.startsWith('usr_search_exec_')) {
    const targetUserId = data.replace('usr_search_exec_', '');
    const user = db.users.find(u => u.id === targetUserId || u.email === targetUserId);
    if (!user) {
      return await sendTelegramMessage('❌ User not found in database.', chatId, [[{ text: '⬅️ Back', callback_data: 'nav_users' }]]);
    }
    return showUserProfileCard(chatId, messageId, user);
  }

  // Toggle Ban/Unban user
  if (data.startsWith('usr_toggleban_')) {
    const targetUserId = data.replace('usr_toggleban_', '');
    const user = db.users.find(u => u.id === targetUserId);
    if (!user) return await answerCallbackQuery(queryId, 'User not found', true);

    const oldStatus = user.status || 'ACTIVE';
    const newStatus = oldStatus === 'BANNED' ? 'ACTIVE' : 'BANNED';
    user.status = newStatus;
    user.updatedAt = new Date().toISOString();
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: newStatus === 'BANNED' ? 'BAN_USER' : 'UNBAN_USER',
      targetId: user.id,
      before: { status: oldStatus },
      after: { status: newStatus },
      reason: `Admin ${auth.name} changed status via Telegram`
    });

    await answerCallbackQuery(queryId, `✅ User is now ${newStatus}!`, true);
    return showUserProfileCard(chatId, messageId, user);
  }

  // Delete User Confirmation
  if (data.startsWith('usr_delconfirm_')) {
    const targetUserId = data.replace('usr_delconfirm_', '');
    const user = db.users.find(u => u.id === targetUserId);
    if (!user) return await answerCallbackQuery(queryId, 'User not found', true);

    const text = `
⚠️ <b>CONFIRM USER DELETION</b> ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━
Are you sure you want to permanently <b>DELETE</b> this user?
👤 <b>User:</b> ${user.name || user.username}
📧 <b>Email:</b> <code>${user.email}</code>
🆔 <b>ID:</b> <code>#${user.id}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>This account will be permanently removed from registered users.</i>
    `.trim();

    const keyboard = [
      [
        { text: '🗑 Yes, Delete User', callback_data: `usr_deleteexec_${user.id}` },
        { text: '❌ Cancel', callback_data: 'usr_del_list_p0' }
      ]
    ];
    return await editTelegramMessage(chatId, messageId, text, keyboard);
  }

  // Execute User Delete
  if (data.startsWith('usr_deleteexec_')) {
    const targetUserId = data.replace('usr_deleteexec_', '');
    const idx = db.users.findIndex(u => u.id === targetUserId);
    if (idx !== -1) {
      const deletedUser = db.users.splice(idx, 1)[0];
      db.saveAll();

      recordAuditLog({
        actorId: `tg_${fromId}`,
        action: 'DELETE_USER',
        targetId: targetUserId,
        before: deletedUser,
        reason: `Deleted by Admin ${auth.name} via Telegram`
      });

      await answerCallbackQuery(queryId, `✅ User "${deletedUser.name || deletedUser.email}" deleted successfully!`, true);
      return await showUsersMenu(chatId, messageId);
    } else {
      await answerCallbackQuery(queryId, 'User not found or already deleted.', true);
      return await showUsersMenu(chatId, messageId);
    }
  }

  // Reset User Password
  if (data.startsWith('usr_pwd_')) {
    const targetUserId = data.replace('usr_pwd_', '');
    const user = db.users.find(u => u.id === targetUserId);
    if (!user) return await answerCallbackQuery(queryId, 'User not found', true);

    const newPass = `FS${Math.floor(100000 + Math.random() * 900000)}#`;
    user.passwordHash = bcrypt.hashSync(newPass, 10);
    user.updatedAt = new Date().toISOString();
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'RESET_PASSWORD',
      targetId: user.id,
      reason: `Password reset by Admin ${auth.name} via Telegram`
    });

    const text = `
🔐 <b>PASSWORD RESET SUCCESSFUL</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> ${user.name || user.username}
📧 <b>Email:</b> <code>${user.email}</code>
🔑 <b>Temporary Password:</b> <code>${newPass}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Please send this password securely to the customer.</i>
    `.trim();

    return await sendTelegramMessage(text, chatId, [[{ text: '⬅️ Back to Profile', callback_data: `usr_search_exec_${user.id}` }]]);
  }

  // Add User Wizard Step 1
  if (data === 'usr_add') {
    sessions.setSession(chatId, { step: 'ADD_USER_NAME', draft: {} });
    const text = `
➕ <b>ADD NEW CUSTOMER ACCOUNT [1/4]</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the <b>Customer Name</b>:
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_users' }]]);
  }

  // Adjust Balance Prompt
  if (data === 'bal_adjust_prompt') {
    sessions.setSession(chatId, { step: 'SEARCH_USER_BALANCE' });
    const text = `
💰 <b>ADJUST USER WALLET BALANCE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the <b>User ID</b> or <b>Gmail / Email</b> of the account:
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_balance' }]]);
  }

  // Balance Options for specific user
  if (data.startsWith('bal_user_')) {
    const targetUserId = data.replace('bal_user_', '');
    const user = db.users.find(u => u.id === targetUserId);
    if (!user) return await answerCallbackQuery(queryId, 'User not found', true);

    const wallet = db.wallets.find(w => w.userId === user.id);
    const bal = wallet ? Number(wallet.balance).toFixed(2) : '0.00';

    const text = `
💰 <b>BALANCE ADJUSTMENT: ${user.name || user.username}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> ${user.name || user.username} (<code>${user.email}</code>)
💵 <b>Current Balance:</b> <b>৳${bal} ${user.currency || 'BDT'}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Select an adjustment mode:</i>
    `.trim();

    const keyboard = [
      [
        { text: '➕ Add Balance (+৳)', callback_data: `bal_mode_ADD_${user.id}` },
        { text: '➖ Deduct Balance (-৳)', callback_data: `bal_mode_DEDUCT_${user.id}` }
      ],
      [
        { text: '✏️ Set Exact Balance (৳)', callback_data: `bal_mode_SET_${user.id}` }
      ],
      [
        { text: '⬅️ Back to Profile', callback_data: `usr_search_exec_${user.id}` }
      ]
    ];

    if (messageId) return await editTelegramMessage(chatId, messageId, text, keyboard);
    return await sendTelegramMessage(text, chatId, keyboard);
  }

  // Confirm user creation
  if (data === 'usr_create_confirm') {
    const session = sessions.getSession(chatId);
    if (!session || !session.draft || !session.draft.email) {
      return await answerCallbackQuery(queryId, 'Session expired. Please start over.', true);
    }

    const { name, email, password, balance } = session.draft;
    sessions.clearSession(chatId);

    const newUserId = `usr_${Date.now().toString(36)}`;
    const passwordHash = bcrypt.hashSync(password, 10);

    const newUser = {
      id: newUserId,
      email: email,
      username: email.split('@')[0],
      name: name,
      passwordHash: passwordHash,
      role: 'USER',
      country: 'BD',
      currency: 'BDT',
      currencyChangeUsed: false,
      referralCode: `FS${Math.floor(100000 + Math.random() * 900000)}`,
      referredById: null,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.users.push(newUser);

    const newWallet = {
      id: `wal_${crypto.randomBytes(8).toString('hex')}`,
      userId: newUserId,
      currency: 'BDT',
      balance: Number((balance || 0).toFixed(2)),
      lockedAmount: 0.00,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.wallets.push(newWallet);

    if (balance && balance > 0) {
      const ledgerTx = {
        id: `tx_${crypto.randomBytes(8).toString('hex')}`,
        walletId: newWallet.id,
        userId: newUserId,
        type: 'INITIAL_CREDIT',
        amount: Number(balance.toFixed(2)),
        previousBalance: 0,
        newBalance: Number(balance.toFixed(2)),
        currency: 'BDT',
        status: 'COMPLETED',
        description: `Initial balance credited upon account creation by Admin ${auth.name} via Telegram`,
        adminId: `tg_${fromId}`,
        createdAt: new Date().toISOString()
      };
      db.transactions.unshift(ledgerTx);
    }

    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'CREATE_USER',
      targetId: newUserId,
      after: { email, name, role: 'USER', initialBalance: balance },
      reason: `Account created via Telegram Bot by ${auth.name}`
    });

    const successMsg = `
✅ <b>USER CREATED SUCCESSFULLY!</b> 👤
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Name:</b> ${newUser.name}
📧 <b>Email:</b> <code>${newUser.email}</code>
🔑 <b>Temporary Password:</b> <code>${password}</code>
💰 <b>Wallet Balance:</b> <b>৳${newWallet.balance.toFixed(2)} BDT</b>
🆔 <b>User ID:</b> <code>#${newUser.id}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Account is active and ready to login on freakshowtopup.shop!</i>
    `.trim();

    return await sendTelegramMessage(successMsg, chatId, [
      [{ text: '👤 User Profile', callback_data: `usr_search_exec_${newUserId}` }, { text: '👥 Users Menu', callback_data: 'nav_users' }]
    ]);
  }

  // Balance adjustment amount prompt (Safe underscore splitting)
  if (data.startsWith('bal_mode_')) {
    const raw = data.slice('bal_mode_'.length);
    const firstSep = raw.indexOf('_');
    const mode = raw.slice(0, firstSep);
    const targetUserId = raw.slice(firstSep + 1);

    sessions.setSession(chatId, { step: 'BALANCE_AMOUNT_INPUT', mode, targetUserId });
    const text = `
💰 <b>ENTER ADJUSTMENT AMOUNT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Action: <b>${mode} BALANCE</b>
Please type the amount in Taka (e.g. <code>100</code> or <code>500.50</code>):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: `bal_user_${targetUserId}` }]]);
  }

  // 1-Click Approve Deposit
  if (data.startsWith('dep_app_')) {
    const depositId = data.replace('dep_app_', '');
    const deposit = db.deposits.find(d => d.id === depositId);
    
    if (!deposit) {
      return await answerCallbackQuery(queryId, 'Deposit request not found!', true);
    }
    if (deposit.status !== 'PENDING') {
      return await answerCallbackQuery(queryId, `Already processed! Status: ${deposit.status}`, true);
    }

    try {
      const walletLib = require('./wallet');
      await walletLib.approveDeposit(depositId, `tg_${fromId}`, `Approved via Telegram Bot by ${auth.name}`);

      const successText = `
✅ <b>DEPOSIT APPROVED & CREDITED</b> 💳
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Deposit ID:</b> <code>#${deposit.id}</code>
👤 <b>Customer:</b> ${deposit.userName} (<code>${deposit.userEmail}</code>)
💰 <b>Amount Credited:</b> <b>৳${deposit.amount} ${deposit.currency || 'BDT'}</b>
🏦 <b>Method:</b> ${deposit.paymentMethod} (Trx: <code>${deposit.transactionId}</code>)
🕒 <b>Processed:</b> ${new Date().toLocaleTimeString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Customer wallet balance updated automatically.</i>
      `.trim();

      if (messageId) {
        await editTelegramMessage(chatId, messageId, successText, [[{ text: '📥 Next Pending', callback_data: 'dep_pending' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]]);
      } else {
        await sendTelegramMessage(successText, chatId);
      }
      return await answerCallbackQuery(queryId, '✅ Deposit approved successfully!');
    } catch (err) {
      return await answerCallbackQuery(queryId, `Error: ${err.message}`, true);
    }
  }

  // 1-Click Reject Deposit
  if (data.startsWith('dep_rej_')) {
    const depositId = data.replace('dep_rej_', '');
    const deposit = db.deposits.find(d => d.id === depositId);

    if (!deposit || deposit.status !== 'PENDING') {
      return await answerCallbackQuery(queryId, 'Deposit already processed or not found', true);
    }

    try {
      const walletLib = require('./wallet');
      await walletLib.rejectDeposit(depositId, `tg_${fromId}`, `Rejected via Telegram Bot by ${auth.name}`);

      const text = `
❌ <b>DEPOSIT REJECTED</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Deposit ID:</b> <code>#${deposit.id}</code>
👤 <b>Customer:</b> ${deposit.userName} (<code>${deposit.userEmail}</code>)
💰 <b>Amount:</b> ৳${deposit.amount}
⚠️ <b>Status:</b> <b>REJECTED</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
      `.trim();

      if (messageId) {
        await editTelegramMessage(chatId, messageId, text, [[{ text: '📥 Next Pending', callback_data: 'dep_pending' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]]);
      } else {
        await sendTelegramMessage(text, chatId);
      }
      return await answerCallbackQuery(queryId, 'Deposit rejected.');
    } catch (err) {
      return await answerCallbackQuery(queryId, `Error: ${err.message}`, true);
    }
  }

  // Pending Deposits Menu
  if (data === 'dep_pending') {
    return await renderPendingDeposits(chatId, messageId);
  }

  // Edit Payment Methods Prompts
  if (data === 'dep_methods' || data.startsWith('set_num_')) {
    let method = 'bkash';
    if (data.includes('nagad')) method = 'nagad';
    if (data.includes('rocket')) method = 'rocket';
    if (data.includes('cellfin')) method = 'cellfin';
    if (data.includes('binance')) method = 'binance';

    sessions.setSession(chatId, { step: 'EDIT_PAYMENT_NUMBER', method });
    const currentNum = (db.settings.paymentNumbers && db.settings.paymentNumbers[method]) || 'Not Set';

    const text = `
📱 <b>EDIT ${method.toUpperCase()} NUMBER / ACCOUNT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Current: <code>${currentNum}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the new number & instructions (e.g. <code>01712-345678 (Personal / Send Money)</code>):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();

    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_settings' }]]);
  }

  // Edit USD to BDT Exchange Rate Prompt
  if (data === 'set_usd_rate_prompt') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    sessions.setSession(chatId, { step: 'SET_USD_RATE' });
    const currentRate = db.settings.usdToBdtRate || db.settings.exchangeRate || 120;
    const text = `
💱 <b>SET 1 USD TO BDT EXCHANGE RATE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Current Rate: <b>$1 USD = ৳${currentRate} BDT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the new exchange rate in Taka (e.g. <code>120</code>, <code>122</code>, <code>125</code>):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_settings' }]]);
  }

  // Edit Minimum Deposit Prompt
  if (data === 'set_min_dep') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    sessions.setSession(chatId, { step: 'SET_MIN_DEP' });
    const currentMin = db.settings.minDepositBDT || 25;
    const currentUsd = db.settings.minDepositUSD || (currentMin / (db.settings.usdToBdtRate || 120)).toFixed(2);
    const text = `
💳 <b>SET MINIMUM DEPOSIT AMOUNT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Current Min Deposit: <b>৳${currentMin} BDT</b> ($${currentUsd})
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the new minimum deposit amount in ৳ BDT (e.g. <code>25</code> or <code>50</code>):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_settings' }]]);
  }

  // VIP Change Code Prompt
  if (data === 'vip_change_prompt') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    sessions.setSession(chatId, { step: 'AWAITING_VIP_CODE' });
    const currentCode = db.settings.currentVipCode || db.settings.vipAccessCode || 'JOY100LVL';
    const text = `
👑 <b>CHANGE VIP ACCESS CODE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔑 Current Code: <code>${currentCode}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the new secret VIP Access Code (e.g. <code>FREAK2026VIP</code>, minimum 4 characters):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_vip' }]]);
  }

  // VIP Auto-Reset
  if (data === 'vip_autoreset') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    const newCode = 'VIP' + Math.floor(100000 + Math.random() * 900000);
    const newHash = await bcrypt.hash(newCode, 10);
    const oldCode = db.settings.currentVipCode || db.settings.vipAccessCode || 'JOY100LVL';

    db.settings.vipAccessCodeHash = newHash;
    db.settings.currentVipCode = newCode;
    db.settings.vipAccessCode = newCode;
    db.settings.vipCodeVersion = Date.now();

    // Revoke all existing customer VIP sessions
    let revokedCount = 0;
    if (Array.isArray(db.users)) {
      db.users.forEach(u => {
        if (u.isVip || u.vipUnlocked || u.hasVipAccess) {
          u.isVip = false;
          u.vipUnlocked = false;
          u.hasVipAccess = false;
          delete u.vipUnlockedAt;
          delete u.vipCodeVersion;
          revokedCount++;
        }
      });
    }
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'VIP_CODE_AUTORESET_TELEGRAM',
      before: { vipCode: oldCode },
      after: { vipCode: newCode, vipCodeVersion: db.settings.vipCodeVersion, revokedSessions: revokedCount },
      reason: `VIP Access Code auto-reset via Telegram Bot by ${auth.name}`
    });

    await answerCallbackQuery(queryId, `🎲 New VIP Code: ${newCode}`, true);
    const text = `
🎲 <b>VIP ACCESS CODE AUTO-RESET!</b> 👑
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔑 <b>New Active VIP Code:</b> <code>${newCode}</code>
🔄 <b>Code Version:</b> <code>${new Date(db.settings.vipCodeVersion).toLocaleString()}</code>
🚫 <b>Revoked Sessions:</b> <b>${revokedCount}</b> customer sessions invalidated
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>All existing customer VIP sessions have been invalidated. Users must enter <code>${newCode}</code> to unlock VIP prices!</i>
    `.trim();

    return await sendTelegramMessage(text, chatId, [
      [{ text: '👑 Back to VIP Menu', callback_data: 'nav_vip' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  // VIP Revoke All Sessions
  if (data === 'vip_revoke_sessions') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin permissions required.', true);
    }
    db.settings.vipCodeVersion = Date.now();
    let revokedCount = 0;
    if (Array.isArray(db.users)) {
      db.users.forEach(u => {
        if (u.isVip || u.vipUnlocked || u.hasVipAccess) {
          u.isVip = false;
          u.vipUnlocked = false;
          u.hasVipAccess = false;
          delete u.vipUnlockedAt;
          delete u.vipCodeVersion;
          revokedCount++;
        }
      });
    }
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'REVOKE_VIP_SESSIONS_TELEGRAM',
      after: { vipCodeVersion: db.settings.vipCodeVersion, revokedSessions: revokedCount },
      reason: `All VIP customer sessions revoked via Telegram Bot by ${auth.name}`
    });

    await answerCallbackQuery(queryId, `🚫 Revoked ${revokedCount} VIP sessions!`, true);
    const text = `
🚫 <b>ALL VIP SESSIONS REVOKED!</b> 🔒
━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 <b>Total Revoked:</b> <b>${revokedCount}</b> customer sessions
🔑 <b>Current Code:</b> <code>${db.settings.currentVipCode || db.settings.vipAccessCode || 'JOY100LVL'}</code>
🔄 <b>New Version:</b> <code>${new Date(db.settings.vipCodeVersion).toLocaleString()}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>All customers currently browsing the VIP storefront will be required to re-authenticate with the VIP code on their next action!</i>
    `.trim();

    return await sendTelegramMessage(text, chatId, [
      [{ text: '👑 Back to VIP Menu', callback_data: 'nav_vip' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  // Order Search Prompt
  if (data === 'ord_search_prompt') {
    sessions.setSession(chatId, { step: 'SEARCH_ORDER' });
    const text = `
🔎 <b>SEARCH ORDERS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Type the <b>Order ID</b> (e.g. <code>#12345</code>), <b>Player UID</b>, or <b>Customer Email</b>:
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_orders' }]]);
  }

  // Filter Orders by status
  if (data.startsWith('ord_filter_')) {
    const status = data.replace('ord_filter_', '');
    const filtered = db.orders.filter(o => o.status === status).slice(0, 5);

    if (filtered.length === 0) {
      const text = `ℹ️ No orders found with status <b>${status}</b>.`;
      return await sendTelegramMessage(text, chatId, [[{ text: '⬅️ Back to Orders', callback_data: 'nav_orders' }]]);
    }

    let orderListText = '';
    filtered.forEach((o, i) => {
      orderListText += `
${i + 1}. 🆔 <code>#${o.id}</code> | <b>${o.productName}</b>
👤 ${o.userName} | UID: <code>${o.playerUid || 'N/A'}</code>
💰 ৳${o.sellingPrice} | Status: <b>${o.status}</b>
🕒 ${new Date(o.createdAt).toLocaleString()}
      `.trim() + '\n\n';
    });

    const text = `
📋 <b>${status} ORDERS (${filtered.length})</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
${orderListText}━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    return await sendTelegramMessage(text, chatId, [[{ text: '⬅️ Back to Orders', callback_data: 'nav_orders' }]]);
  }

  // Order Action: Mark Done & Dispatch Email to Customer Gmail
  if (data.startsWith('ord_markdone_')) {
    const orderId = data.replace('ord_markdone_', '');
    const order = db.orders.find(o => o.id === orderId);
    if (!order) return await answerCallbackQuery(queryId, 'Order not found!', true);
    if (order.status === 'DONE') {
      return await answerCallbackQuery(queryId, 'Order is already marked as DONE!', true);
    }
    order.status = 'DONE';
    order.deliveredAt = new Date().toISOString();
    order.adminDeliveredBy = auth.name || 'Telegram Bot Admin';
    db.saveAll();

    // Send confirmation email directly to user's purchasing Gmail address
    const { sendOrderDeliveredEmail } = require('./email');
    const emailResult = await sendOrderDeliveredEmail(order, 'Successfully processed and delivered by FreakShow Admin.');

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'ORDER_MARKED_DONE_TELEGRAM',
      targetId: order.id,
      after: { status: 'DONE', emailResult },
      reason: `Order marked as DONE via Telegram Bot by ${auth.name}`
    });

    await answerCallbackQuery(queryId, `✅ Order #${order.id} marked as DONE!`, true);
    const confirmMsg = `
✅ <b>ORDER COMPLETED & DELIVERED!</b> 🚀
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Order ID:</b> <code>#${order.id}</code>
🎮 <b>Product:</b> <b>${order.productName || order.productId}</b>
👤 <b>Customer:</b> ${order.userName}
📧 <b>Delivery Email:</b> <code>${order.playerUid || order.userEmail}</code>
💰 <b>Amount:</b> ৳${order.sellingPrice}
✉️ <b>Email Status:</b> ${emailResult.success ? '✅ Dispatched to Customer Gmail' : '⚠️ ' + (emailResult.reason || 'Failed to dispatch')}
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();
    return await sendTelegramMessage(confirmMsg, chatId, [[{ text: '📋 Back to Orders', callback_data: 'nav_orders' }]]);
  }

  // Order Action: Cancel & Execute 100% Wallet Refund
  if (data.startsWith('ord_cancelrefund_')) {
    const orderId = data.replace('ord_cancelrefund_', '');
    const order = db.orders.find(o => o.id === orderId);
    if (!order) return await answerCallbackQuery(queryId, 'Order not found!', true);
    if (order.status === 'REFUNDED') {
      return await answerCallbackQuery(queryId, 'Order is already REFUNDED!', true);
    }

    const orderEngine = require('./orders');
    await orderEngine.executeAutoRefund(order.id, `Order cancelled via Telegram Bot by ${auth.name}`);

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'ORDER_CANCELLED_REFUNDED_TELEGRAM',
      targetId: order.id,
      after: { status: 'REFUNDED', refundedAmount: order.sellingPrice },
      reason: `Order cancelled & 100% wallet refunded via Telegram Bot by ${auth.name}`
    });

    await answerCallbackQuery(queryId, `✅ Order #${order.id} refunded to customer wallet!`, true);
    const cancelMsg = `
🔄 <b>ORDER CANCELLED & 100% REFUNDED!</b> 💸
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Order ID:</b> <code>#${order.id}</code>
🎮 <b>Product:</b> <b>${order.productName || order.productId}</b>
👤 <b>Customer:</b> ${order.userName} (<code>${order.userEmail}</code>)
💵 <b>Refunded to Wallet:</b> <b>৳${order.sellingPrice} BDT</b>
📊 <b>Status:</b> ❌ REFUNDED (Wallet Balance Restored)
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();
    return await sendTelegramMessage(cancelMsg, chatId, [[{ text: '📋 Back to Orders', callback_data: 'nav_orders' }]]);
  }

  // Category Callbacks
  if (data === 'cat_list') {
    let listText = '';
    db.categories.forEach((c, i) => {
      const prodCount = db.products.filter(p => p.categoryId === c.id).length;
      const status = c.isActive !== false ? '✅ Active' : '👁️‍🗨️ Hidden';
      listText += `
${i + 1}. ${c.icon || '📁'} <b>${c.name}</b>
🆔 ID: <code>${c.id}</code> | Slug: <code>${c.slug || c.id}</code>
📦 Products: <b>${prodCount}</b> | Status: <b>${status}</b>
      `.trim() + '\n\n';
    });

    const text = `
📋 <b>ALL WEBSITE CATEGORIES</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
${listText || '<i>No categories found.</i>\n'}━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    return await sendTelegramMessage(text, chatId, [
      [{ text: '➕ Add Category', callback_data: 'cat_add' }, { text: '🗑 Delete Category', callback_data: 'cat_del_list' }],
      [{ text: '⬅️ Back to Categories', callback_data: 'nav_categories' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  if (data === 'cat_add') {
    sessions.setSession(chatId, { step: 'ADD_CAT_NAME', draft: {} });
    const text = `
➕ <b>ADD NEW CATEGORY [1/2]</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the <b>Category Name</b> (e.g. <code>Call of Duty Mobile</code> or <code>Valorant Points</code>):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_categories' }]]);
  }

  if (data === 'cat_del_list') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Access Denied! Only Master Owner (5339688506) can delete categories.', true);
    }
    const cats = db.categories;
    if (cats.length === 0) {
      return await sendTelegramMessage('ℹ️ No categories to delete.', chatId, [[{ text: '⬅️ Back', callback_data: 'nav_categories' }]]);
    }

    const buttons = cats.map(c => [
      { text: `🗑 Delete: ${c.name}`, callback_data: `cat_delconfirm_${c.id}` }
    ]);
    buttons.push([{ text: '⬅️ Back to Categories', callback_data: 'nav_categories' }]);

    const text = `
🗑 <b>SELECT CATEGORY TO DELETE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Choose a category to permanently remove from the website:</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    if (messageId) return await editTelegramMessage(chatId, messageId, text, buttons);
    return await sendTelegramMessage(text, chatId, buttons);
  }

  if (data.startsWith('cat_delconfirm_')) {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Access Denied! Only Master Owner (5339688506) can delete categories.', true);
    }
    const catId = data.replace('cat_delconfirm_', '');
    const cat = db.categories.find(c => c.id === catId);
    if (!cat) return await answerCallbackQuery(queryId, 'Category not found!', true);

    const associatedProds = db.products.filter(p => p.categoryId === cat.id).length;

    const text = `
⚠️ <b>CONFIRM CATEGORY DELETION</b> ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━
Category: <b>${cat.name}</b>
ID: <code>${cat.id}</code>
Icon: ${cat.icon || '📁'}
Associated Products: <b>${associatedProds} items</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Are you sure you want to permanently delete this category?</i>
    `.trim();

    const keyboard = [
      [
        { text: '🗑 Yes, Delete Category', callback_data: `cat_delexec_${cat.id}` },
        { text: '❌ Cancel', callback_data: 'cat_del_list' }
      ]
    ];

    if (messageId) return await editTelegramMessage(chatId, messageId, text, keyboard);
    return await sendTelegramMessage(text, chatId, keyboard);
  }

  if (data.startsWith('cat_delexec_')) {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Access Denied! Only Master Owner (5339688506) can delete categories.', true);
    }
    const catId = data.replace('cat_delexec_', '');
    const idx = db.categories.findIndex(c => c.id === catId);
    if (idx !== -1) {
      const removedCat = db.categories.splice(idx, 1)[0];
      db.saveAll();

      recordAuditLog({
        actorId: `tg_${fromId}`,
        action: 'DELETE_CATEGORY',
        targetId: catId,
        before: removedCat,
        reason: `Deleted via Telegram Bot by ${auth.name}`
      });

      await answerCallbackQuery(queryId, `✅ Category "${removedCat.name}" deleted!`, true);
      return await showCategoriesMenu(chatId, messageId);
    }
    return await answerCallbackQuery(queryId, 'Category not found', true);
  }

  if (data === 'cat_toggle_list') {
    const cats = db.categories;
    if (cats.length === 0) {
      return await sendTelegramMessage('ℹ️ No categories found.', chatId, [[{ text: '⬅️ Back', callback_data: 'nav_categories' }]]);
    }

    const buttons = cats.map(c => {
      const statusText = c.isActive !== false ? '👁 Hide' : '👁️‍🗨️ Unhide';
      return [{ text: `${statusText}: ${c.name}`, callback_data: `cat_toggleexec_${c.id}` }];
    });
    buttons.push([{ text: '⬅️ Back to Categories', callback_data: 'nav_categories' }]);

    const text = `
👁 <b>HIDE / UNHIDE CATEGORIES</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Click a category to toggle its public visibility on the website:</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    if (messageId) return await editTelegramMessage(chatId, messageId, text, buttons);
    return await sendTelegramMessage(text, chatId, buttons);
  }

  if (data.startsWith('cat_toggleexec_')) {
    const catId = data.replace('cat_toggleexec_', '');
    const cat = db.categories.find(c => c.id === catId);
    if (!cat) return await answerCallbackQuery(queryId, 'Category not found!', true);

    const oldStatus = cat.isActive !== false;
    cat.isActive = !oldStatus;
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'TOGGLE_CATEGORY_VISIBILITY',
      targetId: catId,
      before: { isActive: oldStatus },
      after: { isActive: cat.isActive },
      reason: `Toggled via Telegram Bot by ${auth.name}`
    });

    await answerCallbackQuery(queryId, `Category is now ${cat.isActive ? 'Active' : 'Hidden'}!`, true);
    return await showCategoriesMenu(chatId, messageId);
  }

  // Product Callbacks
  if (data === 'prod_add') {
    const cats = db.categories.filter(c => c.isActive !== false);
    if (cats.length === 0) {
      return await sendTelegramMessage('⚠️ Please add at least one category first before adding products.', chatId);
    }

    const buttons = cats.map(c => [
      { text: `${c.icon || '📁'} ${c.name}`, callback_data: `prod_cat_sel_${c.id}` }
    ]);
    buttons.push([{ text: '❌ Cancel', callback_data: 'nav_products' }]);

    const text = `
➕ <b>ADD NEW PRODUCT [1/4]</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>Select a Category for the new product:</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    if (messageId) return await editTelegramMessage(chatId, messageId, text, buttons);
    return await sendTelegramMessage(text, chatId, buttons);
  }

  if (data.startsWith('prod_cat_sel_')) {
    const catId = data.replace('prod_cat_sel_', '');
    const cat = db.categories.find(c => c.id === catId);
    sessions.setSession(chatId, { step: 'ADD_PROD_NAME', draft: { categoryId: catId } });

    const text = `
📁 <b>Category:</b> ${cat ? cat.name : catId}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>[2/4] Please type the Product Name</b> (e.g. <code>500 UC Global</code> or <code>100 Diamonds</code>):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();

    if (messageId) return await editTelegramMessage(chatId, messageId, text, [[{ text: '❌ Cancel', callback_data: 'nav_products' }]]);
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_products' }]]);
  }

  if (data === 'prod_price_prompt') {
    sessions.setSession(chatId, { step: 'SEARCH_PROD_PRICE' });
    const text = `
💰 <b>EDIT PRODUCT PRICE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Type the <b>Product ID</b> or <b>Product Name</b> (e.g. <code>p-pubg-60</code> or <code>60 UC</code>):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_products' }]]);
  }

  if (data === 'prod_stock_prompt') {
    sessions.setSession(chatId, { step: 'SEARCH_PROD_STOCK' });
    const text = `
📦 <b>MANAGE PRODUCT STOCK</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Type the <b>Product ID</b> or <b>Product Name</b>:
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_products' }]]);
  }

  if (data === 'prod_toggle_prompt') {
    const prods = db.products.slice(0, 10);
    const buttons = prods.map(p => {
      const statusText = p.isActive !== false ? '👁 Hide' : '👁️‍🗨️ Unhide';
      return [{ text: `${statusText}: ${p.name}`, callback_data: `prod_toggleexec_${p.id}` }];
    });
    buttons.push([{ text: '⬅️ Back to Products', callback_data: 'nav_products' }]);

    const text = `
👁 <b>HIDE / UNHIDE PRODUCTS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Click a product to toggle its public visibility on the website:</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    if (messageId) return await editTelegramMessage(chatId, messageId, text, buttons);
    return await sendTelegramMessage(text, chatId, buttons);
  }

  if (data.startsWith('prod_toggleexec_')) {
    const prodId = data.replace('prod_toggleexec_', '');
    const prod = db.products.find(p => p.id === prodId);
    if (!prod) return await answerCallbackQuery(queryId, 'Product not found!', true);

    const oldStatus = prod.isActive !== false;
    prod.isActive = !oldStatus;
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'TOGGLE_PRODUCT_VISIBILITY',
      targetId: prodId,
      before: { isActive: oldStatus },
      after: { isActive: prod.isActive },
      reason: `Toggled via Telegram Bot by ${auth.name}`
    });

    await answerCallbackQuery(queryId, `Product is now ${prod.isActive ? 'Active' : 'Hidden'}!`, true);
    return await showProductsMenu(chatId, messageId, 0);
  }

  // Admin & Sub-Admin Callbacks (Strictly Master Owner Only)
  if (data === 'adm_add_prompt' || data === 'adm_addsub_prompt') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Access Denied! Only Master Owner (5339688506) can add administrators.', true);
    }
    const role = data === 'adm_addsub_prompt' ? 'SUB_ADMIN' : 'ADMIN';
    sessions.setSession(chatId, { step: 'ADD_ADMIN_EMAIL', role });
    const text = `
👨‍💼 <b>AUTHORIZE NEW ${role}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the <b>Gmail address</b> (e.g. <code>staff@gmail.com</code>), <b>Username</b>, or <b>Numeric Telegram ID</b> (e.g. <code>5339688506</code>):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();
    return await sendTelegramMessage(text, chatId, [[{ text: '❌ Cancel', callback_data: 'nav_admins' }]]);
  }

  if (data === 'adm_revoke_prompt') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Access Denied! Only Master Owner (5339688506) can revoke admin access.', true);
    }
    const admins = db.users.filter(u => u.role === 'ADMIN' || u.role === 'SUB_ADMIN');
    if (admins.length === 0) {
      return await sendTelegramMessage('ℹ️ No custom Admins or Sub-Admins found to revoke.', chatId, [[{ text: '⬅️ Back', callback_data: 'nav_admins' }]]);
    }

    const buttons = admins.map(a => [
      { text: `🚫 Revoke: ${a.name || a.username} (${a.role})`, callback_data: `adm_revokeexec_${a.id}` }
    ]);
    buttons.push([{ text: '⬅️ Back to Admins', callback_data: 'nav_admins' }]);

    const text = `
🚫 <b>REVOKE ADMIN PRIVILEGES</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Select an account to remove administrative access:</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    if (messageId) return await editTelegramMessage(chatId, messageId, text, buttons);
    return await sendTelegramMessage(text, chatId, buttons);
  }

  if (data.startsWith('adm_revokeexec_')) {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Access Denied! Only Master Owner (5339688506) can revoke admin access.', true);
    }
    const adminUserId = data.replace('adm_revokeexec_', '');
    const targetUser = db.users.find(u => u.id === adminUserId);
    if (!targetUser) return await answerCallbackQuery(queryId, 'Admin account not found!', true);

    const oldRole = targetUser.role;
    targetUser.role = 'USER';
    targetUser.updatedAt = new Date().toISOString();
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'REVOKE_ADMIN_ROLE',
      targetId: adminUserId,
      before: { role: oldRole },
      after: { role: 'USER' },
      reason: `Revoked via Telegram Bot by ${auth.name}`
    });

    await answerCallbackQuery(queryId, `Role revoked. ${targetUser.name || targetUser.email} is now USER!`, true);
    return await showAdminsMenu(chatId, messageId);
  }

  // Broadcast Announcement Callbacks (Master Owner Only)
  if (data === 'nav_broadcast') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin access required.', true);
    }
    const recipients = db.users.filter(u => u.telegramChatId);
    const text = `
📢 <b>BROADCAST ANNOUNCEMENT HUB</b> 📢
━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 <b>Connected Telegram Users:</b> <b>${recipients.length}</b>
🌐 <b>Channel:</b> Direct Telegram DMs (Zero Cost)
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Send instant promotional notices, price drops, or service updates to all customers directly to their Telegram inbox!</i>
    `.trim();

    const buttons = [
      [{ text: '✍️ Compose Broadcast Message', callback_data: 'bc_start' }],
      [{ text: '🏠 Back to Main Menu', callback_data: 'nav_main' }]
    ];

    if (messageId) return await editTelegramMessage(chatId, messageId, text, buttons);
    return await sendTelegramMessage(text, chatId, buttons);
  }

  if (data === 'bc_start') {
    if (!auth.isSuperAdmin) {
      return await answerCallbackQuery(queryId, '⛔ Super Admin access required.', true);
    }
    sessions.setSession(chatId, { step: 'AWAITING_BROADCAST_MSG' });
    const text = `
✍️ <b>COMPOSE BROADCAST MESSAGE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Type your announcement message below. It will be delivered immediately to all connected Telegram users.

<i>Example:</i>
<code>🔥 Special Offer! 115 Diamonds now only ৳75! Top-up instantly on freakshowtopup.shop</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim();

    return await sendTelegramMessage(text, chatId, [
      [{ text: '❌ Cancel', callback_data: 'nav_broadcast' }]
    ]);
  }

  // Fallback to main menu
  return await showMainMenu(chatId, messageId, auth);
}

// ==========================================
// 13. CONVERSATIONAL TEXT INPUT ENGINE (STATE MACHINE)
// ==========================================

async function handleTelegramCommand(msg) {
  const chatId = msg.chat ? msg.chat.id : null;
  const fromId = msg.from ? String(msg.from.id) : null;
  const text = (msg.text || '').trim();

  if (!chatId) return;

  const auth = verifyTelegramAdmin(fromId, chatId);

  // 1. Deep-Link Account Linking: /start link_<token>
  if (text.startsWith('/start link_')) {
    const token = text.replace('/start link_', '').trim();
    const linkRes = linkTelegramAccount(token, chatId, msg.from ? msg.from.username : '');
    if (linkRes.success) {
      const u = linkRes.user;
      const wallet = db.wallets.find(w => w.userId === u.id);
      const bal = wallet ? Number(wallet.balance).toFixed(2) : '0.00';
      const msgText = `
🎉 <b>TELEGRAM LINKED SUCCESSFULLY!</b> ✅
━━━━━━━━━━━━━━━━━━━━━━━━━━
Hello <b>${u.name || 'Gamer'}</b>, your Telegram account is now connected to <code>${u.email}</code>.

💰 <b>Wallet Balance:</b> <b>৳${bal} BDT</b>
🔔 <b>Instant Alerts:</b> <b>ENABLED</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>You will now receive automatic order delivery notifications & cash refund alerts right here!</i>
      `.trim();
      await sendTelegramMessage(msgText, chatId);
      return await showUserMenu(chatId, null, u);
    } else {
      return await sendTelegramMessage(`⚠️ <b>Link Failed:</b> ${linkRes.message}`, chatId);
    }
  }

  // 2. Direct 6-Digit Code Linking: /link <code>
  if (text.toLowerCase().startsWith('/link ')) {
    const code = text.split(' ')[1] ? text.split(' ')[1].trim() : '';
    const linkRes = linkTelegramAccount(code, chatId, msg.from ? msg.from.username : '');
    if (linkRes.success) {
      const u = linkRes.user;
      await sendTelegramMessage(`🎉 <b>Success!</b> Linked to <code>${u.email}</code>.`, chatId);
      return await showUserMenu(chatId, null, u);
    } else {
      return await sendTelegramMessage(`⚠️ <b>Link Failed:</b> ${linkRes.message}`, chatId);
    }
  }

  // 3. User Unlink Command: /unlink
  if (text.toLowerCase() === '/unlink') {
    const existingUser = db.users.find(u => u.telegramChatId && (String(u.telegramChatId) === String(chatId) || String(u.telegramChatId) === String(fromId)));
    if (existingUser) {
      unlinkTelegramAccount(existingUser.id);
      return await sendTelegramMessage('👋 Your Telegram account has been disconnected from FREAKSHOW TOP UP.', chatId);
    } else {
      return await sendTelegramMessage('ℹ️ Your Telegram is not currently linked to any account.', chatId);
    }
  }

  // 4. Check Active User Shopping Session (UID Input & Nickname Verification)
  const userShopSession = userShoppingSessions.get(String(chatId));
  if (userShopSession && userShopSession.step === 'AWAITING_UID') {
    const user = db.users.find(u => u.id === userShopSession.userId) || 
                 db.users.find(u => u.telegramChatId && (String(u.telegramChatId) === String(chatId) || String(u.telegramChatId) === String(fromId)));
    
    if (!user) {
      userShoppingSessions.delete(String(chatId));
      return await sendTelegramMessage('⚠️ User account not found. Please reconnect from your website profile.', chatId);
    }

    if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'cancel') {
      userShoppingSessions.delete(String(chatId));
      return await sendTelegramMessage('🚫 <i>Order cancelled.</i>', chatId, [
        [{ text: '« Main Menu', callback_data: 'usr_menu' }]
      ]);
    }

    const inputData = text.trim();
    if (!inputData || inputData.length < 5 || !/^\d+$/.test(inputData)) {
      return await sendTelegramMessage('⚠️ <b>Invalid UID!</b> Please enter a valid numeric Free Fire Player ID (e.g. <code>515215855</code>):', chatId, [
        [{ text: '❌ Cancel Order', callback_data: 'usr_cancel_order' }]
      ]);
    }

    await sendTelegramMessage('⏳ <i>Checking player nickname in real-time...</i>', chatId);
    const nickname = await fetchPlayerNickname(inputData, 'bd');
    const playerName = nickname || 'Verified Player';
    
    const wallet = db.wallets.find(w => w.userId === user.id);
    const balance = wallet ? Number(wallet.balance) : 0;
    const price = Number(userShopSession.sellingPrice);

    if (balance < price) {
      userShoppingSessions.delete(String(chatId));
      const deficit = (price - balance).toFixed(2);
      const insufficientMsg = `
⚠️ <b>INSUFFICIENT WALLET BALANCE!</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 <b>Package:</b> ${userShopSession.productName}
✅ <b>Player Name:</b> <b>${playerName}</b>
🆔 <b>Player UID:</b> <code>${inputData}</code>
💰 <b>Package Price:</b> <b>৳${price.toFixed(2)} BDT</b>
💼 <b>Current Balance:</b> <b>৳${balance.toFixed(2)} BDT</b>
🚨 <b>Deficit:</b> <b>৳${deficit} BDT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Please add funds to your wallet to complete this order.</i>
      `.trim();

      return await sendTelegramMessage(insufficientMsg, chatId, [
        [{ text: '➕ Add Money / Deposit', callback_data: 'usr_deposit' }],
        [{ text: '« Main Menu', callback_data: 'usr_menu' }]
      ]);
    }

    // Balance sufficient - set confirmation step
    const confirmToken = crypto.randomBytes(4).toString('hex');
    userShoppingSessions.set(String(chatId), {
      step: 'AWAITING_CONFIRMATION',
      confirmToken,
      userId: user.id,
      productId: userShopSession.productId,
      productName: userShopSession.productName,
      sellingPrice: price,
      playerUid: inputData,
      playerName: playerName,
      isVoucher: false,
      createdAt: Date.now()
    });

    const remainBal = (balance - price).toFixed(2);
    const confirmMsg = `
🛒 <b>ORDER CONFIRMATION</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 <b>Package:</b> <b>${userShopSession.productName}</b>
✅ <b>Player Name:</b> <b>${playerName}</b>
🆔 <b>Player UID:</b> <code>${inputData}</code>
💰 <b>Total Bill:</b> <b>৳${price.toFixed(2)} BDT</b>
💼 <b>Current Balance:</b> ৳${balance.toFixed(2)}
💼 <b>Balance After Order:</b> <b>৳${remainBal} BDT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Would you like to confirm and pay for this order?</i>
    `.trim();

    return await sendTelegramMessage(confirmMsg, chatId, [
      [{ text: `✅ Confirm & Pay (৳${price})`, callback_data: `usr_pay_${confirmToken}` }],
      [{ text: '❌ Cancel', callback_data: 'usr_cancel_order' }]
    ]);
  }

  // 5. Check Active Admin Broadcast Input
  const adminBcSession = sessions.getSession(chatId);
  if (adminBcSession && adminBcSession.step === 'AWAITING_BROADCAST_MSG') {
    if (!auth.isSuperAdmin) {
      sessions.clearSession(chatId);
      return await sendTelegramMessage('⛔ Super Admin access required.', chatId);
    }
    if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'cancel') {
      sessions.clearSession(chatId);
      return await sendTelegramMessage('🚫 <i>Broadcast announcement cancelled.</i>', chatId, getMainMenuKeyboard());
    }

    sessions.clearSession(chatId);
    await sendTelegramMessage('⏳ <i>Broadcasting message to all connected Telegram users...</i>', chatId);
    const stats = await sendBroadcastToUsers(text);
    const report = `
📢 <b>BROADCAST DELIVERY SUMMARY</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 <b>Total Users:</b> <b>${stats.total}</b>
✅ <b>Delivered Successfully:</b> <b>${stats.successful}</b>
❌ <b>Failed / Blocked:</b> <b>${stats.failed}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Sent by: ${auth.name || 'Master Admin'}</i>
    `.trim();

    return await sendTelegramMessage(report, chatId, [
      [{ text: '📢 Broadcast Hub', callback_data: 'nav_broadcast' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  // 6. If Non-Admin, handle user commands & menu
  if (!auth.isAuthorized) {
    const user = db.users.find(u => u.telegramChatId && (String(u.telegramChatId) === String(chatId) || String(u.telegramChatId) === String(fromId)));
    if (user) {
      const lower = text.toLowerCase();
      if (lower === '/topup' || lower === '/shop' || lower === 'topup' || lower === 'shop') {
        return await showUserGames(chatId, null);
      }
      if (lower === '/deposit' || lower === 'deposit') {
        return await handleUserCallbackQuery(chatId, null, 'usr_deposit', fromId);
      }
      if (lower === '/balance' || lower === 'balance') {
        const wallet = db.wallets.find(w => w.userId === user.id);
        const bal = wallet ? Number(wallet.balance).toFixed(2) : '0.00';
        return await sendTelegramMessage(`💰 <b>Wallet Balance:</b> <b>৳${bal} BDT</b>`, chatId, [
          [{ text: '🎯 Game Top-Up', callback_data: 'usr_games' }, { text: '➕ Deposit', callback_data: 'usr_deposit' }],
          [{ text: '« Main Menu', callback_data: 'usr_menu' }]
        ]);
      }
      if (lower === '/orders' || lower === '/myorders' || lower === 'orders') {
        const orders = db.orders.filter(o => o.userId === user.id).slice(-5).reverse();
        if (orders.length === 0) {
          return await sendTelegramMessage('📦 <i>You have no recent orders.</i>', chatId);
        }
        const orderList = orders.map((o, idx) => {
          const statusIcon = (o.status === 'DONE' || o.status === 'COMPLETED') ? '✅' : (o.status === 'REFUNDED' ? '💰' : '⏳');
          return `${idx + 1}. <b>#${o.id}</b> - ${o.productName || o.productId} (৳${o.sellingPrice})\n   Status: ${statusIcon} <b>${o.status}</b>`;
        }).join('\n\n');
        return await sendTelegramMessage(`📦 <b>YOUR LAST ${orders.length} ORDERS:</b>\n\n${orderList}`, chatId);
      }
      return await showUserMenu(chatId, null, user);
    }
    // Unlinked regular visitor
    return await showUserMenu(chatId, null, null);
  }

  // 5. Super Admin Broadcast Slash Command: /broadcast_users <message>
  if (text.toLowerCase().startsWith('/broadcast_users ') || text.toLowerCase().startsWith('/broadcast_all ')) {
    if (!auth.isSuperAdmin) return await sendTelegramMessage('⛔ Super Admin access required.', chatId);
    const bcText = text.split(' ').slice(1).join(' ').trim();
    if (!bcText) return await sendTelegramMessage('⚠️ Usage: <code>/broadcast_users <message text></code>', chatId);

    await sendTelegramMessage('⏳ <i>Sending broadcast to all connected users...</i>', chatId);
    const stats = await sendBroadcastToUsers(bcText);
    return await sendTelegramMessage(`📢 <b>Broadcast Summary:</b>\n\n👥 <b>Total Users:</b> ${stats.total}\n✅ <b>Delivered:</b> ${stats.successful}\n❌ <b>Failed:</b> ${stats.failed}`, chatId);
  }

  // Global Cancel command
  if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'cancel' || text.toLowerCase().includes('cancel')) {
    sessions.clearSession(chatId);
    return await sendTelegramMessage('🚫 <i>Operation cancelled.</i>', chatId, getMainMenuKeyboard());
  }

  // Direct Slash Commands & Natural Language Quick Buttons
  const lowerText = text.toLowerCase();
  if (lowerText === '/start' || lowerText === '/menu' || lowerText === '/help' || lowerText === 'menu' || lowerText.includes('main menu') || lowerText.includes('dashboard') || lowerText === 'help') {
    sessions.clearSession(chatId);
    return await showMainMenu(chatId, null, auth);
  }
  if (lowerText === '/users' || lowerText === '/user' || lowerText.includes('user') || lowerText.includes('customer')) return await showUsersMenu(chatId);
  if (lowerText === '/balance' || lowerText === '/balances' || lowerText.includes('balance') || lowerText.includes('financial')) return await showBalanceMenu(chatId);
  if (lowerText === '/deposit' || lowerText === '/deposits' || lowerText.includes('deposit')) return await showDepositMenu(chatId);
  if (lowerText === '/referral' || lowerText === '/ref' || lowerText.includes('referral') || lowerText.includes('refer & earn')) return await showReferralMenu(chatId);
  if (lowerText === '/refstats' || lowerText === '/referralstats') return await showReferralMenu(chatId);
  if (lowerText.startsWith('/refrate ') || lowerText.startsWith('/setrate ') || lowerText.startsWith('/setrefrate ')) {
    if (!auth.isSuperAdmin) {
      return await sendTelegramMessage('⛔ Super Admin access required.', chatId);
    }
    const valStr = text.split(' ')[1];
    const rate = parseFloat(valStr);
    if (!isNaN(rate) && rate >= 0.01 && rate <= 100) {
      const oldRate = db.settings.referralCommissionPercent || 2.5;
      db.settings.referralCommissionPercent = Number(rate.toFixed(4));
      db.saveAll();

      recordAuditLog({
        actorId: `tg_${fromId}`,
        action: 'UPDATE_REFERRAL_RATE_TELEGRAM',
        before: { referralCommissionPercent: oldRate },
        after: { referralCommissionPercent: db.settings.referralCommissionPercent },
        reason: `Commission rate changed via /refrate by ${auth.name}`
      });

      return await sendTelegramMessage(`✅ <b>Referral Commission Rate set to: ${db.settings.referralCommissionPercent}%</b>`, chatId, [
        [{ text: '⚙️ Referral Settings', callback_data: 'ref_settings' }, { text: '🎁 Referral Hub', callback_data: 'nav_referral' }]
      ]);
    } else {
      return await sendTelegramMessage('⚠️ Please provide a valid rate between 0.01 and 100 (e.g. <code>/refrate 0.01</code> or <code>/refrate 2.5</code>).', chatId);
    }
  }

  // Super Admin VIP Code Management & Invalidation
  if (lowerText.startsWith('/vipcode ') || lowerText.startsWith('/setvip ') || lowerText === '/vipreset') {
    if (!auth.isSuperAdmin) {
      return await sendTelegramMessage('⛔ Super Admin access required.', chatId);
    }
    let newCode = text.split(' ').slice(1).join(' ').trim();
    if (!newCode) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let gen = 'FSVIP-';
      for (let i = 0; i < 6; i++) gen += chars.charAt(Math.floor(Math.random() * chars.length));
      newCode = gen;
    }

    const newHash = await bcrypt.hash(newCode, 10);
    const oldCode = db.settings.currentVipCode || db.settings.vipAccessCode || 'JOY100LVL';
    db.settings.vipAccessCodeHash = newHash;
    db.settings.currentVipCode = newCode;
    db.settings.vipAccessCode = newCode;
    db.settings.vipCodeVersion = Date.now();

    // Revoke all existing customer VIP sessions
    let revokedCount = 0;
    if (Array.isArray(db.users)) {
      db.users.forEach(u => {
        if (u.isVip || u.vipUnlocked || u.hasVipAccess) {
          u.isVip = false;
          u.vipUnlocked = false;
          u.hasVipAccess = false;
          delete u.vipUnlockedAt;
          delete u.vipCodeVersion;
          revokedCount++;
        }
      });
    }
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'VIP_CODE_ROTATED_TELEGRAM',
      before: { vipCode: oldCode },
      after: { vipCode: newCode, vipCodeVersion: db.settings.vipCodeVersion, revokedSessions: revokedCount },
      reason: `VIP Access Code rotated via Telegram by ${auth.name}. All existing user VIP sessions revoked.`
    });

    const msg = `
👑 <b>VIP ACCESS CODE UPDATED!</b> ⚡
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔑 <b>New VIP Secret Code:</b> <code>${newCode}</code>
🔄 <b>Old VIP Access:</b> <b>REVOKED 🚫 (${revokedCount} sessions)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>All previous VIP passes and user sessions have been invalidated. Customers must now enter this new code to unlock VIP prices!</i>
    `.trim();

    return await sendTelegramMessage(msg, chatId, [
      [{ text: '👑 VIP Management', callback_data: 'nav_vip' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  if (lowerText === '/vip' || lowerText === '/vipcode') {
    if (!auth.isSuperAdmin) {
      return await sendTelegramMessage('⛔ Super Admin access required.', chatId);
    }
    return await showVipMenu(chatId);
  }

  if (lowerText.startsWith('/usdrate ') || lowerText.startsWith('/setusd ')) {
    if (!auth.isSuperAdmin) {
      return await sendTelegramMessage('⛔ Super Admin access required.', chatId);
    }
    const valStr = text.split(' ')[1];
    const rate = parseFloat(valStr);
    if (!isNaN(rate) && rate > 0) {
      const oldRate = db.settings.usdToBdtRate || db.settings.exchangeRate || 120;
      db.settings.usdToBdtRate = Number(rate.toFixed(2));
      db.settings.exchangeRate = Number(rate.toFixed(2));
      db.saveAll();

      recordAuditLog({
        actorId: `tg_${fromId}`,
        action: 'UPDATE_USD_RATE_TELEGRAM',
        before: { usdToBdtRate: oldRate },
        after: { usdToBdtRate: db.settings.usdToBdtRate },
        reason: `USD rate changed via /usdrate by ${auth.name}`
      });

      return await sendTelegramMessage(`✅ <b>USD Exchange Rate set to: $1 USD = ৳${db.settings.usdToBdtRate} BDT</b>`, chatId, [
        [{ text: '⚙️ Settings', callback_data: 'nav_settings' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
      ]);
    } else {
      return await sendTelegramMessage('⚠️ Please provide a valid rate (e.g. <code>/usdrate 120</code> or <code>/usdrate 125</code>).', chatId);
    }
  }

  // Direct Slash Command: /refmin <amount>
  if (lowerText.startsWith('/refmin ') || lowerText.startsWith('/setrefmin ')) {
    if (!auth.isSuperAdmin) return await sendTelegramMessage('⛔ Super Admin access required.', chatId);
    const val = parseFloat(text.split(' ')[1]);
    if (!isNaN(val) && val >= 0) {
      const oldVal = db.settings.minDepositForCommission || 0;
      db.settings.minDepositForCommission = Number(val.toFixed(2));
      db.saveAll();
      recordAuditLog({
        actorId: `tg_${fromId}`,
        action: 'UPDATE_REFERRAL_MIN_DEP_TELEGRAM',
        before: { minDepositForCommission: oldVal },
        after: { minDepositForCommission: db.settings.minDepositForCommission },
        reason: `Min deposit for commission changed via /refmin by ${auth.name}`
      });
      return await sendTelegramMessage(`✅ <b>Min Deposit for Referral Commission set to: ৳${db.settings.minDepositForCommission}</b>`, chatId, [
        [{ text: '⚙️ Referral Settings', callback_data: 'ref_settings' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
      ]);
    } else {
      return await sendTelegramMessage('⚠️ Please provide a valid amount (e.g. <code>/refmin 100</code> or <code>/refmin 0</code>).', chatId);
    }
  }

  // Direct Slash Command: /refcap <amount>
  if (lowerText.startsWith('/refcap ') || lowerText.startsWith('/setrefcap ')) {
    if (!auth.isSuperAdmin) return await sendTelegramMessage('⛔ Super Admin access required.', chatId);
    const val = parseFloat(text.split(' ')[1]);
    if (!isNaN(val) && val >= 0) {
      const oldVal = db.settings.maxCommissionPerDeposit || 0;
      db.settings.maxCommissionPerDeposit = Number(val.toFixed(2));
      db.saveAll();
      recordAuditLog({
        actorId: `tg_${fromId}`,
        action: 'UPDATE_REFERRAL_MAX_CAP_TELEGRAM',
        before: { maxCommissionPerDeposit: oldVal },
        after: { maxCommissionPerDeposit: db.settings.maxCommissionPerDeposit },
        reason: `Max commission cap changed via /refcap by ${auth.name}`
      });
      return await sendTelegramMessage(`✅ <b>Max Commission Cap set to: ${db.settings.maxCommissionPerDeposit > 0 ? '৳' + db.settings.maxCommissionPerDeposit : 'No Limit (৳0)'}</b>`, chatId, [
        [{ text: '⚙️ Referral Settings', callback_data: 'ref_settings' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
      ]);
    } else {
      return await sendTelegramMessage('⚠️ Please provide a valid amount (e.g. <code>/refcap 500</code> or <code>/refcap 0</code>).', chatId);
    }
  }

  // Direct Slash Command: /mindep <amount>
  if (lowerText.startsWith('/mindep ') || lowerText.startsWith('/setmindep ')) {
    if (!auth.isSuperAdmin) return await sendTelegramMessage('⛔ Super Admin access required.', chatId);
    const val = parseFloat(text.split(' ')[1]);
    if (!isNaN(val) && val > 0) {
      const oldBdt = db.settings.minDepositBDT || 25;
      const usdRate = Number(db.settings.usdToBdtRate || db.settings.exchangeRate || 120);
      db.settings.minDepositBDT = Number(val.toFixed(2));
      db.settings.minDepositUSD = Number((val / usdRate).toFixed(2));
      db.saveAll();
      recordAuditLog({
        actorId: `tg_${fromId}`,
        action: 'UPDATE_MIN_DEPOSIT_TELEGRAM',
        before: { minDepositBDT: oldBdt },
        after: { minDepositBDT: db.settings.minDepositBDT, minDepositUSD: db.settings.minDepositUSD },
        reason: `Min deposit changed via /mindep by ${auth.name}`
      });
      return await sendTelegramMessage(`✅ <b>Minimum Deposit set to: ৳${db.settings.minDepositBDT} BDT ($${db.settings.minDepositUSD})</b>`, chatId, [
        [{ text: '⚙️ Settings', callback_data: 'nav_settings' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
      ]);
    } else {
      return await sendTelegramMessage('⚠️ Please provide a valid minimum deposit amount (e.g. <code>/mindep 25</code> or <code>/mindep 50</code>).', chatId);
    }
  }

  // Direct Slash Command: /user <query> or /finduser <query>
  if (lowerText.startsWith('/user ') || lowerText.startsWith('/finduser ') || lowerText.startsWith('/searchuser ')) {
    const query = text.split(' ').slice(1).join(' ').trim().toLowerCase().replace('#', '');
    const user = db.users.find(u => 
      u.id.toLowerCase() === query || 
      (u.email && u.email.toLowerCase() === query) ||
      (u.username && u.username.toLowerCase() === query)
    );
    if (!user) {
      return await sendTelegramMessage(`❌ User not found for: <code>${query}</code>`, chatId, [
        [{ text: '👥 Users Menu', callback_data: 'nav_users' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
      ]);
    }
    return showUserProfileCard(chatId, null, user);
  }

  // Direct Slash Command: /order <query> or /findorder <query>
  if (lowerText.startsWith('/order ') || lowerText.startsWith('/findorder ') || lowerText.startsWith('/searchorder ')) {
    const query = text.split(' ').slice(1).join(' ').trim().toLowerCase().replace('#', '');
    const order = db.orders.find(o => 
      o.id.toLowerCase() === query || 
      (o.playerUid && o.playerUid.toLowerCase() === query) ||
      (o.userEmail && o.userEmail.toLowerCase() === query)
    );
    if (!order) {
      return await sendTelegramMessage(`❌ Order not found for: <code>${query}</code>`, chatId, [
        [{ text: '📋 Orders Hub', callback_data: 'nav_orders' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
      ]);
    }
    const orderText = `
📦 <b>ORDER DETAILS: #${order.id}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 <b>Product:</b> <b>${order.productName || order.productId}</b>
👤 <b>Customer:</b> ${order.userName} (<code>${order.userEmail}</code>)
🆔 <b>Player UID:</b> <code>${order.playerUid || 'N/A'}</code>
💰 <b>Amount:</b> <b>৳${order.sellingPrice} ${order.currency || 'BDT'}</b>
📊 <b>Status:</b> <b>${order.status}</b>
🕒 <b>Created:</b> ${new Date(order.createdAt).toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    const canAction = order.status === 'PROCESSING' || order.status === 'PENDING';
    const actionButtons = canAction ? [
      [
        { text: '✅ Mark Done (Send Email)', callback_data: `ord_markdone_${order.id}` },
        { text: '❌ Cancel & Refund Wallet', callback_data: `ord_cancelrefund_${order.id}` }
      ]
    ] : [];

    return await sendTelegramMessage(orderText, chatId, [
      ...actionButtons,
      [{ text: '📋 Back to Orders', callback_data: 'nav_orders' }]
    ]);
  }

  // Direct Slash Command: /addbalance <user_id_or_email> <amount>
  if (lowerText.startsWith('/addbalance ') || lowerText.startsWith('/givebalance ')) {
    const parts = text.split(' ').slice(1).filter(Boolean);
    if (parts.length < 2) {
      return await sendTelegramMessage('⚠️ Usage: <code>/addbalance <user_id_or_email> <amount></code> (e.g. <code>/addbalance user@gmail.com 500</code>)', chatId);
    }
    const userQuery = parts[0].toLowerCase().replace('#', '');
    const amount = parseFloat(parts[1]);
    if (isNaN(amount) || amount <= 0) {
      return await sendTelegramMessage('⚠️ Please provide a valid positive amount (e.g. <code>500</code>).', chatId);
    }
    const user = db.users.find(u => 
      u.id.toLowerCase() === userQuery || 
      (u.email && u.email.toLowerCase() === userQuery) ||
      (u.username && u.username.toLowerCase() === userQuery)
    );
    if (!user) return await sendTelegramMessage(`❌ User not found for: <code>${userQuery}</code>`, chatId);

    const wallet = db.wallets.find(w => w.userId === user.id);
    const oldBal = wallet ? Number(wallet.balance) : 0;
    const newBal = Number((oldBal + amount).toFixed(2));
    if (wallet) {
      wallet.balance = newBal;
      wallet.updatedAt = new Date().toISOString();
    }
    const ledgerTx = {
      id: `tx_${crypto.randomBytes(8).toString('hex')}`,
      walletId: wallet ? wallet.id : `wal_${user.id}`,
      userId: user.id,
      type: 'MANUAL_ADJUSTMENT',
      amount: amount,
      previousBalance: oldBal,
      newBalance: newBal,
      currency: user.currency || 'BDT',
      status: 'COMPLETED',
      description: `Manual balance credited by Admin ${auth.name} via Telegram (/addbalance)`,
      adminId: `tg_${fromId}`,
      createdAt: new Date().toISOString()
    };
    db.transactions.unshift(ledgerTx);
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'WALLET_BALANCE_ADJUSTED',
      targetId: user.id,
      before: { balance: oldBal },
      after: { balance: newBal, mode: 'ADD', adjustmentAmount: amount },
      reason: `Telegram /addbalance executed by ${auth.name}`
    });

    return await sendTelegramMessage(`
✅ <b>BALANCE CREDITED!</b> 💰
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> ${user.name || user.username} (<code>${user.email}</code>)
💵 <b>Added:</b> +৳${amount.toFixed(2)} BDT
💰 <b>New Wallet Balance:</b> <b>৳${newBal.toFixed(2)} BDT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim(), chatId, [
      [{ text: '👤 View Profile', callback_data: `usr_search_exec_${user.id}` }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  // Direct Slash Command: /announcement <text> or /broadcast <text>
  if (lowerText.startsWith('/announcement ') || lowerText.startsWith('/broadcast ')) {
    if (!auth.isSuperAdmin) return await sendTelegramMessage('⛔ Super Admin access required.', chatId);
    const newAnn = text.split(' ').slice(1).join(' ').trim();
    if (!newAnn) return await sendTelegramMessage('⚠️ Please provide announcement text (e.g. <code>/announcement Welcome to FREAKSHOWTOPUP!</code>)', chatId);
    const oldAnn = db.settings.announcement || '';
    db.settings.announcement = newAnn;
    db.saveAll();
    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'UPDATE_ANNOUNCEMENT_TELEGRAM',
      before: { announcement: oldAnn },
      after: { announcement: newAnn },
      reason: `Announcement updated via /announcement by ${auth.name}`
    });
    return await sendTelegramMessage(`✅ <b>Website Announcement Banner updated:</b>\n<i>"${newAnn}"</i>`, chatId, [
      [{ text: '⚙️ Settings', callback_data: 'nav_settings' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  if (lowerText === '/pending') return await renderPendingDeposits(chatId);
  if (lowerText === '/categories' || lowerText === '/category' || lowerText.includes('categor')) return await showCategoriesMenu(chatId);
  if (lowerText === '/products' || lowerText === '/product' || lowerText.includes('product')) return await showProductsMenu(chatId, null, 0);
  if (lowerText === '/orders' || lowerText === '/order' || lowerText.includes('order')) return await showOrdersMenu(chatId);
  if (lowerText === '/admins' || lowerText === '/admin') return await showAdminsMenu(chatId);
  if (lowerText === '/vip' || lowerText === '/vipcode') return await showVipMenu(chatId);
  if (lowerText === '/stats' || lowerText === '/statistics') return await showStatsMenu(chatId);
  if (lowerText === '/settings' || lowerText === '/setting') return await showSettingsMenu(chatId);

  // Active Session / Multi-step Wizard Handlers
  const session = sessions.getSession(chatId);
  if (!session) {
    // If not in a session and user typed text, show main menu
    if (text.startsWith('/')) {
      return await showMainMenu(chatId, null, auth);
    }
    return;
  }

  // Referral Settings Wizard Steps
  if (session.step === 'SET_REF_RATE') {
    sessions.clearSession(chatId);
    const rate = parseFloat(text);
    if (!isNaN(rate) && rate >= 0.01 && rate <= 100) {
      const oldRate = db.settings.referralCommissionPercent || 2.5;
      db.settings.referralCommissionPercent = Number(rate.toFixed(4));
      db.saveAll();
      recordAuditLog({
        actorId: `tg_${fromId}`,
        action: 'UPDATE_REFERRAL_RATE_TELEGRAM',
        before: { referralCommissionPercent: oldRate },
        after: { referralCommissionPercent: db.settings.referralCommissionPercent },
        reason: `Commission rate changed via wizard by ${auth.name}`
      });
      return await sendTelegramMessage(`✅ <b>Referral Commission Rate set to: ${db.settings.referralCommissionPercent}%</b>`, chatId, [
        [{ text: '⚙️ Referral Settings', callback_data: 'ref_settings' }, { text: '🎁 Referral Hub', callback_data: 'nav_referral' }]
      ]);
    } else {
      return await sendTelegramMessage('⚠️ Please provide a valid rate between 0.01 and 100 (e.g. <code>2.5</code>).', chatId);
    }
  }

  if (session.step === 'SET_REF_MIN_DEP') {
    sessions.clearSession(chatId);
    const val = parseFloat(text);
    if (!isNaN(val) && val >= 0) {
      const oldVal = db.settings.minDepositForCommission || 0;
      db.settings.minDepositForCommission = Number(val.toFixed(2));
      db.saveAll();
      return await sendTelegramMessage(`✅ <b>Min Deposit for Referral Commission set to: ৳${db.settings.minDepositForCommission}</b>`, chatId);
    }
  }

  if (session.step === 'SET_REF_MAX_CAP') {
    sessions.clearSession(chatId);
    const val = parseFloat(text);
    if (!isNaN(val) && val >= 0) {
      const oldVal = db.settings.maxCommissionPerDeposit || 0;
      db.settings.maxCommissionPerDeposit = Number(val.toFixed(2));
      db.saveAll();
      return await sendTelegramMessage(`✅ <b>Max Commission Cap set to: ৳${db.settings.maxCommissionPerDeposit}</b>`, chatId);
    }
  }

  // 1. Search User Step
  if (session.step === 'SEARCH_USER' || session.step === 'SEARCH_USER_BALANCE') {
    sessions.clearSession(chatId);
    const query = text.toLowerCase().replace('#', '').trim();
    const user = db.users.find(u => 
      u.id.toLowerCase() === query || 
      (u.email && u.email.toLowerCase() === query) ||
      (u.username && u.username.toLowerCase() === query)
    );

    if (!user) {
      return await sendTelegramMessage(`❌ User not found for query: <code>${text}</code>`, chatId, [
        [{ text: '🔄 Try Again', callback_data: 'usr_search_prompt' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
      ]);
    }

    if (session.step === 'SEARCH_USER_BALANCE') {
      return await handleTelegramCallbackQuery({
        id: 'direct_call',
        from: msg.from,
        message: { chat: { id: chatId }, message_id: null },
        data: `bal_user_${user.id}`
      });
    }

    return showUserProfileCard(chatId, null, user);
  }

  // 2. Add User Multi-Step Wizard
  if (session.step === 'ADD_USER_NAME') {
    session.draft.name = text;
    session.step = 'ADD_USER_EMAIL';
    sessions.setSession(chatId, session);
    return await sendTelegramMessage(`
👤 <b>Name:</b> ${text}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>[2/4] Please type the Customer's Email / Gmail:</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim(), chatId);
  }

  if (session.step === 'ADD_USER_EMAIL') {
    if (!text.includes('@') || !text.includes('.')) {
      return await sendTelegramMessage('⚠️ Please provide a valid email address (e.g. <code>gamer@gmail.com</code>):', chatId);
    }
    const exists = db.users.find(u => u.email && u.email.toLowerCase() === text.toLowerCase());
    if (exists) {
      return await sendTelegramMessage('⚠️ An account with this email already exists!', chatId);
    }

    session.draft.email = text.toLowerCase().trim();
    session.step = 'ADD_USER_BALANCE';
    sessions.setSession(chatId, session);
    return await sendTelegramMessage(`
✉️ <b>Email:</b> ${session.draft.email}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>[3/4] Initial Wallet Balance (BDT)?</b> (e.g. <code>0</code> or <code>100</code>):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim(), chatId);
  }

  if (session.step === 'ADD_USER_BALANCE') {
    const initBal = parseFloat(text) || 0;
    session.draft.balance = initBal;
    session.step = 'CONFIRM_USER_CREATE';
    sessions.setSession(chatId, session);

    const generatedPassword = `FS${Math.floor(100000 + Math.random() * 900000)}#`;
    session.draft.password = generatedPassword;

    const confirmText = `
✅ <b>CONFIRM NEW USER CREATION [4/4]</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Name:</b> ${session.draft.name}
📧 <b>Email:</b> <code>${session.draft.email}</code>
🔑 <b>Auto-Generated Password:</b> <code>${generatedPassword}</code>
💰 <b>Initial Balance:</b> <b>৳${initBal.toFixed(2)} BDT</b>
🛡️ <b>Role:</b> USER
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Do you want to create this account now?</i>
    `.trim();

    return await sendTelegramMessage(confirmText, chatId, [
      [
        { text: '✅ Confirm & Create', callback_data: 'usr_create_confirm' },
        { text: '❌ Cancel', callback_data: 'nav_users' }
      ]
    ]);
  }

  // 3. Balance Amount Input Execution
  if (session.step === 'BALANCE_AMOUNT_INPUT') {
    const { mode, targetUserId } = session;
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return await sendTelegramMessage('⚠️ Please type a valid positive number (e.g. <code>100</code>):', chatId);
    }

    sessions.clearSession(chatId);
    const user = db.users.find(u => u.id === targetUserId || u.email === targetUserId || (u.username && u.username === targetUserId));
    if (!user) return await sendTelegramMessage('❌ User not found.', chatId);

    const wallet = db.wallets.find(w => w.userId === user.id);
    const oldBal = wallet ? Number(wallet.balance) : 0;
    let newBal = oldBal;

    if (mode === 'ADD') newBal = oldBal + amount;
    else if (mode === 'DEDUCT') newBal = Math.max(0, oldBal - amount);
    else if (mode === 'SET') newBal = amount;

    newBal = Number(newBal.toFixed(2));

    // Update wallet
    if (wallet) {
      wallet.balance = newBal;
      wallet.updatedAt = new Date().toISOString();
    }

    // Ledger record
    const ledgerTx = {
      id: `tx_${crypto.randomBytes(8).toString('hex')}`,
      walletId: wallet ? wallet.id : `wal_${user.id}`,
      userId: user.id,
      type: 'MANUAL_ADJUSTMENT',
      amount: mode === 'DEDUCT' ? -amount : amount,
      previousBalance: oldBal,
      newBalance: newBal,
      currency: user.currency || 'BDT',
      status: 'COMPLETED',
      description: `Manual balance adjustment (${mode}) by Admin ${auth.name} via Telegram`,
      adminId: `tg_${fromId}`,
      createdAt: new Date().toISOString()
    };
    db.transactions.unshift(ledgerTx);
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'WALLET_BALANCE_ADJUSTED',
      targetId: user.id,
      before: { balance: oldBal },
      after: { balance: newBal, mode, adjustmentAmount: amount },
      reason: `Telegram Admin adjustment by ${auth.name}`
    });

    const resultText = `
✅ <b>WALLET BALANCE UPDATED</b> 💰
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> ${user.name || user.username} (<code>${user.email}</code>)
💵 <b>Previous Balance:</b> ৳${oldBal.toFixed(2)}
🔄 <b>Adjustment (${mode}):</b> ${mode === 'DEDUCT' ? '-' : '+'}৳${amount.toFixed(2)}
💰 <b>New Wallet Balance:</b> <b>৳${newBal.toFixed(2)} BDT</b>
🔢 <b>Transaction ID:</b> <code>#${ledgerTx.id}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    return await sendTelegramMessage(resultText, chatId, [
      [{ text: '👤 View User Profile', callback_data: `usr_search_exec_${user.id}` }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  // 4. Edit Payment Number Execution
  if (session.step === 'EDIT_PAYMENT_NUMBER') {
    const { method } = session;
    sessions.clearSession(chatId);

    if (!db.settings.paymentNumbers) db.settings.paymentNumbers = {};
    const oldNum = db.settings.paymentNumbers[method] || 'Not Set';
    db.settings.paymentNumbers[method] = text;
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'UPDATE_PAYMENT_NUMBER',
      before: { method, number: oldNum },
      after: { method, number: text },
      reason: `Updated via Telegram Bot by ${auth.name}`
    });

    const successText = `
✅ <b>${method.toUpperCase()} NUMBER UPDATED</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
New Instruction / Number:
<code>${text}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Customers will now see this updated number during deposit!</i>
    `.trim();

    return await sendTelegramMessage(successText, chatId, [[{ text: '⚙️ Back to Settings', callback_data: 'nav_settings' }]]);
  }

  // 5. Search Order Execution
  if (session.step === 'SEARCH_ORDER') {
    sessions.clearSession(chatId);
    const query = text.toLowerCase().replace('#', '').trim();
    const order = db.orders.find(o => 
      o.id.toLowerCase() === query || 
      (o.playerUid && o.playerUid.toLowerCase() === query) ||
      (o.userEmail && o.userEmail.toLowerCase() === query)
    );

    if (!order) {
      return await sendTelegramMessage(`❌ Order not found for query: <code>${text}</code>`, chatId, [
        [{ text: '🔄 Try Again', callback_data: 'ord_search_prompt' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
      ]);
    }

    const orderText = `
📦 <b>ORDER DETAILS: #${order.id}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 <b>Product:</b> <b>${order.productName || order.productId}</b>
👤 <b>Customer:</b> ${order.userName} (<code>${order.userEmail}</code>)
🆔 <b>Player UID:</b> <code>${order.playerUid || 'N/A'}</code>
💰 <b>Amount:</b> <b>৳${order.sellingPrice} ${order.currency || 'BDT'}</b>
📊 <b>Status:</b> <b>${order.status}</b>
🕒 <b>Created:</b> ${new Date(order.createdAt).toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    const canAction = order.status === 'PROCESSING' || order.status === 'PENDING';
    const actionButtons = canAction ? [
      [
        { text: '✅ Mark Done (Send Email)', callback_data: `ord_markdone_${order.id}` },
        { text: '❌ Cancel & Refund Wallet', callback_data: `ord_cancelrefund_${order.id}` }
      ]
    ] : [];

    return await sendTelegramMessage(orderText, chatId, [
      ...actionButtons,
      [{ text: '📋 Back to Orders', callback_data: 'nav_orders' }]
    ]);
  }

  // 6. Add Admin By Gmail, Username or Telegram ID Execution
  if (session.step === 'ADD_ADMIN_EMAIL') {
    const { role } = session;
    sessions.clearSession(chatId);

    const input = text.trim();
    const cleanInput = input.replace(/^@/, '').toLowerCase();
    const isNumericId = /^\d{6,15}$/.test(input);

    if (isNumericId) {
      // Find user by telegram ID or create admin placeholder
      let user = db.users.find(u => u.telegramId && String(u.telegramId) === input);
      if (!user) {
        user = {
          id: `usr_tg_${input}`,
          email: `tg_${input}@freakshowtopup.shop`,
          username: `tg_admin_${input.slice(-4)}`,
          name: `Telegram Admin ${input.slice(-4)}`,
          telegramId: input,
          passwordHash: '',
          role: role || 'ADMIN',
          country: 'BD',
          currency: 'BDT',
          currencyChangeUsed: false,
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        db.users.push(user);
      } else {
        user.role = role || 'ADMIN';
        user.updatedAt = new Date().toISOString();
      }
      db.saveAll();

      recordAuditLog({
        actorId: `tg_${fromId}`,
        action: 'ASSIGN_ADMIN_ROLE_TELEGRAM',
        targetId: user.id,
        after: { telegramId: input, role: user.role },
        reason: `Authorized as ${user.role} by ${auth.name} via Telegram`
      });

      return await sendTelegramMessage(`
👑 <b>${role} AUTHORIZED VIA TELEGRAM ID</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Telegram User ID:</b> <code>${input}</code>
🛡️ <b>Assigned Role:</b> <b>${user.role}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>This Telegram account now has administrative bot access!</i>
      `.trim(), chatId, [[{ text: '👨‍💼 Admins List', callback_data: 'nav_admins' }]]);
    }

    // Lookup existing user by Email, Username, or User ID
    let user = db.users.find(u => 
      (u.email && u.email.toLowerCase() === cleanInput) ||
      (u.username && u.username.toLowerCase() === cleanInput) ||
      (u.id && u.id.toLowerCase() === cleanInput) ||
      (u.name && u.name.toLowerCase() === cleanInput)
    );

    if (user) {
      const oldRole = user.role;
      user.role = role || 'ADMIN';
      user.updatedAt = new Date().toISOString();
      db.saveAll();

      recordAuditLog({
        actorId: `tg_${fromId}`,
        action: 'ASSIGN_ADMIN_ROLE',
        targetId: user.id,
        before: { role: oldRole },
        after: { role: user.role },
        reason: `Promoted via Telegram Bot by ${auth.name}`
      });

      return await sendTelegramMessage(`
👑 <b>${role} PRIVILEGES GRANTED</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> ${user.name || user.username}
✉️ <b>Email:</b> <code>${user.email}</code>
🛡️ <b>Role:</b> <b>${user.role}</b>
🆔 <b>ID:</b> <code>${user.id}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>User now has ${role} administrative permissions on the website and bot!</i>
      `.trim(), chatId, [[{ text: '👨‍💼 Admins List', callback_data: 'nav_admins' }]]);
    }

    // If not found and input looks like an email, register them in advance
    if (cleanInput.includes('@')) {
      const newUserId = `usr_${Date.now().toString(36)}`;
      const newUser = {
        id: newUserId,
        email: cleanInput,
        username: cleanInput.split('@')[0],
        name: cleanInput.split('@')[0],
        passwordHash: '',
        role: role || 'ADMIN',
        country: 'BD',
        currency: 'BDT',
        currencyChangeUsed: false,
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      db.users.push(newUser);
      db.saveAll();

      return await sendTelegramMessage(`
👑 <b>NEW ${role} REGISTERED</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
✉️ <b>Email:</b> <code>${cleanInput}</code>
🛡️ <b>Role:</b> <b>${role}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>When they login on freakshowtopup.shop with this Gmail, they will have ${role} access!</i>
      `.trim(), chatId, [[{ text: '👨‍💼 Admins List', callback_data: 'nav_admins' }]]);
    }

    return await sendTelegramMessage(`
❌ <b>USER NOT FOUND</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
No account found matching: <code>${input}</code>
<i>Please provide a valid Gmail address, registered Username, or Numeric Telegram ID.</i>
    `.trim(), chatId, [
      [{ text: '🔄 Try Again', callback_data: `adm_add${role === 'SUB_ADMIN' ? 'sub' : ''}_prompt` }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  // 7. Add Category Wizard Steps
  if (session.step === 'ADD_CAT_NAME') {
    session.draft = session.draft || {};
    session.draft.name = text.trim();
    session.step = 'ADD_CAT_ICON';
    sessions.setSession(chatId, session);

    return await sendTelegramMessage(`
📁 <b>Category Name:</b> ${session.draft.name}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>[2/2] Please type an Icon or Emoji</b> (e.g. 🔥, 🎯, 🎮, 💎, 🎬):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim(), chatId);
  }

  if (session.step === 'ADD_CAT_ICON') {
    const icon = text.trim().slice(0, 4) || '📁';
    const catName = session.draft.name;
    sessions.clearSession(chatId);

    const slug = catName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const newCat = {
      id: `cat-${slug || Date.now().toString(36)}`,
      slug: slug || `cat-${Date.now()}`,
      name: catName,
      icon: icon,
      sortOrder: db.categories.length + 1,
      isActive: true,
      subcategories: []
    };

    db.categories.push(newCat);
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'CREATE_CATEGORY',
      targetId: newCat.id,
      after: newCat,
      reason: `Created via Telegram Bot by ${auth.name}`
    });

    const successText = `
✅ <b>CATEGORY CREATED SUCCESSFULLY!</b> 📦
━━━━━━━━━━━━━━━━━━━━━━━━━━
${newCat.icon} <b>Name:</b> ${newCat.name}
🆔 <b>ID:</b> <code>${newCat.id}</code>
🔗 <b>Slug:</b> <code>${newCat.slug}</code>
📊 <b>Status:</b> ✅ Active
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Now live on freakshowtopup.shop!</i>
    `.trim();

    return await sendTelegramMessage(successText, chatId, [
      [{ text: '📦 Category Management', callback_data: 'nav_categories' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  // 8. Add Product Wizard Steps
  if (session.step === 'ADD_PROD_NAME') {
    session.draft = session.draft || {};
    session.draft.name = text.trim();
    session.step = 'ADD_PROD_PRICE';
    sessions.setSession(chatId, session);

    return await sendTelegramMessage(`
🛍 <b>Product Name:</b> ${session.draft.name}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>[3/4] Customer Selling Price (৳ BDT)?</b> (e.g. <code>120</code> or <code>750</code>):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim(), chatId);
  }

  if (session.step === 'ADD_PROD_PRICE') {
    const price = parseFloat(text);
    if (isNaN(price) || price <= 0) {
      return await sendTelegramMessage('⚠️ Please type a valid price in Taka (e.g. <code>150</code>):', chatId);
    }

    session.draft.sellingPrice = price;
    session.step = 'ADD_PROD_COST';
    sessions.setSession(chatId, session);

    return await sendTelegramMessage(`
💵 <b>Selling Price:</b> ৳${price.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>[4/4] Supplier Purchase Cost (৳ BDT)?</b> (e.g. <code>130</code> or <code>0</code> if none):
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim(), chatId);
  }

  if (session.step === 'ADD_PROD_COST') {
    const cost = parseFloat(text) || 0;
    const { name, categoryId, sellingPrice } = session.draft;
    sessions.clearSession(chatId);

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const newProd = {
      id: `p-${slug || Date.now().toString(36)}`,
      categoryId: categoryId || 'cat-others',
      name: name,
      slug: slug || `p-${Date.now()}`,
      icon: 'assets/pubg_uc.jpg',
      sellingPrice: Number(sellingPrice.toFixed(2)),
      supplierCost: Number(cost.toFixed(2)),
      currency: 'BDT',
      productType: 'FIXED',
      sortOrder: db.products.length + 1,
      isActive: true
    };

    db.products.push(newProd);
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'CREATE_PRODUCT',
      targetId: newProd.id,
      after: newProd,
      reason: `Created via Telegram Bot by ${auth.name}`
    });

    const successText = `
✅ <b>PRODUCT ADDED SUCCESSFULLY!</b> 🛍
━━━━━━━━━━━━━━━━━━━━━━━━━━
🛍 <b>Name:</b> ${newProd.name}
🆔 <b>ID:</b> <code>${newProd.id}</code>
💰 <b>Price:</b> <b>৳${newProd.sellingPrice}</b> | Cost: ৳${newProd.supplierCost}
📁 <b>Category:</b> <code>${newProd.categoryId}</code>
📊 <b>Status:</b> ✅ Active
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Now available for customers on freakshowtopup.shop!</i>
    `.trim();

    return await sendTelegramMessage(successText, chatId, [
      [{ text: '🛍 Products Management', callback_data: 'nav_products' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  // 9. Edit Product Price Step
  if (session.step === 'SEARCH_PROD_PRICE') {
    const query = text.toLowerCase().trim();
    const prod = db.products.find(p => p.id.toLowerCase() === query || p.name.toLowerCase().includes(query));

    if (!prod) {
      return await sendTelegramMessage(`❌ Product not found for: <code>${text}</code>`, chatId, [
        [{ text: '🔄 Try Again', callback_data: 'prod_price_prompt' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
      ]);
    }

    session.step = 'EDIT_PROD_PRICE_VAL';
    session.targetProdId = prod.id;
    sessions.setSession(chatId, session);

    return await sendTelegramMessage(`
🛍 <b>Product:</b> ${prod.name}
💰 <b>Current Price:</b> <b>৳${prod.sellingPrice}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Please type the <b>New Selling Price (৳ BDT)</b>:
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Type /cancel to abort.</i>
    `.trim(), chatId);
  }

  if (session.step === 'EDIT_PROD_PRICE_VAL') {
    const newPrice = parseFloat(text);
    if (isNaN(newPrice) || newPrice <= 0) {
      return await sendTelegramMessage('⚠️ Please type a valid price in Taka (e.g. <code>200</code>):', chatId);
    }

    const { targetProdId } = session;
    sessions.clearSession(chatId);

    const prod = db.products.find(p => p.id === targetProdId);
    if (!prod) return await sendTelegramMessage('❌ Product not found.', chatId);

    const oldPrice = prod.sellingPrice;
    prod.sellingPrice = Number(newPrice.toFixed(2));
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'UPDATE_PRODUCT_PRICE',
      targetId: prod.id,
      before: { sellingPrice: oldPrice },
      after: { sellingPrice: prod.sellingPrice },
      reason: `Price updated via Telegram Bot by ${auth.name}`
    });

    return await sendTelegramMessage(`
✅ <b>PRODUCT PRICE UPDATED!</b> 💰
━━━━━━━━━━━━━━━━━━━━━━━━━━
🛍 <b>Product:</b> ${prod.name}
💵 <b>Old Price:</b> ৳${oldPrice}
💰 <b>New Price:</b> <b>৳${prod.sellingPrice} BDT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim(), chatId, [
      [{ text: '🛍 Products Management', callback_data: 'nav_products' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  // 10. Referral Wizard Steps
  if (session.step === 'SET_REF_RATE') {
    const rate = parseFloat(text);
    if (isNaN(rate) || rate < 0.01 || rate > 100) {
      return await sendTelegramMessage('⚠️ Please type a valid commission percentage between 0.01 and 100 (e.g. <code>0.01</code>, <code>0.5</code>, <code>1.5</code>, <code>2.5</code>, <code>5</code>):', chatId);
    }

    sessions.clearSession(chatId);
    const oldRate = db.settings.referralCommissionPercent !== undefined ? db.settings.referralCommissionPercent : 2.5;
    db.settings.referralCommissionPercent = Number(rate.toFixed(4));
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'UPDATE_REFERRAL_RATE_TELEGRAM',
      before: { referralCommissionPercent: oldRate },
      after: { referralCommissionPercent: db.settings.referralCommissionPercent },
      reason: `Commission rate changed to ${db.settings.referralCommissionPercent}% via Telegram Bot by ${auth.name}`
    });

    const successText = `
✅ <b>COMMISSION RATE UPDATED!</b> 🎁
━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Previous Rate:</b> ${oldRate}%
💰 <b>New Commission Rate:</b> <b>${db.settings.referralCommissionPercent}%</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>All qualifying deposits will now calculate commissions at ${db.settings.referralCommissionPercent}%!</i>
    `.trim();

    return await sendTelegramMessage(successText, chatId, [
      [{ text: '⚙️ Referral Settings', callback_data: 'ref_settings' }, { text: '🎁 Referral Hub', callback_data: 'nav_referral' }]
    ]);
  }

  if (session.step === 'SET_REF_MIN_DEP') {
    const minDep = parseFloat(text);
    if (isNaN(minDep) || minDep < 0) {
      return await sendTelegramMessage('⚠️ Please type a valid minimum deposit amount in ৳ (e.g. <code>50</code> or <code>100</code>, 0 for none):', chatId);
    }
    sessions.clearSession(chatId);
    const oldVal = db.settings.minDepositForCommission || 0;
    db.settings.minDepositForCommission = Number(minDep.toFixed(2));
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'UPDATE_REFERRAL_MIN_DEP_TELEGRAM',
      before: { minDepositForCommission: oldVal },
      after: { minDepositForCommission: db.settings.minDepositForCommission },
      reason: `Min deposit for commission changed to ৳${db.settings.minDepositForCommission} by ${auth.name}`
    });

    return await sendTelegramMessage(`✅ <b>Min Deposit for Commission updated: ৳${db.settings.minDepositForCommission}</b>`, chatId, [
      [{ text: '⚙️ Referral Settings', callback_data: 'ref_settings' }, { text: '🎁 Referral Hub', callback_data: 'nav_referral' }]
    ]);
  }

  if (session.step === 'SET_REF_MAX_CAP') {
    const maxCap = parseFloat(text);
    if (isNaN(maxCap) || maxCap < 0) {
      return await sendTelegramMessage('⚠️ Please type a valid maximum commission cap in ৳ (e.g. <code>500</code>, 0 for no cap):', chatId);
    }
    sessions.clearSession(chatId);
    const oldVal = db.settings.maxCommissionPerDeposit || 0;
    db.settings.maxCommissionPerDeposit = Number(maxCap.toFixed(2));
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'UPDATE_REFERRAL_MAX_CAP_TELEGRAM',
      before: { maxCommissionPerDeposit: oldVal },
      after: { maxCommissionPerDeposit: db.settings.maxCommissionPerDeposit },
      reason: `Max commission cap changed to ৳${db.settings.maxCommissionPerDeposit} by ${auth.name}`
    });

    return await sendTelegramMessage(`✅ <b>Max Commission Cap updated: ${db.settings.maxCommissionPerDeposit > 0 ? '৳' + db.settings.maxCommissionPerDeposit : 'No Limit (৳0)'}</b>`, chatId, [
      [{ text: '⚙️ Referral Settings', callback_data: 'ref_settings' }, { text: '🎁 Referral Hub', callback_data: 'nav_referral' }]
    ]);
  }

  // 11. Set USD Exchange Rate Step
  if (session.step === 'SET_USD_RATE') {
    const rate = parseFloat(text);
    if (isNaN(rate) || rate <= 0) {
      return await sendTelegramMessage('⚠️ Please type a valid exchange rate in Taka (e.g. <code>120</code> or <code>125</code>):', chatId);
    }

    sessions.clearSession(chatId);
    const oldRate = db.settings.usdToBdtRate || db.settings.exchangeRate || 120;
    db.settings.usdToBdtRate = Number(rate.toFixed(2));
    db.settings.exchangeRate = Number(rate.toFixed(2));
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'UPDATE_USD_RATE_TELEGRAM',
      before: { usdToBdtRate: oldRate },
      after: { usdToBdtRate: db.settings.usdToBdtRate },
      reason: `USD exchange rate changed to ৳${db.settings.usdToBdtRate} via Telegram Bot by ${auth.name}`
    });

    const successText = `
✅ <b>USD EXCHANGE RATE UPDATED!</b> 💱
━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Previous Rate:</b> $1 USD = ৳${oldRate} BDT
💰 <b>New Rate:</b> <b>$1 USD = ৳${db.settings.usdToBdtRate} BDT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Users depositing USD will now have their wallets credited at $1 = ৳${db.settings.usdToBdtRate} BDT!</i>
    `.trim();

    return await sendTelegramMessage(successText, chatId, [
      [{ text: '⚙️ Platform Settings', callback_data: 'nav_settings' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  // 12. Set Minimum Deposit Step
  if (session.step === 'SET_MIN_DEP') {
    const minVal = parseFloat(text);
    if (isNaN(minVal) || minVal <= 0) {
      return await sendTelegramMessage('⚠️ Please type a valid minimum deposit amount in ৳ (e.g. <code>25</code> or <code>50</code>):', chatId);
    }

    sessions.clearSession(chatId);
    const oldBdt = db.settings.minDepositBDT || 25;
    const usdRate = Number(db.settings.usdToBdtRate || db.settings.exchangeRate || 120);
    db.settings.minDepositBDT = Number(minVal.toFixed(2));
    db.settings.minDepositUSD = Number((minVal / usdRate).toFixed(2));
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'UPDATE_MIN_DEPOSIT_TELEGRAM',
      before: { minDepositBDT: oldBdt },
      after: { minDepositBDT: db.settings.minDepositBDT, minDepositUSD: db.settings.minDepositUSD },
      reason: `Min deposit changed to ৳${db.settings.minDepositBDT} via Telegram by ${auth.name}`
    });

    const successText = `
✅ <b>MINIMUM DEPOSIT UPDATED!</b> 💳
━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 <b>Min Deposit (BDT):</b> <b>৳${db.settings.minDepositBDT}</b>
💵 <b>Min Deposit (USD):</b> <b>$${db.settings.minDepositUSD}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    return await sendTelegramMessage(successText, chatId, [
      [{ text: '⚙️ Platform Settings', callback_data: 'nav_settings' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }

  // 13. Set VIP Code Wizard Step
  if (session.step === 'AWAITING_VIP_CODE') {
    const newCode = text.trim();
    if (!newCode || newCode.length < 4) {
      return await sendTelegramMessage('⚠️ VIP Access Code must be at least 4 characters (e.g. <code>FREAK2026VIP</code>). Please type a valid code (or /cancel):', chatId);
    }

    sessions.clearSession(chatId);
    const oldCode = db.settings.currentVipCode || db.settings.vipAccessCode || 'JOY100LVL';
    const newHash = await bcrypt.hash(newCode, 10);

    db.settings.vipAccessCodeHash = newHash;
    db.settings.currentVipCode = newCode;
    db.settings.vipAccessCode = newCode;
    db.settings.vipCodeVersion = Date.now();

    // Revoke all existing customer VIP sessions
    let revokedCount = 0;
    if (Array.isArray(db.users)) {
      db.users.forEach(u => {
        if (u.isVip || u.vipUnlocked || u.hasVipAccess) {
          u.isVip = false;
          u.vipUnlocked = false;
          u.hasVipAccess = false;
          delete u.vipUnlockedAt;
          delete u.vipCodeVersion;
          revokedCount++;
        }
      });
    }
    db.saveAll();

    recordAuditLog({
      actorId: `tg_${fromId}`,
      action: 'UPDATE_VIP_CODE_TELEGRAM',
      before: { vipCode: oldCode },
      after: { vipCode: newCode, vipCodeVersion: db.settings.vipCodeVersion, revokedSessions: revokedCount },
      reason: `VIP Access Code updated via Telegram Bot by ${auth.name}`
    });

    const successText = `
✅ <b>VIP ACCESS CODE UPDATED!</b> 👑
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔑 <b>New Active VIP Code:</b> <code>${newCode}</code>
🔄 <b>Code Version:</b> <code>${new Date(db.settings.vipCodeVersion).toLocaleString()}</code>
🚫 <b>Revoked Sessions:</b> <b>${revokedCount}</b> customer sessions invalidated
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Customers must now enter <code>${newCode}</code> on the website to access VIP products!</i>
    `.trim();

    return await sendTelegramMessage(successText, chatId, [
      [{ text: '👑 VIP Menu', callback_data: 'nav_vip' }, { text: '🏠 Main Menu', callback_data: 'nav_main' }]
    ]);
  }
}

// ==========================================
// 14. TELEGRAM POLLING & EVENT LOOP
// ==========================================

async function registerBotMenuAndCommands(token) {
  try {
    const commands = [
      { command: 'start', description: '🏠 Admin Dashboard & Main Menu' },
      { command: 'menu', description: '📋 Quick Navigation Menu' },
      { command: 'vip', description: '👑 VIP Access Code Control' },
      { command: 'vipcode', description: '👑 Set VIP Code (/vipcode CODE)' },
      { command: 'referral', description: '🎁 Referral Hub & Settings' },
      { command: 'refrate', description: '💸 Set Referral Commission % (/refrate 2.5)' },
      { command: 'refmin', description: '💳 Set Min Deposit for Commission (/refmin 100)' },
      { command: 'refcap', description: '💰 Set Max Commission Cap (/refcap 500)' },
      { command: 'usdrate', description: '💱 Set 1 USD to BDT Rate (/usdrate 122)' },
      { command: 'mindep', description: '💳 Set Minimum Deposit Amount (/mindep 25)' },
      { command: 'deposits', description: '💳 Approve / Reject Deposits' },
      { command: 'orders', description: '📦 Live Orders Management' },
      { command: 'categories', description: '🗂️ Categories Management' },
      { command: 'products', description: '🛍️ Products & Pricing' },
      { command: 'users', description: '👥 Manage Users & Wallets' },
      { command: 'balances', description: '💰 Live Supplier & Financial Hub' },
      { command: 'settings', description: '⚙️ Payment & Site Settings' },
      { command: 'stats', description: '📊 Live Sales Analytics' },
      { command: 'admins', description: '👑 Admins (Master Owner Only)' },
      { command: 'cancel', description: '❌ Cancel Current Action' },
      { command: 'help', description: 'ℹ️ Command Help Guide' }
    ];

    await sendTelegramRequest('setMyCommands', { commands });
    await sendTelegramRequest('setChatMenuButton', {
      menu_button: { type: 'commands' }
    });
    console.log('🤖 [Telegram Bot] Bot Commands Menu & Persistent Menu Button registered.');
  } catch (e) {
    console.warn('[TELEGRAM MENU REGISTRATION ERROR]', e.message);
  }
}

let isPolling = false;
function startTelegramPolling() {
  const token = process.env.TELEGRAM_BOT_TOKEN || db.settings.telegramBotToken || BOT_TOKEN;
  if (!token || isPolling) return;
  isPolling = true;

  console.log('🤖 [Telegram Bot] Secure Admin Management Engine started.');

  // Register persistent menu button and commands list with Telegram
  registerBotMenuAndCommands(token);

  let offset = 0;
  let isRequestInFlight = false;

  async function poll() {
    if (isRequestInFlight) return;
    isRequestInFlight = true;

    try {
      const customBaseUrl = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org';
      const url = `${customBaseUrl}/bot${token}/getUpdates?offset=${offset}&timeout=15`;
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const httpLib = isHttps ? https : require('http');

      let handled = false;
      const done = (delay) => {
        if (handled) return;
        handled = true;
        isRequestInFlight = false;
        setTimeout(poll, delay);
      };

      const req = httpLib.get(url, { timeout: 25000 }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', async () => {
          try {
            const data = JSON.parse(raw);
            if (data.ok && Array.isArray(data.result)) {
              for (const update of data.result) {
                offset = update.update_id + 1;
                if (update.message) {
                  await handleTelegramCommand(update.message);
                } else if (update.callback_query) {
                  await handleTelegramCallbackQuery(update.callback_query);
                }
              }
            }
          } catch (e) {}
          done(1500);
        });
      });

      req.on('error', () => done(5000));
      req.on('timeout', () => { req.destroy(); done(5000); });
    } catch (err) {
      isRequestInFlight = false;
      setTimeout(poll, 5000);
    }
  }

  poll();
}

// Order & Refund Dispatches
async function sendOrderAlert(order) {
  let playerUid = order.playerUid || 'N/A';
  if (!playerUid && order.playerData) {
    try {
      const p = JSON.parse(order.playerData);
      playerUid = p.uid || p.playerId || 'N/A';
    } catch(e) {}
  }

  const msg = `
⚡ <b>NEW TOP-UP ORDER DISPATCHED</b> ⚡
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Order ID:</b> <code>#${order.id}</code>
🎮 <b>Product:</b> ${order.productName || order.productId}
👤 <b>Player UID:</b> <code>${playerUid}</code>
💵 <b>Amount Paid:</b> ৳${order.sellingPrice} (${order.currency || 'BDT'})
📊 <b>Status:</b> <b>${order.status}</b>
🕒 <b>Time:</b> ${new Date().toLocaleTimeString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>FREAKSHOWTOPUP Automated Engine</i>
  `.trim();

  return sendTelegramMessage(msg);
}

async function sendOrderRefundAlert(order, refundAmount, reason) {
  const msg = `
🚨 <b>ORDER REFUND PROCESSED</b> 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Order ID:</b> <code>#${order.id}</code>
👤 <b>Player UID:</b> <code>${order.playerUid || 'N/A'}</code>
💰 <b>Refunded Amount:</b> ৳${refundAmount} (${order.currency || 'BDT'})
⚠️ <b>Reason:</b> ${reason}
💼 <b>Wallet:</b> Credited 100% back to customer
🕒 <b>Time:</b> ${new Date().toLocaleTimeString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>FREAKSHOWTOPUP Auto-Failover Engine</i>
  `.trim();

  return sendTelegramMessage(msg);
}

// ==========================================
// USER TELEGRAM SHOPPING & INSTANT TOP-UP ENGINE
// ==========================================

const userShoppingSessions = new Map();

async function fetchPlayerNickname(uid, region = 'bd') {
  const apiKey = process.env.FF_NICKNAME_API_KEY || 'tkBAueh5RMhzUgBPvYawX9Eeg1n2gYuh';
  const apiUrl = `https://public.ggwhitehawk.site/nickname?uid=${encodeURIComponent(uid)}&region=${encodeURIComponent(region)}&key=${apiKey}`;

  return new Promise((resolve) => {
    try {
      const https = require('https');
      const req = https.get(apiUrl, { timeout: 7000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.success && (parsed.name || parsed.nickname)) {
              return resolve(parsed.name || parsed.nickname);
            }
          } catch (e) {}
          resolve(null);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch (e) {
      resolve(null);
    }
  });
}

async function showUserMenu(chatId, messageId = null, user = null) {
  const targetUser = user || db.users.find(u => u.telegramChatId && String(u.telegramChatId) === String(chatId));
  const waLink = (db.settings && db.settings.whatsappLink) || 'https://wa.me/8801641625723';
  const siteUrl = 'https://' + (db.settings.domain || 'freakshowtopup.shop');

  if (!targetUser) {
    const welcomeMsg = `
👋 <b>Welcome to FREAKSHOW TOP UP Bot!</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ <i>Instant Automated Free Fire Diamonds, UniPin Vouchers & Gaming Top-Up in Bangladesh & Globally.</i>

🔗 <b>Connect your Account:</b>
Login to our website and click <b>"Connect Telegram"</b> in your profile to enable instant in-bot top-ups & wallet orders!
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    const buttons = [
      [{ text: '🌐 Visit Website', url: siteUrl }, { text: '💬 WhatsApp Support', url: waLink }]
    ];
    if (messageId) return await editTelegramMessage(chatId, messageId, welcomeMsg, buttons);
    return await sendTelegramMessage(welcomeMsg, chatId, buttons);
  }

  const wallet = db.wallets.find(w => w.userId === targetUser.id);
  const balance = wallet ? Number(wallet.balance).toFixed(2) : '0.00';
  const currency = (wallet && wallet.currency) || targetUser.currency || 'BDT';

  const userMsg = `
🎮 <b>FREAKSHOW GAMER DASHBOARD</b> 🎮
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Account:</b> <b>${targetUser.name || 'Gamer'}</b> (<code>${targetUser.email}</code>)
💰 <b>Wallet Balance:</b> <b>৳${balance} ${currency}</b>
🔔 <b>Delivery Alerts:</b> <b>ACTIVE ✅</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Use the buttons below to top-up games, buy vouchers, or check your balance:</i>
  `.trim();

  const buttons = [
    [{ text: '🎯 Game Top-Up', callback_data: 'usr_games' }, { text: '💰 Wallet Balance', callback_data: 'usr_balance' }],
    [{ text: '➕ Add Money / Deposit', callback_data: 'usr_deposit' }, { text: '📦 Order History', callback_data: 'usr_orders' }],
    [{ text: '🌐 Website Shop', url: siteUrl }, { text: '💬 WhatsApp Support', url: waLink }],
    [{ text: '❌ Disconnect Telegram', callback_data: 'usr_unlink' }]
  ];

  if (messageId) return await editTelegramMessage(chatId, messageId, userMsg, buttons);
  return await sendTelegramMessage(userMsg, chatId, buttons);
}

async function showUserGames(chatId, messageId) {
  const categories = [
    { id: 'sub-ff-bd', name: '🔥 Free Fire BD UID' },
    { id: 'sub-vouchers-unipin', name: '🎟️ UniPin Voucher' },
    { id: 'sub-ff-membership', name: '👑 Weekly & Monthly Pass' },
    { id: 'sub-ff-lvl', name: '⭐ Level Up Pass' },
    { id: 'sub-ff-indo', name: '🇮🇩 Indonesia UID' },
    { id: 'sub-ff-likes', name: '👍 Profile Likes' },
    { id: 'sub-vouchers-garena', name: '🎟️ Garena Shells' }
  ];

  const buttons = [];
  for (let i = 0; i < categories.length; i += 2) {
    const row = [{ text: categories[i].name, callback_data: `usr_sub_${categories[i].id}` }];
    if (categories[i + 1]) {
      row.push({ text: categories[i + 1].name, callback_data: `usr_sub_${categories[i + 1].id}` });
    }
    buttons.push(row);
  }
  buttons.push([{ text: '« Back to Menu', callback_data: 'usr_menu' }]);

  const msg = `
🎯 <b>SELECT GAME OR SERVICE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Choose the game or digital voucher category you want to order:</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  if (messageId) return await editTelegramMessage(chatId, messageId, msg, buttons);
  return await sendTelegramMessage(msg, chatId, buttons);
}

async function showUserCategoryPackages(chatId, messageId, subcategoryId) {
  const products = db.products.filter(p => 
    (p.subcategoryId === subcategoryId || p.categoryId === subcategoryId) && 
    p.isActive !== false && 
    !p.isVip
  ).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || Number(a.sellingPrice) - Number(b.sellingPrice));

  if (products.length === 0) {
    const msg = `
⚠️ <b>NO PACKAGES AVAILABLE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>There are currently no active packages in this category.</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();
    return await editTelegramMessage(chatId, messageId, msg, [
      [{ text: '« Back to Games', callback_data: 'usr_games' }]
    ]);
  }

  const buttons = [];
  for (let i = 0; i < products.length; i += 2) {
    const p1 = products[i];
    const label1 = p1.inStock === false ? `❌ ${p1.name} (Stock Out)` : `${p1.name} - ৳${p1.sellingPrice}`;
    const row = [{ text: label1, callback_data: `usr_pkg_${p1.id}` }];
    
    if (products[i + 1]) {
      const p2 = products[i + 1];
      const label2 = p2.inStock === false ? `❌ ${p2.name} (Stock Out)` : `${p2.name} - ৳${p2.sellingPrice}`;
      row.push({ text: label2, callback_data: `usr_pkg_${p2.id}` });
    }
    buttons.push(row);
  }
  buttons.push([{ text: '« Back to Games', callback_data: 'usr_games' }]);

  const msg = `
💎 <b>CHOOSE PACKAGE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Select your desired top-up package with live prices & stock:</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  if (messageId) return await editTelegramMessage(chatId, messageId, msg, buttons);
  return await sendTelegramMessage(msg, chatId, buttons);
}

async function startUserTopUpFlow(chatId, messageId, productId, user) {
  const product = db.products.find(p => p.id === productId);
  if (!product) {
    return await editTelegramMessage(chatId, messageId, '⚠️ Package not found.', [
      [{ text: '« Back to Games', callback_data: 'usr_games' }]
    ]);
  }

  if (product.inStock === false) {
    return await editTelegramMessage(chatId, messageId, `⚠️ <b>${product.name} is currently out of stock!</b>\nPlease choose another package.`, [
      [{ text: '« Back to Games', callback_data: 'usr_games' }]
    ]);
  }

  const isVoucher = product.deliveryType === 'CODE Delivery' || product.productType === 'CODE DELIVERY';

  userShoppingSessions.set(String(chatId), {
    step: isVoucher ? 'AWAITING_CONFIRMATION' : 'AWAITING_UID',
    userId: user.id,
    productId: product.id,
    productName: product.name,
    sellingPrice: Number(product.sellingPrice),
    deliveryType: product.deliveryType,
    subcategoryId: product.subcategoryId,
    isVoucher,
    updatedAt: Date.now()
  });

  if (isVoucher) {
    // For Vouchers, direct instant confirmation card
    const wallet = db.wallets.find(w => w.userId === user.id);
    const balance = wallet ? Number(wallet.balance) : 0;
    const price = Number(product.sellingPrice);

    if (balance < price) {
      userShoppingSessions.delete(String(chatId));
      const deficit = (price - balance).toFixed(2);
      const insufficientMsg = `
⚠️ <b>INSUFFICIENT WALLET BALANCE!</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎟️ <b>Voucher:</b> ${product.name}
💰 <b>Price:</b> <b>৳${price.toFixed(2)} BDT</b>
💼 <b>Your Current Balance:</b> <b>৳${balance.toFixed(2)} BDT</b>
🚨 <b>Deficit:</b> <b>৳${deficit} BDT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Please add funds to your wallet to buy this digital voucher.</i>
      `.trim();

      return await editTelegramMessage(chatId, messageId, insufficientMsg, [
        [{ text: '➕ Add Money / Deposit', callback_data: 'usr_deposit' }],
        [{ text: '« Main Menu', callback_data: 'usr_menu' }]
      ]);
    }

    const confirmToken = crypto.randomBytes(4).toString('hex');
    userShoppingSessions.set(String(chatId), {
      step: 'AWAITING_CONFIRMATION',
      confirmToken,
      userId: user.id,
      productId: product.id,
      productName: product.name,
      sellingPrice: price,
      playerUid: 'DIGITAL_PIN_DELIVERY',
      playerName: 'Voucher Purchase',
      isVoucher: true,
      createdAt: Date.now()
    });

    const remainBal = (balance - price).toFixed(2);
    const confirmMsg = `
🎟️ <b>VOUCHER ORDER CONFIRMATION</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 <b>Package:</b> <b>${product.name}</b>
⚡ <b>Delivery:</b> <b>Digital Voucher PIN (Instant)</b>
💰 <b>Total Bill:</b> <b>৳${price.toFixed(2)} BDT</b>
💼 <b>Current Balance:</b> ৳${balance.toFixed(2)}
💼 <b>Balance After Order:</b> <b>৳${remainBal} BDT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Would you like to confirm and pay for this digital voucher?</i>
    `.trim();

    return await editTelegramMessage(chatId, messageId, confirmMsg, [
      [{ text: `✅ Confirm & Pay (৳${price})`, callback_data: `usr_pay_${confirmToken}` }],
      [{ text: '❌ Cancel', callback_data: 'usr_cancel_order' }]
    ]);
  }

  // For Free Fire UID Top-Up
  const promptText = `
🎮 <b>${product.name}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 <b>Price:</b> <b>৳${product.sellingPrice} BDT</b>
⚡ <b>Delivery:</b> ${product.deliveryType || 'Instant UID Auto'}
━━━━━━━━━━━━━━━━━━━━━━━━━━
✍️ <b>Please enter your Free Fire Player ID (UID):</b>
<i>(Example: 515215855)</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  const buttons = [
    [{ text: '❌ Cancel Order', callback_data: 'usr_cancel_order' }]
  ];

  if (messageId) return await editTelegramMessage(chatId, messageId, promptText, buttons);
  return await sendTelegramMessage(promptText, chatId, buttons);
}

async function handleUserCallbackQuery(chatId, messageId, data, fromId) {
  const user = db.users.find(u => u.telegramChatId && (String(u.telegramChatId) === String(chatId) || String(u.telegramChatId) === String(fromId)));
  const siteUrl = 'https://' + (db.settings.domain || 'freakshowtopup.shop');
  const waLink = (db.settings && db.settings.whatsappLink) || 'https://wa.me/8801641625723';

  if (!user) {
    return await showUserMenu(chatId, messageId, null);
  }

  if (data === 'usr_menu') {
    userShoppingSessions.delete(String(chatId));
    return await showUserMenu(chatId, messageId, user);
  }

  if (data === 'usr_games') {
    userShoppingSessions.delete(String(chatId));
    return await showUserGames(chatId, messageId);
  }

  if (data.startsWith('usr_sub_')) {
    const subId = data.replace('usr_sub_', '').trim();
    return await showUserCategoryPackages(chatId, messageId, subId);
  }

  if (data.startsWith('usr_pkg_')) {
    const prodId = data.replace('usr_pkg_', '').trim();
    return await startUserTopUpFlow(chatId, messageId, prodId, user);
  }

  if (data === 'usr_cancel_order') {
    userShoppingSessions.delete(String(chatId));
    await answerCallbackQuery(messageId, 'Order cancelled.');
    return await showUserMenu(chatId, messageId, user);
  }

  if (data.startsWith('usr_pay_')) {
    const token = data.replace('usr_pay_', '').trim();
    const session = userShoppingSessions.get(String(chatId));

    if (!session || session.step !== 'AWAITING_CONFIRMATION' || session.confirmToken !== token) {
      return await editTelegramMessage(chatId, messageId, '⚠️ This order session has expired or was cancelled. Please start a new order.', [
        [{ text: '🎯 Game Top-Up', callback_data: 'usr_games' }, { text: '« Main Menu', callback_data: 'usr_menu' }]
      ]);
    }

    userShoppingSessions.delete(String(chatId));
    await editTelegramMessage(chatId, messageId, '⏳ <i>Processing order & deducting wallet balance...</i>');

    try {
      const ordersEngine = require('./orders');
      const orderRes = await ordersEngine.createOrder({
        userId: user.id,
        productId: session.productId,
        playerData: { uid: session.playerUid, name: session.playerName },
        quantity: 1,
        ipAddress: 'TELEGRAM_BOT'
      });

      const order = orderRes.order;
      const updatedWallet = db.wallets.find(w => w.userId === user.id);
      const finalBal = updatedWallet ? Number(updatedWallet.balance).toFixed(2) : '0.00';

      const isVoucher = Boolean(order.voucherCode || order.codeDelivered || session.isVoucher);
      const voucherPin = order.voucherCode || order.codeDelivered;

      const receiptMsg = isVoucher ? `
🎉 <b>VOUCHER ORDER COMPLETED!</b> 🎟️
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Order ID:</b> <code>#${order.id}</code>
📦 <b>Product:</b> <b>${order.productName || session.productName}</b>
💰 <b>Amount Paid:</b> <b>৳${order.sellingPrice} BDT</b>
💼 <b>Remaining Balance:</b> <b>৳${finalBal} BDT</b>
📊 <b>Status:</b> <b>COMPLETED ✅</b>
${voucherPin ? `\n🎟️ <b>Voucher Code:</b> <code>${voucherPin}</code>\n🔗 <b>Redeem Link:</b> ${db.settings.voucherRedeemUrl || 'https://shop.garena.my/'}` : '\n⚡ <i>Voucher PIN delivered instantly to your order history!</i>'}
🕒 <b>Time:</b> ${new Date().toLocaleTimeString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>FREAKSHOW TOP UP Digital Deliveries</i>
      `.trim() : `
🎉 <b>ORDER PLACED SUCCESSFULLY!</b> ⚡
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Order ID:</b> <code>#${order.id}</code>
🎮 <b>Product:</b> <b>${order.productName || session.productName}</b>
👤 <b>Player Name:</b> <b>${session.playerName}</b>
🆔 <b>Player UID:</b> <code>${session.playerUid}</code>
💰 <b>Amount Paid:</b> <b>৳${order.sellingPrice} BDT</b>
💼 <b>Remaining Balance:</b> <b>৳${finalBal} BDT</b>
📊 <b>Status:</b> <b>${order.status} ⚡</b>
🕒 <b>Time:</b> ${new Date().toLocaleTimeString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>✅ Diamonds are being delivered instantly to your game account!</i>
      `.trim();

      return await sendTelegramMessage(receiptMsg, chatId, [
        [{ text: '📦 Order History', callback_data: 'usr_orders' }, { text: '🎯 New Order', callback_data: 'usr_games' }],
        [{ text: '« Main Menu', callback_data: 'usr_menu' }]
      ]);
    } catch (err) {
      console.error('[TELEGRAM BOT ORDER ERROR]', err.message);
      const errMsg = `❌ <b>Order Failed:</b> ${err.message}`;
      return await sendTelegramMessage(errMsg, chatId, [
        [{ text: '🎯 Game Top-Up', callback_data: 'usr_games' }, { text: '« Main Menu', callback_data: 'usr_menu' }]
      ]);
    }
  }

  if (data === 'usr_deposit') {
    const minDep = db.settings.minDepositBDT || 25;
    const bkash = db.settings.bkashNumber || '01641625723';
    const nagad = db.settings.nagadNumber || '01641625723';
    const rocket = db.settings.rocketNumber || '01641625723';

    const depositMsg = `
➕ <b>ADD MONEY / DEPOSIT GUIDE</b> 💳
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Send Money to any of our official numbers and submit your TrxID on the website:</i>

📱 <b>bKash:</b> <code>${bkash}</code> (Personal)
📱 <b>Nagad:</b> <code>${nagad}</code> (Personal)
📱 <b>Rocket:</b> <code>${rocket}</code> (Personal)

💵 <b>Minimum Deposit:</b> <b>৳${minDep} BDT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Submit your TrxID on our website for instant balance credit (5-10 mins):</i>
    `.trim();

    return await editTelegramMessage(chatId, messageId, depositMsg, [
      [{ text: '🌐 Deposit on Website', url: `${siteUrl}/#wallet` }],
      [{ text: '« Back to Menu', callback_data: 'usr_menu' }]
    ]);
  }

  if (data === 'usr_balance') {
    const wallet = db.wallets.find(w => w.userId === user.id);
    const bal = wallet ? Number(wallet.balance).toFixed(2) : '0.00';
    const curr = (wallet && wallet.currency) || user.currency || 'BDT';
    const msg = `
💰 <b>MY WALLET BALANCE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> <b>${user.name || 'Gamer'}</b>
💵 <b>Balance:</b> <b>৳${bal} ${curr}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>To add funds to your wallet, tap Deposit below:</i>
    `.trim();

    return await editTelegramMessage(chatId, messageId, msg, [
      [{ text: '➕ Add Money / Deposit', callback_data: 'usr_deposit' }],
      [{ text: '🎯 Game Top-Up', callback_data: 'usr_games' }],
      [{ text: '« Back to Menu', callback_data: 'usr_menu' }]
    ]);
  }

  if (data === 'usr_orders') {
    const orders = db.orders.filter(o => o.userId === user.id).slice(-5).reverse();
    if (orders.length === 0) {
      const msg = `
📦 <b>MY RECENT ORDERS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>You have not placed any orders yet. Visit our shop to top up instantly!</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
      `.trim();
      return await editTelegramMessage(chatId, messageId, msg, [
        [{ text: '🎯 Game Top-Up', callback_data: 'usr_games' }],
        [{ text: '« Back to Menu', callback_data: 'usr_menu' }]
      ]);
    }

    const orderList = orders.map((o, idx) => {
      const statusIcon = (o.status === 'DONE' || o.status === 'COMPLETED') ? '✅' : (o.status === 'REFUNDED' ? '💰' : '⏳');
      return `${idx + 1}. <b>#${o.id}</b> - ${o.productName || o.productId} (৳${o.sellingPrice})\n   Status: ${statusIcon} <b>${o.status}</b>`;
    }).join('\n\n');

    const msg = `
📦 <b>YOUR LAST ${orders.length} ORDERS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
${orderList}
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    return await editTelegramMessage(chatId, messageId, msg, [
      [{ text: '🎯 New Order', callback_data: 'usr_games' }],
      [{ text: '« Back to Menu', callback_data: 'usr_menu' }]
    ]);
  }

  if (data === 'usr_unlink') {
    unlinkTelegramAccount(user.id);
    const msg = `
👋 <b>Telegram Account Unlinked</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Your Telegram account has been disconnected from <code>${user.email}</code>.
You can reconnect anytime from your website profile!
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();
    return await editTelegramMessage(chatId, messageId, msg, [
      [{ text: '🌐 Visit Website', url: siteUrl }]
    ]);
  }
}

async function notifyUserOrder(order) {
  if (!order || !order.userId) return;
  const user = db.users.find(u => u.id === order.userId);
  if (!user || !user.telegramChatId) return;

  const chatId = user.telegramChatId;
  const isDone = (order.status === 'DONE' || order.status === 'COMPLETED');
  const isFailed = (order.status === 'REFUNDED' || order.status === 'FAILED');

  if (isDone) {
    const isVoucher = Boolean(order.voucherCode || order.codeDelivered);
    const msg = `
🎉 <b>TOP-UP ORDER COMPLETED!</b> ⚡
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Order ID:</b> <code>#${order.id}</code>
🎮 <b>Product:</b> <b>${order.productName || order.productId}</b>
💰 <b>Paid:</b> ৳${order.sellingPrice} (${order.currency || 'BDT'})
📊 <b>Status:</b> <b>COMPLETED ✅</b>
${isVoucher ? `🎟️ <b>Voucher Code:</b> <code>${order.voucherCode || order.codeDelivered}</code>\n🔗 <b>Redeem:</b> ${db.settings.voucherRedeemUrl || 'https://shop.garena.my/'}` : `🆔 <b>Player UID:</b> <code>${order.playerUid || 'N/A'}</code>\n✅ <i>${db.settings.uidSuccessMessage || 'Diamonds added to your game account!'}</i>`}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Thank you for choosing FREAKSHOW TOP UP!</i>
    `.trim();
    return await sendTelegramMessage(msg, chatId, [
      [{ text: '🌐 Visit Website', url: 'https://' + (db.settings.domain || 'freakshowtopup.shop') }]
    ]);
  }

  if (isFailed) {
    const msg = `
⚠️ <b>ORDER UPDATE: #${order.id}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 <b>Product:</b> ${order.productName || order.productId}
💰 <b>Refund:</b> <b>100% Refunded to Wallet (৳${order.sellingPrice})</b>
⚠️ <b>Reason:</b> ${order.failureReason || 'Server error / Invalid UID'}
💬 <i>${db.settings.failedRefundMessage || 'Your balance has been refunded safely.'}</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>FREAKSHOW TOP UP Customer Protection</i>
    `.trim();
    return await sendTelegramMessage(msg, chatId);
  }
}

async function notifyUserDeposit(deposit, newBalance) {
  if (!deposit || !deposit.userId) return;
  const user = db.users.find(u => u.id === deposit.userId);
  if (!user || !user.telegramChatId) return;

  const msg = `
💰 <b>DEPOSIT APPROVED!</b> ✅
━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>Deposit ID:</b> <code>#${deposit.id}</code>
💵 <b>Amount Added:</b> <b>৳${deposit.amount} ${deposit.currency || 'BDT'}</b>
💳 <b>Method:</b> ${deposit.method ? deposit.method.toUpperCase() : 'MANUAL'}
💼 <b>New Wallet Balance:</b> <b>৳${Number(newBalance).toFixed(2)}</b>
🕒 <b>Time:</b> ${new Date().toLocaleTimeString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>You can now purchase instant diamonds on our shop!</i>
  `.trim();

  return await sendTelegramMessage(msg, user.telegramChatId, [
    [{ text: '🛍️ Go to Shop', url: 'https://' + (db.settings.domain || 'freakshowtopup.shop') }]
  ]);
}

async function sendBroadcastToUsers(messageText) {
  const formattedText = `
📢 <b>FREAKSHOW OFFICIAL ANNOUNCEMENT</b> 📢
━━━━━━━━━━━━━━━━━━━━━━━━━━
${messageText}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>FREAKSHOW TOP UP (freakshowtopup.shop)</i>
  `.trim();

  const recipients = db.users.filter(u => u.telegramChatId);
  let successful = 0;
  let failed = 0;

  for (const user of recipients) {
    try {
      const res = await sendTelegramMessage(formattedText, user.telegramChatId);
      if (res && res.ok !== false) successful++;
      else failed++;
    } catch (e) {
      failed++;
    }
  }

  return { total: recipients.length, successful, failed };
}

module.exports = {
  sendTelegramMessage,
  editTelegramMessage,
  answerCallbackQuery,
  sendOrderAlert,
  sendDepositAlert,
  sendOrderRefundAlert,
  handleTelegramCommand,
  handleTelegramCallbackQuery,
  startTelegramPolling,
  generateTelegramLinkToken,
  linkTelegramAccount,
  unlinkTelegramAccount,
  notifyUserOrder,
  notifyUserDeposit,
  sendBroadcastToUsers,
  showUserMenu
};

