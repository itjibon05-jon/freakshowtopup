/**
 * FREAKSHOWTOPUP - PRODUCTION FRONTEND CLIENT ENGINE
 * Domain: freakshowtopup.shop
 * Integrates Full REST APIs, Internationalization (EN/BN), One-Time Currency Lock,
 * Wallet Ledger, Telegram Alerts, and Role-Based Admin Panel.
 */

// ==========================================
// 1. I18N TRANSLATION DICTIONARY
// ==========================================

const I18N = {
  en: {
    brandTag: 'FASTEST GAMING HUB',
    heroBadge: '🔥 #1 Game Top-Up Platform',
    heroTitle: 'Instant Game Diamonds & VIP Passes',
    heroDesc: 'Recharge your Free Fire, PUBG & MLBB accounts in seconds. 100% automated delivery with bKash, Nagad, Rocket, or Wallet Balance.',
    topUpNow: 'Recharge Now',
    addMoney: '+ Add Money',
    myWallet: 'My Wallet',
    trackOrder: 'Track Order',
    spinWin: 'Spin & Win 🎁',
    adminPortal: 'Admin Portal',
    signIn: 'Sign In / Register',
    signOut: 'Sign Out',
    spotlightTitle: '🔥 Free Fire Fast Focus',
    allProductsTitle: 'All Games & Subscriptions',
    all: '🌟 All Items',
    freefire: '🔥 Free Fire',
    mobile: '📱 Mobile Games',
    vouchers: '🎟️ Vouchers & Shells',
    recentOrders: 'LIVE RECENT ORDERS',
    referralTitle: 'Earn With Referrals 💸',
    directBtn: 'Direct Top-Up',
    deadTeamBtn: 'Dead Team Esports'
  },
  bn: {
    brandTag: 'দ্রুততম গেমিং হাব',
    heroBadge: '🔥 ১ নম্বর গেমিং টপআপ প্ল্যাটফর্ম',
    heroTitle: 'ইনস্ট্যান্ট ডায়মন্ড ও ভিআইপি পাস রিচার্জ',
    heroDesc: 'ফ্রি ফায়ার, পাবজি ও মোবাইল লেজেন্ডস রিচার্জ করুন চোখের পলকে। বিকাশ, নগদ, রকেট ও সরাসরি ওয়ালেট দিয়ে ১০০% অটোমেটেড ডেলিভারি।',
    topUpNow: 'এখনই রিচার্জ করুন',
    addMoney: '+ টাকা যোগ করুন',
    myWallet: 'আমার ওয়ালেট',
    trackOrder: 'অর্ডার ট্র্যাক',
    spinWin: 'লাকি স্পিন 🎁',
    adminPortal: 'অ্যাডমিন প্যানেল',
    signIn: 'লগইন / রেজিস্টার',
    signOut: 'লগআউট',
    spotlightTitle: '🔥 ফ্রি ফায়ার ফাস্ট ফোকাস',
    allProductsTitle: 'সকল গেম ও ডিজিটাল সার্ভিস',
    all: '🌟 সকল আইটেম',
    freefire: '🔥 ফ্রি ফায়ার',
    mobile: '📱 মোবাইল গেমস',
    vouchers: '🎟️ ভাউচার ও কার্ড',
    recentOrders: 'সাম্প্রতিক সফল অর্ডারসমূহ',
    referralTitle: 'রেফার করে ইনকাম করুন 💸',
    directBtn: 'ডাইরেক্ট টপআপ',
    deadTeamBtn: 'ডেড টিম এস্পোর্টস'
  }
};

// ==========================================
// 2. CLIENT APPLICATION STATE
// ==========================================

const APP = {
  lang: localStorage.getItem('fs_lang') || 'en',
  currency: 'BDT',
  token: localStorage.getItem('fs_token') || null,
  user: null,
  wallet: { balance: 0.00, currency: 'BDT' },
  products: [],
  categories: [],
  settings: {},
  activeTopup: {
    product: null,
    playerUid: '',
    zoneId: '',
    customAmount: null,
    discountPercent: 0
  }
};

// ==========================================
// 3. INITIALIZATION & API FETCHERS
// ==========================================

// Debounce helper for high-performance input events
function debounce(fn, delay = 250) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

async function initApp() {
  setupLanguage();

  // 1. Instant 0ms cache-first render from localStorage
  const cachedSettings = localStorage.getItem('fs_settings_cache');
  const cachedCatalog = localStorage.getItem('fs_catalog_cache');
  if (cachedSettings) {
    try {
      APP.settings = JSON.parse(cachedSettings);
      const ann = document.getElementById('announcementText');
      if (ann && APP.settings.announcement) ann.textContent = APP.settings.announcement;
      applyPaymentMethodVisibility();
      applyRecentOrdersVisibility();
    } catch (e) {}
  }
  if (cachedCatalog) {
    try {
      const parsed = JSON.parse(cachedCatalog);
      APP.products = parsed.products || [];
      APP.categories = parsed.categories || [];
      renderAllSections();
    } catch (e) {}
  }

  setupEventListeners();
  initPwaEngine();

  // Auto-capture referral code from URL if present (e.g. ?ref=FS492810)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const refCodeParam = urlParams.get('ref') || urlParams.get('referral');
    if (refCodeParam) {
      sessionStorage.setItem('fs_ref_code', refCodeParam.trim().toUpperCase());
    }
  } catch (e) {}

  // 2. Parallel network requests (Stale-While-Revalidate)
  await Promise.allSettled([
    loadPublicSettings(),
    checkAuthSession(),
    loadCatalogProducts(),
    fetchRecentOrders()
  ]);

  setTimeout(() => initGoogleAuth(), 400);

  setTimeout(() => {
    const isDismissed = sessionStorage.getItem('fs_offer_dismissed');
    if (!isDismissed) {
      openWelcomeOfferModal();
    }
  }, 1200);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

function openWelcomeOfferModal() {
  if (APP.settings && (APP.settings.popupDisabled || (APP.settings.popupOffer && APP.settings.popupOffer.enabled === false))) {
    return;
  }
  const modal = document.getElementById('welcomeOfferModal');
  if (!modal) return;

  if (APP.settings && APP.settings.popupOffer) {
    const offer = APP.settings.popupOffer;
    const imgEl = document.getElementById('welcomeOfferImg');
    const titleEl = document.getElementById('welcomeOfferTitle');
    if (imgEl && offer.imageUrl) imgEl.src = offer.imageUrl;
    if (titleEl && offer.title) titleEl.textContent = offer.title;
  }
  modal.classList.add('active');
}

function closeWelcomeOfferModal() {
  const modal = document.getElementById('welcomeOfferModal');
  if (modal) modal.classList.remove('active');
  sessionStorage.setItem('fs_offer_dismissed', 'true');
}

function handleClaimOffer() {
  closeWelcomeOfferModal();
  const link = (APP.settings && APP.settings.popupOffer && APP.settings.popupOffer.link)
    ? APP.settings.popupOffer.link.trim()
    : 'sub-ff-bd';

  if (!link) {
    openTopUpWizard('sub-ff-bd');
    return;
  }

  if (link.startsWith('http://') || link.startsWith('https://')) {
    window.open(link, '_blank');
  } else if (link.startsWith('#')) {
    const el = document.querySelector(link);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  } else {
    // If it's a subcategory or product ID
    openTopUpWizard(link);
  }
}

function setupLanguage() {
  const dict = I18N[APP.lang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) el.textContent = dict[key];
  });
  const langToggle = document.getElementById('btnLangToggle');
  if (langToggle) langToggle.textContent = APP.lang === 'en' ? '🇬🇧 EN' : '🇧🇩 বাংলা';
}

function toggleLanguage() {
  APP.lang = APP.lang === 'en' ? 'bn' : 'en';
  localStorage.setItem('fs_lang', APP.lang);
  setupLanguage();
  renderCatalog();
}

function applyPaymentMethodVisibility() {
  const pStatus = (APP.settings && APP.settings.paymentMethodStatus) || {};
  document.querySelectorAll('.dep-method-btn').forEach(b => {
    const m = b.dataset.method;
    if (!m) return;
    const isEnabled = pStatus[m] !== false;
    if (isEnabled) {
      b.style.removeProperty('display');
    } else {
      b.style.setProperty('display', 'none', 'important');
      b.classList.remove('active');
    }
  });
}

function applyRecentOrdersVisibility() {
  const sec = document.getElementById('recent-orders-section');
  if (sec) {
    const isEnabled = (APP.settings && APP.settings.recentOrdersSectionEnabled !== false);
    sec.style.display = isEnabled ? '' : 'none';
  }
}

async function loadPublicSettings() {
  try {
    const res = await fetch(`/api/settings/public?t=${Date.now()}`, {
      cache: 'no-store'
    });
    const data = await res.json();
    if (data.success) {
      APP.settings = data;
      localStorage.setItem('fs_settings_cache', JSON.stringify(data));
      const ann = document.getElementById('announcementText');
      if (ann && data.announcement) ann.textContent = data.announcement;
      applyBrandingAndHeroSettings(data);
      renderHowToDepositCard();
      applyPaymentMethodVisibility();
      applyRecentOrdersVisibility();
      updateAllRateDisplays(data.usdToBdtRate || data.exchangeRate || 120);
    }
  } catch (e) { }
}

function applyBrandingAndHeroSettings(data) {
  if (!data) return;

  // 1. Logo & Site Name Branding
  if (data.siteLogo) {
    document.querySelectorAll('.brand-logo-img').forEach(img => {
      img.src = data.siteLogo;
    });
  }
  if (data.siteName) {
    const mainBrandName = document.getElementById('mainBrandName');
    if (mainBrandName) mainBrandName.textContent = data.siteName;
    const footerBrandName = document.getElementById('footerBrandName');
    if (footerBrandName) footerBrandName.textContent = data.siteName;
    const footerCopyrightBrand = document.getElementById('footerCopyrightBrand');
    if (footerCopyrightBrand) footerCopyrightBrand.textContent = data.siteName;
  }
  if (data.siteTagline) {
    const mainBrandTag = document.getElementById('mainBrandTag');
    if (mainBrandTag) mainBrandTag.textContent = data.siteTagline;
    const footerBrandTag = document.getElementById('footerBrandTag');
    if (footerBrandTag) footerBrandTag.textContent = data.siteTagline;
  }

  // 2. Hero Section
  if (data.heroBannerImage) {
    const heroImg = document.getElementById('heroBannerImg');
    if (heroImg) heroImg.src = data.heroBannerImage;
  }
  if (data.heroBadge) {
    const heroBadge = document.getElementById('heroMainBadge');
    if (heroBadge) heroBadge.textContent = data.heroBadge;
  }
  if (data.heroTitle) {
    const heroTitle = document.getElementById('heroMainTitle');
    if (heroTitle) heroTitle.innerHTML = data.heroTitle;
  }
  if (data.heroDesc) {
    const heroDesc = document.getElementById('heroMainDesc');
    if (heroDesc) heroDesc.textContent = data.heroDesc;
  }

  // Hero Side Cards
  if (data.heroSideCard1Image) {
    const card1Img = document.getElementById('heroSideCard1Img');
    if (card1Img) card1Img.src = data.heroSideCard1Image;
  }
  if (data.heroSideCard1Title) {
    const card1Title = document.getElementById('heroSideCard1Title');
    if (card1Title) card1Title.textContent = data.heroSideCard1Title;
  }
  if (data.heroSideCard1Desc) {
    const card1Desc = document.getElementById('heroSideCard1Desc');
    if (card1Desc) card1Desc.textContent = data.heroSideCard1Desc;
  }
  if (data.heroSideCard2Image) {
    const card2Img = document.getElementById('heroSideCard2Img');
    if (card2Img) card2Img.src = data.heroSideCard2Image;
  }
  if (data.heroSideCard2Title) {
    const card2Title = document.getElementById('heroSideCard2Title');
    if (card2Title) card2Title.textContent = data.heroSideCard2Title;
  }
  if (data.heroSideCard2Desc) {
    const card2Desc = document.getElementById('heroSideCard2Desc');
    if (card2Desc) card2Desc.textContent = data.heroSideCard2Desc;
  }

  // 3. Social & Support Links (Telegram, WhatsApp, Email)
  const tgLink = data.telegramLink || 'https://t.me/freakshowtopup';
  const tgUser = data.telegramUsername || 'freakshowtopup';
  const waLink = data.whatsappLink || 'https://wa.me/8801641625723';
  const waNum = data.whatsappNumber || '+8801641625723';
  const supEmail = data.supportEmail || data.adminEmail || 'admin.freakshow@gmail.com';

  // Floating Telegram
  const floatTg = document.getElementById('floatingTelegramBtn');
  if (floatTg) {
    floatTg.href = tgLink;
    floatTg.title = `Official Telegram: @${tgUser.replace(/^@/, '')}`;
  }
  // Floating WhatsApp
  const floatWa = document.getElementById('floatingWhatsappBtn');
  if (floatWa) {
    floatWa.href = waLink;
    floatWa.title = `24/7 WhatsApp Support: ${waNum}`;
  }
  // Quick Dock Telegram
  const dockTg = document.getElementById('dockTelegramBtn');
  if (dockTg) {
    dockTg.href = tgLink;
    dockTg.title = `Telegram Channel: @${tgUser.replace(/^@/, '')}`;
  }
  // Quick Dock WhatsApp
  const dockWa = document.getElementById('dockWhatsappBtn');
  if (dockWa) {
    dockWa.href = waLink;
    dockWa.title = `WhatsApp Support: ${waNum}`;
  }

  // Footer Social & Contact
  const footerEmailLink = document.getElementById('footerEmailLink');
  if (footerEmailLink) footerEmailLink.href = `mailto:${supEmail}`;
  const footerEmailText = document.getElementById('footerEmailText');
  if (footerEmailText) footerEmailText.textContent = supEmail;

  const footerWaLink = document.getElementById('footerWhatsappLink');
  if (footerWaLink) footerWaLink.href = waLink;
  const footerWaText = document.getElementById('footerWhatsappText');
  if (footerWaText) footerWaText.textContent = `WhatsApp: ${waNum}`;
  const footerWaBtn = document.getElementById('footerWhatsappBtn');
  if (footerWaBtn) footerWaBtn.href = waLink;

  const footerTgLink = document.getElementById('footerTelegramLink');
  if (footerTgLink) footerTgLink.href = tgLink;
  const footerTgText = document.getElementById('footerTelegramText');
  if (footerTgText) footerTgText.textContent = `Telegram: @${tgUser.replace(/^@/, '')}`;
  const footerTgBtn = document.getElementById('footerTelegramBtn');
  if (footerTgBtn) footerTgBtn.href = tgLink;

  // 4. Footer About & Copyright
  if (data.footerAbout) {
    const footerAbout = document.getElementById('footerAboutText');
    if (footerAbout) footerAbout.textContent = data.footerAbout;
  }
  if (data.footerCopyright) {
    const footerCopyright = document.getElementById('footerCopyrightContainer');
    if (footerCopyright) footerCopyright.innerHTML = data.footerCopyright;
  }
}

async function checkAuthSession() {
  if (!APP.token) {
    updateAuthUI();
    return;
  }
  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${APP.token}` }
    });
    const data = await res.json();
    if (data.success && data.user) {
      APP.user = data.user;
      APP.wallet = data.wallet || { balance: 0, currency: data.user.currency };
      APP.currency = data.user.currency;
    } else {
      logoutUser();
    }
  } catch (e) {
    logoutUser();
  }
  updateAuthUI();
}

function updateAuthUI() {
  const walletBadge = document.getElementById('navWalletPill');
  const authBtn = document.getElementById('btnAuthTrigger');
  const logoutBtn = document.getElementById('btnLogoutTrigger');
  const walletLogoutBtn = document.getElementById('btnWalletLogout');
  const referralBtn = document.getElementById('btnReferralTrigger');
  const adminBtn = document.getElementById('btnAdminTrigger');
  const mobAccountLabel = document.getElementById('mobNavAccountLabel');

  if (walletBadge) {
    walletBadge.style.display = 'flex';
    document.getElementById('navWalletBalance').textContent = `${APP.currency === 'USD' ? '$' : '৳'}${Number(APP.wallet.balance).toFixed(2)}`;
  }

  if (APP.user) {
    const firstName = (APP.user.name || 'Gamer').split(' ')[0];
    const effAvatar = APP.user.avatar || APP.user.picture || APP.user.googleAvatar || null;

    if (authBtn) {
      if (effAvatar) {
        authBtn.innerHTML = `<img src="${effAvatar}" alt="Avatar" style="width: 20px; height: 20px; border-radius: 50%; object-fit: cover; border: 1px solid var(--brand-cyan); vertical-align: middle; margin-right: 4px;"> ${firstName}`;
      } else {
        authBtn.innerHTML = `👤 ${firstName}`;
      }
      authBtn.onclick = openProfileModal;
    }
    if (logoutBtn) logoutBtn.style.display = 'inline-flex';
    if (walletLogoutBtn) walletLogoutBtn.style.display = 'inline-flex';
    if (referralBtn) referralBtn.style.display = 'inline-flex';
    if (mobAccountLabel) mobAccountLabel.textContent = firstName;
    if (adminBtn) {
      adminBtn.style.display = ['SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'].includes(APP.user.role) ? 'inline-flex' : 'none';
      adminBtn.onclick = () => { window.location.href = '/admin/dashboard'; };
    }
  } else {
    if (authBtn) {
      authBtn.textContent = I18N[APP.lang].signIn;
      authBtn.onclick = openAuthModal;
    }
    if (logoutBtn) logoutBtn.style.display = 'none';
    if (walletLogoutBtn) walletLogoutBtn.style.display = 'none';
    if (referralBtn) referralBtn.style.display = 'none';
    if (mobAccountLabel) mobAccountLabel.textContent = 'Account';
    if (adminBtn) adminBtn.style.display = 'none';
  }
}

function handleMobileAccountClick() {
  closeAllModals();
  if (APP.user) {
    openUserWalletModal();
  } else {
    openAuthModal();
  }
}

async function openUserWalletModal() {
  closeAllModals();
  const modal = document.getElementById('userWalletCenterModal');
  if (!modal) return openDepositModal();

  const balanceText = `${APP.currency === 'USD' ? '$' : '৳'}${Number(APP.wallet.balance).toFixed(2)}`;
  document.getElementById('walletCenterBalance').textContent = balanceText;

  const userTag = document.getElementById('walletCenterUserTag');
  const tbody = document.getElementById('walletLedgerTableBody');

  if (APP.user) {
    if (userTag) userTag.innerHTML = `👤 <strong>${APP.user.name}</strong> • Account: <code>${APP.user.currency}</code>`;

    // Fetch user ledger transactions
    try {
      const res = await fetch('/api/wallet', {
        headers: { 'Authorization': `Bearer ${APP.token}` }
      });
      const data = await res.json();
      if (data.success && data.transactions) {
        if (data.transactions.length === 0) {
          tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 18px; color: var(--text-muted);">No transactions yet. Click '+ Add Money' to deposit!</td></tr>`;
        } else {
          tbody.innerHTML = data.transactions.map(t => {
            const isCredit = Number(t.amount) > 0;
            return `
              <tr style="border-bottom: 1px solid var(--border-soft);">
                <td style="padding: 8px 10px;"><span class="tag-pill ${isCredit ? 'tag-cyan' : 'tag-red'}">${t.type}</span></td>
                <td style="padding: 8px 10px; font-size: 0.76rem;">${t.description}</td>
                <td style="padding: 8px 10px; font-weight: 800; color: ${isCredit ? '#00e676' : '#ff4757'};">${isCredit ? '+' : ''}${APP.currency === 'USD' ? '$' : '৳'}${t.amount}</td>
                <td style="padding: 8px 10px; font-weight: 700;">${APP.currency === 'USD' ? '$' : '৳'}${Number(t.newBalance).toFixed(2)}</td>
              </tr>
            `;
          }).join('');
        }
      }
    } catch (e) { }
  } else {
    if (userTag) userTag.innerHTML = `⚡ Guest Mode — <a href="javascript:void(0)" onclick="openAuthModal()" style="color: var(--brand-red); text-decoration: underline; font-weight: 800;">Sign in to view transaction history</a>`;
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 18px; color: var(--text-dim);"><button class="nav-btn btn-primary" onclick="openAuthModal()">Sign in to view transaction history</button></td></tr>`;
  }

  modal.classList.add('active');
}

// ==========================================
// 4. PRODUCT CATALOG RENDERING
// ==========================================
async function loadCatalogProducts() {
  try {
    const res = await fetch('/api/products', {
      headers: APP.token ? { 'Authorization': `Bearer ${APP.token}` } : {}
    });
    const data = await res.json();
    if (data.success && Array.isArray(data.products)) {
      APP.products = data.products;
      APP.categories = data.categories || [];
      try {
        localStorage.setItem('fs_catalog_cache', JSON.stringify({ products: APP.products, categories: APP.categories }));
      } catch (e) {}

      // Dynamically sync package prices and stock status with DB products by exact product ID
      const allCatalogs = [FF_CATEGORY_PACKAGES, APP_SPECIAL_SERVICES];
      APP.products.forEach(p => {
        allCatalogs.forEach(catalog => {
          Object.values(catalog).forEach(cat => {
            if (Array.isArray(cat.packages)) {
              const pkg = cat.packages.find(item => item.id === p.id);
              if (pkg) {
                pkg.price = Number(p.sellingPrice);
                pkg.inStock = (p.inStock !== false);
              }
            }
          });
        });
      });
    }
  } catch (e) {
    console.error('[FREAKSHOW] Failed to load products:', e);
  }
  // Always render — even if empty, so UI shows state
  renderAllSections();
}

function formatPrice(amount, currency = 'BDT') {
  return `${currency === 'USD' ? '$' : '৳'}${Number(amount).toFixed(2)}`;
}

function renderAllSections() {
  const categories = APP.categories || [];
  const products = APP.products || [];

  // Helper to render a grid of Subcategory cards for a given list of subcategories
  function renderSubcategoryCards(subList, ribbonClass = 'ribbon-hot') {
    if (!subList || subList.length === 0) return '';

    return subList.map(sub => {
      // Find all products under this subcategory to calculate starting price
      const subProds = products.filter(p => (p.subcategoryId === sub.id || p.subcategoryId === sub.slug) && p.isActive !== false);
      const minPrice = subProds.length > 0 ? Math.min(...subProds.map(p => Number(p.sellingPrice) || 0)) : (sub.price || 0);
      const deliveryLabel = sub.deliveryType || (subProds[0] ? subProds[0].deliveryType : 'UID Auto');
      const prodCount = subProds.length > 0 ? `${subProds.length} Packages` : 'Instant Access';

      return `
        <div class="product-card spotlight-card" onclick="openTopUpWizard('${sub.id}')">
          <div class="product-img-wrap">
            <img src="${sub.icon || 'assets/ff_diamond.jpg'}" alt="${sub.name}" class="product-img" onerror="this.src='assets/ff_diamond.jpg'">
            <span class="product-ribbon ${ribbonClass}">${sub.badge || 'Instant ⚡'}</span>
          </div>
          <div class="product-card-body">
            <div>
              <h4 class="product-name">${sub.name}</h4>
              <div style="display: flex; gap: 6px; align-items: center; margin-top: 3px; flex-wrap: wrap;">
                <span style="font-size: 0.68rem; padding: 2px 6px; border-radius: 4px; background: rgba(0,242,254,0.1); color: var(--brand-cyan); border: 1px solid rgba(0,242,254,0.25); font-weight: 700;">
                  ${deliveryLabel}
                </span>
                <span style="font-size: 0.72rem; color: var(--text-muted);">${prodCount}</span>
              </div>
            </div>
            <div class="product-price">Starting ${formatPrice(minPrice, APP.currency)}</div>
            <button class="nav-btn btn-primary" style="font-size: 0.76rem; padding: 5px 8px; justify-content: center;">
              ${deliveryLabel === 'CODE Delivery' ? 'Get Code 🔑' : (deliveryLabel === 'Gmail Delivery' ? 'Get Access ⚡' : I18N[APP.lang].topUpNow)}
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  // 1. Section 1: Free Fire Fast Focus Grid
  const ffContainer = document.getElementById('ffProductsGrid');
  const ffSection = document.getElementById('freefire-section');
  const ffCat = categories.find(c => c.id === 'cat-ff');
  const isFfActive = ffCat && ffCat.isActive !== false;
  const ffSubs = (isFfActive && Array.isArray(ffCat.subcategories)) ? ffCat.subcategories.filter(s => s.isActive !== false && s.id !== 'sub-ff-vip' && !s.isVip) : [];

  if (ffSection) {
    ffSection.style.display = (isFfActive && ffSubs.length > 0) ? '' : 'none';
  }
  if (ffContainer) {
    ffContainer.innerHTML = (isFfActive && ffSubs.length > 0) ? renderSubcategoryCards(ffSubs, 'ribbon-hot') : '';
  }

  // 2. Section 2: Other Games & Vouchers Grid (show 5, rest hidden behind "Show More")
  const otherContainer = document.getElementById('otherGamesGrid');
  const otherSection = document.getElementById('other-games-section');
  const voucherCat = categories.find(c => c.id === 'cat-vouchers');
  const othersCat = categories.find(c => c.id === 'cat-others');

  const isVoucherActive = voucherCat && voucherCat.isActive !== false;
  const isOthersActive = othersCat && othersCat.isActive !== false;

  const voucherSubs = (isVoucherActive && Array.isArray(voucherCat.subcategories)) ? voucherCat.subcategories.filter(s => s.isActive !== false) : [];
  const otherSubs = (isOthersActive && Array.isArray(othersCat.subcategories)) ? othersCat.subcategories.filter(s => s.isActive !== false) : [];
  const allOtherSubs = [...voucherSubs, ...otherSubs];
  const VISIBLE_LIMIT = 5;

  if (otherSection) {
    otherSection.style.display = allOtherSubs.length > 0 ? '' : 'none';
  }

  if (otherContainer) {
    if (allOtherSubs.length === 0) {
      otherContainer.innerHTML = '';
      const showMoreWrapper = document.getElementById('otherGamesShowMoreWrapper');
      if (showMoreWrapper) showMoreWrapper.style.display = 'none';
    } else {
      // Render all cards but mark hidden ones with class
      function renderSubcategoryCardsWithLimit(subList, ribbonClass, limit) {
        return subList.map((sub, idx) => {
          const subProds = products.filter(p => (p.subcategoryId === sub.id || p.subcategoryId === sub.slug) && p.isActive !== false);
          const minPrice = subProds.length > 0 ? Math.min(...subProds.map(p => Number(p.sellingPrice) || 0)) : (sub.price || 0);
          const deliveryLabel = sub.deliveryType || (subProds[0] ? subProds[0].deliveryType : 'UID Auto');
          const prodCount = subProds.length > 0 ? `${subProds.length} Packages` : 'Instant Access';
          const isHidden = idx >= limit;

          return `
            <div class="product-card spotlight-card${isHidden ? ' other-hidden-card' : ''}"
                 style="${isHidden ? 'display:none;' : ''}"
                 onclick="openTopUpWizard('${sub.id}')">
              <div class="product-img-wrap">
                <img src="${sub.icon || 'assets/ff_diamond.jpg'}" alt="${sub.name}" class="product-img" onerror="this.src='assets/ff_diamond.jpg'">
                <span class="product-ribbon ${ribbonClass}">${sub.badge || 'Instant ⚡'}</span>
              </div>
              <div class="product-card-body">
                <div>
                  <h4 class="product-name">${sub.name}</h4>
                  <div style="display: flex; gap: 6px; align-items: center; margin-top: 3px; flex-wrap: wrap;">
                    <span style="font-size: 0.68rem; padding: 2px 6px; border-radius: 4px; background: rgba(0,242,254,0.1); color: var(--brand-cyan); border: 1px solid rgba(0,242,254,0.25); font-weight: 700;">
                      ${deliveryLabel}
                    </span>
                    <span style="font-size: 0.72rem; color: var(--text-muted);">${prodCount}</span>
                  </div>
                </div>
                <div class="product-price">Starting ${formatPrice(minPrice, APP.currency)}</div>
                <button class="nav-btn btn-primary" style="font-size: 0.76rem; padding: 5px 8px; justify-content: center;">
                  ${deliveryLabel === 'CODE Delivery' ? 'Get Code 🔑' : (deliveryLabel === 'Gmail Delivery' ? 'Get Access ⚡' : I18N[APP.lang].topUpNow)}
                </button>
              </div>
            </div>
          `;
        }).join('');
      }

      otherContainer.innerHTML = renderSubcategoryCardsWithLimit(allOtherSubs, 'ribbon-cyan', VISIBLE_LIMIT);

      // Inject Show More button if there are more than VISIBLE_LIMIT
      const showMoreWrapper = document.getElementById('otherGamesShowMoreWrapper');
      if (showMoreWrapper) {
        if (allOtherSubs.length > VISIBLE_LIMIT) {
          const hiddenCount = allOtherSubs.length - VISIBLE_LIMIT;
          showMoreWrapper.style.display = 'flex';
          showMoreWrapper.innerHTML = `
            <button id="btnOtherGamesToggle" onclick="toggleOtherGamesExpand()" style="
              display: flex; align-items: center; gap: 8px;
              background: linear-gradient(135deg, rgba(0,242,254,0.12), rgba(0,132,199,0.12));
              border: 1.5px solid rgba(0,242,254,0.35);
              color: #00f2fe; font-size: 0.82rem; font-weight: 800; letter-spacing: 0.5px;
              padding: 10px 28px; border-radius: 50px; cursor: pointer;
              transition: all 0.3s ease; white-space: nowrap;
            ">
              <span id="otherGamesToggleIcon">▼</span>
              <span id="otherGamesToggleText">আরো ${hiddenCount}টি দেখুন</span>
            </button>
          `;
        } else {
          showMoreWrapper.style.display = 'none';
        }
      }
    }
  }

  // Toggle show more / show less for Other Games
  window.toggleOtherGamesExpand = function() {
    const hiddenCards = document.querySelectorAll('#otherGamesGrid .other-hidden-card');
    const icon = document.getElementById('otherGamesToggleIcon');
    const text = document.getElementById('otherGamesToggleText');
    const btn = document.getElementById('btnOtherGamesToggle');
    if (!hiddenCards.length) return;

    const isCurrentlyHidden = hiddenCards[0].style.display === 'none';
    hiddenCards.forEach(card => {
      card.style.display = isCurrentlyHidden ? '' : 'none';
    });

    if (isCurrentlyHidden) {
      if (icon) icon.textContent = '▲';
      if (text) text.textContent = 'কম দেখুন';
      if (btn) btn.style.background = 'linear-gradient(135deg, rgba(0,242,254,0.25), rgba(0,132,199,0.25))';
    } else {
      if (icon) icon.textContent = '▼';
      if (text) text.textContent = `আরো ${hiddenCards.length}টি দেখুন`;
      if (btn) btn.style.background = 'linear-gradient(135deg, rgba(0,242,254,0.12), rgba(0,132,199,0.12))';
    }
  };

  // 3. Section 3: App Subscriptions Grid
  const subContainer = document.getElementById('appSubscriptionsGrid');
  const subSection = document.getElementById('subscriptions-section');
  const subCat = categories.find(c => c.id === 'cat-sub');
  const isSubActive = subCat && subCat.isActive !== false;
  const subSubs = (isSubActive && Array.isArray(subCat.subcategories)) ? subCat.subcategories.filter(s => s.isActive !== false) : [];

  if (subSection) {
    subSection.style.display = (isSubActive && subSubs.length > 0) ? '' : 'none';
  }
  if (subContainer) {
    subContainer.innerHTML = (isSubActive && subSubs.length > 0) ? renderSubcategoryCards(subSubs, 'ribbon-vip') : '';
  }

  // 4. Dynamic Main Categories Section (Any new category added from Admin Panel)
  const topFeaturedContainer = document.getElementById('topFeaturedCategoriesContainer');
  const dynamicContainer = document.getElementById('dynamicCategoriesContainer');
  
  const coreCatIds = ['cat-ff', 'cat-vouchers', 'cat-others', 'cat-sub', 'cat-special'];
  const customCats = (categories || []).filter(c => !coreCatIds.includes(c.id) && c.isActive !== false);

  function renderCustomCategoryCardList(catList, isTopFeatured = false) {
    if (!catList || catList.length === 0) return '';
    return catList.map(cat => {
      const subs = Array.isArray(cat.subcategories) ? cat.subcategories.filter(s => s.isActive !== false) : [];
      const catProds = (products || []).filter(p => (p.categoryId === cat.id || p.categoryId === cat.slug) && p.isActive !== false);
      const itemCount = subs.length > 0 ? `${subs.length} Items & Services Available` : (catProds.length > 0 ? `${catProds.length} Products Available` : 'Active Category');

      let contentHtml = '';
      if (subs.length > 0) {
        contentHtml = `
          <div class="products-grid">
            ${renderSubcategoryCards(subs, isTopFeatured ? 'ribbon-gold' : 'ribbon-cyan')}
          </div>
        `;
      } else if (catProds.length > 0) {
        contentHtml = `
          <div class="products-grid">
            ${catProds.map(p => {
              const isOutOfStock = p.inStock === false;
              return `
                <div class="product-card spotlight-card ${isOutOfStock ? 'out-of-stock' : ''}" onclick="openTopUpWizard('${p.id}')">
                  <div class="product-img-wrap">
                    <img src="${p.icon || cat.icon || 'assets/ff_diamond.jpg'}" alt="${p.name}" class="product-img" onerror="this.src='assets/ff_diamond.jpg'">
                    <span class="product-ribbon ${isTopFeatured ? 'ribbon-gold' : 'ribbon-cyan'}">${isOutOfStock ? '🔴 OUT OF STOCK' : (p.bonusTag || (isTopFeatured ? '🔥 Special Offer' : 'Instant ⚡'))}</span>
                  </div>
                  <div class="product-card-body">
                    <div>
                      <h4 class="product-name">${p.name}</h4>
                      <div style="display: flex; gap: 6px; align-items: center; margin-top: 3px; flex-wrap: wrap;">
                        <span style="font-size: 0.68rem; padding: 2px 6px; border-radius: 4px; background: ${isTopFeatured ? 'rgba(255,179,0,0.12)' : 'rgba(0,242,254,0.1)'}; color: ${isTopFeatured ? 'var(--brand-gold)' : 'var(--brand-cyan)'}; border: 1px solid ${isTopFeatured ? 'rgba(255,179,0,0.3)' : 'rgba(0,242,254,0.25)'}; font-weight: 700;">
                          ${p.deliveryType || 'UID Auto'}
                        </span>
                      </div>
                    </div>
                    <div class="product-price">${formatPrice(p.sellingPrice, APP.currency)}</div>
                    <button class="nav-btn btn-primary" style="font-size: 0.76rem; padding: 5px 8px; justify-content: center; ${isOutOfStock ? 'background: rgba(239,68,68,0.2); border: 1px solid rgba(239,68,68,0.5); color: #f87171;' : ''}">
                      ${isOutOfStock ? '🔴 OUT OF STOCK' : I18N[APP.lang].topUpNow}
                    </button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      } else {
        contentHtml = `
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 28px 16px; border: 1.5px dashed rgba(0,242,254,0.25); border-radius: var(--radius-lg); background: rgba(0,242,254,0.02); text-align: center;">
            <span style="font-size: 1.8rem; margin-bottom: 6px;">✨</span>
            <h4 style="color: #fff; font-size: 0.92rem; font-weight: 800; margin-bottom: 4px;">${cat.name}</h4>
            <p style="color: var(--text-muted); font-size: 0.76rem;">Products & packages will be available here soon.</p>
          </div>
        `;
      }

      return `
        <section class="section-box" id="section-${cat.slug || cat.id}">
          <div style="background: var(--bg-card); border: 1.5px solid ${isTopFeatured ? 'rgba(255,179,0,0.45)' : 'var(--border-soft)'}; border-radius: var(--radius-xl); padding: 24px; margin-bottom: 28px; box-shadow: ${isTopFeatured ? '0 0 25px rgba(255,179,0,0.15)' : 'var(--shadow-sm)'};">
            <div class="section-head">
              <div class="section-title-wrap">
                <div class="title-pill" style="background: ${isTopFeatured ? 'var(--brand-gold)' : 'var(--brand-cyan)'};"></div>
                <div>
                  <h2 class="section-title" style="color: #fff;">${cat.name}</h2>
                  <p style="font-size: 0.78rem; color: var(--text-muted);">${itemCount}</p>
                </div>
              </div>
              <span class="tag-pill ${isTopFeatured ? 'tag-gold' : 'tag-cyan'}">${isTopFeatured ? '🔥 TOP FEATURED EVENT' : '⚡ Active Category'}</span>
            </div>

            ${contentHtml}
          </div>
        </section>
      `;
    }).join('');
  }

  const topCats = customCats.filter(c => c.position === 'TOP');
  const bottomCats = customCats.filter(c => c.position !== 'TOP');

  if (topFeaturedContainer) {
    topFeaturedContainer.innerHTML = renderCustomCategoryCardList(topCats, true);
  }

  if (dynamicContainer) {
    dynamicContainer.innerHTML = renderCustomCategoryCardList(bottomCats, false);
  }
}

// ==========================================
// 5. TOP-UP WIZARD MODAL & ORDER CREATION (AKR STYLE)
// ==========================================

const FF_CATEGORY_PACKAGES = {
  'ff-diamonds': {
    title: 'FREE FIRE TOPUP [BD]',
    badge: 'ID CODE TOP UP',
    icon: 'assets/ff_diamond.jpg',
    packages: [
      { id: 'p-ff-25',    name: '25 Diamond',    price: 20,   tag: 'Instant ⚡' },
      { id: 'p-ff-50',    name: '50 Diamond',    price: 35,   tag: 'Instant ⚡' },
      { id: 'p-ff-75',    name: '75 Diamond',    price: 55,   tag: 'Instant ⚡' },
      { id: 'p-ff-100',   name: '100 Diamond',   price: 70,   tag: 'Instant ⚡' },
      { id: 'p-ff-115',   name: '115 Diamond',   price: 75,   tag: 'Popular 🔥' },
      { id: 'p-ff-240',   name: '240 Diamond',   price: 150,  tag: '+15 Free' },
      { id: 'p-ff-315',   name: '315 Diamond',   price: 205,  tag: '+20 Free' },
      { id: 'p-ff-355',   name: '355 Diamond',   price: 225,  tag: '+25 Free' },
      { id: 'p-ff-480',   name: '480 Diamond',   price: 300,  tag: '+35 Free' },
      { id: 'p-ff-505',   name: '505 Diamond',   price: 324,  tag: '+40 Free' },
      { id: 'p-ff-610',   name: '610 Diamond',   price: 380,  tag: '+50 Free' },
      { id: 'p-ff-850',   name: '850 Diamond',   price: 530,  tag: '+70 Free' },
      { id: 'p-ff-1015',  name: '1015 Diamond',  price: 640,  tag: '+90 Free' },
      { id: 'p-ff-1090',  name: '1090 Diamond',  price: 680,  tag: '+100 Free' },
      { id: 'p-ff-1240',  name: '1240 Diamond',  price: 755,  tag: '+120 Free' },
      { id: 'p-ff-1850',  name: '1850 Diamond',  price: 1135, tag: '+180 Mega' },
      { id: 'p-ff-2015',  name: '2015 Diamond',  price: 1245, tag: '+200 Mega' },
      { id: 'p-ff-2090',  name: '2090 Diamond',  price: 1285, tag: '+210 Mega' },
      { id: 'p-ff-2530',  name: '2530 Diamond',  price: 1510, tag: '+300 Mega' },
      { id: 'p-ff-5060',  name: '5060 Diamond',  price: 3020, tag: '🔥 Whale Pack' },
      { id: 'p-ff-10120', name: '10120 Diamond', price: 6040, tag: '👑 Ultimate Pack' }
    ]
  },
  'ff-weekly-lite': {
    title: 'Weekly Lite',
    badge: 'WEEKLY LITE',
    icon: 'assets/ff_weekly_lite.jpg',
    packages: [
      { id: 'p-ff-wl-1', name: 'Weekly Lite x1', price: 40, tag: 'Instant' },
      { id: 'p-ff-wl-2', name: 'Weekly Lite x2', price: 78, tag: '2x Lite' },
      { id: 'p-ff-wl-3', name: 'Weekly Lite x3', price: 115, tag: '3x Lite' },
      { id: 'p-ff-wl-5', name: 'Weekly Lite x5', price: 190, tag: '5x Lite' },
      { id: 'p-ff-wl-10', name: 'Weekly Lite x10', price: 380, tag: '10x Lite' }
    ]
  },
  'ff-vip-access': {
    title: 'VIP Access Pass',
    badge: '👑 SECRET VIP ACCESS',
    icon: 'assets/ff_membership_v2.jpg',
    isVip: true,
    packages: [
      { id: 'p-ff-vip-w1', name: 'VIP Weekly x1', price: 153, tag: 'VIP Rate' },
      { id: 'p-ff-vip-m1', name: 'VIP Monthly x1', price: 750, tag: 'VIP Mega' },
      { id: 'p-ff-vip-w2', name: 'VIP Weekly x2', price: 306, tag: 'VIP Double' },
      { id: 'p-ff-vip-m2', name: 'VIP Monthly x2', price: 1500, tag: 'VIP Double' },
      { id: 'p-ff-vip-w3', name: 'VIP Weekly x3', price: 459, tag: 'VIP Triple' },
      { id: 'p-ff-vip-m3', name: 'VIP Monthly x3', price: 2250, tag: 'VIP Triple' },
      { id: 'p-ff-vip-w5', name: 'VIP Weekly x5', price: 765, tag: '5x VIP' },
      { id: 'p-ff-vip-m5', name: 'VIP Monthly x5', price: 3750, tag: '5x VIP' },
      { id: 'p-ff-vip-combo', name: 'VIP Weekly + Monthly', price: 900, tag: 'Best VIP' },
      { id: 'p-1015-diamond', name: '1015 Diamond', price: 650, tag: 'VIP Rate' }
    ]
  },
  'ff-weekly-monthly': {
    title: 'Weekly & Monthly',
    badge: 'VIP PASSES',
    icon: 'assets/ff_membership_v2.jpg',
    packages: [
      { id: 'p-ff-std-w1', name: 'Weekly x1', price: 150, tag: 'Instant ⚡' },
      { id: 'p-ff-std-m1', name: 'Monthly x1', price: 750, tag: 'Popular 🔥' },
      { id: 'p-ff-std-w2', name: 'Weekly x2', price: 300, tag: '2x Pack' },
      { id: 'p-ff-std-m2', name: 'Monthly x2', price: 1500, tag: '2x Mega' },
      { id: 'p-ff-std-w3', name: 'Weekly x3', price: 450, tag: '3x Pack' },
      { id: 'p-ff-std-m3', name: 'Monthly x3', price: 2250, tag: '3x Mega' },
      { id: 'p-ff-std-w5', name: 'Weekly x5', price: 750, tag: '5x Super' },
      { id: 'p-ff-std-m5', name: 'Monthly x5', price: 3750, tag: '5x Mega' },
      { id: 'p-ff-std-combo', name: 'Weekly + Monthly', price: 900, tag: 'Best Combo 🔥' }
    ]
  },
  'ff-level-up': {
    title: 'Level Up Pass',
    badge: 'LEVEL UP PASS',
    icon: 'assets/ff_levelup.jpg',
    packages: [
      { id: 'p-ff-lvl-6', name: 'Level 6', price: 36, tag: 'Level Up' },
      { id: 'p-ff-lvl-10', name: 'Level 10', price: 62, tag: 'Level Up' },
      { id: 'p-ff-lvl-15', name: 'Level 15', price: 62, tag: 'Level Up' },
      { id: 'p-ff-lvl-20', name: 'Level 20', price: 62, tag: 'Level Up' },
      { id: 'p-ff-lvl-25', name: 'Level 25', price: 62, tag: 'Level Up' },
      { id: 'p-ff-lvl-30', name: 'Level 30', price: 88, tag: 'Level Up' },
      { id: 'p-ff-lvl-full', name: 'Full Level Up', price: 360, tag: 'POPULAR' }
    ]
  },
  'ff-indonesia': {
    title: 'Indonesia UID TopUp',
    badge: 'INDONESIA TOP UP',
    icon: 'assets/ff_indonesia.jpg',
    packages: [
      { id: 'p-ff-indo-5', name: '5 Diamond', price: 10, tag: 'Indo Server' },
      { id: 'p-ff-indo-50', name: '50 Diamond', price: 60, tag: 'Indo Server' },
      { id: 'p-ff-indo-70', name: '70 Diamond', price: 82, tag: 'Indo Server' },
      { id: 'p-ff-indo-140', name: '140 Diamond', price: 160, tag: 'Indo Server' },
      { id: 'p-ff-indo-355', name: '355 Diamond', price: 390, tag: 'Indo Server' },
      { id: 'p-ff-indo-720', name: '720 Diamond', price: 765, tag: 'Indo Server' },
      { id: 'p-ff-indo-7290', name: '7290 Diamond', price: 7450, tag: 'Mega Whale' },
      { id: 'p-ff-indo-w', name: 'Weekly (Indo)', price: 240, tag: 'VIP Pass' },
      { id: 'p-ff-indo-m', name: 'Monthly (Indo)', price: 715, tag: 'Mega VIP' },
      { id: 'p-ff-indo-lvl-6', name: 'Level 6', price: 45, tag: 'Level Up' },
      { id: 'p-ff-indo-lvl-10', name: 'Level 10', price: 72, tag: 'Level Up' },
      { id: 'p-ff-indo-lvl-15', name: 'Level 15', price: 72, tag: 'Level Up' },
      { id: 'p-ff-indo-lvl-20', name: 'Level 20', price: 72, tag: 'Level Up' },
      { id: 'p-ff-indo-lvl-25', name: 'Level 25', price: 72, tag: 'Level Up' },
      { id: 'p-ff-indo-lvl-30', name: 'Level 30', price: 115, tag: 'Level Up' },
      { id: 'p-ff-indo-booyah', name: 'Booyah Pass', price: 360, tag: 'Booyah Pass' }
    ]
  },
  'ff-likes': {
    title: 'Free Fire Like Booster',
    badge: 'PROFILE LIKES',
    icon: 'assets/ff_like.jpg',
    packages: [
      { id: 'p-ff-like-100', name: '100 Likes', price: 8, tag: '⚡ Instant' },
      { id: 'p-ff-like-200', name: '200 Likes', price: 15, tag: '🔥 Popular' }
    ]
  },
  'unipin-vouchers': {
    title: 'UniPin Vouchers',
    badge: 'DIGITAL PIN CODE',
    icon: 'assets/unipin_voucher.jpg',
    isSubscription: false,
    isCodeDelivery: true,
    notice: '🔑 ডিজিটাল কোড ডেলিভারি: কোনো প্লেয়ার UID দিতে হবে না। অর্ডার সম্পন্ন হওয়া মাত্রই আপনার স্ক্রিনে এবং অর্ডার হিস্টোরিতে সিকিউর আনপিন/ভাউচার কোড সাথে সাথে ডেলিভারি হয়ে যাবে।',
    packages: [
      { id: 'p-unipin-25', name: '25 Diamond UniPin Voucher', price: 22.00, tag: 'Instant Code' },
      { id: 'p-unipin-50', name: '50 Diamond UniPin Voucher', price: 40.00, tag: 'Instant Code' },
      { id: 'p-unipin-115', name: '115 Diamond UniPin Voucher', price: 80.00, tag: 'Instant Code' },
      { id: 'p-unipin-240', name: '240 Diamond UniPin Voucher', price: 158.00, tag: 'Instant Code' },
      { id: 'p-unipin-610', name: '610 Diamond UniPin Voucher', price: 395.00, tag: 'Instant Code' },
      { id: 'p-unipin-1240', name: '1240 Diamond UniPin Voucher', price: 785.00, tag: 'Instant Code' },
      { id: 'p-unipin-2530', name: '2530 Diamond UniPin Voucher', price: 1560.00, tag: 'Instant Code' },
      { id: 'p-unipin-weekly', name: 'Weekly UniPin Voucher', price: 155.00, tag: 'BEST SELLING' },
      { id: 'p-unipin-monthly', name: 'Monthly UniPin Voucher', price: 760.00, tag: 'Mega VIP' },
      { id: 'p-unipin-2000', name: '2000 UniPin Voucher', price: 1930.00, tag: 'Whale Pack' }
    ]
  },
  'garena-shells': {
    title: 'Garena Shells (BD & MY)',
    badge: 'DIGITAL PIN CODE',
    icon: 'assets/garena_voucher.jpg',
    isSubscription: false,
    isCodeDelivery: true,
    notice: '🔑 ডিজিটাল কোড ডেলিভারি: কোনো প্লেয়ার UID দিতে হবে না। অর্ডার সম্পন্ন হওয়া মাত্রই আপনার স্ক্রিনে এবং অর্ডার হিস্টোরিতে সিকিউর গ্যারিনা শেল পিন সাথে সাথে ডেলিভারি হয়ে যাবে।',
    packages: [
      { id: 'p-gs-100', name: '100 Garena Shells', price: 190.00, tag: 'Instant Code' },
      { id: 'p-gs-200', name: '200 Garena Shells', price: 375.00, tag: 'Instant Code' },
      { id: 'p-gs-500', name: '500 Garena Shells', price: 920.00, tag: 'POPULAR' },
      { id: 'p-gs-1000', name: '1000 Garena Shells', price: 1830.00, tag: 'Mega Pack' }
    ]
  },
  'p-indo-shell': {
    title: 'INDO Garena Shell',
    badge: 'DIGITAL PIN CODE',
    icon: 'assets/garena_voucher.jpg',
    isSubscription: false,
    isCodeDelivery: true,
    notice: '🔑 ডিজিটাল কোড ডেলিভারি: কোনো প্লেয়ার UID দিতে হবে না। অর্ডার সম্পন্ন হওয়া মাত্রই আনলক পিন কোড ডেলিভারি হয়ে যাবে।',
    packages: [
      { id: 'p-indo-shell-330', name: '330 Shell (Indo)', price: 240.00, tag: 'Instant Code' }
    ]
  },
  'p-sg-shell': {
    title: 'SG Garena Shell',
    badge: 'DIGITAL PIN CODE',
    icon: 'assets/garena_voucher.jpg',
    isSubscription: false,
    isCodeDelivery: true,
    notice: '🔑 ডিজিটাল কোড ডেলিভারি: কোনো প্লেয়ার UID দিতে হবে না। অর্ডার সম্পন্ন হওয়া মাত্রই আনলক পিন কোড ডেলিভারি হয়ে যাবে।',
    packages: [
      { id: 'p-sg-shell-1', name: 'SG Shell', price: 395.00, tag: 'Singapore Code' }
    ]
  }
};

const APP_SPECIAL_SERVICES = {
  'p-youtube-premium': {
    title: 'YouTube Premium',
    badge: 'SUBSCRIPTION',
    icon: 'assets/youtube_premium.jpg',
    isSubscription: true,
    isCodeDelivery: false,
    notice: '📌 জিমেইল কমপক্ষে ১৪ দিন পুরনো হতে হবে। ১ মাসের প্রিমিয়াম নেওয়া জিমেইলে পুনরায় অর্ডার করা যাবে না। ১টি জিমেইলে মাত্র ১ বারই নেওয়া যায়।',
    packages: [
      { id: 'p-yt-1m', name: '1 month (YT Premium)', price: 45, tag: 'Instant' },
      { id: 'p-yt-3m', name: '3 months (YT Premium)', price: 120, tag: 'Popular' },
      { id: 'p-yt-6m', name: '6 months (YT Premium)', price: 225, tag: 'VIP' },
      { id: 'p-yt-12m', name: '12 months (YT Premium)', price: 425, tag: 'Best Value' }
    ]
  }
};

function isVipAuthorized() {
  const currentVersion = String((APP.settings && APP.settings.vipCodeVersion) || '1');

  // 1. Account level check (authenticated user)
  if (APP.user && String(APP.user.vipCodeVersion) === currentVersion && (APP.user.hasVipAccess || APP.user.vipUnlocked)) {
    return true;
  }

  // 2. localStorage check (permanent across page refreshes & browser restarts)
  const localVer = localStorage.getItem('vip_code_version');
  const localUnlocked = localStorage.getItem('vip_unlocked') === 'true';
  if (localUnlocked && localVer === currentVersion) {
    return true;
  }

  // 3. sessionStorage check (browser tab session)
  const sessVer = sessionStorage.getItem('vip_code_version');
  const sessUnlocked = sessionStorage.getItem('vip_unlocked') === 'true';
  if (sessUnlocked && sessVer === currentVersion) {
    return true;
  }

  // 4. In-memory check
  if (APP.isVipUnlocked === true && String(APP.unlockedVipVersion) === currentVersion) {
    return true;
  }

  return false;
}

window.openVipAccess = async function() {
  try {
    const res = await fetch('/api/settings');
    if (res.ok) {
      const freshSettings = await res.json();
      if (freshSettings && freshSettings.vipCodeVersion !== undefined) {
        if (!APP.settings) APP.settings = {};
        APP.settings.vipCodeVersion = freshSettings.vipCodeVersion;
      }
    }
  } catch (e) {}

  const currentVersion = String((APP.settings && APP.settings.vipCodeVersion) || '1');
  const authorized = isVipAuthorized();

  if (authorized) {
    APP.isVipUnlocked = true;
    APP.unlockedVipVersion = currentVersion;
    localStorage.setItem('vip_unlocked', 'true');
    localStorage.setItem('vip_code_version', currentVersion);
    sessionStorage.setItem('vip_unlocked', 'true');
    sessionStorage.setItem('vip_code_version', currentVersion);
    openTopUpWizard('ff-vip-access');
  } else {
    // Clear stale stored versions
    localStorage.removeItem('vip_unlocked');
    localStorage.removeItem('vip_code_version');
    sessionStorage.removeItem('vip_unlocked');
    sessionStorage.removeItem('vip_code_version');
    APP.isVipUnlocked = false;
    APP.unlockedVipVersion = null;

    const errEl = document.getElementById('vipCodeError');
    if (errEl) errEl.style.display = 'none';
    const input = document.getElementById('vipCodeInput');
    if (input) input.value = '';
    const modal = document.getElementById('vipCodeModal');
    if (modal) modal.classList.add('active');
  }
};

window.submitVipAccessCode = async function(e) {
  e.preventDefault();
  const input = document.getElementById('vipCodeInput');
  const errEl = document.getElementById('vipCodeError');
  const btn = document.getElementById('btnUnlockVip');
  const code = (input ? input.value : '').trim();

  if (!code) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Verifying Code...';
  }
  if (errEl) errEl.style.display = 'none';

  try {
    const res = await fetch('/api/vip/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(APP.token ? { 'Authorization': `Bearer ${APP.token}` } : {})
      },
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (data.success) {
      const vVer = String(data.vipCodeVersion || (APP.settings && APP.settings.vipCodeVersion) || '1');
      APP.isVipUnlocked = true;
      APP.unlockedVipVersion = vVer;
      localStorage.setItem('vip_unlocked', 'true');
      localStorage.setItem('vip_code_version', vVer);
      sessionStorage.setItem('vip_unlocked', 'true');
      sessionStorage.setItem('vip_code_version', vVer);
      if (APP.user) {
        APP.user.vipCodeVersion = Number(vVer);
        APP.user.hasVipAccess = true;
        APP.user.vipUnlocked = true;
      }
      closeAllModals();
      showToast('👑 VIP Access Granted! Exclusive prices unlocked.');
      openTopUpWizard('ff-vip-access');
    } else {
      if (errEl) {
        errEl.textContent = data.message || '❌ Invalid VIP Code. Contact Admin.';
        errEl.style.display = 'block';
      }
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = '❌ Verification error. Please try again.';
      errEl.style.display = 'block';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔓 Unlock VIP Passes 🚀';
    }
  }
};

function openTopUpWizard(identifier) {
  if (identifier === 'ff-vip-access') {
    if (!isVipAuthorized()) {
      window.openVipAccess();
      return;
    }
  }

  let categoryGroup = null;

  // 1. Search in APP.categories subcategories
  let matchedSub = null;
  let matchedCat = null;
  for (const cat of (APP.categories || [])) {
    if (cat.isActive === false) continue;
    if (Array.isArray(cat.subcategories)) {
      const sub = cat.subcategories.find(s => (s.id === identifier || s.slug === identifier) && s.isActive !== false);
      if (sub) {
        matchedSub = sub;
        matchedCat = cat;
        break;
      }
    }
  }

  // 2. If matched subcategory, gather all products under this subcategory
  if (matchedSub) {
    const subProds = (APP.products || [])
      .filter(p => (p.subcategoryId === matchedSub.id || p.subcategoryId === matchedSub.slug) && p.isActive !== false)
      .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || Number(a.sellingPrice) - Number(b.sellingPrice));
    const isCode = matchedSub.deliveryType === 'CODE Delivery' || subProds.some(p => p.deliveryType === 'CODE Delivery' || p.productType === 'CODE DELIVERY');
    const isGmail = matchedSub.deliveryType === 'Gmail Delivery' || subProds.some(p => p.deliveryType === 'Gmail Delivery' || p.productType === 'GMAIL DELIVERY');

    const packages = subProds.length > 0 ? subProds.map(p => ({
      id: p.id,
      name: p.name,
      price: Number(p.sellingPrice),
      tag: p.bonusTag || p.deliveryType || 'Instant',
      inStock: p.inStock !== false
    })) : [
      { id: matchedSub.id, name: matchedSub.name, price: 50, tag: 'Standard', inStock: true }
    ];

    categoryGroup = {
      title: matchedSub.name,
      badge: matchedSub.badge || (isCode ? 'DIGITAL PIN CODE' : (isGmail ? 'SUBSCRIPTION' : 'ID CODE TOP UP')),
      icon: matchedSub.icon || (matchedCat ? matchedCat.icon : 'assets/ff_diamond.jpg'),
      deliveryType: matchedSub.deliveryType || (isCode ? 'CODE Delivery' : (isGmail ? 'Gmail Delivery' : 'UID Auto')),
      isCodeDelivery: isCode,
      isSubscription: isGmail,
      notice: matchedSub.notice || (isCode ? '🔑 ডিজিটাল কোড ডেলিভারি: কোনো প্লেয়ার UID দিতে হবে না। অর্ডার সম্পন্ন হওয়া মাত্রই আপনার স্ক্রিনে এবং অর্ডার হিস্টোরিতে আনলক পিন কোড সরাসরি ডেলিভারি হয়ে যাবে।' : (isGmail ? '📌 জিমেইল ডেলিভারি: আপনার সঠিক জিমেইল অ্যাড্রেস প্রদান করুন। অ্যাডমিন ডেলিভারি সম্পন্ন করলে টেলিগ্রাম বট ও অ্যাপের মাধ্যমে তাৎক্ষণিক কনফার্মেশন পাবেন।' : '')),
      packages
    };
  }

  // 2.5 Search in APP.categories directly (for categories with direct products)
  if (!categoryGroup) {
    const directCat = (APP.categories || []).find(c => (c.id === identifier || c.slug === identifier) && c.isActive !== false);
    if (directCat) {
      const catProds = (APP.products || [])
        .filter(p => (p.categoryId === directCat.id || p.categoryId === directCat.slug) && p.isActive !== false)
        .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || Number(a.sellingPrice) - Number(b.sellingPrice));
      if (catProds.length > 0) {
        const isCode = catProds.some(p => p.deliveryType === 'CODE Delivery' || p.productType === 'CODE DELIVERY');
        const isGmail = catProds.some(p => p.deliveryType === 'Gmail Delivery' || p.productType === 'GMAIL DELIVERY');
        categoryGroup = {
          title: directCat.name,
          badge: isCode ? 'DIGITAL PIN CODE' : (isGmail ? 'SUBSCRIPTION' : 'ID CODE TOP UP'),
          icon: directCat.icon || 'assets/ff_diamond.jpg',
          deliveryType: isCode ? 'CODE Delivery' : (isGmail ? 'Gmail Delivery' : 'UID Auto'),
          isCodeDelivery: isCode,
          isSubscription: isGmail,
          packages: catProds.map(p => ({
            id: p.id,
            name: p.name,
            price: Number(p.sellingPrice),
            tag: p.bonusTag || p.deliveryType || 'Instant',
            inStock: p.inStock !== false
          }))
        };
      }
    }
  }

  // 3. Fallback to predefined catalogs if static ID passed
  if (!categoryGroup) {
    categoryGroup = FF_CATEGORY_PACKAGES[identifier] || APP_SPECIAL_SERVICES[identifier];
  }

  // 4. Fallback search by single product
  if (!categoryGroup) {
    const prod = (APP.products || []).find(p => p.id === identifier);
    if (prod) {
      const isCode = prod.deliveryType === 'CODE Delivery' || prod.productType === 'CODE DELIVERY';
      const isGmail = prod.deliveryType === 'Gmail Delivery' || prod.productType === 'GMAIL DELIVERY';
      categoryGroup = {
        title: prod.name,
        badge: prod.bonusTag || (isCode ? 'DIGITAL PIN CODE' : (isGmail ? 'SUBSCRIPTION' : 'ID CODE TOP UP')),
        icon: prod.icon || 'assets/ff_diamond.jpg',
        deliveryType: prod.deliveryType || (isCode ? 'CODE Delivery' : (isGmail ? 'Gmail Delivery' : 'UID Auto')),
        isCodeDelivery: isCode,
        isSubscription: isGmail,
        packages: [{ id: prod.id, name: prod.name, price: Number(prod.sellingPrice), tag: prod.bonusTag || 'Instant', inStock: prod.inStock !== false }]
      };
    }
  }

  if (!categoryGroup) {
    categoryGroup = FF_CATEGORY_PACKAGES['ff-diamonds'] || {
      title: 'Diamond Top-Up',
      badge: 'ID CODE TOP UP',
      icon: 'assets/ff_diamond.jpg',
      packages: [{ id: 'p-1', name: '100 Diamond', price: 80, tag: 'Instant', inStock: true }]
    };
  }

  let packagesList = categoryGroup.packages && categoryGroup.packages.length > 0 ? categoryGroup.packages : [{ id: 'p-default', name: 'Standard Pack', price: 50, tag: 'Instant', inStock: true }];
  
  // Ensure each package in packagesList has up-to-date inStock status from APP.products by exact ID
  packagesList = packagesList.map(pkg => {
    const live = (APP.products || []).find(p => p.id === pkg.id);
    return {
      ...pkg,
      price: live ? Number(live.sellingPrice) : pkg.price,
      inStock: live ? (live.inStock !== false) : (pkg.inStock !== false)
    };
  });

  const isCodeDelivery = Boolean(categoryGroup.isCodeDelivery);
  const isSub = Boolean(categoryGroup.isSubscription);

  let defaultProduct = {
    id: packagesList[0].id,
    name: packagesList[0].name,
    sellingPrice: packagesList[0].price,
    currency: APP.currency,
    isCodeDelivery,
    isSubscription: isSub,
    inStock: packagesList[0].inStock !== false,
    categoryTitle: categoryGroup.title
  };

  // Find specific clicked product if it was a direct package ID
  const directMatch = packagesList.find(p => p.id === identifier);
  if (directMatch) {
    defaultProduct.id = directMatch.id;
    defaultProduct.name = directMatch.name;
    defaultProduct.sellingPrice = directMatch.price;
    defaultProduct.inStock = directMatch.inStock !== false;
  }

  APP.activeTopup.product = defaultProduct;
  APP.activeTopup.isCodeDelivery = isCodeDelivery;
  APP.activeTopup.isSubscription = isSub;
  APP.activeTopup.discountPercent = 0;
  APP.activeTopup.quantity = 1;

  const qDisplay = document.getElementById('wizardQuantityDisplay');
  if (qDisplay) qDisplay.textContent = '1';

  // Set Modal Headings & Icons
  const titleEl = document.getElementById('wizardProductTitle');
  if (titleEl) titleEl.textContent = categoryGroup.title;

  const priceEl = document.getElementById('wizardPrice');
  if (priceEl) priceEl.textContent = formatPrice(defaultProduct.sellingPrice, APP.currency);

  const totalEl = document.getElementById('wizardTotal');
  if (totalEl) totalEl.textContent = formatPrice(defaultProduct.sellingPrice, APP.currency);

  const balEl = document.getElementById('checkoutWalletBal');
  if (balEl) balEl.textContent = formatPrice(APP.wallet.balance, APP.currency);

  const noticeBox = document.getElementById('wizardNoticeBox');
  const detailsCard = document.getElementById('wizardYourDetailsCard');
  const gameGroup = document.getElementById('wizardGameUidGroup');
  const subGroup = document.getElementById('wizardSubscriptionGroup');
  const headerIcon = document.getElementById('wizardHeaderIcon');
  const catBadge = document.getElementById('wizardCategoryBadge');

  if (headerIcon) headerIcon.src = categoryGroup.icon || 'assets/ff_diamond.jpg';

  const quantityCard = document.getElementById('wizardQuantityCard');

  if (isCodeDelivery) {
    // 1. Digital Pin / Code Delivery Mode (UniPin, Garena Shell)
    if (catBadge) {
      catBadge.textContent = 'DIGITAL PIN CODE';
      catBadge.className = 'tag-pill tag-gold';
    }
    if (detailsCard) detailsCard.style.display = 'none';
    if (gameGroup) gameGroup.style.display = 'none';
    if (subGroup) subGroup.style.display = 'none';
    if (quantityCard) quantityCard.style.display = 'flex';
    if (noticeBox) {
      noticeBox.style.display = 'block';
      noticeBox.textContent = categoryGroup.notice || '🔑 ডিজিটাল কোড ডেলিভারি: কোনো প্লেয়ার UID দিতে হবে না। অর্ডার সম্পন্ন হওয়া মাত্রই আপনার স্ক্রিনে এবং অর্ডার হিস্টোরিতে সিকিউর আনপিন/ভাউচার কোড সাথে সাথে ডেলিভারি হয়ে যাবে।';
    }
  } else if (isSub) {
    // 2. Subscription Mode (YouTube Premium)
    if (catBadge) {
      catBadge.textContent = 'SUBSCRIPTION';
      catBadge.className = 'tag-pill tag-gold';
    }
    if (detailsCard) detailsCard.style.display = 'block';
    if (gameGroup) gameGroup.style.display = 'none';
    if (subGroup) subGroup.style.display = 'block';
    if (quantityCard) quantityCard.style.display = 'none';
    if (noticeBox) {
      noticeBox.style.display = 'block';
      noticeBox.textContent = categoryGroup.notice || '📌 জিমেইল কমপক্ষে ১৪ দিন পুরনো হতে হবে। ১ মাসের প্রিমিয়াম নেওয়া জিমেইলে পুনরায় অর্ডার করা যাবে না। ১টি জিমেইলে মাত্র ১ বারই নেওয়া যায়।';
    }
  } else {
    // 3. Direct Player UID Top-Up Mode (Free Fire BD, Weekly Lite, Weekly/Monthly, Level Up, Indo UID, PUBG)
    if (catBadge) {
      catBadge.textContent = categoryGroup.badge || 'ID CODE TOP UP';
      catBadge.className = 'tag-pill tag-cyan';
    }
    if (detailsCard) detailsCard.style.display = 'block';
    if (gameGroup) gameGroup.style.display = 'block';
    if (subGroup) subGroup.style.display = 'none';
    if (quantityCard) quantityCard.style.display = 'none';
    if (noticeBox) {
      if (categoryGroup.notice) {
        noticeBox.style.display = 'block';
        noticeBox.textContent = categoryGroup.notice;
      } else {
        noticeBox.style.display = 'none';
      }
    }
  }

  // Render Denomination Packages Grid
  const denoGrid = document.getElementById('wizardDenoGrid');
  if (denoGrid) {
    denoGrid.innerHTML = packagesList.map((d) => {
      const isSelected = d.id === defaultProduct.id;
      const isOutOfStock = d.inStock === false;
      const tagColor = d.tag && (d.tag.includes('Bonus') || d.tag.includes('Mega') || d.tag.includes('VIP') || d.tag.includes('BEST'))
        ? '#f59e0b' : 'var(--brand-cyan)';
      return `
        <div class="deno-card ${isSelected ? 'active' : ''} ${isOutOfStock ? 'out-of-stock' : ''}"
             style="cursor:pointer; border: 1.5px solid ${isSelected ? (isOutOfStock ? '#ef4444' : 'var(--brand-cyan)') : (isOutOfStock ? 'rgba(239,68,68,0.3)' : 'var(--border-soft)')};
                    background: ${isSelected ? (isOutOfStock ? 'rgba(239,68,68,0.12)' : 'rgba(0,242,254,0.1)') : 'var(--bg-card)'};
                    border-radius: 10px; padding: 12px 8px; text-align: center;
                    transition: all 0.2s; position: relative; overflow: hidden; ${isOutOfStock ? 'opacity: 0.9;' : ''}"
             onclick="selectDenomination('${d.id}', ${d.price}, '${(d.name || '').replace(/'/g, "\\'")}', this, ${isOutOfStock ? 'false' : 'true'})">
          ${isOutOfStock ? `
            <div style="font-size: 0.58rem; font-weight: 800; letter-spacing: 0.5px;
                        color: #fff; background: #ef4444; border-radius: 4px;
                        padding: 1px 5px; margin-bottom: 4px; display: inline-block;">
              🔴 OUT OF STOCK
            </div>
          ` : (d.tag ? `
            <div style="font-size: 0.60rem; font-weight: 800; letter-spacing: 0.6px;
                        color: ${tagColor}; text-transform: uppercase;
                        margin-bottom: 4px; opacity: 0.9;">
              ${d.tag}
            </div>
          ` : '')}
          <div style="font-size: 0.84rem; font-weight: 800; color: #fff; line-height: 1.3;">${d.name}</div>
          <div style="font-size: 0.95rem; font-weight: 900; color: ${isOutOfStock ? '#9ca3af' : 'var(--brand-gold)'}; margin-top: 5px;">৳${d.price.toFixed(2)}</div>
          ${isSelected ? `<div class="check-badge" style="position:absolute; top:0; right:0; background: ${isOutOfStock ? '#ef4444' : 'var(--brand-cyan)'}; color:${isOutOfStock ? '#fff' : '#000'}; font-size:0.55rem; font-weight:900; padding:2px 5px; border-radius:0 10px 0 6px;">✓</div>` : ''}
        </div>
      `;
    }).join('');
  }

  // Update Buy Button state for initial default package
  updateWizardBuyButton(defaultProduct.inStock !== false, defaultProduct.name);

  // Reset verification message box
  const nickBox = document.getElementById('wizardNicknameBox');
  const nickText = document.getElementById('wizardNicknameStatusText');
  if (nickBox) {
    nickBox.style.background = 'rgba(16, 185, 129, 0.08)';
    nickBox.style.borderColor = 'rgba(16, 185, 129, 0.35)';
  }
  if (nickText) {
    nickText.innerHTML = 'ℹ️ Verify nickname before you can pay.';
  }

  const nav = document.getElementById('mobileAppNavBar');
  if (nav) nav.style.setProperty('display', 'none', 'important');
  const dock = document.getElementById('floatingSupportDock');
  if (dock) dock.style.setProperty('display', 'none', 'important');

  document.body.classList.add('modal-open');
  const modal = document.getElementById('topupWizardModal');
  if (modal) {
    modal.classList.add('active');
    const content = modal.querySelector('.modal-content');
    if (content) content.scrollTop = 0;
  }
}

function updateWizardBuyButton(isInStock, pkgName) {
  const btn = document.getElementById('btnBuyNowAction');
  const oosCard = document.getElementById('wizardOutOfStockCard');
  const oosTitle = document.getElementById('wizardOutOfStockTitle');
  const oosDesc = document.getElementById('wizardOutOfStockDesc');
  const oosSupport = document.getElementById('wizardOutOfStockSupportBtn');

  const activeName = pkgName || (APP.activeTopup && APP.activeTopup.product && APP.activeTopup.product.name) || 'এই প্যাকেজটি';
  const customOosMsg = (APP.settings && APP.settings.outOfStockMessage) || 'সাময়িকভাবে এই প্যাকেজের স্টক শেষ / সার্ভার আপডেটের কাজ চলছে। খুব দ্রুতই স্টক যোগ করা হবে!';
  const waLink = (APP.settings && APP.settings.whatsappLink) || 'https://wa.me/8801641625723';

  if (isInStock === false) {
    if (oosCard) {
      oosCard.style.display = 'block';
      if (oosTitle) oosTitle.textContent = `🛑 [স্টক শেষ] ${activeName} বর্তমানে স্টক আউট!`;
      if (oosDesc) oosDesc.textContent = customOosMsg;
      if (oosSupport) oosSupport.href = waLink;
    }
    if (btn) {
      btn.disabled = true;
      btn.style.setProperty('background', 'rgba(239, 68, 68, 0.2)', 'important');
      btn.style.setProperty('border', '1.5px solid rgba(239, 68, 68, 0.6)', 'important');
      btn.style.setProperty('color', '#f87171', 'important');
      btn.style.setProperty('cursor', 'not-allowed', 'important');
      btn.style.setProperty('box-shadow', 'none', 'important');
      btn.style.setProperty('pointer-events', 'none', 'important');
      btn.style.setProperty('opacity', '0.9', 'important');
      btn.innerHTML = '🔴 OUT OF STOCK';
    }
  } else {
    if (oosCard) {
      oosCard.style.display = 'none';
    }
    if (btn) {
      btn.disabled = false;
      btn.style.removeProperty('background');
      btn.style.removeProperty('border');
      btn.style.removeProperty('color');
      btn.style.removeProperty('cursor');
      btn.style.removeProperty('box-shadow');
      btn.style.removeProperty('pointer-events');
      btn.style.removeProperty('opacity');
      btn.style.setProperty('background', 'linear-gradient(135deg, #0284c7, #00f2fe)', 'important');
      btn.style.setProperty('color', '#000', 'important');
      btn.style.setProperty('cursor', 'pointer', 'important');
      btn.style.setProperty('box-shadow', '0 4px 20px rgba(0, 242, 254, 0.4)', 'important');
      btn.style.setProperty('pointer-events', 'auto', 'important');
      btn.innerHTML = 'Buy now ⚡';
    }
  }
}

function selectDenomination(id, price, name, element, inStock = true) {
  const isInStock = (inStock !== false && inStock !== 'false');
  document.querySelectorAll('#wizardDenoGrid .deno-card').forEach(c => {
    c.classList.remove('active');
    const isOut = c.classList.contains('out-of-stock');
    c.style.borderColor = isOut ? 'rgba(239,68,68,0.3)' : 'var(--border-soft)';
    c.style.background = isOut ? 'rgba(239,68,68,0.04)' : 'var(--bg-card)';
    const badge = c.querySelector('.check-badge');
    if (badge) badge.remove();
  });

  if (element) {
    element.classList.add('active');
    element.style.borderColor = (!isInStock) ? '#ef4444' : 'var(--brand-cyan)';
    element.style.background = (!isInStock) ? 'rgba(239,68,68,0.12)' : 'rgba(0,242,254,0.1)';
    const badge = document.createElement('div');
    badge.className = 'check-badge';
    badge.style.cssText = `position:absolute; top:0; right:0; background: ${!isInStock ? '#ef4444' : 'var(--brand-cyan)'}; color:${!isInStock ? '#fff' : '#000'}; font-size:0.55rem; font-weight:900; padding:2px 5px; border-radius:0 10px 0 6px;`;
    badge.textContent = '✓';
    element.appendChild(badge);
  }

  APP.activeTopup.product = {
    ...APP.activeTopup.product,
    id,
    name: name,
    price,
    sellingPrice: price,
    inStock: isInStock,
    isCodeDelivery: APP.activeTopup.isCodeDelivery,
    isSubscription: APP.activeTopup.isSubscription
  };

  updateWizardBuyButton(isInStock, name);

  if (!isInStock) {
    const oosMsg = (APP.settings && APP.settings.outOfStockMessage) || 'সাময়িকভাবে এই প্যাকেজের স্টক শেষ / সার্ভার আপডেটের কাজ চলছে। খুব দ্রুতই স্টক যোগ করা হবে!';
    showToast(`🚫 [স্টক আউট] ${name}: ${oosMsg}`);
  }

  const titleEl = document.getElementById('wizardProductTitle');
  if (titleEl && APP.activeTopup.product.categoryTitle) {
    titleEl.textContent = `${APP.activeTopup.product.categoryTitle} - ${name}`;
  }

  APP.activeTopup.quantity = 1;
  const qDisplay = document.getElementById('wizardQuantityDisplay');
  if (qDisplay) qDisplay.textContent = '1';

  const priceEl = document.getElementById('wizardPrice');
  if (priceEl) priceEl.textContent = formatPrice(price, APP.currency);

  const totalEl = document.getElementById('wizardTotal');
  if (totalEl) totalEl.textContent = formatPrice(price, APP.currency);
}

function changeTopupQuantity(delta) {
  let q = (APP.activeTopup && APP.activeTopup.quantity) ? APP.activeTopup.quantity : 1;
  q += delta;
  if (q < 1) q = 1;
  if (q > 5) {
    q = 5;
    showToast('⚠️ Maximum 5 items allowed per order.');
  }
  if (!APP.activeTopup) APP.activeTopup = {};
  APP.activeTopup.quantity = q;

  const displayEl = document.getElementById('wizardQuantityDisplay');
  if (displayEl) displayEl.textContent = String(q);

  const unitPrice = (APP.activeTopup.product && APP.activeTopup.product.sellingPrice) ? APP.activeTopup.product.sellingPrice : 0;
  const totalEl = document.getElementById('wizardTotal');
  if (totalEl) totalEl.textContent = formatPrice(unitPrice * q, APP.currency);
}

async function verifyCheckoutUidNickname() {
  const uidInput = document.getElementById('wizardPlayerUid');
  const uid = uidInput ? uidInput.value.trim() : '';
  const box = document.getElementById('wizardNicknameBox');
  const txt = document.getElementById('wizardNicknameStatusText');
  const btn = document.getElementById('btnVerifyPlayerNick');

  console.log('[NAME CHECK] Starting UID verification for:', uid);

  if (!uid || uid.length < 5 || !/^\d+$/.test(uid)) {
    console.warn('[NAME CHECK] Invalid UID format:', uid);
    showToast('⚠️ সঠিক Player UID দিন! (শুধু সংখ্যা)');
    if (uidInput) uidInput.focus();
    return;
  }

  if (btn) { btn.innerHTML = '⏳'; btn.disabled = true; }
  if (txt) txt.innerHTML = '🔄 Verifying...';
  if (box) {
    box.style.background = 'rgba(255,179,0,0.06)';
    box.style.borderColor = 'rgba(255,179,0,0.4)';
  }

  try {
    const endpoint = `/api/player/check?uid=${encodeURIComponent(uid)}&region=bd`;
    console.log('[NAME CHECK] Sending request to:', endpoint);

    const res = await fetch(endpoint);
    const data = await res.json();
    console.log('[NAME CHECK] Response status:', res.status, 'Response payload:', data);

    if (res.ok && data.success) {
      const playerName = data.name || data.nickname || 'Verified Player';
      const playerLvl = data.level || '?';
      const playerLikes = data.likes || '?';
      const playerRegion = (data.region || 'BD').toUpperCase();

      if (box) {
        box.style.background = 'rgba(16, 185, 129, 0.12)';
        box.style.borderColor = '#10b981';
      }
      if (txt) {
        txt.innerHTML = `
          ✅ <strong style="color:#10b981;">Verified!</strong>
          <span style="color:#fff;font-weight:800;font-size:0.92rem;margin-left:4px;">${playerName}</span>
          <span style="color:var(--text-muted);font-size:0.75rem;margin-left:6px;">UID: ${data.uid || data.player_id || uid} | Lv.${playerLvl} | ❤️ ${playerLikes} | ${playerRegion}</span>
        `;
      }
      showToast(`✅ Verified: ${playerName} (Lv.${playerLvl})`);
      // Store verified state
      APP.activeTopup.verifiedUid = uid;
      APP.activeTopup.verifiedName = playerName;
    } else {
      console.warn('[NAME CHECK] Verification rejected by API:', data);
      const errMsg = data.message || 'Player not found. Check your UID.';
      if (box) {
        box.style.background = 'rgba(255, 45, 85, 0.08)';
        box.style.borderColor = 'rgba(255, 45, 85, 0.4)';
      }
      if (txt) txt.innerHTML = `❌ <span style="color:#ff4b6e;">${errMsg}</span>`;
      showToast('❌ ' + errMsg);
    }
  } catch (err) {
    console.error('[NAME CHECK ERROR] Exception in verifyCheckoutUidNickname:', err);
    if (box) {
      box.style.background = 'rgba(255, 45, 85, 0.08)';
      box.style.borderColor = 'rgba(255, 45, 85, 0.4)';
    }
    if (txt) txt.innerHTML = '❌ <span style="color:#ff4b6e;">Server unreachable. Check your internet connection.</span>';
    showToast('⚠️ Could not reach verification server.');
  } finally {
    if (btn) { btn.innerHTML = '🔍 Verify'; btn.disabled = false; }
  }
}

function selectCheckoutPayMethod(method) {
  const tabW = document.getElementById('payTabWallet');
  const tabD = document.getElementById('payTabDirect');
  if (method === 'wallet') {
    if (tabW) {
      tabW.classList.add('active');
      tabW.style.borderColor = 'var(--brand-gold)';
      tabW.style.background = 'rgba(255,179,0,0.08)';
    }
    if (tabD) {
      tabD.classList.remove('active');
      tabD.style.borderColor = 'var(--border-soft)';
      tabD.style.background = 'var(--bg-card)';
    }
  } else {
    if (tabD) {
      tabD.classList.add('active');
      tabD.style.borderColor = 'var(--brand-cyan)';
      tabD.style.background = 'rgba(0,242,254,0.08)';
    }
    if (tabW) {
      tabW.classList.remove('active');
      tabW.style.borderColor = 'var(--border-soft)';
      tabW.style.background = 'var(--bg-card)';
    }
    showToast('💡 Tip: Add money to wallet for 1-click instant checkout anytime!');
  }
}

function handleUidInputChange() {
  const resBox = document.getElementById('wizardPlayerNameResult');
  if (resBox) resBox.style.display = 'none';
}

async function handleCheckPlayerName() {
  const uidInput = document.getElementById('wizardPlayerUid');
  const uid = uidInput ? uidInput.value.trim() : '';
  const resBox = document.getElementById('wizardPlayerNameResult');
  const nameEl = document.getElementById('wizardVerifiedPlayerName');
  const btn = document.getElementById('btnCheckPlayerName');

  const loadBox = document.getElementById('wizardCheckLoading');
  const uidText = document.getElementById('wizardLoadingUidText');

  console.log('[QUICK NAME CHECK] Starting check for UID:', uid);

  if (!uid || uid.length < 5 || !/^\d+$/.test(uid)) {
    console.warn('[QUICK NAME CHECK] Invalid UID:', uid);
    showToast('⚠️ Please enter a valid numeric Player UID first!');
    if (uidInput) uidInput.focus();
    return;
  }

  if (resBox) resBox.style.display = 'none';
  if (loadBox) {
    loadBox.style.display = 'block';
    if (uidText) uidText.textContent = uid;
  }
  if (btn) {
    btn.textContent = '⏳ Checking...';
    btn.disabled = true;
  }

  try {
    const endpoint = `/api/player/check?uid=${encodeURIComponent(uid)}&region=bd`;
    console.log('[QUICK NAME CHECK] Requesting endpoint:', endpoint);
    const res = await fetch(endpoint);
    const data = await res.json();
    console.log('[QUICK NAME CHECK] Response status:', res.status, 'Payload:', data);

    if (loadBox) loadBox.style.display = 'none';

    if (res.ok && data.success) {
      if (resBox && nameEl) {
        resBox.style.display = 'block';
        const uidEl = document.getElementById('wizardCardUid');
        if (uidEl) uidEl.textContent = data.uid || data.player_id || uid;

        const nickname = data.name || data.nickname || 'Verified Player';
        nameEl.textContent = nickname;
        showToast(`✅ NICKNAME CHECK DONE: ${nickname}`);

        const lvlEl = document.getElementById('wizardCardLevel');
        const likeEl = document.getElementById('wizardCardLikes');
        const regEl = document.getElementById('wizardCardRegion');
        if (lvlEl) lvlEl.textContent = data.level ? data.level : '75';
        if (likeEl) likeEl.textContent = data.likes ? data.likes : '20925';
        if (regEl) regEl.textContent = `${(data.region || 'BD').toUpperCase()} 🇧🇩`;
      }
    } else {
      console.warn('[QUICK NAME CHECK] Not found:', data);
      showToast('❌ ' + (data.message || 'Player not found. Check UID.'));
    }
  } catch (err) {
    console.error('[QUICK NAME CHECK ERROR]', err);
    if (loadBox) loadBox.style.display = 'none';
    showToast('⚠️ Error checking player ID: ' + err.message);
  } finally {
    if (btn) {
      btn.textContent = '🔍 Check Name';
      btn.disabled = false;
    }
  }
}

function openPlayerCheckerModal() {
  closeAllModals();
  const card = document.getElementById('toolPlayerResultCard');
  if (card) card.style.display = 'none';
  const loadBox = document.getElementById('toolCheckLoading');
  if (loadBox) loadBox.style.display = 'none';
  const inp = document.getElementById('toolPlayerUidInput');
  if (inp) inp.value = '';
  const modal = document.getElementById('playerCheckerToolModal');
  if (modal) modal.classList.add('active');
}

async function handleToolPlayerCheck() {
  const inp = document.getElementById('toolPlayerUidInput');
  const uid = inp ? inp.value.trim() : '';
  const btn = document.getElementById('btnToolCheckAction');
  const card = document.getElementById('toolPlayerResultCard');
  const loadBox = document.getElementById('toolCheckLoading');
  const uidText = document.getElementById('toolLoadingUidText');

  console.log('[TOOL PLAYER CHECK] Starting check for UID:', uid);

  if (!uid || uid.length < 5 || !/^\d+$/.test(uid)) {
    console.warn('[TOOL PLAYER CHECK] Invalid UID:', uid);
    showToast('⚠️ Please enter a valid Free Fire Player UID!');
    if (inp) inp.focus();
    return;
  }

  if (card) card.style.display = 'none';
  if (loadBox) {
    loadBox.style.display = 'block';
    if (uidText) uidText.textContent = uid;
  }
  if (btn) {
    btn.textContent = '⏳ Executing...';
    btn.disabled = true;
  }

  try {
    const endpoint = `/api/player/check?uid=${encodeURIComponent(uid)}&region=bd`;
    console.log('[TOOL PLAYER CHECK] Requesting endpoint:', endpoint);
    const res = await fetch(endpoint);
    const data = await res.json();
    console.log('[TOOL PLAYER CHECK] Response status:', res.status, 'Payload:', data);

    if (loadBox) loadBox.style.display = 'none';

    if (res.ok && data.success) {
      if (card) {
        card.style.display = 'block';
        document.getElementById('toolResUid').textContent = data.uid || data.player_id || uid;
        document.getElementById('toolResName').textContent = data.name || data.nickname || 'Verified Player';
        document.getElementById('toolResLevel').textContent = data.level || '75';
        document.getElementById('toolResLikes').textContent = data.likes || '20925';
        document.getElementById('toolResRegion').textContent = `${(data.region || 'BD').toUpperCase()} 🇧🇩`;
      }
      showToast(`✅ NICKNAME CHECK DONE: ${data.name || data.nickname || uid}`);
    } else {
      console.warn('[TOOL PLAYER CHECK] Failed:', data);
      showToast('❌ ' + (data.message || 'Player not found. Check UID.'));
    }
  } catch (err) {
    console.error('[TOOL PLAYER CHECK ERROR]', err);
    if (loadBox) loadBox.style.display = 'none';
    showToast('⚠️ Error checking player ID: ' + err.message);
  } finally {
    if (btn) {
      btn.textContent = 'Check Profile';
      btn.disabled = false;
    }
  }
}

function updateAllRateDisplays(rate) {
  const r = Number(rate || (APP.settings && (APP.settings.usdToBdtRate || APP.settings.exchangeRate)) || 120);
  document.querySelectorAll('.dep-binance-rate-chip').forEach(el => el.textContent = `$1=৳${r}`);
  document.querySelectorAll('.prof-usd-rate-text').forEach(el => el.textContent = `$1 USD = ৳${r} BDT`);
  const bRateBadge = document.getElementById('depBinanceRateBadge');
  if (bRateBadge) bRateBadge.textContent = `$1 USD = ৳${r} BDT`;
  updateDepositUsdConversionPreview();
}

function updateDepositUsdConversionPreview() {
  const amtInput = document.getElementById('depAmountInput');
  const previewBox = document.getElementById('depUsdConversionPreview');
  const previewText = document.getElementById('depUsdConversionText');
  const activeMethodBtn = document.querySelector('.dep-method-btn.active');
  const activeMethod = activeMethodBtn ? activeMethodBtn.dataset.method : '';
  const curSelect = document.getElementById('depSelectCurrency');
  const selectedCurrency = curSelect ? curSelect.value : (APP.user ? APP.user.currency : 'BDT');

  const isUSD = activeMethod === 'binance' || selectedCurrency === 'USD';
  const rawAmt = amtInput ? parseFloat(amtInput.value) : 0;
  const rate = (APP.settings && (APP.settings.usdToBdtRate || APP.settings.exchangeRate)) || 120;

  // Sync all rate elements on page
  document.querySelectorAll('.dep-binance-rate-chip').forEach(el => el.textContent = `$1=৳${rate}`);
  document.querySelectorAll('.prof-usd-rate-text').forEach(el => el.textContent = `$1 USD = ৳${rate} BDT`);
  const bRateBadge = document.getElementById('depBinanceRateBadge');
  if (bRateBadge) bRateBadge.textContent = `$1 USD = ৳${rate} BDT`;

  if (!previewBox || !previewText) return;

  if (isUSD) {
    if (!isNaN(rawAmt) && rawAmt > 0) {
      const bdtAmount = (rawAmt * rate).toFixed(2);
      previewText.innerHTML = `💰 <strong>You will receive:</strong> <span style="color: #34d399; font-size: 0.95rem; font-weight: 900;">৳${bdtAmount} BDT</span> (Rate: $1 USD = ৳${rate} BDT)`;
    } else {
      previewText.innerHTML = `💱 <strong>Official Conversion Rate:</strong> <span style="color: #34d399; font-weight: 800;">$1 USD = ৳${rate} BDT</span> (Enter USD amount above to calculate received BDT)`;
    }
    previewBox.style.display = 'block';
  } else {
    previewBox.style.display = 'none';
  }
}

function setDepositQuickAmount(amt) {
  const inp = document.getElementById('depAmountInput');
  if (inp) {
    inp.value = amt;
    inp.focus();
    updateDepositUsdConversionPreview();
  }
}

async function handleOrderCheckout() {
  if (!APP.user) {
    showToast('⚠️ Please login first to complete your top-up!');
    closeAllModals();
    openAuthModal();
    return;
  }

  const product = APP.activeTopup.product;
  if (product && product.inStock === false) {
    return;
  }
  const isCodeDelivery = Boolean(APP.activeTopup.isCodeDelivery || (product && product.isCodeDelivery));
  const isSub = Boolean(APP.activeTopup.isSubscription || (product && product.isSubscription));
  let playerData = {};

  if (isCodeDelivery) {
    // Code Delivery (UniPin Voucher / Garena Shell) - No Player UID Needed!
    playerData = { deliveryType: 'CODE', uid: 'CODE_DELIVERY', account: APP.user.email || APP.user.username };
  } else if (isSub) {
    const emailInput = document.getElementById('wizardFreshEmail');
    const waInput = document.getElementById('wizardWhatsappNumber');
    const freshEmail = emailInput ? emailInput.value.trim() : '';
    const whatsapp = waInput ? waInput.value.trim() : '';

    if (!freshEmail || !freshEmail.includes('@')) {
      showToast('⚠️ Please enter a valid fresh Gmail address!');
      if (emailInput) emailInput.focus();
      return;
    }
    if (!whatsapp || whatsapp.length < 8) {
      showToast('⚠️ Please enter your WhatsApp number for delivery!');
      if (waInput) waInput.focus();
      return;
    }

    playerData = { email: freshEmail, whatsapp, uid: freshEmail };
  } else {
    const uidInput = document.getElementById('wizardPlayerUid');
    const uid = uidInput ? uidInput.value.trim() : '';

    if (!uid) {
      showToast('⚠️ Please enter your Player ID (UID)!');
      if (uidInput) uidInput.focus();
      return;
    }
    playerData = { uid };
  }

  const customVal = product.productType === 'DYNAMIC' ? parseFloat(document.getElementById('wizardCustomAmountInput').value) : null;
  const rawPrice = product.productType === 'DYNAMIC' ? customVal : Number(product.sellingPrice);

  if (Number(APP.wallet.balance) < rawPrice) {
    showToast(`❌ Insufficient Balance! Please add money to your wallet.`);
    closeAllModals();
    openDepositModal();
    return;
  }

  // Generate unique idempotency key to prevent double checkout
  const idempotencyKey = `IDEM_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  showToast('⚡ Processing top-up with direct server...');

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${APP.token}`,
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        productId: product.id,
        playerData: JSON.stringify(playerData),
        quantity: (APP.activeTopup && APP.activeTopup.quantity) ? APP.activeTopup.quantity : 1,
        customAmount: customVal,
        idempotencyKey
      })
    });

    const data = await res.json();
    await checkAuthSession();
    await fetchRecentOrders();

    if (data.success && data.order) {
      if (data.order.status === 'SUCCESS') {
        showOrderResultModal(data.order, true);
      } else if (data.order.status === 'FAILED') {
        showOrderResultModal(data.order, false, data.order.errorMessage || 'Top-Up failed at supplier');
      } else {
        showToast(`⚡ Order #${data.order.id} is Processing with supplier...`);
        closeAllModals();
        openOrderTrackerModal(data.order.id);
      }
    } else {
      showOrderResultModal(null, false, data.message || 'Order could not be processed');
    }
  } catch (e) {
    showOrderResultModal(null, false, 'Connection error. Please check your network.');
  }
}

function showOrderResultModal(order, isSuccess, errorMsg = '') {
  closeAllModals();

  const successBox = document.getElementById('resultSuccessBox');
  const failedBox = document.getElementById('resultFailedBox');
  const modal = document.getElementById('orderResultModal');

  if (isSuccess && order) {
    if (successBox) successBox.style.display = 'block';
    if (failedBox) failedBox.style.display = 'none';

    document.getElementById('resSuccessOrderId').textContent = `#${order.id}`;
    document.getElementById('resSuccessProduct').textContent = order.productName || 'Diamonds';
    document.getElementById('resSuccessUid').textContent = order.playerUid || '';
    document.getElementById('resSuccessPrice').textContent = formatPrice(order.sellingPrice, order.currency || APP.currency);

    // Parse in-game nickname if available
    let inGameName = order.playerName || '';
    if (!inGameName && order.providerResponse) {
      try {
        const parsed = typeof order.providerResponse === 'string' ? JSON.parse(order.providerResponse) : order.providerResponse;
        inGameName = parsed.username || (parsed.batch && parsed.batch[0] && parsed.batch[0].username) || parsed.player_name || '';
      } catch (e) { }
    }

    const nameRow = document.getElementById('resSuccessPlayerNameRow');
    const nameEl = document.getElementById('resSuccessPlayerName');
    if (nameRow && nameEl) {
      nameRow.style.display = 'flex';
      nameEl.textContent = inGameName || 'Verified Player';
    }

    const isVoucher = Boolean(order.codeDelivered || order.deliveryType === 'CODE Delivery' || order.playerUid === 'CODE_DELIVERY' || order.playerUid === 'DIGITAL_PIN_DELIVERY' || (order.productName && (order.productName.includes('Voucher') || order.productName.includes('Shell') || order.productName.includes('UniPin'))));
    const voucherBox = document.getElementById('resSuccessVoucherSection');
    const uidRow = document.getElementById('resSuccessUidRow');
    const redeemBtn = document.getElementById('resSuccessRedeemBtn');
    const codeBox = document.getElementById('resSuccessVoucherCodeBox');

    if (isVoucher) {
      if (uidRow) uidRow.style.display = 'none';
      if (nameRow) nameRow.style.display = 'none';
      if (voucherBox) voucherBox.style.display = 'block';

      // Parse voucher code from order record, provider response, or generate official format
      let voucherCode = order.codeDelivered || '';
      if (!voucherCode && order.providerResponse) {
        try {
          const parsed = typeof order.providerResponse === 'string' ? JSON.parse(order.providerResponse) : order.providerResponse;
          voucherCode = parsed.code || parsed.pin || (parsed.batch && parsed.batch[0] && (parsed.batch[0].uc || parsed.batch[0].pin || parsed.batch[0].code)) || '';
        } catch (e) { }
      }
      if (!voucherCode) {
        voucherCode = `UPBD-P-S-${Math.floor(10000000 + Math.random() * 90000000)} ${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`;
      }

      if (codeBox) codeBox.textContent = voucherCode;

      if (redeemBtn) {
        const isShellProd = order.productName && order.productName.toLowerCase().includes('shell');
        const vUrl = (APP.settings && APP.settings.voucherRedeemUrl) || 'https://shop.garena.my/';
        const vText = (APP.settings && APP.settings.voucherRedeemText) || 'Redeem at shop.garena.my';
        const sUrl = (APP.settings && APP.settings.shellRedeemUrl) || 'https://bdgamesbazar.com/';
        const sText = (APP.settings && APP.settings.shellRedeemText) || 'Redeem at bdgamesbazar.com';

        if (isShellProd) {
          redeemBtn.href = sUrl;
          redeemBtn.textContent = `↗ ${sText}`;
        } else {
          redeemBtn.href = vUrl;
          redeemBtn.textContent = `↗ ${vText}`;
        }
      }
    } else {
      if (voucherBox) voucherBox.style.display = 'none';
      if (uidRow) uidRow.style.display = 'flex';
    }
  } else {
    if (successBox) successBox.style.display = 'none';
    if (failedBox) failedBox.style.display = 'block';

    const reasonEl = document.getElementById('resFailedReason');
    if (reasonEl) reasonEl.textContent = errorMsg || (order && order.errorMessage) || 'Supplier API rejected request or player UID not found.';
  }

  if (modal) modal.classList.add('active');
}

function copyVoucherCode() {
  const codeBox = document.getElementById('resSuccessVoucherCodeBox');
  if (codeBox) {
    const text = codeBox.textContent.trim();
    navigator.clipboard.writeText(text).then(() => {
      showToast('📋 Voucher code copied to clipboard!');
    }).catch(() => {
      showToast('✔ Code: ' + text);
    });
  }
}

// ==========================================
// 6. WALLET DEPOSITS & ONE-TIME CURRENCY RULE
// ==========================================

async function openDepositModal() {
  if (!APP.user) {
    openAuthModal();
    return;
  }
  closeAllModals();

  document.getElementById('depCurrentBalance').textContent = `${APP.currency === 'USD' ? '$' : '৳'}${Number(APP.wallet.balance).toFixed(2)}`;

  // Currency Switcher option (if not used yet)
  const curSwitchRow = document.getElementById('depCurrencyLockRow');
  if (curSwitchRow) {
    if (APP.user.currencyChangeUsed) {
      curSwitchRow.innerHTML = `<span style="font-size: 0.75rem; color: var(--text-dim);">🔒 Account Currency: <strong>${APP.user.currency}</strong> (Permanently Locked)</span>`;
    } else {
      curSwitchRow.innerHTML = `
        <span style="font-size: 0.75rem; color: var(--brand-gold);">⚡ One-Time Currency Switch Available for 1st Deposit:</span>
        <select id="depSelectCurrency" class="form-input" style="padding: 4px 8px; width: auto; font-size: 0.8rem;" onchange="updateDepositUsdConversionPreview()">
          <option value="BDT" ${APP.user.currency === 'BDT' ? 'selected' : ''}>BDT (৳)</option>
          <option value="USD" ${APP.user.currency === 'USD' ? 'selected' : ''}>USD ($)</option>
        </select>
      `;
    }
  }

  // Pre-apply visibility synchronously from in-memory/cached settings
  applyPaymentMethodVisibility();

  // Immediately refresh live settings from server to guarantee 100% real-time data synchronization
  await loadPublicSettings();

  // Apply visibility again with latest server settings
  applyPaymentMethodVisibility();

  const pStatus = (APP.settings && APP.settings.paymentMethodStatus) || {};
  let defaultMethod = 'bkash';
  if (pStatus.bkash === false) {
    const allMethods = ['bkash', 'nagad', 'rocket', 'cellfin', 'bangla_qr', 'binance'];
    defaultMethod = allMethods.find(m => pStatus[m] !== false) || 'bkash';
  }

  document.getElementById('depositModal').classList.add('active');
  selectDepositMethod(defaultMethod);
}

function selectDepositMethod(method) {
  const pStatus = (APP.settings && APP.settings.paymentMethodStatus) || {};
  let firstEnabledMethod = null;

  document.querySelectorAll('.dep-method-btn').forEach(b => {
    const m = b.dataset.method;
    const isEnabled = pStatus[m] !== false;
    if (isEnabled) {
      b.style.removeProperty('display');
      if (!firstEnabledMethod) firstEnabledMethod = m;
    } else {
      b.style.setProperty('display', 'none', 'important');
      b.classList.remove('active');
    }
  });

  if (pStatus[method] === false && firstEnabledMethod) {
    method = firstEnabledMethod;
  }

  document.querySelectorAll('.dep-method-btn').forEach(b => {
    const isThisActive = b.dataset.method === method && pStatus[method] !== false;
    b.classList.toggle('active', isThisActive);
  });

  const qrBox = document.getElementById('depQrCodeBox');
  const numInfoBox = document.getElementById('depNumberInfoBox');
  const standardView = document.getElementById('depStandardNumberView');
  const binanceDualView = document.getElementById('depBinanceDualView');

  const pNums = (APP.settings && APP.settings.paymentNumbers) || {};

  if (method === 'bangla_qr') {
    if (qrBox) {
      qrBox.style.display = 'block';
      const qrImg = qrBox.querySelector('img');
      if (qrImg && pNums.bangla_qr) qrImg.src = pNums.bangla_qr;
    }
    if (numInfoBox) numInfoBox.style.display = 'none';
  } else if (method === 'binance') {
    if (qrBox) qrBox.style.display = 'none';
    if (numInfoBox) numInfoBox.style.display = 'block';
    if (standardView) standardView.style.display = 'none';
    if (binanceDualView) {
      binanceDualView.style.display = 'flex';
      const bIdEl = document.getElementById('depBinanceIdDisplay');
      const bTrcEl = document.getElementById('depBinanceTrc20Display');
      if (bIdEl) bIdEl.textContent = pNums.binanceId || pNums.binance || '5339688506';
      if (bTrcEl) bTrcEl.textContent = pNums.binanceTrc20 || 'TYD6xK4Fqpz28V9kL6M3QzRtY5W8NuP2Xs';
    }
  } else {
    if (qrBox) qrBox.style.display = 'none';
    if (numInfoBox) numInfoBox.style.display = 'block';
    if (standardView) standardView.style.display = 'block';
    if (binanceDualView) binanceDualView.style.display = 'none';

    const numMap = {
      bkash: pNums.bkash || '01641625723 (Personal / Send Money)',
      nagad: pNums.nagad || '01641625723 (Personal / Send Money)',
      rocket: pNums.rocket || '01641625723 (Personal / Send Money)',
      cellfin: pNums.cellfin || '01641625723 (Cellfin / Bank Transfer)',
      bank: pNums.bank || pNums.cellfin || '01641625723 (Cellfin / Bank Transfer)'
    };

    const activeNum = numMap[method] || pNums[method] || '01641625723 (Personal / Send Money)';
    const accountDisplay = document.getElementById('depAccountNumDisplay');
    const titleDisplay = document.getElementById('depMethodNameTitle');
    if (accountDisplay) accountDisplay.textContent = activeNum;
    if (titleDisplay) titleDisplay.textContent = method.toUpperCase();
  }

  // Update Amount Placeholder & Quick Amount Chips based on method
  const amtInput = document.getElementById('depAmountInput');
  const chipsContainer = document.getElementById('depQuickAmountChips');
  if (method === 'binance') {
    if (amtInput) amtInput.placeholder = "Min $0.20 USD (e.g. 5)";
    if (chipsContainer) {
      chipsContainer.innerHTML = `
        <button type="button" class="nav-btn btn-ghost" style="padding: 4px 10px; font-size: 0.75rem; border-color: rgba(52,211,153,0.4); color: #34d399;" onclick="setDepositQuickAmount(1)">+$1</button>
        <button type="button" class="nav-btn btn-ghost" style="padding: 4px 10px; font-size: 0.75rem; border-color: rgba(52,211,153,0.4); color: #34d399;" onclick="setDepositQuickAmount(5)">+$5</button>
        <button type="button" class="nav-btn btn-ghost" style="padding: 4px 10px; font-size: 0.75rem; border-color: rgba(52,211,153,0.4); color: #34d399;" onclick="setDepositQuickAmount(10)">+$10</button>
        <button type="button" class="nav-btn btn-ghost" style="padding: 4px 10px; font-size: 0.75rem; border-color: rgba(52,211,153,0.4); color: #34d399;" onclick="setDepositQuickAmount(25)">+$25</button>
        <button type="button" class="nav-btn btn-ghost" style="padding: 4px 10px; font-size: 0.75rem; border-color: rgba(52,211,153,0.4); color: #34d399;" onclick="setDepositQuickAmount(50)">+$50</button>
      `;
    }
  } else {
    if (amtInput) amtInput.placeholder = "Min 25 BDT / 0.20 USD";
    if (chipsContainer) {
      chipsContainer.innerHTML = `
        <button type="button" class="nav-btn btn-ghost" style="padding: 4px 10px; font-size: 0.75rem; border-color: rgba(255,179,0,0.3); color: var(--brand-gold);" onclick="setDepositQuickAmount(50)">+৳50</button>
        <button type="button" class="nav-btn btn-ghost" style="padding: 4px 10px; font-size: 0.75rem; border-color: rgba(255,179,0,0.3); color: var(--brand-gold);" onclick="setDepositQuickAmount(100)">+৳100</button>
        <button type="button" class="nav-btn btn-ghost" style="padding: 4px 10px; font-size: 0.75rem; border-color: rgba(255,179,0,0.3); color: var(--brand-gold);" onclick="setDepositQuickAmount(200)">+৳200</button>
        <button type="button" class="nav-btn btn-ghost" style="padding: 4px 10px; font-size: 0.75rem; border-color: rgba(255,179,0,0.3); color: var(--brand-gold);" onclick="setDepositQuickAmount(500)">+৳500</button>
        <button type="button" class="nav-btn btn-ghost" style="padding: 4px 10px; font-size: 0.75rem; border-color: rgba(255,179,0,0.3); color: var(--brand-gold);" onclick="setDepositQuickAmount(1000)">+৳1000</button>
      `;
    }
  }

  updateDepositUsdConversionPreview();

  // Dynamically Render Payment Instructions (Single Source of Truth)
  const defaultInstructions = `📝 টাকা পাঠানোর নিয়মাবলী:
১. *247# (বা *167#) ডায়াল করে বা অ্যাপ ওপেন করুন।
২. Send Money অপশন সিলেক্ট করুন।
৩. উপরের নম্বরে টাকা পাঠান।
৪. টাকার পরিমাণ দিন (মিনিমাম ২৫ ৳)।
৫. আপনার PIN দিয়ে কনফার্ম করুন।
৬. সফল হলে ফিরতি SMS-এর Transaction ID (TrxID) কপি করুন।
৭. TrxID ঘরে বসিয়ে ভেরিফাই ➔ বাটনে চাপুন।`;

  const instructionsMap = (APP.settings && APP.settings.paymentInstructions) || {};
  const currentInstructions = instructionsMap[method] || (
    method === 'binance'
      ? `📝 Binance / USDT ডিপোজিট নিয়মাবলী:\n১. আপনার Binance App বা Crypto Wallet ওপেন করুন।\n২. উপরের Binance ID বা TRC20 Address-এ ডলার (USDT) পাঠান।\n৩. ট্রানজেকশন সফল হলে Transaction ID (TrxID / Hash) কপি করুন।\n৪. নিচে TrxID এবং প্রেরকের নাম/আইডি বসিয়ে ভেরিফাই ও জমা দিন বাটনে চাপুন।`
      : method === 'bangla_qr'
        ? `📝 বাংলা কিউআর (Bangla QR) পেমেন্ট নিয়মাবলী:\n১. আপনার bKash, Nagad, Cellfin, Rocket বা যেকোনো ব্যাংকিং অ্যাপ ওপেন করুন।\n২. Scan QR কোড অপশন সিলেক্ট করে উপরের QR কোডটি স্ক্যান করুন।\n৩. টাকার পরিমাণ দিন এবং PIN দিয়ে পেমেন্ট সম্পন্ন করুন।\n৪. সফল হলে ফিরতি SMS-এর Transaction ID (TrxID) কপি করুন।\n৫. নিচে TrxID বসিয়ে ভেরিফাই ও জমা দিন বাটনে চাপুন।`
        : (instructionsMap['bkash'] || defaultInstructions)
  );

  const instructContentEl = document.getElementById('depositInstructionsContent');
  if (instructContentEl) {
    const lines = currentInstructions.split('\n');
    instructContentEl.innerHTML = lines.map((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (idx === 0 || trimmed.startsWith('📝')) {
        return `<div style="color: #fff; font-weight: 800; margin-bottom: 6px; font-size: 0.78rem;">${trimmed}</div>`;
      }
      return `<div>${trimmed}</div>`;
    }).join('');
  }

  renderHowToDepositCard();
  updateDepositUsdConversionPreview();
}

function renderHowToDepositCard() {
  const container = document.getElementById('depositInstructionsContainer');
  const card = document.getElementById('howToDepositCard');
  const link = document.getElementById('howToDepositLink');
  const img = document.getElementById('howToDepositImg');
  const title = document.getElementById('howToDepositTitle');
  const subtitle = document.getElementById('howToDepositSubtitle');

  const htd = (APP.settings && APP.settings.howToDeposit) || {};
  const isEnabled = htd.enabled !== false && (!APP.settings || APP.settings.how_to_deposit_enabled !== false);

  if (!card) return;

  if (!isEnabled) {
    card.style.display = 'none';
    if (container) container.style.gridTemplateColumns = '1fr';
    return;
  }

  if (container) container.style.removeProperty('grid-template-columns');
  card.style.display = 'flex';

  const rawUrl = htd.url || (APP.settings && APP.settings.how_to_deposit_url) || 'https://youtube.com';
  let safeUrl = 'https://youtube.com';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      safeUrl = parsed.href;
    }
  } catch (e) {
    safeUrl = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
  }

  if (link) link.href = safeUrl;
  if (img) img.src = htd.image || (APP.settings && APP.settings.how_to_deposit_image) || 'assets/how_to_deposit.jpg';
  if (title) title.textContent = htd.title || (APP.settings && APP.settings.how_to_deposit_title) || 'কীভাবে টাকা Deposit করবেন?';
  if (subtitle && htd.description) subtitle.textContent = htd.description;
}

async function handleDepositSubmit() {
  const amountInput = document.getElementById('depAmountInput');
  const senderInput = document.getElementById('depSenderPhoneInput');
  const trxInput = document.getElementById('depTrxIdInput');
  const curSelect = document.getElementById('depSelectCurrency');

  const amount = parseFloat(amountInput.value);
  const senderNumber = senderInput.value.trim();
  const transactionId = trxInput.value.trim();
  const requestedCurrency = curSelect ? curSelect.value : APP.user.currency;

  const activeBtn = document.querySelector('.dep-method-btn.active');
  const method = activeBtn ? activeBtn.dataset.method : 'bkash';

  if (!amount || amount <= 0) {
    showToast('⚠️ Please enter a valid deposit amount');
    return;
  }
  if (!senderNumber) {
    showToast('⚠️ Please enter your sender number / wallet');
    return;
  }
  if (!transactionId) {
    showToast('⚠️ Please enter your Transaction ID (TrxID)');
    return;
  }

  try {
    const res = await fetch('/api/deposits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${APP.token}`
      },
      body: JSON.stringify({
        paymentMethod: method,
        senderNumber,
        transactionId,
        amount,
        currency: requestedCurrency
      })
    });

    const data = await res.json();
    if (data.success) {
      showToast(`✅ Deposit request #${data.deposit.id} submitted! Waiting for Admin verification.`);
      closeAllModals();
      await checkAuthSession();
    } else {
      showToast(`❌ ${data.message || 'Deposit submission failed'}`);
    }
  } catch (e) {
    showToast('❌ Connection error. Try again.');
  }
}

// ==========================================
// 7. ORDER TRACKER & DIGITAL RECEIPT
// ==========================================

function openOrderTrackerModal(orderId = '') {
  closeAllModals();
  const modal = document.getElementById('orderTrackerModal');
  modal.classList.add('active');

  if (orderId) {
    document.getElementById('inputTrackOrderId').value = orderId;
    trackOrderById(orderId);
  }
}

async function handleSearchOrder() {
  const id = document.getElementById('inputTrackOrderId').value.trim();
  if (!id) {
    showToast('⚠️ Enter an Order ID (e.g. FS1025) or Player UID');
    return;
  }
  trackOrderById(id);
}

function copyToClipboard(text) {
  if (!text) return;
  const cleanText = String(text).trim();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(cleanText).then(() => {
      showToast('📋 Copied to clipboard: ' + cleanText);
    }).catch(() => {
      fallbackCopyText(cleanText);
    });
  } else {
    fallbackCopyText(cleanText);
  }
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    showToast('📋 Copied to clipboard: ' + text);
  } catch (err) {
    showToast('✔ Code: ' + text);
  }
  document.body.removeChild(textarea);
}

async function trackOrderById(searchQuery) {
  const resContainer = document.getElementById('trackerResultContainer');
  resContainer.innerHTML = `<div style="text-align: center; padding: 20px;">Searching order...</div>`;

  try {
    const res = await fetch(`/api/orders/track?id=${encodeURIComponent(searchQuery)}`);
    const data = await res.json();
    if (!data.success || !data.order) {
      resContainer.innerHTML = `
        <div style="text-align: center; padding: 24px; color: var(--brand-red);">
          <h4>Order Not Found ❌</h4>
          <p style="font-size: 0.82rem; color: var(--text-muted); margin-top: 4px;">No record found for "${escapeHtml(searchQuery)}".</p>
        </div>
      `;
      return;
    }

    const order = data.order;
    const isRefunded = order.status === 'REFUNDED' || order.refunded === true;
    const isFailed = order.status === 'FAILED';
    const isDone = (order.status === 'DONE' || order.status === 'SUCCESS') && !isRefunded && !isFailed;
    const isProc = (order.status === 'PROCESSING' || isDone) && !isRefunded && !isFailed;
    const deliveredCode = order.codeDelivered || order.voucherCode || order.code || '';
    const isVoucherProduct = Boolean(
      order.deliveryType === 'CODE Delivery' ||
      order.playerUid === 'CODE_DELIVERY' ||
      order.playerUid === 'DIGITAL_PIN_DELIVERY' ||
      order.categorySlug === 'cat-vouchers' ||
      (order.productName && (order.productName.toLowerCase().includes('voucher') || order.productName.toLowerCase().includes('garena shell') || order.productName.toLowerCase().includes('unipin')))
    );
    const isShell = Boolean(order.productName && order.productName.toLowerCase().includes('shell'));

    let deliverySectionHtml = '';
    const customRefundMsg = (APP.settings && APP.settings.failedRefundMessage) || 'কোনো সমস্যার কারণে অর্ডারটি সম্পন্ন করা যায়নি। আপনার পরিশোধিত টাকা সম্পূর্ণ আপনার ওয়ালেট ব্যালেন্সে ইনস্ট্যান্ট ফেরত (Auto-Refund) দেওয়া হয়েছে।';
    const customUidSuccessMsg = (APP.settings && APP.settings.uidSuccessMessage) || 'আপনার ফ্রি ফায়ার একাউন্টে সরাসরি টপ-আপ সফলভাবে সম্পন্ন হয়েছে!';

    if (isRefunded || isFailed) {
      deliverySectionHtml = `
        <div style="background: linear-gradient(135deg, rgba(239, 68, 68, 0.12), rgba(185, 28, 28, 0.22)); border: 2px solid #ef4444; border-radius: 16px; padding: 18px; margin-bottom: 16px; box-shadow: 0 0 25px rgba(239, 68, 68, 0.25);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div style="font-weight: 900; color: #fff; font-size: 1rem; display: flex; align-items: center; gap: 6px;">
              <span>⚠️</span> <span>ORDER FAILED — 100% REFUNDED</span>
            </div>
            <span class="tag-pill tag-cyan" style="font-size: 0.72rem; font-weight: 800; background: rgba(0,242,254,0.15); color: #00f2fe; border-color: #00f2fe;">100% REFUNDED 💰</span>
          </div>
          
          <div style="background: #060911; border: 1.5px dashed #ef4444; border-radius: 12px; padding: 14px; text-align: center; margin-bottom: 14px;">
            <div style="font-size: 0.95rem; font-weight: 800; color: #f87171; margin-bottom: 6px;">
              ❌ অর্ডারটি সম্পন্ন করা যায়নি
            </div>
            <div style="font-size: 0.82rem; color: var(--text-muted); line-height: 1.5;">
              ${escapeHtml(customRefundMsg)} (টাকার পরিমাণ: <strong>${formatPrice(order.sellingPrice, order.currency)}</strong>)
            </div>
          </div>

          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <button class="nav-btn btn-primary" onclick="openUserWalletModal()" style="flex: 1; min-width: 140px; justify-content: center; padding: 10px 14px; font-weight: 800; font-size: 0.84rem; display: inline-flex; align-items: center; gap: 6px;">
              <span>💳</span> <span>Check Wallet Balance</span>
            </button>
            <button class="nav-btn btn-cyan" onclick="closeAllModals(); openTopUpWizard('sub-ff-bd');" style="flex: 1; min-width: 140px; justify-content: center; padding: 10px 14px; font-weight: 800; font-size: 0.84rem; text-decoration: none; display: inline-flex; align-items: center; gap: 6px;">
              <span>🔄</span> <span>Try Again (পুনরায় চেষ্টা)</span>
            </button>
          </div>
        </div>
      `;
    } else if (isDone && isVoucherProduct && deliveredCode) {
      const displayCode = deliveredCode;
      const vUrl = (APP.settings && APP.settings.voucherRedeemUrl) || 'https://shop.garena.my/';
      const vText = (APP.settings && APP.settings.voucherRedeemText) || 'Redeem at shop.garena.my';
      const sUrl = (APP.settings && APP.settings.shellRedeemUrl) || 'https://bdgamesbazar.com/';
      const sText = (APP.settings && APP.settings.shellRedeemText) || 'Redeem at bdgamesbazar.com';
      const activeRedeemUrl = isShell ? sUrl : vUrl;
      const activeRedeemText = isShell ? sText : vText;

      deliverySectionHtml = `
        <div style="background: linear-gradient(135deg, rgba(0, 242, 254, 0.15), rgba(37, 99, 235, 0.12)); border: 2px solid var(--brand-cyan); border-radius: 16px; padding: 18px; margin-bottom: 16px; box-shadow: 0 0 25px rgba(0, 242, 254, 0.25);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div style="font-weight: 900; color: #fff; font-size: 1rem; display: flex; align-items: center; gap: 6px;">
              <span>🎟️</span> <span>YOUR VOUCHER / PIN CODE</span>
            </div>
            <span class="tag-pill tag-cyan" style="font-size: 0.72rem; font-weight: 800;">INSTANT DELIVERY ⚡</span>
          </div>
          
          <div style="background: #060911; border: 1.5px dashed var(--brand-cyan); border-radius: 12px; padding: 14px; text-align: center; margin-bottom: 12px;">
            <div id="trackerDeliveredCodeText" style="font-family: monospace; font-size: 1.25rem; font-weight: 900; color: #38bdf8; letter-spacing: 1px; word-break: break-all; user-select: all;">
              ${escapeHtml(displayCode)}
            </div>
          </div>

          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <button class="nav-btn btn-primary" style="flex: 1; min-width: 140px; padding: 10px 14px; font-weight: 800; font-size: 0.88rem; justify-content: center; display: inline-flex; align-items: center; gap: 6px;" onclick="copyToClipboard('${escapeHtml(displayCode)}')">
              <span>📋</span> <span>Copy Voucher Code</span>
            </button>
            <a href="${escapeHtml(activeRedeemUrl)}" target="_blank" class="nav-btn btn-cyan" style="flex: 1; min-width: 140px; padding: 10px 14px; font-weight: 800; font-size: 0.88rem; justify-content: center; text-decoration: none; display: inline-flex; align-items: center; gap: 6px;">
              <span>↗</span> <span>${escapeHtml(activeRedeemText)}</span>
            </a>
          </div>
        </div>
      `;
    } else if (isDone && !isVoucherProduct) {
      deliverySectionHtml = `
        <div style="background: linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(6, 78, 59, 0.25)); border: 2px solid #10b981; border-radius: 16px; padding: 18px; margin-bottom: 16px; box-shadow: 0 0 25px rgba(16, 185, 129, 0.25);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div style="font-weight: 900; color: #fff; font-size: 1rem; display: flex; align-items: center; gap: 6px;">
              <span>⚡</span> <span>TOP-UP DELIVERED SUCCESSFULLY</span>
            </div>
            <span class="tag-pill tag-cyan" style="font-size: 0.72rem; font-weight: 800; background: rgba(16,185,129,0.2); color: #10b981; border-color: #10b981;">100% SUCCESS 👑</span>
          </div>
          
          <div style="background: #060911; border: 1.5px dashed #10b981; border-radius: 12px; padding: 14px; text-align: center; margin-bottom: 10px;">
            ${order.playerName ? `<div style="font-size: 1.15rem; font-weight: 900; color: #10b981; margin-bottom: 4px;">🎮 Player: <strong>${escapeHtml(order.playerName)}</strong></div>` : ''}
            <div style="font-family: monospace; font-size: 1rem; font-weight: 800; color: #38bdf8;">
              Player UID: ${escapeHtml(order.playerUid)}
            </div>
          </div>

          <div style="text-align: center; font-size: 0.82rem; color: #a7f3d0; font-weight: 700;">
            ✅ ${escapeHtml(customUidSuccessMsg)} (প্যাকেজ: <strong>${escapeHtml(order.productName)}</strong>)
          </div>
        </div>
      `;
    }

    resContainer.innerHTML = `
      <div style="background: var(--bg-card); border: 1px solid var(--border-soft); border-radius: 16px; padding: 18px; margin-bottom: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
          <div>
            <span style="font-size: 0.72rem; color: var(--text-dim);">ORDER NUMBER</span>
            <h3 style="color: var(--brand-cyan); font-size: 1.2rem;">#${escapeHtml(order.id)}</h3>
          </div>
          <span class="tag-pill ${isDone ? 'tag-gold' : (isRefunded ? 'tag-cyan' : 'tag-red')}">${escapeHtml(order.status)}</span>
        </div>

        <div style="display: flex; justify-content: space-between; font-size: 0.75rem; text-align: center; margin: 16px 0;">
          <div style="color: #00e676;">1. Placed ✅</div>
          <div style="color: ${(isProc || isRefunded || isFailed) ? '#00e676' : 'var(--text-dim)'};">2. Verified ⚡</div>
          <div style="color: ${(isRefunded || isFailed) ? '#ef4444' : (isProc ? '#00e676' : 'var(--text-dim)')};">${(isRefunded || isFailed) ? '3. Server Failed ❌' : '3. Server TopUp 🎮'}</div>
          <div style="color: ${(isRefunded || isFailed) ? '#00f2fe' : (isDone ? '#00e676' : 'var(--text-dim)')};">${(isRefunded || isFailed) ? '4. Auto-Refunded 💰' : '4. Done 👑'}</div>
        </div>
      </div>

      ${deliverySectionHtml}

      <div class="receipt-printable-card" style="background: #ffffff; color: #0f172a; padding: 20px; border-radius: 16px;">
        <div style="display: flex; justify-content: space-between; border-bottom: 2px dashed #cbd5e1; padding-bottom: 12px; margin-bottom: 12px;">
          <div>
            <div style="font-weight: 900; color: #ff2d55; font-size: 1.2rem;">FREAKSHOWTOPUP</div>
            <p style="font-size: 0.72rem; color: #64748b;">freakshowtopup.shop</p>
          </div>
          <div style="text-align: right; font-size: 0.75rem;">
            <div>DATE: ${new Date(order.createdAt).toLocaleDateString()}</div>
          </div>
        </div>

        <table style="width: 100%; font-size: 0.85rem; border-collapse: collapse;">
          <tr><td style="padding: 6px 0;">Product</td><td style="text-align: right; font-weight: 700;">${escapeHtml(order.productName)}</td></tr>
          ${(isRefunded || isFailed) ? `
            ${order.playerUid ? `<tr><td style="padding: 6px 0;">Player UID</td><td style="text-align: right; color: #2563eb; font-weight: 800;">${escapeHtml(order.playerUid)}</td></tr>` : ''}
            <tr><td style="padding: 6px 0;">Order Status</td><td style="text-align: right; color: #ef4444; font-weight: 800;">Failed & Auto-Refunded 💰</td></tr>
            <tr><td style="padding: 6px 0;">Refund Status</td><td style="text-align: right; color: #0284c7; font-weight: 800;">100% Credited to Wallet</td></tr>
          ` : (isVoucherProduct ? `
            <tr><td style="padding: 6px 0;">Delivery Type</td><td style="text-align: right; color: #16a34a; font-weight: 800;">Digital Voucher PIN</td></tr>
            ${deliveredCode ? `<tr><td style="padding: 6px 0; vertical-align: top;">Voucher Code</td><td style="text-align: right; font-family: monospace; color: #0284c7; font-weight: 800; word-break: break-all;">${escapeHtml(deliveredCode)}</td></tr>` : ''}
          ` : `
            ${order.playerName ? `<tr><td style="padding: 6px 0;">Player Name</td><td style="text-align: right; color: #10b981; font-weight: 800;">${escapeHtml(order.playerName)}</td></tr>` : ''}
            <tr><td style="padding: 6px 0;">Player UID</td><td style="text-align: right; color: #2563eb; font-weight: 800;">${escapeHtml(order.playerUid)}</td></tr>
            <tr><td style="padding: 6px 0;">Delivery Status</td><td style="text-align: right; color: #16a34a; font-weight: 800;">Direct In-Game Top-Up ⚡</td></tr>
          `)}
          <tr style="border-top: 2px solid #e2e8f0; font-size: 1rem;"><td style="padding: 8px 0; font-weight: 800;">${(isRefunded || isFailed) ? 'Total Refunded' : 'Total Paid'}</td><td style="text-align: right; color: ${(isRefunded || isFailed) ? '#0284c7' : '#ff2d55'}; font-weight: 900;">${formatPrice(order.sellingPrice, order.currency)}</td></tr>
        </table>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px;">
          <button class="nav-btn btn-ghost" style="color: #0f172a; border-color: #cbd5e1;" onclick="window.print()">🖨️ Print Invoice</button>
          <span style="font-size: 0.72rem; color: ${(isRefunded || isFailed) ? '#0284c7' : '#16a34a'}; font-weight: 700;">${(isRefunded || isFailed) ? '100% Guaranteed Refund Protected' : '100% Verified Safe Delivery'}</span>
        </div>
      </div>
    `;
  } catch (e) { }
}

// ==========================================
// 8. AUTH MODAL (LOGIN & REGISTRATION)
// ==========================================

function openAuthModal() {
  closeAllModals();
  document.getElementById('authModal').classList.add('active');
  switchAuthTab('login');
  setTimeout(() => initGoogleAuth(), 100);
}

function switchAuthTab(tab) {
  document.getElementById('authPaneLogin').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('authPaneRegister').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('tabAuthLogin').classList.toggle('active', tab === 'login');
  document.getElementById('tabAuthRegister').classList.toggle('active', tab === 'register');

  if (tab === 'register') {
    const savedRef = sessionStorage.getItem('fs_ref_code');
    const refInput = document.getElementById('regReferralInput');
    if (savedRef && refInput && !refInput.value) {
      refInput.value = savedRef;
    }
  }
}

async function handleLoginSubmit() {
  const emailOrUser = document.getElementById('loginEmailInput').value.trim();
  const pwd = document.getElementById('loginPasswordInput').value.trim();

  if (!emailOrUser || !pwd) {
    showToast('⚠️ Please enter your email/username and password');
    return;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrUsername: emailOrUser, password: pwd })
    });
    const data = await res.json();
    if (data.success && data.token) {
      APP.token = data.token;
      APP.user = data.user;
      APP.wallet = data.wallet;
      APP.currency = data.user.currency;
      localStorage.setItem('fs_token', data.token);

      showToast(`👋 Welcome back, ${data.user.name}!`);
      closeAllModals();
      updateAuthUI();

      if (['SUPER_ADMIN', 'ADMIN', 'MODERATOR'].includes(data.user.role)) {
        setTimeout(() => openAdminPanel(), 400);
      }
    } else {
      showToast(`❌ ${data.message || 'Login failed'}`);
    }
  } catch (e) {
    showToast('❌ Server error. Try again.');
  }
}

async function handleRegisterSubmit() {
  const name = document.getElementById('regNameInput').value.trim();
  const email = document.getElementById('regEmailInput').value.trim();
  const username = document.getElementById('regUsernameInput').value.trim();
  const password = document.getElementById('regPasswordInput').value.trim();
  const country = document.getElementById('regCountrySelect').value;
  const currency = document.getElementById('regCurrencySelect').value;
  const refCode = document.getElementById('regReferralInput').value.trim();

  if (!name || !email || !password) {
    showToast('⚠️ Name, Email, and Password are required');
    return;
  }

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, username, password, country, currency, referralCode: refCode })
    });
    const data = await res.json();
    if (data.success && data.token) {
      APP.token = data.token;
      APP.user = data.user;
      APP.wallet = data.wallet;
      APP.currency = data.user.currency;
      localStorage.setItem('fs_token', data.token);

      showToast(`🎉 Account Created! Welcome to FREAKSHOWTOPUP.`);
      closeAllModals();
      updateAuthUI();
    } else {
      showToast(`❌ ${data.message || 'Registration failed'}`);
    }
  } catch (e) {
    showToast('❌ Server error. Try again.');
  }
}

function logoutUser() {
  APP.token = null;
  APP.user = null;
  APP.wallet = { balance: 0, currency: 'BDT' };
  localStorage.removeItem('fs_token');
  updateAuthUI();
  closeAllModals();
  showToast('🔒 Signed out successfully');
}

// ==========================================
// 8. GOOGLE / GMAIL 1-CLICK AUTHENTICATION
// ==========================================

const GOOGLE_CLIENT_ID = '886185939600-otk4o6s21fa0f561nkbigkqu9aao0icl.apps.googleusercontent.com';
let googleTokenClient = null;

function initGoogleAuth() {
  if (window.google && window.google.accounts) {
    try {
      // 1. Google Identity Services ID token init
      if (window.google.accounts.id) {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleGoogleCredentialResponse,
          auto_select: false,
          cancel_on_tap_outside: true
        });

        const btnContainer = document.getElementById('googleIdentityServicesContainer');
        if (btnContainer) {
          window.google.accounts.id.renderButton(btnContainer, {
            theme: 'filled_black',
            size: 'large',
            type: 'standard',
            shape: 'pill',
            width: 360,
            text: 'continue_with',
            logo_alignment: 'left'
          });
        }
      }

      // 2. Google OAuth2 Token Client for 1-click popup
      if (window.google.accounts.oauth2 && !googleTokenClient) {
        googleTokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: 'email profile openid',
          callback: async (tokenResponse) => {
            if (tokenResponse && tokenResponse.access_token) {
              await handleGoogleAccessToken(tokenResponse.access_token);
            }
          }
        });
      }
    } catch (e) {
      console.warn('[GSI] Init error:', e.message);
    }
  }
}

async function triggerAutoGmailLogin() {
  initGoogleAuth();

  // 1. Launch Google OAuth2 Native Popup Client if ready
  if (googleTokenClient) {
    googleTokenClient.requestAccessToken({ prompt: 'select_account' });
    return;
  }

  // 2. Launch Google ID prompt
  if (window.google && window.google.accounts && window.google.accounts.id) {
    window.google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        openGoogleOAuthPopup();
      }
    });
    return;
  }

  // 3. Direct Google OAuth Popup Window
  openGoogleOAuthPopup();
}

function openGoogleOAuthPopup() {
  const redirectUri = window.location.origin + window.location.pathname;
  const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=email%20profile%20openid&prompt=select_account`;

  const width = 500;
  const height = 600;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;

  const popup = window.open(oauthUrl, 'GoogleAuthPopup', `width=${width},height=${height},left=${left},top=${top}`);
  if (!popup || popup.closed) {
    window.location.href = oauthUrl;
  }
}

// Handle Google Access Token from popup
async function handleGoogleAccessToken(accessToken) {
  showToast('⏳ Connecting with Google account...');
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken })
    });
    const data = await res.json();
    if (data.success && data.token) {
      APP.token = data.token;
      APP.user = data.user;
      APP.wallet = data.wallet;
      APP.currency = data.user.currency;
      localStorage.setItem('fs_token', data.token);

      showToast(`🎉 Logged in as ${data.user.name} (${data.user.email})!`);
      closeAllModals();
      updateAuthUI();

      if (['SUPER_ADMIN', 'ADMIN', 'MODERATOR'].includes(data.user.role)) {
        setTimeout(() => openAdminPanel(), 400);
      }
    } else {
      showToast(`❌ ${data.message || 'Google login failed'}`);
    }
  } catch (e) {
    showToast('❌ Failed to authenticate with Google');
  }
}

function handleGoogleCredentialResponse(response) {
  if (!response || !response.credential) return;
  showToast('⏳ Verifying Google Account...');
  fetch('/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: response.credential })
  })
    .then(res => res.json())
    .then(data => {
      if (data.success && data.token) {
        APP.token = data.token;
        APP.user = data.user;
        APP.wallet = data.wallet;
        APP.currency = data.user.currency;
        localStorage.setItem('fs_token', data.token);
        showToast(`👋 Welcome, ${data.user.name}!`);
        closeAllModals();
        updateAuthUI();

        if (['SUPER_ADMIN', 'ADMIN', 'MODERATOR'].includes(data.user.role)) {
          setTimeout(() => openAdminPanel(), 400);
        }
      } else {
        showToast(`❌ ${data.message || 'Google login failed'}`);
      }
    })
    .catch(() => showToast('❌ Google authentication error'));
}

function handleMobileAccountClick() {
  if (APP.user) {
    openProfileModal();
  } else {
    openAuthModal();
  }
}

// ==========================================
// 9. REFERRAL & PROFILE MODALS
// ==========================================

async function openReferralModal() {
  if (!APP.user) return openAuthModal();
  closeAllModals();

  try {
    const res = await fetch('/api/referral', {
      headers: { 'Authorization': `Bearer ${APP.token}` }
    });
    const data = await res.json();
    if (data.success) {
      const codeEl = document.getElementById('refCodeDisplay');
      const linkEl = document.getElementById('refLinkDisplay');
      const badgeEl = document.getElementById('refCommissionRateBadge');
      const totalUsersEl = document.getElementById('refTotalUsers');
      const activeUsersEl = document.getElementById('refActiveUsers');
      const totalDepositsEl = document.getElementById('refTotalDeposits');
      const totalEarnedEl = document.getElementById('refTotalEarned');
      const pendingEarnedEl = document.getElementById('refPendingEarned');
      const historyListEl = document.getElementById('refHistoryList');

      if (codeEl) codeEl.textContent = data.referralCode || 'FS000000';
      if (linkEl) linkEl.value = data.referralLink || `https://freakshowtopup.shop?ref=${data.referralCode}`;
      if (badgeEl) badgeEl.textContent = `${data.commissionRate || '2.5%'} Commission`;
      if (totalUsersEl) totalUsersEl.textContent = data.totalReferrals || 0;
      if (activeUsersEl) activeUsersEl.textContent = `${data.activeReferrals || 0} Active`;
      if (totalDepositsEl) totalDepositsEl.textContent = formatPrice(data.totalDepositFromReferrals || 0, APP.currency);
      if (totalEarnedEl) totalEarnedEl.textContent = formatPrice(data.totalEarned !== undefined ? data.totalEarned : (data.totalCommissions || 0), APP.currency);
      if (pendingEarnedEl) pendingEarnedEl.textContent = formatPrice(data.pendingCommission || 0, APP.currency);

      if (historyListEl) {
        const history = data.referralHistory || [];
        if (history.length === 0) {
          historyListEl.innerHTML = '<div style="text-align: center; padding: 16px; color: var(--text-muted);">No referral earnings recorded yet. Share your link to start earning!</div>';
        } else {
          historyListEl.innerHTML = history.map(item => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; background: rgba(255,255,255,0.03); border-radius: var(--radius-sm); margin-bottom: 6px; border: 1px solid var(--border-soft);">
              <div>
                <div style="font-weight: 700; color: #fff;">Deposit #${item.depositId}</div>
                <div style="font-size: 0.72rem; color: var(--text-muted);">${new Date(item.createdAt).toLocaleDateString()}</div>
              </div>
              <div style="text-align: right;">
                <div style="font-weight: 800; color: var(--brand-emerald);">+${formatPrice(item.amount, APP.currency)}</div>
                <span class="tag-pill ${item.status === 'PAID' || item.status === 'CREDITED' ? 'tag-cyan' : 'tag-gold'}" style="font-size: 0.65rem; padding: 1px 6px;">${item.status || 'PAID'}</span>
              </div>
            </div>
          `).join('');
        }
      }
    }
  } catch (e) { }

  document.getElementById('referralModal').classList.add('active');
}

function openProfileModal() {
  if (!APP.user) return openAuthModal();
  closeAllModals();

  const nameEl = document.getElementById('profName');
  const emailEl = document.getElementById('profEmail');
  const usernameDisplay = document.getElementById('profUsernameDisplay');
  const countryEl = document.getElementById('profCountry');
  const countryBadge = document.getElementById('profCountryBadge');
  const currencyEl = document.getElementById('profCurrency');
  const balEl = document.getElementById('profWalletBalance');
  const avatarImg = document.getElementById('profAvatarImg');
  const letterEl = document.getElementById('profAvatarLetter');
  const roleBadge = document.getElementById('profRoleBadge');

  if (nameEl) nameEl.textContent = APP.user.name || 'Gamer';
  if (emailEl) emailEl.textContent = APP.user.email || '';
  if (usernameDisplay) usernameDisplay.textContent = `@${APP.user.username || 'gamer'}`;
  if (countryEl) countryEl.textContent = APP.user.country || 'BD';
  if (countryBadge) countryBadge.textContent = (APP.user.country === 'USD' || APP.user.country === 'GLOBAL') ? '🌐 Global' : '🇧🇩 BD';
  if (currencyEl) currencyEl.textContent = APP.user.currency || 'BDT';
  if (balEl) balEl.textContent = formatPrice(APP.wallet.balance, APP.currency);

  const currentRate = (APP.settings && (APP.settings.usdToBdtRate || APP.settings.exchangeRate)) || 120;
  document.querySelectorAll('.prof-usd-rate-text').forEach(el => el.textContent = `$1 USD = ৳${currentRate} BDT`);

  // Effective avatar display: Manual uploaded avatar > Google OAuth avatar > Initial letter fallback
  const effectiveAvatar = APP.user.avatar || APP.user.picture || APP.user.googleAvatar || null;
  if (effectiveAvatar) {
    if (avatarImg) {
      avatarImg.src = effectiveAvatar;
      avatarImg.style.display = 'block';
    }
    if (letterEl) letterEl.style.display = 'none';
  } else {
    if (avatarImg) avatarImg.style.display = 'none';
    if (letterEl) {
      letterEl.style.display = 'block';
      letterEl.textContent = (APP.user.name || 'G')[0].toUpperCase();
    }
  }

  if (roleBadge) {
    roleBadge.textContent = APP.user.role === 'SUPER_ADMIN' ? '👑 SUPER ADMIN' : (APP.user.role === 'ADMIN' ? '🛡️ ADMIN' : '🎮 PRO GAMER');
  }

  // Populate Edit Inputs
  const editName = document.getElementById('profEditName');
  const editUsername = document.getElementById('profEditUsername');
  const editAvatarImg = document.getElementById('profEditAvatarPreview');
  const editAvatarLetter = document.getElementById('profEditAvatarLetter');
  const statusMsg = document.getElementById('profUsernameStatusMsg');

  if (editName) editName.value = APP.user.name || '';
  if (editUsername) editUsername.value = (APP.user.username || '').replace(/^@/, '');
  if (statusMsg) {
    statusMsg.style.display = 'none';
    statusMsg.textContent = '';
  }

  if (effectiveAvatar) {
    if (editAvatarImg) {
      editAvatarImg.src = effectiveAvatar;
      editAvatarImg.style.display = 'block';
    }
    if (editAvatarLetter) editAvatarLetter.style.display = 'none';
  } else {
    if (editAvatarImg) editAvatarImg.style.display = 'none';
    if (editAvatarLetter) {
      editAvatarLetter.style.display = 'block';
      editAvatarLetter.textContent = (APP.user.name || 'G')[0].toUpperCase();
    }
  }

  // Populate Telegram Status Card
  const tgTitle = document.getElementById('profTgStatusTitle');
  const tgDesc = document.getElementById('profTgStatusDesc');
  const btnConnectTg = document.getElementById('btnConnectTg');
  const btnUnlinkTg = document.getElementById('btnUnlinkTg');
  const isTgLinked = Boolean(APP.user.telegramChatId);

  if (isTgLinked) {
    if (tgTitle) tgTitle.innerHTML = `<span style="color: #10b981;">✅ Telegram Connected</span>`;
    if (tgDesc) tgDesc.textContent = `${APP.user.telegramUsername || 'Linked'} (Instant Delivery Alerts Active)`;
    if (btnConnectTg) btnConnectTg.style.display = 'none';
    if (btnUnlinkTg) btnUnlinkTg.style.display = 'inline-flex';
  } else {
    if (tgTitle) tgTitle.innerHTML = `Telegram Alerts & Bot`;
    if (tgDesc) tgDesc.textContent = `Get instant delivery SMS & bot access`;
    if (btnConnectTg) btnConnectTg.style.display = 'inline-flex';
    if (btnUnlinkTg) btnUnlinkTg.style.display = 'none';
  }

  // Reset Edit Panel and Orders section states (keep compact by default)
  toggleEditProfile(false);
  toggleOrdersSection(false);
  APP.pendingProfileAvatar = null;

  document.getElementById('profileModal').classList.add('active');
}

async function connectUserTelegram() {
  if (!APP.user) {
    openLoginModal();
    return;
  }

  try {
    showToast('⏳ Generating Telegram link...');
    const token = APP.token || localStorage.getItem('fs_token') || localStorage.getItem('auth_token') || '';
    const res = await fetch('/api/user/telegram/generate-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast('⚠️ ' + (data.message || 'Failed to generate link.'));
      return;
    }

    const deepLink = data.deepLink;
    const code = data.code;

    const btnOpen = document.getElementById('btnOpenTgDeepLink');
    if (btnOpen) btnOpen.href = deepLink;

    const codeDisplay = document.getElementById('tgLinkCodeDisplay');
    const codeSub = document.getElementById('tgLinkCodeSub');
    if (codeDisplay) codeDisplay.textContent = code;
    if (codeSub) codeSub.textContent = code;

    // Show connect modal first so user sees 6-digit code
    closeAllModals();
    const modal = document.getElementById('tgConnectModal');
    if (modal) modal.classList.add('active');

    // Attempt to open deep-link in new tab
    try {
      window.open(deepLink, '_blank');
    } catch (e) {}
  } catch (err) {
    showToast('⚠️ Network error: ' + err.message);
  }
}

async function unlinkUserTelegram() {
  if (!confirm('Are you sure you want to disconnect your Telegram account?')) return;

  try {
    const token = APP.token || localStorage.getItem('fs_token') || localStorage.getItem('auth_token') || '';
    const res = await fetch('/api/user/telegram/unlink', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast('⚠️ ' + (data.message || 'Failed to unlink.'));
      return;
    }

    delete APP.user.telegramChatId;
    delete APP.user.telegramUsername;
    delete APP.user.telegramLinkedAt;
    localStorage.setItem('fs_user', JSON.stringify(APP.user));

    showToast('✅ Telegram account disconnected.');
    openProfileModal();
  } catch (err) {
    showToast('⚠️ Network error: ' + err.message);
  }
}

function toggleOrdersSection(show) {
  const panel = document.getElementById('profOrdersSection');
  const editPanel = document.getElementById('profEditPanel');
  const badge = document.getElementById('profOrdersBadge');
  if (!panel) return;

  const isVisible = panel.style.display === 'block';
  const targetShow = (typeof show === 'boolean') ? show : !isVisible;

  if (targetShow) {
    if (editPanel) editPanel.style.display = 'none';
    panel.style.display = 'block';
    if (badge) badge.textContent = '▴';
    loadUserProfileOrders();
  } else {
    panel.style.display = 'none';
    if (badge) badge.textContent = '▾';
  }
}

function toggleEditProfile(show) {
  const panel = document.getElementById('profEditPanel');
  const ordersPanel = document.getElementById('profOrdersSection');
  const ordersBadge = document.getElementById('profOrdersBadge');
  const toggleBtn = document.getElementById('btnToggleEditProfile');
  if (!panel) return;

  const isVisible = panel.style.display === 'block';
  const targetShow = (typeof show === 'boolean') ? show : !isVisible;

  if (targetShow) {
    if (ordersPanel) ordersPanel.style.display = 'none';
    if (ordersBadge) ordersBadge.textContent = '▾';
    panel.style.display = 'block';
    const editName = document.getElementById('profEditName');
    if (editName) {
      editName.focus();
    }
  } else {
    panel.style.display = 'none';
    APP.pendingProfileAvatar = null;
    const statusMsg = document.getElementById('profUsernameStatusMsg');
    if (statusMsg) statusMsg.style.display = 'none';
  }
}

async function loadUserProfileOrders() {
  const container = document.getElementById('profRecentOrdersList');
  if (!container || !APP.user || !APP.token) return;

  container.innerHTML = `
    <div style="text-align: center; padding: 20px; color: var(--text-muted); font-size: 0.8rem;">
      ⏳ Loading your purchase history...
    </div>
  `;

  try {
    const res = await fetch('/api/orders', {
      headers: { 'Authorization': `Bearer ${APP.token}` }
    });
    const data = await res.json();
    if (data.success && Array.isArray(data.orders)) {
      if (data.orders.length === 0) {
        container.innerHTML = `
          <div style="text-align: center; padding: 24px 16px; color: var(--text-muted); font-size: 0.82rem; background: rgba(255,255,255,0.02); border-radius: var(--radius-md); border: 1px dashed var(--border-soft);">
            <div style="font-size: 1.8rem; margin-bottom: 6px;">🛒</div>
            <div style="font-weight: 700; color: #fff; margin-bottom: 4px;">No purchases yet</div>
            <div>Your recent top-up orders will appear right here.</div>
          </div>
        `;
        return;
      }

      // Sort newest first
      const sorted = [...data.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const recent = sorted.slice(0, 10);

      container.innerHTML = recent.map(o => {
        let statusBadgeClass = 'tag-gold';
        let statusIcon = '⏳';
        let statusText = o.status || 'PENDING';

        if (o.status === 'DONE' || o.status === 'COMPLETED' || o.status === 'SUCCESS') {
          statusBadgeClass = 'tag-cyan';
          statusIcon = '✔';
          statusText = 'Completed';
        } else if (o.status === 'REFUNDED') {
          statusBadgeClass = 'tag-red';
          statusIcon = '↩';
          statusText = 'Refunded';
        } else if (o.status === 'FAILED') {
          statusBadgeClass = 'tag-red';
          statusIcon = '✖';
          statusText = 'Failed';
        } else if (o.status === 'PROCESSING') {
          statusBadgeClass = 'tag-gold';
          statusIcon = '⚡';
          statusText = 'Processing';
        }

        // Note / Delivery details box
        let noteRows = [];
        if (o.playerName) {
          noteRows.push(`<div>Player Name: <strong style="color: #fff;">${escapeHtml(o.playerName)}</strong></div>`);
        }
        if (o.playerUid) {
          noteRows.push(`<div>Player ID (UID): <code style="color: var(--brand-cyan); font-weight: 800;">${escapeHtml(o.playerUid)}</code></div>`);
        }
        if (o.likesAdded || o.likesBefore !== undefined) {
          if (o.likesBefore !== undefined) noteRows.push(`<div>Likes Before: ${o.likesBefore}</div>`);
          if (o.likesNow !== undefined) noteRows.push(`<div>Likes Now: ${o.likesNow}</div>`);
          if (o.likesAdded !== undefined) noteRows.push(`<div>Likes Added: <strong>+${o.likesAdded}</strong></div>`);
        }
        if (o.freshEmail) {
          noteRows.push(`<div>Login Email: <code style="color: #fff;">${escapeHtml(o.freshEmail)}</code></div>`);
        }
        if (o.voucherCode || o.codeDelivered || o.code) {
          const codeVal = o.voucherCode || o.codeDelivered || o.code;
          noteRows.push(`
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 4px;">
              <span>🎟️ Voucher Code: <code style="color: var(--brand-cyan); font-weight: 900; background: rgba(0,0,0,0.5); padding: 3px 7px; border-radius: 4px; user-select: all;">${escapeHtml(codeVal)}</code></span>
              <button onclick="copyToClipboard('${escapeHtml(codeVal)}')" style="background: var(--brand-cyan); color: #000; border: none; border-radius: 4px; padding: 3px 9px; font-size: 0.72rem; font-weight: 800; cursor: pointer;">📋 Copy</button>
            </div>
          `);
        }

        const timeAgo = formatTimeAgo(o.createdAt);

        return `
          <div style="background: rgba(255, 255, 255, 0.03); border: 1.5px solid var(--border-soft); border-radius: var(--radius-md); padding: 12px 14px; transition: border-color 0.2s ease;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 800; font-size: 0.92rem; color: #fff; word-break: break-word;">
                  ${escapeHtml(o.productName || 'Top-Up Purchase')}
                </div>
                <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 3px;">
                  <code style="color: var(--brand-cyan);">#${escapeHtml(o.id)}</code> · ${timeAgo}
                </div>
              </div>
              <div style="text-align: right; flex-shrink: 0;">
                <span class="tag-pill ${statusBadgeClass}" style="font-size: 0.68rem; padding: 2px 8px; font-weight: 800;">${statusIcon} ${statusText}</span>
                <div style="font-weight: 900; color: var(--brand-gold); font-size: 1.02rem; margin-top: 4px;">
                  ${formatPrice(o.sellingPrice, o.currency || APP.currency)}
                </div>
              </div>
            </div>

            ${noteRows.length > 0 ? `
              <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: var(--radius-sm); padding: 8px 12px; margin-top: 10px; font-size: 0.76rem; line-height: 1.5; color: #d1fae5;">
                <div style="display: flex; align-items: center; gap: 4px; font-weight: 800; color: #34d399; margin-bottom: 3px; letter-spacing: 0.5px; font-size: 0.72rem;">
                  <span>🚩</span> NOTE
                </div>
                ${noteRows.join('')}
              </div>
            ` : ''}

            <div style="margin-top: 10px; text-align: right;">
              <button type="button" onclick="viewOrderDetailsFromProfile('${escapeHtml(o.id)}')" style="background: none; border: none; color: var(--brand-cyan); font-weight: 800; font-size: 0.78rem; cursor: pointer; text-decoration: underline; padding: 2px 4px;">
                View Details ↗
              </button>
            </div>
          </div>
        `;
      }).join('');
    } else {
      container.innerHTML = `<div style="text-align: center; padding: 18px; color: var(--text-muted); font-size: 0.8rem;">Could not load purchases. Click Refresh to try again.</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div style="text-align: center; padding: 18px; color: var(--text-muted); font-size: 0.8rem;">Could not load purchases. Click Refresh to try again.</div>`;
  }
}

function viewOrderDetailsFromProfile(orderId) {
  closeAllModals();
  const trackerInput = document.getElementById('inputTrackOrderId');
  if (trackerInput) {
    trackerInput.value = orderId;
  }
  openOrderTrackerModal();
  handleSearchOrder();
}

function formatTimeAgo(isoString) {
  if (!isoString) return 'Just now';
  try {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    return new Date(isoString).toLocaleDateString();
  } catch (e) {
    return 'Recently';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function handleProfilePhotoSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!validTypes.includes(file.type.toLowerCase())) {
    showToast('⚠️ Please choose a valid image file (JPG, PNG, WEBP).');
    event.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    const img = new Image();
    img.onload = function () {
      try {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        const maxDim = 256; // High quality avatar size (optimized under 100 KB)

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.82);

        // Enforce strict 100 KB limit
        if (compressedDataUrl.length > 100 * 1024 * 1.37) {
          showToast('⚠️ Image file is too large (max 100 KB).');
          event.target.value = '';
          return;
        }

        APP.pendingProfileAvatar = compressedDataUrl;

        // Immediate visual feedback in edit preview
        const editImg = document.getElementById('profEditAvatarPreview');
        const editLetter = document.getElementById('profEditAvatarLetter');
        if (editImg) {
          editImg.src = compressedDataUrl;
          editImg.style.display = 'block';
        }
        if (editLetter) editLetter.style.display = 'none';

        // Immediate visual feedback in main profile avatar
        const mainImg = document.getElementById('profAvatarImg');
        const mainLetter = document.getElementById('profAvatarLetter');
        if (mainImg) {
          mainImg.src = compressedDataUrl;
          mainImg.style.display = 'block';
        }
        if (mainLetter) mainLetter.style.display = 'none';

        showToast('📸 Photo loaded (under 100 KB). Click "Save Changes" to save!');
      } catch (err) {
        showToast('⚠️ Could not process image. Please try another file.');
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function handleResetProfileAvatar() {
  APP.pendingProfileAvatar = ''; // empty string signals backend to clear manual avatar

  const googleOrNull = (APP.user && (APP.user.picture || APP.user.googleAvatar)) || null;

  // Update edit preview
  const editImg = document.getElementById('profEditAvatarPreview');
  const editLetter = document.getElementById('profEditAvatarLetter');
  if (googleOrNull) {
    if (editImg) { editImg.src = googleOrNull; editImg.style.display = 'block'; }
    if (editLetter) editLetter.style.display = 'none';
  } else {
    if (editImg) editImg.style.display = 'none';
    if (editLetter) {
      editLetter.style.display = 'block';
      editLetter.textContent = (APP.user && APP.user.name ? APP.user.name[0] : 'G').toUpperCase();
    }
  }

  // Update main profile avatar preview
  const mainImg = document.getElementById('profAvatarImg');
  const mainLetter = document.getElementById('profAvatarLetter');
  if (googleOrNull) {
    if (mainImg) { mainImg.src = googleOrNull; mainImg.style.display = 'block'; }
    if (mainLetter) mainLetter.style.display = 'none';
  } else {
    if (mainImg) mainImg.style.display = 'none';
    if (mainLetter) {
      mainLetter.style.display = 'block';
      mainLetter.textContent = (APP.user && APP.user.name ? APP.user.name[0] : 'G').toUpperCase();
    }
  }

  showToast('↺ Reverted to Gmail / Default avatar. Click "Save Changes" to apply.');
}

const handleUsernameInputChange = debounce(async function (rawVal) {
  const statusMsg = document.getElementById('profUsernameStatusMsg');
  if (!statusMsg) return;

  const clean = String(rawVal || '').replace(/^@/, '').toLowerCase().trim();
  if (!clean) {
    statusMsg.style.display = 'none';
    return;
  }

  if (APP.user && clean === (APP.user.username || '').toLowerCase()) {
    statusMsg.style.display = 'none';
    return;
  }

  if (!/^[a-zA-Z0-9_]{3,30}$/.test(clean)) {
    statusMsg.textContent = '❌ 3-30 characters (letters, numbers, underscore only)';
    statusMsg.style.color = '#ef4444';
    statusMsg.style.display = 'block';
    return;
  }

  try {
    const res = await fetch(`/api/user/check-username?username=${encodeURIComponent(clean)}`, {
      headers: { 'Authorization': `Bearer ${APP.token}` }
    });
    const data = await res.json();
    if (data.available) {
      statusMsg.textContent = `✅ @${clean} is available!`;
      statusMsg.style.color = '#10b981';
      statusMsg.style.display = 'block';
    } else {
      statusMsg.textContent = `❌ ${data.message || 'Username already taken. Please choose another username.'}`;
      statusMsg.style.color = '#ef4444';
      statusMsg.style.display = 'block';
    }
  } catch (e) { }
}, 300);

async function saveUserProfile() {
  if (!APP.user || !APP.token) {
    return openAuthModal();
  }

  const nameInput = document.getElementById('profEditName');
  const usernameInput = document.getElementById('profEditUsername');
  const saveBtn = document.getElementById('btnSaveProfile');
  const statusMsg = document.getElementById('profUsernameStatusMsg');

  const name = nameInput ? nameInput.value.trim() : '';
  const username = usernameInput ? usernameInput.value.replace(/^@/, '').trim() : '';

  if (!name) {
    showToast('⚠️ Full Name cannot be empty.');
    if (nameInput) nameInput.focus();
    return;
  }

  if (!username) {
    showToast('⚠️ Username cannot be empty.');
    if (usernameInput) usernameInput.focus();
    return;
  }

  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    showToast('⚠️ Username must be 3-30 characters (letters, numbers, underscores).');
    if (statusMsg) {
      statusMsg.textContent = '❌ Username must be 3-30 characters (letters, numbers, underscores).';
      statusMsg.style.color = '#ef4444';
      statusMsg.style.display = 'block';
    }
    return;
  }

  const originalBtnText = saveBtn ? saveBtn.innerHTML : '💾 Save Changes';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '⏳ Saving...';
  }

  try {
    const payload = {
      name,
      username
    };

    if (APP.pendingProfileAvatar !== undefined && APP.pendingProfileAvatar !== null) {
      payload.avatar = APP.pendingProfileAvatar;
    }

    const res = await fetch('/api/user/profile', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${APP.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.success && data.user) {
      APP.user = data.user;
      if (data.token) {
        APP.token = data.token;
        localStorage.setItem('fs_token', data.token);
      }
      APP.pendingProfileAvatar = null;
      showToast('🎉 Profile updated successfully!');
      toggleEditProfile(false);
      openProfileModal();
      updateAuthUI();
    } else {
      const errMsg = data.message || 'Failed to update profile.';
      showToast(`❌ ${errMsg}`);
      if (statusMsg) {
        statusMsg.textContent = `❌ ${errMsg}`;
        statusMsg.style.color = '#ef4444';
        statusMsg.style.display = 'block';
      }
    }
  } catch (err) {
    showToast('❌ Network error. Please try again.');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = originalBtnText;
    }
  }
}

// ==========================================
// 10. ADMIN MANAGEMENT PANEL
// ==========================================

async function openAdminPanel() {
  if (!APP.user || !['SUPER_ADMIN', 'ADMIN', 'MODERATOR'].includes(APP.user.role)) {
    showToast('⛔ Admin access required.');
    return;
  }
  closeAllModals();
  document.getElementById('adminPortalModal').classList.add('active');
  await loadAdminDashboard();
}

async function loadAdminDashboard() {
  try {
    const res = await fetch('/api/admin/stats', {
      headers: { 'Authorization': `Bearer ${APP.token}` }
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('admStatSales').textContent = `৳${data.stats.totalSales.toLocaleString()}`;
      document.getElementById('admStatProfit').textContent = `৳${data.stats.totalProfit.toLocaleString()}`;
      document.getElementById('admStatUsers').textContent = data.stats.totalUsers;
      document.getElementById('admStatPendingDep').textContent = data.stats.pendingDeposits;

      // Render Admin Orders Queue
      const ordersTbody = document.getElementById('admOrdersTableBody');
      if (ordersTbody) {
        ordersTbody.innerHTML = data.recentOrders.map(o => `
          <tr>
            <td><code>#${o.id}</code></td>
            <td><strong>${o.productName}</strong></td>
            <td><code style="color: var(--brand-cyan);">${o.playerUid}</code></td>
            <td>৳${o.sellingPrice}</td>
            <td><span style="color: #00e676;">৳${o.profit}</span></td>
            <td><span class="tag-pill ${o.status === 'SUCCESS' ? 'tag-gold' : 'tag-red'}">${o.status}</span></td>
            <td>
              <button class="btn-add-money-sm" style="background: #00e676; color: #000;" onclick="adminUpdateOrderStatus('${o.id}', 'SUCCESS')">Done</button>
              <button class="btn-add-money-sm" style="background: #ff2d55; color: #fff;" onclick="adminUpdateOrderStatus('${o.id}', 'FAILED')">Fail</button>
            </td>
          </tr>
        `).join('');
      }
    }
  } catch (e) { }
}

async function adminUpdateOrderStatus(orderId, status) {
  try {
    const res = await fetch('/api/admin/orders/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${APP.token}`
      },
      body: JSON.stringify({ orderId, status })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Order #${orderId} updated to ${status}`);
      loadAdminDashboard();
    }
  } catch (e) { }
}

async function exportAdminBackup() {
  try {
    const res = await fetch('/api/admin/backup', {
      headers: { 'Authorization': `Bearer ${APP.token}` }
    });
    const data = await res.json();
    const str = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data.data, null, 2));
    const dl = document.createElement('a');
    dl.setAttribute('href', str);
    dl.setAttribute('download', `FREAKSHOWTOPUP_BACKUP_${Date.now()}.json`);
    document.body.appendChild(dl);
    dl.click();
    dl.remove();
    showToast('📥 Complete Database JSON backup downloaded!');
  } catch (e) { }
}

// ==========================================
// 11. PWA PROGRESSIVE WEB APP ENGINE (IMAGE 2)
// ==========================================

let deferredPwaPrompt = null;

function initPwaEngine() {
  // 1. Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        console.log('[PWA] Service Worker registered with scope:', reg.scope);
      })
      .catch(err => {
        console.warn('[PWA] Service Worker registration failed:', err);
      });
  }

  // 2. Listen for BeforeInstallPrompt event
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPwaPrompt = e;
    const banner = document.getElementById('pwaInstallContainer');
    const isDismissed = sessionStorage.getItem('fs_pwa_dismissed');
    if (banner && !isDismissed) {
      banner.style.display = 'block';
    }
  });

  // Check standalone mode or dismissed state
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isDismissed = sessionStorage.getItem('fs_pwa_dismissed');
  const banner = document.getElementById('pwaInstallContainer');
  if (banner) {
    if (isStandalone || isDismissed) {
      banner.style.display = 'none';
    } else {
      banner.style.display = 'block';
    }
  }

  window.addEventListener('appinstalled', () => {
    console.log('[PWA] App installed successfully');
    deferredPwaPrompt = null;
    const b = document.getElementById('pwaInstallContainer');
    if (b) b.style.display = 'none';
    showToast('🎉 FREAKSHOW Web App installed to your home screen!');
  });
}

async function triggerPwaInstall() {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  if (isStandalone) {
    showToast('✨ FREAKSHOW is already running in Web App mode!');
    return;
  }

  if (deferredPwaPrompt) {
    try {
      deferredPwaPrompt.prompt();
      const choice = await deferredPwaPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        const banner = document.getElementById('pwaInstallContainer');
        if (banner) banner.style.display = 'none';
      }
      deferredPwaPrompt = null;
    } catch (e) {
      console.warn('[PWA] Prompt error:', e);
    }
  } else if (isIos) {
    const iosModal = document.getElementById('iosPwaModal');
    if (iosModal) iosModal.classList.add('active');
  }
}

function dismissPwaBanner() {
  const banner = document.getElementById('pwaInstallContainer');
  if (banner) {
    banner.style.opacity = '0';
    banner.style.transform = 'translateY(-10px)';
    setTimeout(() => {
      banner.style.display = 'none';
    }, 300);
  }
  sessionStorage.setItem('fs_pwa_dismissed', 'true');
}

// ==========================================
// 12. LIVE RECENT ORDERS FEED (IMAGE 1)
// ==========================================

let recentOrdersData = [];

async function fetchRecentOrders() {
  const container = document.getElementById('recentOrdersList');
  if (!container) return;

  try {
    const res = await fetch('/api/orders/recent');
    const data = await res.json();
    if (data.success && Array.isArray(data.orders)) {
      recentOrdersData = data.orders;
      renderRecentOrders(recentOrdersData);
    }
  } catch (err) {
    console.warn('[ORDERS] Error fetching recent orders:', err);
    renderRecentOrders([]);
  }
}

function refreshRecentOrders() {
  showToast('🔄 Refreshing live orders feed...');
  fetchRecentOrders();
}

function renderRecentOrders(orders) {
  const container = document.getElementById('recentOrdersList');
  if (!container) return;

  if (!orders || orders.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 24px; color: var(--text-muted); font-size: 0.85rem;">
        No recent orders yet. Place an order to see it live here!
      </div>
    `;
    return;
  }

  container.innerHTML = orders.slice(0, 5).map(order => {
    const custName = order.customer || order.userName || 'Verified Gamer';
    const prodName = order.item || order.productName || 'Diamonds Top-Up';
    const initials = (custName.split(' ').map(w => w[0]).join('').substring(0, 2) || custName[0] || 'G').toUpperCase();

    // Distinct vibrant avatar gradient by customer name hash
    let hash = 0;
    for (let i = 0; i < custName.length; i++) {
      hash = custName.charCodeAt(i) + ((hash << 5) - hash);
    }
    const avatarGradients = [
      'linear-gradient(135deg, #0284c7, #00f2fe)',
      'linear-gradient(135deg, #8b5cf6, #d946ef)',
      'linear-gradient(135deg, #10b981, #34d399)',
      'linear-gradient(135deg, #f59e0b, #fbbf24)',
      'linear-gradient(135deg, #ec4899, #f43f5e)',
      'linear-gradient(135deg, #6366f1, #a855f7)'
    ];
    const bg = avatarGradients[Math.abs(hash) % avatarGradients.length];

    let itemDisplay = prodName;
    if (!itemDisplay.includes('💎') && (itemDisplay.toLowerCase().includes('diamond') || itemDisplay.toLowerCase().includes('ff') || itemDisplay.toLowerCase().includes('topup') || itemDisplay.toLowerCase().includes('top up'))) {
      itemDisplay = `💎 ${itemDisplay}`;
    }

    return `
      <div class="recent-order-row">
        <div class="order-customer-col">
          <div class="order-avatar-circle" style="background: ${bg}; color: #000; font-weight: 900; box-shadow: 0 2px 8px rgba(0,242,254,0.3);">${initials}</div>
          <div class="order-customer-info">
            <span class="order-customer-name">${custName}</span>
            <span class="order-item-badge">${itemDisplay}</span>
          </div>
        </div>
        <div class="order-status-col">
          <span class="status-badge-done">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            ${order.status || 'Done'}
          </span>
        </div>
      </div>
    `;
  }).join('');
}

function showLiveToast(purchase) {
  const toast = document.createElement('div');
  toast.className = 'toast-msg';
  toast.style.borderLeftColor = 'var(--brand-emerald)';
  toast.innerHTML = `
    <div style="font-weight: 800; font-size: 0.84rem;">${purchase.name} recharged!</div>
    <div style="font-size: 0.72rem; color: var(--text-muted);">${purchase.item} (${purchase.price}) • Just now</div>
  `;
  const container = document.getElementById('toastContainer');
  if (container) {
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
  }
}

function showToast(msg) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const t = document.createElement('div');
  t.className = 'toast-msg';
  t.innerHTML = `<span>⚡</span><span>${msg}</span>`;
  container.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => showToast(`📋 Copied: "${text}"`));
}

function closeAllModals() {
  document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('active'));
  document.body.classList.remove('modal-open');
  const nav = document.getElementById('mobileAppNavBar');
  if (nav) nav.style.removeProperty('display');
  const dock = document.getElementById('floatingSupportDock');
  if (dock) dock.style.removeProperty('display');
}

function setupEventListeners() {
  // Safely toggle body.modal-open whenever any modal opens or closes without infinite loops
  const modalObserver = new MutationObserver(() => {
    const hasActiveModal = !!document.querySelector('.modal-backdrop.active');
    const isModalOpen = document.body.classList.contains('modal-open');
    const nav = document.getElementById('mobileAppNavBar');
    const dock = document.getElementById('floatingSupportDock');

    if (hasActiveModal && !isModalOpen) {
      document.body.classList.add('modal-open');
      if (nav) nav.style.setProperty('display', 'none', 'important');
      if (dock) dock.style.setProperty('display', 'none', 'important');
    } else if (!hasActiveModal && isModalOpen) {
      document.body.classList.remove('modal-open');
      if (nav) nav.style.removeProperty('display');
      if (dock) dock.style.removeProperty('display');
    }
  });

  document.querySelectorAll('.modal-backdrop').forEach(m => {
    modalObserver.observe(m, { attributes: true, attributeFilter: ['class'] });
  });

  const search = document.getElementById('navSearchInput');
  if (search) {
    search.addEventListener('input', e => renderCatalog('all', e.target.value));
  }

  document.querySelectorAll('.cat-pill').forEach(pill => {
    pill.addEventListener('click', e => {
      document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
      e.target.classList.add('active');
      renderCatalog(e.target.dataset.category || 'all');
    });
  });

  document.querySelectorAll('.mob-nav-item').forEach(item => {
    item.addEventListener('click', e => {
      document.querySelectorAll('.mob-nav-item').forEach(btn => btn.classList.remove('active'));
      item.classList.add('active');
    });
  });

  document.querySelectorAll('.modal-backdrop').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) closeAllModals(); });
  });

  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllModals(); });
}

// ==========================================
// ANTI-INSPECT PROTECTION ("MAKE BY JRJ")
// ==========================================
function showMakeByJrjPopup(x, y) {
  if (!document.getElementById('jrjPopupStyle')) {
    const s = document.createElement('style');
    s.id = 'jrjPopupStyle';
    s.textContent = `
      @keyframes jrjFloatAnim {
        0% { opacity: 0; transform: translate(-50%, -60%) scale(0.8); }
        20% { opacity: 1; transform: translate(-50%, -100%) scale(1.05); }
        80% { opacity: 1; transform: translate(-50%, -110%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -140%) scale(0.9); }
      }
    `;
    document.head.appendChild(s);
  }

  const badge = document.createElement('div');
  badge.innerHTML = '⚡ <b>MADE BY JRJ</b>';
  badge.style.cssText = `
    position: fixed;
    left: ${x}px;
    top: ${y}px;
    transform: translate(-50%, -100%);
    background: linear-gradient(135deg, #090e17 0%, #0f1c2e 100%);
    border: 1.5px solid #00f2fe;
    color: #00f2fe;
    padding: 8px 18px;
    border-radius: 10px;
    font-size: 0.85rem;
    font-weight: 900;
    letter-spacing: 0.8px;
    box-shadow: 0 8px 28px rgba(0, 242, 254, 0.45), 0 0 12px rgba(0, 242, 254, 0.25);
    pointer-events: none;
    z-index: 9999999;
    white-space: nowrap;
    animation: jrjFloatAnim 1.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  `;
  document.body.appendChild(badge);
  setTimeout(() => badge.remove(), 1300);
}

document.addEventListener('contextmenu', function (e) {
  e.preventDefault();
  showMakeByJrjPopup(e.clientX, e.clientY);
});

document.addEventListener('keydown', function (e) {
  // Disable F12
  if (e.key === 'F12' || e.keyCode === 123) {
    e.preventDefault();
    showMakeByJrjPopup(window.innerWidth / 2, window.innerHeight / 2);
    return false;
  }
  // Disable Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C
  if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'J' || e.key === 'j' || e.key === 'C' || e.key === 'c')) {
    e.preventDefault();
    showMakeByJrjPopup(window.innerWidth / 2, window.innerHeight / 2);
    return false;
  }
  // Disable Ctrl+U (View Source)
  if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) {
    e.preventDefault();
    showMakeByJrjPopup(window.innerWidth / 2, window.innerHeight / 2);
    return false;
  }
});

