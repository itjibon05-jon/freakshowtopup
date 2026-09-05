/**
 * FREAKSHOWTOPUP - WEB ADMIN PANEL FRONTEND ENGINE
 * Domain: freakshowtopup.shop
 */

// ==========================================
// 0. MODAL POPUP HELPERS (DEFINED AT TOP)
// ==========================================

function openModal(id) {
  const m = document.getElementById(id);
  if (m) {
    m.classList.add('active');
    m.style.display = 'flex';
  }
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) {
    m.classList.remove('active');
    m.style.display = 'none';
  }
}

function showToast(msg) {
  const toast = document.getElementById('adminToast');
  if (toast) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
}

// ==========================================
// 1. STATE & AUTHENTICATION
// ==========================================

const ADMIN_STATE = {
  token: localStorage.getItem('fs_admin_token') || localStorage.getItem('fs_token') || '',
  user: JSON.parse(localStorage.getItem('fs_admin_user') || localStorage.getItem('fs_user') || 'null'),
  data: {
    stats: {},
    users: [],
    deposits: [],
    orders: [],
    categories: [],
    products: [],
    banners: [],
    settings: {},
    admins: [],
    auditLogs: []
  }
};

async function verifyAdminAuth() {
  if (!ADMIN_STATE.token) {
    openModal('adminAuthModal');
    return false;
  }

  try {
    const res = await fetch('/api/admin/auth/verify', {
      headers: { 'Authorization': `Bearer ${ADMIN_STATE.token}` }
    });
    const data = await res.json();

    if (!res.ok || !data.success || (data.user.role !== 'SUPER_ADMIN' && data.user.role !== 'ADMIN' && data.user.role !== 'SUB_ADMIN')) {
      openModal('adminAuthModal');
      return false;
    }

    ADMIN_STATE.user = data.user;
    localStorage.setItem('fs_admin_user', JSON.stringify(data.user));
    closeModal('adminAuthModal');
    renderAdminHeaderProfile();
    return true;
  } catch (e) {
    showToast('⚠️ Connection error to backend.');
    return true;
  }
}

async function handleInlineAdminLogin(e) {
  if (e) e.preventDefault();
  const email = (document.getElementById('inlineAdminEmail').value || 'it.jibon05@gmail.com').trim();
  const password = document.getElementById('inlineAdminPassword').value || 'Admin123456!';
  const btn = document.getElementById('inlineLoginBtn');

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'Verifying Admin... ⏳';
  }

  try {
    const res = await fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (res.ok && data.success && data.token) {
      ADMIN_STATE.token = data.token;
      ADMIN_STATE.user = data.user;
      localStorage.setItem('fs_admin_token', data.token);
      localStorage.setItem('fs_admin_user', JSON.stringify(data.user));
      localStorage.setItem('fs_token', data.token);
      closeModal('adminAuthModal');
      renderAdminHeaderProfile();
      await loadAllAdminData();
      showToast('🎉 Admin authenticated successfully!');
    } else {
      alert(data.message || 'Access Denied: Invalid credentials');
    }
  } catch (err) {
    alert('Server connection error.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Unlock Admin Portal 🚀';
    }
  }
}

function renderAdminHeaderProfile() {
  const nameEl = document.getElementById('sidebarAdminName');
  const roleEl = document.getElementById('sidebarAdminRole');
  const avatarEl = document.getElementById('adminAvatarLetter');
  const adminsTab = document.getElementById('sidebarAdminsTab');

  if (ADMIN_STATE.user) {
    if (nameEl) nameEl.textContent = ADMIN_STATE.user.name || ADMIN_STATE.user.username;
    if (roleEl) roleEl.textContent = ADMIN_STATE.user.role;
    if (avatarEl) avatarEl.textContent = (ADMIN_STATE.user.name || ADMIN_STATE.user.username || 'J')[0].toUpperCase();

    if (adminsTab) {
      adminsTab.style.display = ADMIN_STATE.user.role === 'SUPER_ADMIN' ? 'flex' : 'none';
    }
  }
}

function handleAdminLogout() {
  localStorage.removeItem('fs_admin_token');
  localStorage.removeItem('fs_admin_user');
  localStorage.removeItem('fs_token');
  window.location.href = '/Admin-login';
}

// ==========================================
// 2. TAB SWITCHING ENGINE
// ==========================================

function switchAdminTab(tabId) {
  // Hide all tabs
  document.querySelectorAll('.tab-view').forEach(t => {
    t.classList.remove('active');
    t.style.display = 'none';
  });

  // Deactivate all sidebar items
  document.querySelectorAll('.sidebar-menu .menu-item').forEach(m => {
    m.classList.remove('active');
  });

  // Show active tab
  const targetTab = document.getElementById(`tab-${tabId}`);
  if (targetTab) {
    targetTab.classList.add('active');
    targetTab.style.display = 'block';
  }

  // Highlight active menu item
  const activeMenu = document.querySelector(`.sidebar-menu .menu-item[data-tab="${tabId}"]`);
  if (activeMenu) {
    activeMenu.classList.add('active');
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });

  // If data not yet loaded or empty, refresh
  if (!ADMIN_STATE.data.users || ADMIN_STATE.data.users.length === 0) {
    loadAllAdminData();
  }
}

// ==========================================
// 3. MASTER DATA LOADER
// ==========================================

async function loadAllAdminData() {
  if (!ADMIN_STATE.token) {
    openModal('adminAuthModal');
    return;
  }

  try {
    const res = await fetch('/api/admin/data/all', {
      headers: { 'Authorization': `Bearer ${ADMIN_STATE.token}` }
    });

    if (res.status === 401 || res.status === 403) {
      openModal('adminAuthModal');
      return;
    }

    const data = await res.json();
    if (data.success) {
      ADMIN_STATE.data = data;
      renderDashboardOverview();
      renderUsersTable();
      renderDepositsTable();
      renderOrdersTable();
      renderCategoriesTable();
      renderProductsTable();
      renderBannersTable();
      populatePaymentSettings();
      populateWebsiteSettings();
      renderAdminsTable();
      renderAuditLogsTable();
      showToast('🔄 Control center synced!');
    }
  } catch (e) {
    console.error('Failed to load admin data:', e);
  }
}

// ==========================================
// 4. TAB RENDERERS
// ==========================================

function renderDashboardOverview() {
  const stats = ADMIN_STATE.data.stats || {};
  
  const salesEl = document.getElementById('dashTodaySales');
  if (salesEl) salesEl.textContent = `৳${(stats.todaySales || 0).toFixed(2)}`;
  
  const ordersEl = document.getElementById('dashTodayOrders');
  if (ordersEl) ordersEl.textContent = `${stats.todayOrdersCount || 0} completed orders today`;
  
  const supplierBal = stats.supplierBalanceLeft !== undefined ? stats.supplierBalanceLeft : 20.00;
  const supBalEl = document.getElementById('dashSupplierBal');
  if (supBalEl) supBalEl.textContent = `৳${supplierBal.toFixed(2)}`;
  
  const supConsEl = document.getElementById('dashSupplierConsumed');
  if (supConsEl) supConsEl.textContent = `Consumed: ৳${(stats.supplierBalanceConsumed || 80.00).toFixed(2)}`;
  
  const headerApiBal = document.getElementById('headerApiBalanceText');
  if (headerApiBal) headerApiBal.textContent = `৳${supplierBal.toFixed(2)}`;
  
  const custBalEl = document.getElementById('dashCustomerTotalBal');
  if (custBalEl) custBalEl.textContent = `৳${(stats.customerTotalBalance || 0).toFixed(2)}`;
  
  const pendingDeps = stats.pendingDepositsCount || (ADMIN_STATE.data.deposits || []).filter(d => d.status === 'PENDING').length;
  const pendDepEl = document.getElementById('dashPendingDeposits');
  if (pendDepEl) pendDepEl.textContent = pendingDeps;
  
  const depBadge = document.getElementById('menuPendingDepositsBadge');
  if (depBadge) {
    depBadge.textContent = pendingDeps;
    depBadge.style.display = pendingDeps > 0 ? 'inline-block' : 'none';
  }

  const pendingOrds = stats.pendingOrdersCount || 0;
  const ordBadge = document.getElementById('menuPendingOrdersBadge');
  if (ordBadge) {
    ordBadge.textContent = pendingOrds;
    ordBadge.style.display = pendingOrds > 0 ? 'inline-block' : 'none';
  }

  const syncEl = document.getElementById('dashLastSyncTime');
  if (syncEl) syncEl.textContent = `Synced ${new Date().toLocaleTimeString()}`;

  // Recent Orders Mini List
  const recentOrders = (ADMIN_STATE.data.orders || []).slice(0, 5);
  const recOrdersBody = document.getElementById('dashRecentOrdersBody');
  if (recOrdersBody) {
    if (recentOrders.length === 0) {
      recOrdersBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 16px;">No orders recorded yet.</td></tr>';
    } else {
      recOrdersBody.innerHTML = recentOrders.map(o => `
        <tr>
          <td><b style="color: var(--brand-cyan);">#${o.id}</b></td>
          <td>${o.productName || 'Diamonds'}</td>
          <td><code>${o.playerUid || 'CODE'}</code></td>
          <td><b>৳${Number(o.sellingPrice || 0).toFixed(2)}</b></td>
          <td><span class="badge ${o.status === 'DONE' ? 'badge-success' : (o.status === 'FAILED' ? 'badge-failed' : 'badge-pending')}">${o.status}</span></td>
        </tr>
      `).join('');
    }
  }

  // Pending Deposits Mini List
  const pendingDeposits = (ADMIN_STATE.data.deposits || []).filter(d => d.status === 'PENDING').slice(0, 5);
  const pendDepBody = document.getElementById('dashPendingDepositsBody');
  if (pendDepBody) {
    if (pendingDeposits.length === 0) {
      pendDepBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 16px;">No pending deposits. All clear!</td></tr>';
    } else {
      pendDepBody.innerHTML = pendingDeposits.map(d => `
        <tr>
          <td>${d.userEmail || d.userId}</td>
          <td><b>${d.paymentMethod}</b></td>
          <td><b style="color: var(--brand-emerald);">৳${Number(d.amount).toFixed(2)}</b></td>
          <td><code>${d.transactionId}</code></td>
          <td>
            <button class="btn btn-success" style="padding: 3px 8px; font-size: 0.72rem;" onclick="approveDeposit('${d.id}')">Approve</button>
          </td>
        </tr>
      `).join('');
    }
  }
}

// ------------------------------------------
// USERS TABLE
// ------------------------------------------
function renderUsersTable(usersList = null) {
  const users = usersList || ADMIN_STATE.data.users || [];
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;

  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">No users found.</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => {
    const isBanned = u.status === 'BANNED';
    const userCurr = u.currency || 'BDT';
    return `
      <tr>
        <td><code>#${u.id}</code></td>
        <td>
          <div style="font-weight: 700; color: #fff;">${u.name || u.username}</div>
          <div style="font-size: 0.75rem; color: var(--text-muted);">${u.email}</div>
          ${u.username ? `<div style="font-size: 0.72rem; color: var(--brand-cyan); font-family: monospace;">@${u.username}</div>` : ''}
        </td>
        <td>
          <span class="badge ${u.role === 'SUPER_ADMIN' ? 'badge-info' : (u.role === 'SUB_ADMIN' ? 'badge-pending' : 'badge-ghost')}">${u.role}</span>
          <span class="badge ${userCurr === 'USD' ? 'badge-info' : 'badge-ghost'}" style="font-size: 0.68rem; margin-top: 3px; display: inline-block;">${userCurr}</span>
        </td>
        <td><b style="color: var(--brand-emerald); font-size: 0.95rem;">৳${Number(u.walletBalance || 0).toFixed(2)}</b></td>
        <td><span class="badge ${isBanned ? 'badge-failed' : 'badge-success'}">${u.status}</span></td>
        <td style="font-size: 0.78rem; color: var(--text-muted);">${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : 'N/A'}</td>
        <td>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button class="btn btn-ghost" style="padding: 4px 8px; font-size: 0.75rem;" onclick="openAdjustBalanceModal('${u.id}', '${escapeJs(u.name || u.email)}', ${u.walletBalance || 0})">💰 Balance</button>
            <button class="btn btn-ghost" style="padding: 4px 8px; font-size: 0.75rem; color: var(--brand-cyan);" onclick="promptChangeUserCurrency('${u.id}', '${escapeJs(u.name || u.email)}', '${userCurr}')" title="Switch User Currency between BDT and USD">
              💱 ${userCurr}
            </button>
            <button class="btn btn-ghost" style="padding: 4px 8px; font-size: 0.75rem; color: ${isBanned ? '#34d399' : '#f87171'};" onclick="toggleBanUser('${u.id}', '${isBanned ? 'ACTIVE' : 'BANNED'}')">
              ${isBanned ? 'Unban' : 'Ban'}
            </button>
            ${ADMIN_STATE.user && ADMIN_STATE.user.role === 'SUPER_ADMIN' && u.role !== 'SUPER_ADMIN' ? `
              <button class="btn btn-danger" style="padding: 4px 8px; font-size: 0.75rem;" onclick="deleteUser('${u.id}')">🗑</button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterUsersList() {
  const query = (document.getElementById('userSearchInput').value || '').toLowerCase().trim();
  const all = ADMIN_STATE.data.users || [];
  if (!query) {
    renderUsersTable(all);
    return;
  }
  const filtered = all.filter(u => 
    (u.name && u.name.toLowerCase().includes(query)) ||
    (u.email && u.email.toLowerCase().includes(query)) ||
    (u.id && u.id.toLowerCase().includes(query)) ||
    (u.username && u.username.toLowerCase().includes(query))
  );
  renderUsersTable(filtered);
}

// ------------------------------------------
// DEPOSITS TABLE
// ------------------------------------------
function renderDepositsTable(depositsList = null) {
  const deposits = depositsList || ADMIN_STATE.data.deposits || [];
  const tbody = document.getElementById('depositsTableBody');
  if (!tbody) return;

  if (deposits.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 30px;">No deposit requests found.</td></tr>';
    return;
  }

  tbody.innerHTML = deposits.map(d => `
    <tr>
      <td><b style="color: var(--brand-cyan);">#${d.id}</b></td>
      <td>
        <div style="font-weight: 700;">${d.userEmail || d.userId}</div>
        <div style="font-size: 0.72rem; color: var(--text-muted);">UID: #${d.userId}</div>
      </td>
      <td><b>${d.paymentMethod}</b></td>
      <td><code>${d.senderNumber || 'N/A'}</code></td>
      <td><b style="color: var(--brand-emerald); font-size: 1rem;">৳${Number(d.amount).toFixed(2)}</b></td>
      <td><code style="background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px;">${d.transactionId}</code></td>
      <td><span class="badge ${d.status === 'APPROVED' ? 'badge-success' : (d.status === 'REJECTED' ? 'badge-failed' : 'badge-pending')}">${d.status}</span></td>
      <td style="font-size: 0.78rem; color: var(--text-muted);">${d.createdAt ? new Date(d.createdAt).toLocaleString() : 'N/A'}</td>
      <td>
        ${d.status === 'PENDING' ? `
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-success" style="padding: 4px 10px; font-size: 0.75rem;" onclick="approveDeposit('${d.id}')">Approve ✅</button>
            <button class="btn btn-danger" style="padding: 4px 10px; font-size: 0.75rem;" onclick="rejectDeposit('${d.id}')">Reject ❌</button>
          </div>
        ` : `<span style="font-size: 0.75rem; color: var(--text-muted);">Completed</span>`}
      </td>
    </tr>
  `).join('');
}

function filterDepositsList() {
  const status = document.getElementById('depositFilterStatus').value;
  const all = ADMIN_STATE.data.deposits || [];
  if (status === 'ALL') {
    renderDepositsTable(all);
  } else {
    renderDepositsTable(all.filter(d => d.status === status));
  }
}

// ------------------------------------------
// ORDERS TABLE
// ------------------------------------------
function renderOrdersTable(ordersList = null) {
  const orders = ordersList || ADMIN_STATE.data.orders || [];
  const tbody = document.getElementById('ordersTableBody');
  if (!tbody) return;

  if (orders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 30px;">No customer orders found.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map(o => `
    <tr>
      <td><b style="color: var(--brand-cyan);">#${o.id}</b></td>
      <td>
        <div style="font-weight: 700;">${o.userName || o.userEmail || o.userId}</div>
        <div style="font-size: 0.72rem; color: var(--text-muted);">${o.userEmail || ''}</div>
      </td>
      <td><b>${o.productName}</b></td>
      <td><code>${o.playerUid || 'CODE_DELIVERY'}</code></td>
      <td><b>৳${Number(o.sellingPrice).toFixed(2)}</b></td>
      <td><span class="badge ${o.status === 'DONE' ? 'badge-success' : (o.status === 'FAILED' ? 'badge-failed' : 'badge-pending')}">${o.status}</span></td>
      <td style="font-size: 0.78rem; color: var(--text-muted);">${o.createdAt ? new Date(o.createdAt).toLocaleString() : 'N/A'}</td>
      <td>
        ${o.status === 'FAILED' ? `
          <button class="btn btn-ghost" style="padding: 4px 8px; font-size: 0.75rem; color: var(--brand-cyan);" onclick="retryOrder('${o.id}')">🔄 Retry</button>
        ` : `<span style="font-size: 0.75rem; color: var(--text-muted);">-</span>`}
      </td>
    </tr>
  `).join('');
}

function filterOrdersList() {
  const query = (document.getElementById('orderSearchInput').value || '').toLowerCase().trim();
  const status = document.getElementById('orderFilterStatus').value;
  let list = ADMIN_STATE.data.orders || [];

  if (status !== 'ALL') {
    list = list.filter(o => o.status === status);
  }
  if (query) {
    list = list.filter(o => 
      (o.id && o.id.toLowerCase().includes(query)) ||
      (o.playerUid && o.playerUid.toLowerCase().includes(query)) ||
      (o.userName && o.userName.toLowerCase().includes(query)) ||
      (o.userEmail && o.userEmail.toLowerCase().includes(query)) ||
      (o.productName && o.productName.toLowerCase().includes(query))
    );
  }
  renderOrdersTable(list);
}

// ------------------------------------------
// CATEGORIES TABLE
// ------------------------------------------
function renderCategoriesTable() {
  const categories = ADMIN_STATE.data.categories || [];
  const tbody = document.getElementById('categoriesTableBody');
  const catSelect = document.getElementById('prodCategory');
  if (!tbody) return;

  if (categories.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">No categories created.</td></tr>';
    return;
  }

  tbody.innerHTML = categories.map(c => `
    <tr>
      <td><b>#${c.sortOrder || 1}</b></td>
      <td><div style="font-weight: 800; color: #fff;">${c.name}</div></td>
      <td><code>${c.slug || c.id}</code></td>
      <td><span class="badge ${c.isActive ? 'badge-success' : 'badge-failed'}">${c.isActive ? 'Active' : 'Hidden'}</span></td>
      <td>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-ghost" style="padding: 4px 8px; font-size: 0.75rem;" onclick="openEditCategoryModal('${c.id}')">✏️ Edit</button>
          <button class="btn btn-danger" style="padding: 4px 8px; font-size: 0.75rem;" onclick="deleteCategory('${c.id}')">🗑</button>
        </div>
      </td>
    </tr>
  `).join('');

  if (catSelect) {
    catSelect.innerHTML = categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }
}

// ------------------------------------------
// PRODUCTS TABLE
// ------------------------------------------
function renderProductsTable() {
  const products = ADMIN_STATE.data.products || [];
  const tbody = document.getElementById('productsTableBody');
  if (!tbody) return;

  if (products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 30px;">No products added.</td></tr>';
    return;
  }

  tbody.innerHTML = products.map(p => {
    const profit = Math.max(0, (p.sellingPrice || 0) - (p.supplierCost || 0));
    const isVipProd = p.isVip || p.subcategoryId === 'sub-ff-vip' || (p.id && p.id.startsWith('p-ff-vip'));
    const vipBadge = isVipProd ? `<span class="badge" style="background: linear-gradient(135deg, rgba(168,85,247,0.25), rgba(236,72,153,0.25)); color: #c084fc; border: 1px solid rgba(192,132,252,0.4); font-weight: 800; margin-left: 6px;">👑 VIP ACCESS</span>` : '';
    const isInStock = p.inStock !== false;
    const stockBadge = isInStock ? '<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); font-weight: 700;">🟢 IN STOCK</span>' : '<span class="badge" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); font-weight: 700;">🔴 STOCK OUT</span>';
    const stockBtn = isInStock
      ? `<button class="btn" style="padding: 4px 8px; font-size: 0.72rem; background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); font-weight: 700;" onclick="toggleProductStock('${p.id}')" title="Quick Stock Out">🔴 Stock Out</button>`
      : `<button class="btn" style="padding: 4px 8px; font-size: 0.72rem; background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35); font-weight: 700;" onclick="toggleProductStock('${p.id}')" title="Quick Stock In">🟢 Stock In</button>`;

    return `
      <tr>
        <td><img src="${p.icon || 'assets/ff_diamond.jpg'}" style="width: 32px; height: 32px; border-radius: 6px; object-fit: cover;" onerror="this.src='assets/ff_diamond.jpg'"></td>
        <td><b style="color: #fff;">${p.name}</b>${vipBadge}</td>
        <td><code>${p.categoryId}${p.subcategoryId ? ` / ${p.subcategoryId}` : ''}</code></td>
        <td><b style="color: var(--brand-cyan);">৳${Number(p.sellingPrice).toFixed(2)}</b></td>
        <td>৳${Number(p.supplierCost).toFixed(2)}</td>
        <td><b style="color: var(--brand-emerald);">+৳${profit.toFixed(2)}</b></td>
        <td><span class="badge badge-info">${p.productType || 'AUTO TOP-UP'}</span></td>
        <td>${stockBadge}</td>
        <td>
          <div style="display: flex; gap: 6px; align-items: center;">
            <button class="btn btn-ghost" style="padding: 4px 8px; font-size: 0.75rem;" onclick="openEditProductModal('${p.id}')">✏️ Edit</button>
            ${stockBtn}
            <button class="btn btn-danger" style="padding: 4px 8px; font-size: 0.75rem;" onclick="deleteProduct('${p.id}')">🗑</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// ------------------------------------------
// BANNERS TABLE
// ------------------------------------------
function renderBannersTable() {
  const banners = ADMIN_STATE.data.banners || [];
  const tbody = document.getElementById('bannersTableBody');
  if (!tbody) return;

  if (banners.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">No promotional banners created.</td></tr>';
    return;
  }

  tbody.innerHTML = banners.map(b => `
    <tr>
      <td><img src="${b.image || 'assets/freefire_special_offer.jpg'}" style="width: 48px; height: 32px; border-radius: 6px; object-fit: cover;" onerror="this.src='assets/freefire_special_offer.jpg'"></td>
      <td>
        <div style="font-weight: 800; color: #fff;">${b.title}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted);">${b.description || ''}</div>
      </td>
      <td>
        <div><b>${b.buttonText || 'Claim Offer'}</b></div>
        <code style="font-size: 0.72rem; color: var(--brand-cyan);">${b.destinationUrl || '#'}</code>
      </td>
      <td><span class="badge badge-info">${b.displayFrequency || 'ONCE_PER_SESSION'}</span></td>
      <td style="font-size: 0.78rem; color: var(--text-muted);">Active</td>
      <td><span class="badge ${b.status === 'ACTIVE' ? 'badge-success' : 'badge-failed'}">${b.status}</span></td>
      <td>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-ghost" style="padding: 4px 8px; font-size: 0.75rem;" onclick="openEditBannerModal('${b.id}')">✏️ Edit</button>
          <button class="btn btn-danger" style="padding: 4px 8px; font-size: 0.75rem;" onclick="deleteBanner('${b.id}')">🗑</button>
        </div>
      </td>
    </tr>
  `).join('');
}

// ------------------------------------------
// PAYMENT SETTINGS & WEBSITE CONFIG
// ------------------------------------------
function populatePaymentSettings() {
  const s = ADMIN_STATE.data.settings || {};
  const p = s.paymentNumbers || {};

  if (document.getElementById('payBkash')) document.getElementById('payBkash').value = p.bkash || '';
  if (document.getElementById('payNagad')) document.getElementById('payNagad').value = p.nagad || '';
  if (document.getElementById('payRocket')) document.getElementById('payRocket').value = p.rocket || '';
  if (document.getElementById('payCellfin')) document.getElementById('payCellfin').value = p.cellfin || '';
  if (document.getElementById('payBinance')) document.getElementById('payBinance').value = p.binance || p.binanceId || '';
  if (document.getElementById('payBinanceId')) document.getElementById('payBinanceId').value = p.binanceId || p.binance || '';
  if (document.getElementById('payBinanceTrc20')) document.getElementById('payBinanceTrc20').value = p.binanceTrc20 || '';
  if (document.getElementById('payBanglaQrUrl')) document.getElementById('payBanglaQrUrl').value = p.bangla_qr || 'assets/bqr.png';
  if (document.getElementById('payMinDepositBDT')) document.getElementById('payMinDepositBDT').value = s.minDepositBDT || 25;
  if (document.getElementById('payMinDepositUSD')) document.getElementById('payMinDepositUSD').value = s.minDepositUSD || 0.20;
  if (document.getElementById('payUsdRate')) document.getElementById('payUsdRate').value = s.usdToBdtRate || s.exchangeRate || 120;
}

function populateWebsiteSettings() {
  const s = ADMIN_STATE.data.settings || {};

  // Branding & Logo
  const logo = s.siteLogo || 'assets/logo.jpg';
  if (document.getElementById('cfgSiteLogo')) document.getElementById('cfgSiteLogo').value = logo;
  if (document.getElementById('cfgLogoPreview')) document.getElementById('cfgLogoPreview').src = logo;
  if (document.getElementById('cfgSiteName')) document.getElementById('cfgSiteName').value = s.siteName || 'FREAKSHOW';
  if (document.getElementById('cfgSiteTagline')) document.getElementById('cfgSiteTagline').value = s.siteTagline || 'FASTEST GAMING HUB';

  // Social & Support
  if (document.getElementById('cfgTelegramLink')) document.getElementById('cfgTelegramLink').value = s.telegramLink || 'https://t.me/freakshowtopup';
  if (document.getElementById('cfgTelegramUsername')) document.getElementById('cfgTelegramUsername').value = s.telegramUsername || 'freakshowtopup';
  if (document.getElementById('cfgWhatsappNumber')) document.getElementById('cfgWhatsappNumber').value = s.whatsappNumber || '+8801641625723';
  if (document.getElementById('cfgWhatsappLink')) document.getElementById('cfgWhatsappLink').value = s.whatsappLink || 'https://wa.me/8801641625723';
  if (document.getElementById('cfgSupportEmail')) document.getElementById('cfgSupportEmail').value = s.supportEmail || s.adminEmail || 'admin.freakshow@gmail.com';

  // Hero Section
  const heroImg = s.heroBannerImage || 'assets/hero_banner.jpg';
  if (document.getElementById('cfgHeroBannerImage')) document.getElementById('cfgHeroBannerImage').value = heroImg;
  if (document.getElementById('cfgHeroBannerPreview')) document.getElementById('cfgHeroBannerPreview').src = heroImg;
  if (document.getElementById('cfgHeroBadge')) document.getElementById('cfgHeroBadge').value = s.heroBadge || '🔥 #1 Game Top-Up Platform';
  if (document.getElementById('cfgHeroTitle')) document.getElementById('cfgHeroTitle').value = s.heroTitle || 'Instant <span>Game Diamonds</span> & VIP Passes';
  if (document.getElementById('cfgHeroDesc')) document.getElementById('cfgHeroDesc').value = s.heroDesc || 'Recharge your Free Fire, PUBG & MLBB accounts in seconds. 100% automated delivery with bKash, Nagad, Rocket, or Wallet Balance.';

  // Hero Side Cards
  if (document.getElementById('cfgHeroSideCard1Image')) document.getElementById('cfgHeroSideCard1Image').value = s.heroSideCard1Image || 'assets/ff_membership_v2.jpg';
  if (document.getElementById('cfgHeroSideCard1Title')) document.getElementById('cfgHeroSideCard1Title').value = s.heroSideCard1Title || 'Weekly & Monthly Pass';
  if (document.getElementById('cfgHeroSideCard1Desc')) document.getElementById('cfgHeroSideCard1Desc').value = s.heroSideCard1Desc || 'Claim up to 2600 Diamonds with maximum savings';
  if (document.getElementById('cfgHeroSideCard2Image')) document.getElementById('cfgHeroSideCard2Image').value = s.heroSideCard2Image || 'assets/ff_levelup.jpg';
  if (document.getElementById('cfgHeroSideCard2Title')) document.getElementById('cfgHeroSideCard2Title').value = s.heroSideCard2Title || 'Level Up Pass (802 💎)';
  if (document.getElementById('cfgHeroSideCard2Desc')) document.getElementById('cfgHeroSideCard2Desc').value = s.heroSideCard2Desc || 'Instant 802 Diamonds upon level progression';

  // Footer Information
  if (document.getElementById('cfgFooterAbout')) document.getElementById('cfgFooterAbout').value = s.footerAbout || 'The most trusted & fastest automated gaming top-up platform in Bangladesh & Globally. Instant Free Fire Diamonds, VIP Passes, and Gaming Vouchers at wholesale rates.';
  if (document.getElementById('cfgFooterCopyright')) document.getElementById('cfgFooterCopyright').value = s.footerCopyright || '© 2026 <strong>FREAKSHOWTOPUP</strong> (<a href="https://freakshowtopup.shop" style="color: var(--brand-cyan);">freakshowtopup.shop</a>). All Rights Reserved.';

  // Voucher & Digital Code Redeem Websites
  if (document.getElementById('cfgVoucherRedeemUrl')) document.getElementById('cfgVoucherRedeemUrl').value = s.voucherRedeemUrl || 'https://shop.garena.my/';
  if (document.getElementById('cfgVoucherRedeemText')) document.getElementById('cfgVoucherRedeemText').value = s.voucherRedeemText || 'Redeem at shop.garena.my';
  if (document.getElementById('cfgShellRedeemUrl')) document.getElementById('cfgShellRedeemUrl').value = s.shellRedeemUrl || 'https://bdgamesbazar.com/';
  if (document.getElementById('cfgShellRedeemText')) document.getElementById('cfgShellRedeemText').value = s.shellRedeemText || 'Redeem at bdgamesbazar.com';

  // Customer Notification & Alert Messages
  if (document.getElementById('cfgFailedRefundMessage')) document.getElementById('cfgFailedRefundMessage').value = s.failedRefundMessage || 'কোনো সমস্যার কারণে অর্ডারটি সম্পন্ন করা যায়নি। আপনার পরিশোধিত টাকা সম্পূর্ণ ওয়ালেট ব্যালেন্সে ইনস্ট্যান্ট ফেরত (Auto-Refund) দেওয়া হয়েছে।';
  if (document.getElementById('cfgUidSuccessMessage')) document.getElementById('cfgUidSuccessMessage').value = s.uidSuccessMessage || 'আপনার ফ্রি ফায়ার একাউন্টে সরাসরি টপ-আপ সফলভাবে সম্পন্ন হয়েছে!';
  if (document.getElementById('cfgOutOfStockMessage')) document.getElementById('cfgOutOfStockMessage').value = s.outOfStockMessage || 'সাময়িকভাবে এই প্যাকেজের স্টক শেষ / সার্ভার আপডেটের কাজ চলছে। খুব দ্রুতই স্টক যোগ করা হবে!';

  // Operational Switches
  if (document.getElementById('cfgSiteStatus')) document.getElementById('cfgSiteStatus').value = s.maintenanceMode ? 'MAINTENANCE' : 'ONLINE';
  if (document.getElementById('cfgAutoTopup')) document.getElementById('cfgAutoTopup').value = s.autoTopupDisabled ? 'DISABLED' : 'ENABLED';
  if (document.getElementById('cfgRegistration')) document.getElementById('cfgRegistration').value = s.registrationDisabled ? 'DISABLED' : 'ENABLED';
  if (document.getElementById('cfgPopupEnabled')) document.getElementById('cfgPopupEnabled').value = s.popupDisabled ? 'DISABLED' : 'ENABLED';
  if (document.getElementById('cfgRecentOrders')) document.getElementById('cfgRecentOrders').value = (s.recentOrdersSectionEnabled !== false) ? 'ENABLED' : 'DISABLED';
  if (document.getElementById('cfgReferralRate')) document.getElementById('cfgReferralRate').value = s.referralCommissionPercent !== undefined ? s.referralCommissionPercent : 2.5;
  if (document.getElementById('cfgAdminChatId')) document.getElementById('cfgAdminChatId').value = s.telegramAdminChatId || '5339688506';
}

// ------------------------------------------
// ADMINS TABLE
// ------------------------------------------
function renderAdminsTable() {
  const users = ADMIN_STATE.data.users || [];
  const admins = users.filter(u => u.role === 'SUPER_ADMIN' || u.role === 'ADMIN' || u.role === 'SUB_ADMIN');
  const tbody = document.getElementById('adminsTableBody');
  if (!tbody) return;

  tbody.innerHTML = admins.map(a => `
    <tr>
      <td><b>${a.name || a.username}</b></td>
      <td><code>${a.email || a.id}</code></td>
      <td><code>${a.telegramId || 'Not linked'}</code></td>
      <td><span class="badge ${a.role === 'SUPER_ADMIN' ? 'badge-info' : 'badge-pending'}">${a.role}</span></td>
      <td><span style="font-size: 0.78rem;">${a.role === 'SUPER_ADMIN' ? '👑 FULL MASTER AUTHORITY' : 'Staff Access'}</span></td>
      <td><span class="badge badge-success">ACTIVE</span></td>
      <td>
        ${a.role !== 'SUPER_ADMIN' && ADMIN_STATE.user && ADMIN_STATE.user.role === 'SUPER_ADMIN' ? `
          <button class="btn btn-danger" style="padding: 4px 8px; font-size: 0.75rem;" onclick="revokeAdminRole('${a.id}')">Revoke</button>
        ` : `<span style="font-size: 0.75rem; color: var(--text-muted);">-</span>`}
      </td>
    </tr>
  `).join('');
}

// ------------------------------------------
// AUDIT LOGS TABLE
// ------------------------------------------
function renderAuditLogsTable() {
  const logs = ADMIN_STATE.data.auditLogs || [];
  const tbody = document.getElementById('auditLogsTableBody');
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">No audit logs recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = logs.slice(0, 50).map(l => `
    <tr>
      <td style="font-size: 0.75rem; color: var(--text-muted);">${new Date(l.timestamp).toLocaleString()}</td>
      <td><code>${l.actorId}</code></td>
      <td><b style="color: var(--brand-cyan);">${l.action}</b></td>
      <td><code>${l.targetId || 'SYSTEM'}</code></td>
      <td style="font-size: 0.8rem;">${l.reason || JSON.stringify(l.after || l.details || {})}</td>
    </tr>
  `).join('');
}

// ==========================================
// 5. CRUD ACTION HANDLERS
// ==========================================

// --- Balance Adjustments ---
function openAdjustBalanceModal(userId, name, bal) {
  document.getElementById('adjUserId').value = userId;
  document.getElementById('adjUserName').value = `${name} (#${userId})`;
  document.getElementById('adjCurrentBal').value = `৳${Number(bal).toFixed(2)}`;
  document.getElementById('adjAmount').value = '';
  document.getElementById('adjReason').value = '';
  openModal('adjustBalanceModal');
}

async function submitAdjustBalance(e) {
  e.preventDefault();
  const userId = document.getElementById('adjUserId').value;
  const type = document.getElementById('adjType').value;
  const amount = parseFloat(document.getElementById('adjAmount').value);
  const reason = document.getElementById('adjReason').value;

  try {
    const res = await fetch('/api/admin/wallet/adjust', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({ userId, type, amount, reason })
    });
    const data = await res.json();
    if (data.success) {
      showToast('💰 Balance adjusted successfully!');
      closeModal('adjustBalanceModal');
      loadAllAdminData();
    } else {
      alert(data.message || 'Failed to adjust balance');
    }
  } catch (err) {
    alert('Server connection error.');
  }
}

// --- User Management ---
function openAddUserModal() {
  document.getElementById('addUserForm').reset();
  openModal('addUserModal');
}

async function submitAddUser(e) {
  e.preventDefault();
  const name = document.getElementById('addUserName').value;
  const email = document.getElementById('addUserEmail').value;
  const password = document.getElementById('addUserPassword').value;
  const initialBalance = parseFloat(document.getElementById('addUserBalance').value) || 0;
  const role = document.getElementById('addUserRole').value;

  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({ name, email, password, initialBalance, role })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✅ User created successfully!');
      closeModal('addUserModal');
      loadAllAdminData();
    } else {
      alert(data.message || 'Failed to create user');
    }
  } catch (err) {
    alert('Server connection error.');
  }
}

async function toggleBanUser(userId, newStatus) {
  if (!confirm(`Change user status to ${newStatus}?`)) return;
  try {
    const res = await fetch(`/api/admin/users/${userId}/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`User status updated to ${newStatus}`);
      loadAllAdminData();
    }
  } catch (e) {}
}

async function deleteUser(userId) {
  if (!confirm('Are you sure you want to delete this user? Historical orders will remain safe.')) return;
  try {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${ADMIN_STATE.token}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast('🗑 User deleted successfully.');
      loadAllAdminData();
    }
  } catch (e) {}
}

async function promptChangeUserCurrency(userId, userName, currentCurrency) {
  const targetCurrency = currentCurrency === 'BDT' ? 'USD' : 'BDT';
  if (!confirm(`Switch currency for user "${userName}" from ${currentCurrency} to ${targetCurrency}?`)) return;
  try {
    const res = await fetch(`/api/admin/users/${userId}/currency`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({ currency: targetCurrency })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ Currency for ${userName} changed to ${targetCurrency}!`);
      loadAllAdminData();
    } else {
      alert(data.message || 'Failed to update user currency');
    }
  } catch (err) {
    alert('Server error when updating user currency.');
  }
}

// --- Deposit Approvals ---
async function approveDeposit(depositId) {
  if (!confirm('Approve this deposit and credit user wallet?')) return;
  try {
    const res = await fetch(`/api/admin/deposits/${depositId}/approve`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ADMIN_STATE.token}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast('✅ Deposit approved & wallet credited!');
      loadAllAdminData();
    } else {
      alert(data.message || 'Failed to approve deposit');
    }
  } catch (e) {
    alert('Server error.');
  }
}

async function rejectDeposit(depositId) {
  const reason = prompt('Enter rejection reason for customer:', 'Invalid transaction ID');
  if (!reason) return;
  try {
    const res = await fetch(`/api/admin/deposits/${depositId}/reject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({ reason })
    });
    const data = await res.json();
    if (data.success) {
      showToast('❌ Deposit marked as rejected.');
      loadAllAdminData();
    }
  } catch (e) {}
}

// --- Categories CRUD ---
function openAddCategoryModal() {
  document.getElementById('categoryModalTitle').textContent = '➕ Add New Category';
  document.getElementById('catEditId').value = '';
  document.getElementById('catName').value = '';
  document.getElementById('catSlug').value = '';
  if (document.getElementById('catPosition')) document.getElementById('catPosition').value = 'BOTTOM';
  document.getElementById('catSortOrder').value = (ADMIN_STATE.data.categories || []).length + 1;
  openModal('categoryModal');
}

function openEditCategoryModal(catId) {
  const cat = (ADMIN_STATE.data.categories || []).find(c => c.id === catId);
  if (!cat) return;
  document.getElementById('categoryModalTitle').textContent = '✏️ Edit Category';
  document.getElementById('catEditId').value = cat.id;
  document.getElementById('catName').value = cat.name;
  document.getElementById('catSlug').value = cat.slug || cat.id;
  if (document.getElementById('catPosition')) document.getElementById('catPosition').value = cat.position || 'BOTTOM';
  document.getElementById('catSortOrder').value = cat.sortOrder || 1;
  document.getElementById('catStatus').value = cat.isActive ? 'ACTIVE' : 'INACTIVE';
  openModal('categoryModal');
}

async function submitCategory(e) {
  e.preventDefault();
  const id = document.getElementById('catEditId').value;
  const name = document.getElementById('catName').value;
  const slug = document.getElementById('catSlug').value || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const position = document.getElementById('catPosition') ? document.getElementById('catPosition').value : 'BOTTOM';
  const sortOrder = parseInt(document.getElementById('catSortOrder').value) || 1;
  const isActive = document.getElementById('catStatus').value === 'ACTIVE';

  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/admin/categories/${id}` : '/api/admin/categories';

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({ name, slug, position, sortOrder, isActive })
    });
    const data = await res.json();
    if (data.success) {
      showToast('🗂️ Category saved successfully!');
      closeModal('categoryModal');
      loadAllAdminData();
    } else {
      alert(data.message || 'Failed to save category');
    }
  } catch (e) {
    alert('Server error.');
  }
}

async function deleteCategory(id) {
  if (!confirm('Are you sure you want to delete this category?')) return;
  try {
    const res = await fetch(`/api/admin/categories/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${ADMIN_STATE.token}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast('🗑 Category deleted.');
      loadAllAdminData();
    }
  } catch (e) {}
}

// --- Products CRUD ---
function calcProfitPreview() {
  const sell = parseFloat(document.getElementById('prodSellingPrice').value) || 0;
  const cost = parseFloat(document.getElementById('prodSupplierCost').value) || 0;
  const profit = Math.max(0, sell - cost);
  document.getElementById('prodProfitPreview').textContent = `৳${profit.toFixed(2)}`;
}

function openAddProductModal() {
  document.getElementById('productModalTitle').textContent = '➕ Add Product / Denomination';
  document.getElementById('prodEditId').value = '';
  document.getElementById('prodName').value = '';
  document.getElementById('prodSellingPrice').value = '';
  document.getElementById('prodSupplierCost').value = '';
  document.getElementById('prodSupplierCode').value = '';
  if (document.getElementById('prodCommand')) document.getElementById('prodCommand').value = '';
  if (document.getElementById('prodInStock')) document.getElementById('prodInStock').value = 'true';
  document.getElementById('prodIcon').value = 'assets/ff_diamond.jpg';
  calcProfitPreview();
  openModal('productModal');
}

function openEditProductModal(prodId) {
  const p = (ADMIN_STATE.data.products || []).find(item => item.id === prodId);
  if (!p) return;
  document.getElementById('productModalTitle').textContent = '✏️ Edit Product';
  document.getElementById('prodEditId').value = p.id;
  document.getElementById('prodName').value = p.name;
  document.getElementById('prodCategory').value = p.categoryId;
  document.getElementById('prodType').value = p.productType || 'FIXED';
  document.getElementById('prodSellingPrice').value = p.sellingPrice;
  document.getElementById('prodSupplierCost').value = p.supplierCost;
  document.getElementById('prodSupplierCode').value = p.providerCode || '';
  
  let autoCmd = p.command;
  if (!autoCmd && p.providerCode) {
    if (p.providerCode === 'like100') autoCmd = 'Klike UID';
    else if (p.providerCode === 'like200') autoCmd = 'Klike200 UID';
    else if (p.providerCode === 'likesub_30_100') autoCmd = 'Klikesub UID 30 100';
    else if (p.providerCode === 'likesub_30_200') autoCmd = 'Klikesub UID 30 200';
    else if (p.providerCode.startsWith('Ktp') || p.providerCode.startsWith('Kbaki') || p.providerCode.startsWith('Klike')) autoCmd = p.providerCode;
    else autoCmd = `Ktp uid ${p.providerCode}`;
  }
  if (document.getElementById('prodCommand')) {
    document.getElementById('prodCommand').value = autoCmd || '';
  }
  if (document.getElementById('prodInStock')) {
    document.getElementById('prodInStock').value = (p.inStock !== false) ? 'true' : 'false';
  }

  document.getElementById('prodIcon').value = p.icon || 'assets/ff_diamond.jpg';
  calcProfitPreview();
  openModal('productModal');
}

async function submitProduct(e) {
  e.preventDefault();
  const id = document.getElementById('prodEditId').value;
  const name = document.getElementById('prodName').value;
  const categoryId = document.getElementById('prodCategory').value;
  const productType = document.getElementById('prodType').value;
  const sellingPrice = parseFloat(document.getElementById('prodSellingPrice').value);
  const supplierCost = parseFloat(document.getElementById('prodSupplierCost').value);
  const providerCode = document.getElementById('prodSupplierCode').value;
  const command = (document.getElementById('prodCommand') ? document.getElementById('prodCommand').value : '').trim();
  const inStock = document.getElementById('prodInStock') ? (document.getElementById('prodInStock').value === 'true') : true;
  const icon = document.getElementById('prodIcon').value;

  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/admin/products/${id}` : '/api/admin/products';

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({ name, categoryId, productType, sellingPrice, supplierCost, providerCode, command, inStock, icon, isActive: true })
    });
    const data = await res.json();
    if (data.success) {
      showToast('🛍️ Product saved successfully!');
      closeModal('productModal');
      loadAllAdminData();
    } else {
      alert(data.message || 'Failed to save product');
    }
  } catch (e) {
    alert('Server error.');
  }
}

async function toggleProductStock(prodId) {
  try {
    const res = await fetch(`/api/admin/products/${encodeURIComponent(prodId)}/toggle-stock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      }
    });
    const data = await res.json();
    if (data.success) {
      const p = (ADMIN_STATE.data.products || []).find(item => item.id === prodId);
      if (p) p.inStock = data.inStock;
      renderProductsTable();
      showToast(data.inStock ? '🟢 Product is now IN STOCK!' : '🔴 Product is now STOCK OUT!');
    } else {
      showToast(data.message || 'Failed to update stock status', 'error');
    }
  } catch (err) {
    showToast('Network error while updating stock status', 'error');
  }
}

async function deleteProduct(id) {
  if (!confirm('Are you sure you want to delete this product?')) return;
  try {
    const res = await fetch(`/api/admin/products/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${ADMIN_STATE.token}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast('🗑 Product deleted.');
      loadAllAdminData();
    }
  } catch (e) {}
}

// --- Banners CRUD ---
function openAddBannerModal() {
  document.getElementById('bannerModalTitle').textContent = '🎨 Add Promotional Banner';
  document.getElementById('banEditId').value = '';
  document.getElementById('banTitle').value = '';
  document.getElementById('banDesc').value = '';
  document.getElementById('banBtnText').value = 'Recharge Now 🚀';
  document.getElementById('banUrl').value = '#freefire-section';
  document.getElementById('banImage').value = 'assets/freefire_special_offer.jpg';
  openModal('bannerModal');
}

function openEditBannerModal(banId) {
  const b = (ADMIN_STATE.data.banners || []).find(item => item.id === banId);
  if (!b) return;
  document.getElementById('bannerModalTitle').textContent = '✏️ Edit Promotional Banner';
  document.getElementById('banEditId').value = b.id;
  document.getElementById('banTitle').value = b.title;
  document.getElementById('banDesc').value = b.description || '';
  document.getElementById('banBtnText').value = b.buttonText || 'Recharge Now 🚀';
  document.getElementById('banUrl').value = b.destinationUrl || '#freefire-section';
  document.getElementById('banImage').value = b.image || 'assets/freefire_special_offer.jpg';
  document.getElementById('banFreq').value = b.displayFrequency || 'ONCE_PER_SESSION';
  document.getElementById('banStatus').value = b.status || 'ACTIVE';
  openModal('bannerModal');
}

async function submitBanner(e) {
  e.preventDefault();
  const id = document.getElementById('banEditId').value;
  const title = document.getElementById('banTitle').value;
  const description = document.getElementById('banDesc').value;
  const buttonText = document.getElementById('banBtnText').value;
  const destinationUrl = document.getElementById('banUrl').value;
  const image = document.getElementById('banImage').value;
  const displayFrequency = document.getElementById('banFreq').value;
  const status = document.getElementById('banStatus').value;

  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/admin/banners/${id}` : '/api/admin/banners';

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({ title, description, buttonText, destinationUrl, image, displayFrequency, status })
    });
    const data = await res.json();
    if (data.success) {
      showToast('🎨 Banner saved successfully!');
      closeModal('bannerModal');
      loadAllAdminData();
    } else {
      alert(data.message || 'Failed to save banner');
    }
  } catch (e) {
    alert('Server error.');
  }
}

async function deleteBanner(id) {
  if (!confirm('Are you sure you want to delete this promotional banner?')) return;
  try {
    const res = await fetch(`/api/admin/banners/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${ADMIN_STATE.token}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast('🗑 Banner deleted.');
      loadAllAdminData();
    }
  } catch (e) {}
}

// --- Payment & Website Settings Savers ---
async function savePaymentSettings() {
  const bkash = (document.getElementById('payBkash') ? document.getElementById('payBkash').value : '').trim();
  const nagad = (document.getElementById('payNagad') ? document.getElementById('payNagad').value : '').trim();
  const rocket = (document.getElementById('payRocket') ? document.getElementById('payRocket').value : '').trim();
  const cellfin = (document.getElementById('payCellfin') ? document.getElementById('payCellfin').value : '').trim();
  const binanceId = (document.getElementById('payBinanceId') ? document.getElementById('payBinanceId').value : '').trim();
  const binanceTrc20 = (document.getElementById('payBinanceTrc20') ? document.getElementById('payBinanceTrc20').value : '').trim();
  const binance = binanceId || (document.getElementById('payBinance') ? document.getElementById('payBinance').value : '');
  const bangla_qr = (document.getElementById('payBanglaQrUrl') ? document.getElementById('payBanglaQrUrl').value : '').trim() || 'assets/bqr.png';
  const minDepositBDT = parseFloat(document.getElementById('payMinDepositBDT') ? document.getElementById('payMinDepositBDT').value : 25) || 25;
  const minDepositUSD = parseFloat(document.getElementById('payMinDepositUSD') ? document.getElementById('payMinDepositUSD').value : 0.20) || 0.20;
  const usdToBdtRate = parseFloat(document.getElementById('payUsdRate') ? document.getElementById('payUsdRate').value : 120) || 120;

  const paymentMethodStatus = {
    bkash: document.getElementById('payStatusBkash') ? document.getElementById('payStatusBkash').value === 'ENABLED' : true,
    nagad: document.getElementById('payStatusNagad') ? document.getElementById('payStatusNagad').value === 'ENABLED' : true,
    rocket: document.getElementById('payStatusRocket') ? document.getElementById('payStatusRocket').value === 'ENABLED' : true,
    cellfin: document.getElementById('payStatusCellfin') ? document.getElementById('payStatusCellfin').value === 'ENABLED' : true,
    binance: document.getElementById('payStatusBinance') ? document.getElementById('payStatusBinance').value === 'ENABLED' : true,
    bangla_qr: document.getElementById('payStatusBanglaQr') ? document.getElementById('payStatusBanglaQr').value === 'ENABLED' : true
  };

  try {
    const res = await fetch('/api/admin/payment-settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({
        paymentNumbers: { bkash, nagad, rocket, cellfin, binance, binanceId, binanceTrc20, bangla_qr },
        paymentMethodStatus,
        minDepositBDT,
        minDepositUSD,
        usdToBdtRate,
        exchangeRate: usdToBdtRate
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast('💾 Payment settings saved!');
      loadAllAdminData();
    }
  } catch (e) {
    alert('Failed to save payment settings');
  }
}

const DEFAULT_PAYMENT_INSTRUCTIONS = `📝 টাকা পাঠানোর নিয়মাবলী:
১. *247# (বা *167#) ডায়াল করে বা অ্যাপ ওপেন করুন।
২. Send Money অপশন সিলেক্ট করুন।
৩. উপরের নম্বরে টাকা পাঠান।
৪. টাকার পরিমাণ দিন (মিনিমাম ২৫ ৳)।
৫. আপনার PIN দিয়ে কনফার্ম করুন।
৬. সফল হলে ফিরতি SMS-এর Transaction ID (TrxID) কপি করুন।
৭. TrxID ঘরে বসিয়ে ভেরিফাই ➔ বাটনে চাপুন।`;

function openPaymentInstructionsModal(method, methodLabel) {
  const instructionsMap = (ADMIN_STATE.data.settings && ADMIN_STATE.data.settings.paymentInstructions) || {};
  const currentText = instructionsMap[method] || DEFAULT_PAYMENT_INSTRUCTIONS;

  document.getElementById('payInstructMethod').value = method;
  document.getElementById('payInstructMethodLabel').value = `${methodLabel} (${method.toUpperCase()})`;
  document.getElementById('payInstructModalTitle').textContent = `📝 Edit ${methodLabel} Payment Instructions`;
  document.getElementById('payInstructText').value = currentText;

  openModal('paymentInstructionsModal');
}

function resetPaymentInstructionsDefault() {
  document.getElementById('payInstructText').value = DEFAULT_PAYMENT_INSTRUCTIONS;
}

async function submitPaymentInstructions(e) {
  e.preventDefault();
  const method = document.getElementById('payInstructMethod').value;
  const text = document.getElementById('payInstructText').value.trim();

  if (!method || !text) return;

  try {
    const res = await fetch('/api/admin/payment-settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({
        paymentInstructions: {
          [method]: text
        }
      })
    });
    const data = await res.json();
    if (data.success) {
      if (!ADMIN_STATE.data.settings) ADMIN_STATE.data.settings = {};
      if (!ADMIN_STATE.data.settings.paymentInstructions) ADMIN_STATE.data.settings.paymentInstructions = {};
      ADMIN_STATE.data.settings.paymentInstructions[method] = text;

      closeModal('paymentInstructionsModal');
      showToast(`💾 ${method.toUpperCase()} instructions saved!`);
    } else {
      alert('Failed to save payment instructions: ' + (data.message || 'Error'));
    }
  } catch (err) {
    alert('Server error saving payment instructions');
  }
}

async function savePlatformSettings() {
  const siteLogo = (document.getElementById('cfgSiteLogo') ? document.getElementById('cfgSiteLogo').value : '').trim() || 'assets/logo.jpg';
  const siteName = (document.getElementById('cfgSiteName') ? document.getElementById('cfgSiteName').value : '').trim() || 'FREAKSHOW';
  const siteTagline = (document.getElementById('cfgSiteTagline') ? document.getElementById('cfgSiteTagline').value : '').trim() || 'FASTEST GAMING HUB';

  const telegramLink = (document.getElementById('cfgTelegramLink') ? document.getElementById('cfgTelegramLink').value : '').trim() || 'https://t.me/freakshowtopup';
  const telegramUsername = (document.getElementById('cfgTelegramUsername') ? document.getElementById('cfgTelegramUsername').value : '').trim() || 'freakshowtopup';
  const whatsappNumber = (document.getElementById('cfgWhatsappNumber') ? document.getElementById('cfgWhatsappNumber').value : '').trim() || '+8801641625723';
  const whatsappLink = (document.getElementById('cfgWhatsappLink') ? document.getElementById('cfgWhatsappLink').value : '').trim() || 'https://wa.me/8801641625723';
  const supportEmail = (document.getElementById('cfgSupportEmail') ? document.getElementById('cfgSupportEmail').value : '').trim() || 'admin.freakshow@gmail.com';

  const heroBannerImage = (document.getElementById('cfgHeroBannerImage') ? document.getElementById('cfgHeroBannerImage').value : '').trim() || 'assets/hero_banner.jpg';
  const heroBadge = (document.getElementById('cfgHeroBadge') ? document.getElementById('cfgHeroBadge').value : '').trim() || '🔥 #1 Game Top-Up Platform';
  const heroTitle = (document.getElementById('cfgHeroTitle') ? document.getElementById('cfgHeroTitle').value : '').trim() || 'Instant <span>Game Diamonds</span> & VIP Passes';
  const heroDesc = (document.getElementById('cfgHeroDesc') ? document.getElementById('cfgHeroDesc').value : '').trim() || 'Recharge your Free Fire, PUBG & MLBB accounts in seconds. 100% automated delivery with bKash, Nagad, Rocket, or Wallet Balance.';

  const heroSideCard1Image = (document.getElementById('cfgHeroSideCard1Image') ? document.getElementById('cfgHeroSideCard1Image').value : '').trim() || 'assets/ff_membership_v2.jpg';
  const heroSideCard1Title = (document.getElementById('cfgHeroSideCard1Title') ? document.getElementById('cfgHeroSideCard1Title').value : '').trim() || 'Weekly & Monthly Pass';
  const heroSideCard1Desc = (document.getElementById('cfgHeroSideCard1Desc') ? document.getElementById('cfgHeroSideCard1Desc').value : '').trim() || 'Claim up to 2600 Diamonds with maximum savings';

  const heroSideCard2Image = (document.getElementById('cfgHeroSideCard2Image') ? document.getElementById('cfgHeroSideCard2Image').value : '').trim() || 'assets/ff_levelup.jpg';
  const heroSideCard2Title = (document.getElementById('cfgHeroSideCard2Title') ? document.getElementById('cfgHeroSideCard2Title').value : '').trim() || 'Level Up Pass (802 💎)';
  const heroSideCard2Desc = (document.getElementById('cfgHeroSideCard2Desc') ? document.getElementById('cfgHeroSideCard2Desc').value : '').trim() || 'Instant 802 Diamonds upon level progression';

  const footerAbout = (document.getElementById('cfgFooterAbout') ? document.getElementById('cfgFooterAbout').value : '').trim();
  const footerCopyright = (document.getElementById('cfgFooterCopyright') ? document.getElementById('cfgFooterCopyright').value : '').trim();

  const voucherRedeemUrl = (document.getElementById('cfgVoucherRedeemUrl') ? document.getElementById('cfgVoucherRedeemUrl').value : '').trim() || 'https://shop.garena.my/';
  const voucherRedeemText = (document.getElementById('cfgVoucherRedeemText') ? document.getElementById('cfgVoucherRedeemText').value : '').trim() || 'Redeem at shop.garena.my';
  const shellRedeemUrl = (document.getElementById('cfgShellRedeemUrl') ? document.getElementById('cfgShellRedeemUrl').value : '').trim() || 'https://bdgamesbazar.com/';
  const shellRedeemText = (document.getElementById('cfgShellRedeemText') ? document.getElementById('cfgShellRedeemText').value : '').trim() || 'Redeem at bdgamesbazar.com';

  const failedRefundMessage = (document.getElementById('cfgFailedRefundMessage') ? document.getElementById('cfgFailedRefundMessage').value : '').trim() || 'কোনো সমস্যার কারণে অর্ডারটি সম্পন্ন করা যায়নি। আপনার পরিশোধিত টাকা সম্পূর্ণ ওয়ালেট ব্যালেন্সে ইনস্ট্যান্ট ফেরত (Auto-Refund) দেওয়া হয়েছে।';
  const uidSuccessMessage = (document.getElementById('cfgUidSuccessMessage') ? document.getElementById('cfgUidSuccessMessage').value : '').trim() || 'আপনার ফ্রি ফায়ার একাউন্টে সরাসরি টপ-আপ সফলভাবে সম্পন্ন হয়েছে!';
  const outOfStockMessage = (document.getElementById('cfgOutOfStockMessage') ? document.getElementById('cfgOutOfStockMessage').value : '').trim() || 'সাময়িকভাবে এই প্যাকেজের স্টক শেষ / সার্ভার আপডেটের কাজ চলছে। খুব দ্রুতই স্টক যোগ করা হবে!';

  const maintenanceMode = document.getElementById('cfgSiteStatus').value === 'MAINTENANCE';
  const autoTopupDisabled = document.getElementById('cfgAutoTopup').value === 'DISABLED';
  const registrationDisabled = document.getElementById('cfgRegistration').value === 'DISABLED';
  const popupDisabled = document.getElementById('cfgPopupEnabled').value === 'DISABLED';
  const recentOrdersSectionEnabled = document.getElementById('cfgRecentOrders') ? document.getElementById('cfgRecentOrders').value === 'ENABLED' : true;
  const referralCommissionPercent = parseFloat(document.getElementById('cfgReferralRate').value) || 2.5;
  const telegramAdminChatId = document.getElementById('cfgAdminChatId').value;

  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({
        siteLogo,
        siteName,
        siteTagline,
        telegramLink,
        telegramUsername,
        whatsappNumber,
        whatsappLink,
        supportEmail,
        heroBannerImage,
        heroBadge,
        heroTitle,
        heroDesc,
        heroSideCard1Image,
        heroSideCard1Title,
        heroSideCard1Desc,
        heroSideCard2Image,
        heroSideCard2Title,
        heroSideCard2Desc,
        footerAbout,
        footerCopyright,
        voucherRedeemUrl,
        voucherRedeemText,
        shellRedeemUrl,
        shellRedeemText,
        failedRefundMessage,
        uidSuccessMessage,
        outOfStockMessage,
        maintenanceMode,
        autoTopupDisabled,
        registrationDisabled,
        popupDisabled,
        recentOrdersSectionEnabled,
        referralCommissionPercent,
        telegramAdminChatId
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast('💾 Website customization & system settings saved!');
      loadAllAdminData();
    } else {
      alert(data.message || 'Failed to save settings');
    }
  } catch (e) {
    alert('Failed to save settings');
  }
}

async function handleAdminImageUpload(inputEl, targetInputId, previewImgId) {
  if (!inputEl.files || !inputEl.files[0]) return;
  const file = inputEl.files[0];

  // Client-side file size check (5MB)
  if (file.size > 5 * 1024 * 1024) {
    alert('⚠️ Image size exceeds maximum limit (5 MB). Please choose a smaller image.');
    inputEl.value = '';
    return;
  }

  showToast('⏳ Uploading image asset...');

  const reader = new FileReader();
  reader.onload = async function (e) {
    const base64Data = e.target.result;
    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ADMIN_STATE.token}`
        },
        body: JSON.stringify({
          imageBase64: base64Data,
          filename: file.name
        })
      });

      const data = await res.json();
      if (data.success && data.url) {
        if (document.getElementById(targetInputId)) {
          document.getElementById(targetInputId).value = data.url;
        }
        if (document.getElementById(previewImgId)) {
          document.getElementById(previewImgId).src = data.url;
        }
        showToast('✅ Image uploaded successfully!');
      } else {
        alert(data.message || 'Failed to upload image.');
      }
    } catch (err) {
      alert('Network error while uploading image.');
    }
  };
  reader.readAsDataURL(file);
}

function resetLogoImage() {
  if (document.getElementById('cfgSiteLogo')) document.getElementById('cfgSiteLogo').value = 'assets/logo.jpg';
  if (document.getElementById('cfgLogoPreview')) document.getElementById('cfgLogoPreview').src = 'assets/logo.jpg';
}

function resetHeroBannerImage() {
  if (document.getElementById('cfgHeroBannerImage')) document.getElementById('cfgHeroBannerImage').value = 'assets/hero_banner.jpg';
  if (document.getElementById('cfgHeroBannerPreview')) document.getElementById('cfgHeroBannerPreview').src = 'assets/hero_banner.jpg';
}

function updateWhatsappLinkFromNumber(num) {
  const cleanDigits = String(num || '').replace(/[^\d]/g, '');
  if (cleanDigits && document.getElementById('cfgWhatsappLink')) {
    document.getElementById('cfgWhatsappLink').value = `https://wa.me/${cleanDigits}`;
  }
}

// --- Admins Management ---
function openAddAdminModal() {
  document.getElementById('admIdentifier').value = '';
  document.getElementById('admTelegramId').value = '';
  openModal('adminModal');
}

async function submitAuthorizeAdmin(e) {
  e.preventDefault();
  const identifier = document.getElementById('admIdentifier').value.trim();
  const telegramId = document.getElementById('admTelegramId').value.trim();
  const role = document.getElementById('admRole').value;

  try {
    const res = await fetch('/api/admin/admins', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({ identifier, telegramId, role })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`👑 Staff access granted (${role})`);
      closeModal('adminModal');
      loadAllAdminData();
    } else {
      alert(data.message || 'Failed to authorize admin');
    }
  } catch (e) {
    alert('Server error.');
  }
}

async function revokeAdminRole(userId) {
  if (!confirm('Revoke administrative access for this user?')) return;
  try {
    const res = await fetch(`/api/admin/admins/${userId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${ADMIN_STATE.token}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast('🚫 Admin access revoked.');
      loadAllAdminData();
    }
  } catch (e) {}
}

async function handleChangeVipCode(e) {
  e.preventDefault();
  const oldCode = (document.getElementById('vipOldCode').value || '').trim();
  const newCode = (document.getElementById('vipNewCode').value || '').trim();
  const confirmCode = (document.getElementById('vipConfirmCode').value || '').trim();
  const alertEl = document.getElementById('vipCodeChangeAlert');
  const btn = document.getElementById('btnSaveVipCode');

  if (!oldCode || !newCode || !confirmCode) {
    if (alertEl) {
      alertEl.style.display = 'block';
      alertEl.style.background = 'rgba(239,68,68,0.15)';
      alertEl.style.color = '#f87171';
      alertEl.textContent = '❌ All fields are required.';
    }
    return;
  }

  if (newCode.length < 4) {
    if (alertEl) {
      alertEl.style.display = 'block';
      alertEl.style.background = 'rgba(239,68,68,0.15)';
      alertEl.style.color = '#f87171';
      alertEl.textContent = '❌ New VIP Code must be at least 4 characters long.';
    }
    return;
  }

  if (newCode !== confirmCode) {
    if (alertEl) {
      alertEl.style.display = 'block';
      alertEl.style.background = 'rgba(239,68,68,0.15)';
      alertEl.style.color = '#f87171';
      alertEl.textContent = '❌ New VIP Code and Confirm Code do not match.';
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Encrypting & Saving...';
  }

  try {
    const res = await fetch('/api/admin/vip-code', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_STATE.token}`
      },
      body: JSON.stringify({ oldCode, newCode, confirmCode })
    });
    const data = await res.json();
    if (data.success) {
      if (alertEl) {
        alertEl.style.display = 'block';
        alertEl.style.background = 'rgba(52,211,153,0.15)';
        alertEl.style.color = '#34d399';
        alertEl.textContent = '✅ ' + (data.message || 'VIP Access Code updated and encrypted successfully!');
      }
      document.getElementById('vipOldCode').value = '';
      document.getElementById('vipNewCode').value = '';
      document.getElementById('vipConfirmCode').value = '';
      showToast('👑 VIP Access Code updated successfully!');
    } else {
      if (alertEl) {
        alertEl.style.display = 'block';
        alertEl.style.background = 'rgba(239,68,68,0.15)';
        alertEl.style.color = '#f87171';
        alertEl.textContent = '❌ ' + (data.message || 'Failed to update VIP Code.');
      }
    }
  } catch (err) {
    if (alertEl) {
      alertEl.style.display = 'block';
      alertEl.style.background = 'rgba(239,68,68,0.15)';
      alertEl.style.color = '#f87171';
      alertEl.textContent = '❌ Server connection error.';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔒 Update & Encrypt VIP Code 🚀';
    }
  }
}

async function sendAdminTelegramBroadcast() {
  const input = document.getElementById('adminBroadcastMessageInput');
  const status = document.getElementById('adminBroadcastStatusText');
  const btn = document.getElementById('btnSendTgBroadcast');

  const message = (input ? input.value : '').trim();
  if (!message) {
    alert('Please enter a broadcast message to send.');
    return;
  }

  if (!confirm('Are you sure you want to broadcast this message to all connected Telegram users?')) {
    return;
  }

  if (btn) btn.disabled = true;
  if (status) status.textContent = '⏳ Sending broadcast to all users...';

  try {
    const token = ADMIN_STATE.token || localStorage.getItem('fs_admin_token') || localStorage.getItem('admin_token') || '';
    const res = await fetch('/api/admin/telegram/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ message })
    });
    const data = await res.json();
    if (data.success) {
      if (status) status.innerHTML = `<span style="color: #10b981;">✅ Sent to ${data.successful} users (Failed: ${data.failed})</span>`;
      showToast(`🚀 Broadcast delivered to ${data.successful} users!`);
      if (input) input.value = '';
    } else {
      if (status) status.innerHTML = `<span style="color: #f87171;">❌ ${data.message || 'Failed'}</span>`;
      alert(data.message || 'Failed to send broadcast');
    }
  } catch (e) {
    if (status) status.innerHTML = `<span style="color: #f87171;">❌ Network error</span>`;
    alert('Network error while sending broadcast');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ==========================================
// 6. INITIALIZATION & LIFECYCLE
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
  const isAuth = await verifyAdminAuth();
  if (isAuth) {
    await loadAllAdminData();
    setInterval(loadAllAdminData, 30000);
  }
});
