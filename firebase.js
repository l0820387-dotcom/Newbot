require('dotenv').config();
const admin = require('firebase-admin');

// ---- Init Firebase ----
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (e) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON is invalid or missing in .env');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

// ================= USERS =================

async function getUser(telegramId) {
  const snap = await db.ref(`users/${telegramId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

async function createUserIfNotExists(telegramId, tgUser, referredByCode) {
  const existing = await getUser(telegramId);
  if (existing) return existing;

  const referralCode = generateReferralCode(telegramId);
  let referredBy = null;

  if (referredByCode) {
    const referrer = await getUserByReferralCode(referredByCode);
    if (referrer && referrer.telegramId != telegramId) {
      referredBy = referrer.telegramId;
    }
  }

  const newUser = {
    telegramId,
    name: tgUser.first_name || '',
    username: tgUser.username || '',
    joinedAt: Date.now(),
    walletBalance: 0,
    referralCode,
    referredBy,
    hasFirstPurchase: false
  };

  await db.ref(`users/${telegramId}`).set(newUser);
  return newUser;
}

function generateReferralCode(telegramId) {
  return 'REF' + telegramId.toString().slice(-6);
}

async function getUserByReferralCode(code) {
  const snap = await db.ref('users').orderByChild('referralCode').equalTo(code).once('value');
  if (!snap.exists()) return null;
  const val = snap.val();
  const key = Object.keys(val)[0];
  return { ...val[key], telegramId: key };
}

async function getAllUsers() {
  const snap = await db.ref('users').once('value');
  return snap.exists() ? snap.val() : {};
}

// ================= WALLET =================

async function getWalletBalance(telegramId) {
  const user = await getUser(telegramId);
  return user ? (user.walletBalance || 0) : 0;
}

async function creditWallet(telegramId, amount, reason) {
  const ref = db.ref(`users/${telegramId}/walletBalance`);
  const snap = await ref.once('value');
  const current = snap.exists() ? snap.val() : 0;
  const updated = current + amount;
  await ref.set(updated);

  await logWalletTxn(telegramId, amount, 'credit', reason);
  return updated;
}

async function debitWallet(telegramId, amount, reason) {
  const ref = db.ref(`users/${telegramId}/walletBalance`);
  const snap = await ref.once('value');
  const current = snap.exists() ? snap.val() : 0;

  if (current < amount) {
    throw new Error('INSUFFICIENT_BALANCE');
  }

  const updated = current - amount;
  await ref.set(updated);

  await logWalletTxn(telegramId, amount, 'debit', reason);
  return updated;
}

// ================= USER BAN SYSTEM =================

async function banUser(telegramId, reason) {
  await db.ref(`users/${telegramId}`).update({
    banned: true,
    banReason: reason || 'No reason given',
    bannedAt: Date.now()
  });
}

async function unbanUser(telegramId) {
  await db.ref(`users/${telegramId}`).update({
    banned: false,
    banReason: null,
    bannedAt: null
  });
}

async function isUserBanned(telegramId) {
  const user = await getUser(telegramId);
  return user ? !!user.banned : false;
}

async function logWalletTxn(telegramId, amount, type, reason) {
  const txnRef = db.ref('walletTransactions').push();
  await txnRef.set({
    userId: telegramId,
    amount,
    type,
    reason,
    createdAt: Date.now()
  });
}

// ================= PRODUCTS =================

async function getAllProducts(activeOnly = true) {
  const snap = await db.ref('products').once('value');
  if (!snap.exists()) return {};
  const all = snap.val();
  if (!activeOnly) return all;

  const filtered = {};
  for (const [id, p] of Object.entries(all)) {
    if (p.active) filtered[id] = p;
  }
  return filtered;
}

async function getProductsByCategory(category) {
  const all = await getAllProducts(true);
  const filtered = {};
  for (const [id, p] of Object.entries(all)) {
    if (p.category === category) filtered[id] = p;
  }
  return filtered;
}

async function getAllCategories() {
  const all = await getAllProducts(true);
  const cats = new Set();
  Object.values(all).forEach(p => cats.add(p.category));
  return [...cats];
}

async function getProduct(productId) {
  const snap = await db.ref(`products/${productId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

async function searchProducts(query) {
  const all = await getAllProducts(true);
  const q = query.toLowerCase().trim();
  const results = {};
  for (const [id, p] of Object.entries(all)) {
    if (p.name && p.name.toLowerCase().includes(q)) results[id] = p;
  }
  return results;
}

async function decrementStock(productId) {
  const ref = db.ref(`products/${productId}/stock`);
  const snap = await ref.once('value');
  const current = snap.exists() ? snap.val() : -1;

  if (current === -1) return; // unlimited stock, skip

  const updated = Math.max(0, current - 1);
  await ref.set(updated);
  return updated;
}

async function checkLowStock(productId) {
  const product = await getProduct(productId);
  if (!product || product.stock === -1) return null; // unlimited, no alert needed

  const LOW_STOCK_THRESHOLD = 3;
  if (product.stock <= LOW_STOCK_THRESHOLD) {
    return { productName: product.name, stock: product.stock };
  }
  return null;
}

// ================= RATINGS & REVIEWS =================

async function addReview(productId, telegramId, userName, rating, comment) {
  const reviewRef = db.ref(`reviews/${productId}`).push();
  await reviewRef.set({
    userId: telegramId,
    userName,
    rating,
    comment: comment || '',
    createdAt: Date.now()
  });
  return reviewRef.key;
}

async function getProductReviews(productId) {
  const snap = await db.ref(`reviews/${productId}`).once('value');
  return snap.exists() ? snap.val() : {};
}

async function getProductAvgRating(productId) {
  const reviews = await getProductReviews(productId);
  const list = Object.values(reviews);
  if (list.length === 0) return { avg: 0, count: 0 };

  const sum = list.reduce((acc, r) => acc + (r.rating || 0), 0);
  return { avg: (sum / list.length).toFixed(1), count: list.length };
}

// ================= COUPONS =================

async function getCoupon(code) {
  const snap = await db.ref(`coupons/${code.toUpperCase()}`).once('value');
  return snap.exists() ? snap.val() : null;
}

async function validateCoupon(code, orderAmount) {
  const coupon = await getCoupon(code);
  if (!coupon || !coupon.active) return { valid: false, reason: 'Invalid or inactive coupon' };

  if (coupon.expiresAt && Date.now() > coupon.expiresAt) {
    return { valid: false, reason: 'Coupon expired' };
  }

  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    return { valid: false, reason: 'Coupon usage limit reached' };
  }

  if (coupon.minAmount && orderAmount < coupon.minAmount) {
    return { valid: false, reason: `Minimum order amount ₹${coupon.minAmount} required` };
  }

  let discount = coupon.discountType === 'percent'
    ? Math.round((orderAmount * coupon.discountValue) / 100)
    : coupon.discountValue;

  discount = Math.min(discount, orderAmount); // never discount more than order value

  return { valid: true, discount, coupon };
}

async function incrementCouponUsage(code) {
  const ref = db.ref(`coupons/${code.toUpperCase()}/usedCount`);
  const snap = await ref.once('value');
  const current = snap.exists() ? snap.val() : 0;
  await ref.set(current + 1);
}

// ================= ORDERS =================

async function createOrder(orderData) {
  const orderRef = db.ref('orders').push();
  const order = {
    ...orderData,
    id: orderRef.key,
    createdAt: Date.now(),
    status: 'pending'
  };
  await orderRef.set(order);
  return order;
}

async function updateOrderStatus(orderId, status, extra = {}) {
  await db.ref(`orders/${orderId}`).update({ status, ...extra });
}

async function getOrder(orderId) {
  const snap = await db.ref(`orders/${orderId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

async function getUserOrders(telegramId) {
  const snap = await db.ref('orders').orderByChild('userId').equalTo(String(telegramId)).once('value');
  return snap.exists() ? snap.val() : {};
}

async function hasUserBoughtProduct(telegramId, productId) {
  const orders = await getUserOrders(telegramId);
  return Object.values(orders).some(o =>
    o.productId === productId && (o.status === 'paid' || o.status === 'delivered')
  );
}

// ================= REFUNDS =================

async function requestRefund(orderId, reason) {
  await db.ref(`orders/${orderId}`).update({
    refundStatus: 'requested',
    refundReason: reason || '',
    refundRequestedAt: Date.now()
  });
}

async function processRefund(orderId, approve) {
  const order = await getOrder(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');

  if (approve) {
    await creditWallet(order.userId, order.amount, 'refund');
    await db.ref(`orders/${orderId}`).update({
      status: 'refunded',
      refundStatus: 'approved',
      refundedAt: Date.now()
    });
  } else {
    await db.ref(`orders/${orderId}`).update({ refundStatus: 'rejected' });
  }
}

// ================= SALES REPORTS =================

async function getSalesReport(periodDays) {
  const cutoff = Date.now() - (periodDays * 24 * 60 * 60 * 1000);
  const snap = await db.ref('orders').once('value');
  if (!snap.exists()) return { totalSales: 0, orderCount: 0, topProducts: [] };

  const orders = Object.values(snap.val())
    .filter(o => o.createdAt >= cutoff && (o.status === 'paid' || o.status === 'delivered'));

  const totalSales = orders.reduce((sum, o) => sum + (o.amount || 0), 0);
  const productCounts = {};
  orders.forEach(o => {
    productCounts[o.productName] = (productCounts[o.productName] || 0) + 1;
  });

  const topProducts = Object.entries(productCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name} (${count} sold)`);

  return { totalSales, orderCount: orders.length, topProducts };
}

// ================= REFERRAL =================

async function getReferralSettings() {
  const snap = await db.ref('referralSettings').once('value');
  return snap.exists() ? snap.val() : { bonusAmount: 20, bonusType: 'flat' };
}

async function processReferralBonus(buyerTelegramId, orderAmount) {
  const buyer = await getUser(buyerTelegramId);
  if (!buyer || buyer.hasFirstPurchase || !buyer.referredBy) return;

  const settings = await getReferralSettings();
  let bonus = settings.bonusType === 'percent'
    ? Math.round((orderAmount * settings.bonusAmount) / 100)
    : settings.bonusAmount;

  await creditWallet(buyer.referredBy, bonus, 'referral_bonus');
  await db.ref(`users/${buyerTelegramId}/hasFirstPurchase`).set(true);

  return { referrerId: buyer.referredBy, bonus };
}

// ================= PRO PLAN / VIP =================

async function getProPlanSettings() {
  const snap = await db.ref('proPlanSettings').once('value');
  return snap.exists() ? snap.val() : { price: 1499, durationDays: 30, active: true, description: '30 days of unlimited downloads' };
}

async function activateProPlan(telegramId, durationDays) {
  const now = Date.now();
  const user = await getUser(telegramId);

  // If already VIP and not expired, extend from current expiry. Otherwise start fresh.
  const currentExpiry = (user && user.vipExpiresAt && user.vipExpiresAt > now) ? user.vipExpiresAt : now;
  const newExpiry = currentExpiry + (durationDays * 24 * 60 * 60 * 1000);

  await db.ref(`users/${telegramId}`).update({
    isVip: true,
    vipExpiresAt: newExpiry,
    vipActivatedAt: now
  });

  return newExpiry;
}

async function isUserVip(telegramId) {
  const user = await getUser(telegramId);
  if (!user || !user.isVip) return false;

  if (user.vipExpiresAt && user.vipExpiresAt < Date.now()) {
    // expired — auto clear flag
    await db.ref(`users/${telegramId}`).update({ isVip: false });
    return false;
  }
  return true;
}

async function getVipDaysLeft(telegramId) {
  const user = await getUser(telegramId);
  if (!user || !user.isVip || !user.vipExpiresAt) return 0;
  const msLeft = user.vipExpiresAt - Date.now();
  return msLeft > 0 ? Math.ceil(msLeft / (24 * 60 * 60 * 1000)) : 0;
}

// ================= BOT SETTINGS (admin-editable) =================

async function getBotSettings() {
  const snap = await db.ref('botSettings').once('value');
  return snap.exists() ? snap.val() : {
    welcomeMessage: '👋 Welcome {name}!\n\nQuality you can count on, delivery you can rely on.\n\n🛍 Curated Products — paid & free\n💳 Secure Payments via UPI\n⚡ Instant Delivery after payment\n🛡 Dedicated Support, whenever you need it\n\n👇 Select an option below to begin',
    channelUsername: '',
    channelRequired: false,
    supportTelegram: '',
    supportWhatsapp: '',
    botName: '',
    botDescription: ''
  };
}

// ================= ADMIN CHECK =================

function isAdmin(telegramId) {
  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim());
  return adminIds.includes(String(telegramId));
}

module.exports = {
  db,
  admin,
  getUser,
  createUserIfNotExists,
  getUserByReferralCode,
  getAllUsers,
  getWalletBalance,
  creditWallet,
  debitWallet,
  banUser,
  unbanUser,
  isUserBanned,
  getAllProducts,
  getProductsByCategory,
  getAllCategories,
  getProduct,
  searchProducts,
  decrementStock,
  checkLowStock,
  addReview,
  getProductReviews,
  getProductAvgRating,
  getCoupon,
  validateCoupon,
  incrementCouponUsage,
  createOrder,
  updateOrderStatus,
  getOrder,
  getUserOrders,
  hasUserBoughtProduct,
  requestRefund,
  processRefund,
  getSalesReport,
  getReferralSettings,
  processReferralBonus,
  getProPlanSettings,
  activateProPlan,
  isUserVip,
  getVipDaysLeft,
  getBotSettings,
  isAdmin
};
