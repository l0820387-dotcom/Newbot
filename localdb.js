// ============================================================
// LOCAL JSON DATABASE (replaces Firebase)
// ============================================================
// Stores everything in JSON files under ./data/. This has ONE major
// tradeoff vs Firebase: on platforms like Railway, the filesystem is
// EPHEMERAL — every redeploy/restart wipes ./data/ and all data
// (products, orders, users, wallets) is permanently lost unless you
// download a backup first via the /backup admin command.
//
// All functions below mirror firebase.js's exact names and return
// shapes, so bot.js works with either module interchangeably.
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  products: 'products.json',
  orders: 'orders.json',
  users: 'users.json',
  walletTransactions: 'walletTransactions.json',
  referralSettings: 'referralSettings.json',
  coupons: 'coupons.json',
  reviews: 'reviews.json',
  botSettings: 'botSettings.json',
  proPlanSettings: 'proPlanSettings.json',
  checkInSettings: 'checkInSettings.json',
  broadcastQueue: 'broadcastQueue.json',
  dmQueue: 'dmQueue.json'
};

// ---- Low-level file read/write with an in-process write queue so
// concurrent writes to the same file never race and corrupt data ----
const writeQueues = {};

function filePath(key) {
  return path.join(DATA_DIR, FILES[key]);
}

function readCollection(key) {
  const fp = filePath(key);
  if (!fs.existsSync(fp)) return {};
  try {
    const raw = fs.readFileSync(fp, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error(`⚠️ Failed to read ${key}, treating as empty:`, err.message);
    return {};
  }
}

async function writeCollection(key, data) {
  const fp = filePath(key);
  // Queue writes per-file so two near-simultaneous updates (e.g. two orders
  // created at once) can't interleave and corrupt the JSON.
  const prev = writeQueues[key] || Promise.resolve();
  const next = prev.then(() => new Promise((resolve, reject) => {
    const tmp = fp + '.tmp';
    fs.writeFile(tmp, JSON.stringify(data, null, 2), (err) => {
      if (err) return reject(err);
      fs.rename(tmp, fp, (err2) => err2 ? reject(err2) : resolve());
    });
  }));
  writeQueues[key] = next.catch(() => {}); // don't let one failure jam the queue forever
  return next;
}

function generateId(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ================= USERS =================

async function getUser(telegramId) {
  const users = readCollection('users');
  return users[telegramId] || null;
}

async function createUserIfNotExists(telegramId, tgUser, referredByCode) {
  const users = readCollection('users');
  telegramId = String(telegramId);
  if (users[telegramId]) return users[telegramId];

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

  users[telegramId] = newUser;
  await writeCollection('users', users);
  return newUser;
}

function generateReferralCode(telegramId) {
  return 'REF' + telegramId.toString().slice(-6);
}

async function getUserByReferralCode(code) {
  const users = readCollection('users');
  const entry = Object.entries(users).find(([, u]) => u.referralCode === code);
  if (!entry) return null;
  return { ...entry[1], telegramId: entry[0] };
}

async function getAllUsers() {
  return readCollection('users');
}

// ================= WALLET =================

async function getWalletBalance(telegramId) {
  const user = await getUser(telegramId);
  return user ? (user.walletBalance || 0) : 0;
}

async function creditWallet(telegramId, amount, reason) {
  const users = readCollection('users');
  telegramId = String(telegramId);
  const current = users[telegramId]?.walletBalance || 0;
  const updated = current + amount;
  if (!users[telegramId]) return current; // safety: user must exist
  users[telegramId].walletBalance = updated;
  await writeCollection('users', users);

  await logWalletTxn(telegramId, amount, 'credit', reason);
  return updated;
}

async function debitWallet(telegramId, amount, reason) {
  const users = readCollection('users');
  telegramId = String(telegramId);
  const current = users[telegramId]?.walletBalance || 0;

  if (current < amount) {
    throw new Error('INSUFFICIENT_BALANCE');
  }

  const updated = current - amount;
  users[telegramId].walletBalance = updated;
  await writeCollection('users', users);

  await logWalletTxn(telegramId, amount, 'debit', reason);
  return updated;
}

async function logWalletTxn(telegramId, amount, type, reason) {
  const txns = readCollection('walletTransactions');
  const id = generateId('txn_');
  txns[id] = { userId: String(telegramId), amount, type, reason, createdAt: Date.now() };
  await writeCollection('walletTransactions', txns);
}

// ================= USER BAN SYSTEM =================

async function banUser(telegramId, reason) {
  const users = readCollection('users');
  telegramId = String(telegramId);
  if (!users[telegramId]) return;
  users[telegramId].banned = true;
  users[telegramId].banReason = reason || 'No reason given';
  users[telegramId].bannedAt = Date.now();
  await writeCollection('users', users);
}

async function unbanUser(telegramId) {
  const users = readCollection('users');
  telegramId = String(telegramId);
  if (!users[telegramId]) return;
  users[telegramId].banned = false;
  users[telegramId].banReason = null;
  users[telegramId].bannedAt = null;
  await writeCollection('users', users);
}

async function isUserBanned(telegramId) {
  const user = await getUser(telegramId);
  return user ? !!user.banned : false;
}

// ================= PRODUCTS =================

async function getAllProducts(activeOnly = true) {
  const all = readCollection('products');
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
  const all = readCollection('products');
  return all[productId] || null;
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

async function createProduct(data) {
  const products = readCollection('products');
  const id = generateId('prod_');
  products[id] = { ...data, views: 0, active: true, createdAt: Date.now() };
  await writeCollection('products', products);
  return { id, ...products[id] };
}

async function updateProduct(productId, updates) {
  const products = readCollection('products');
  if (!products[productId]) return null;
  products[productId] = { ...products[productId], ...updates };
  await writeCollection('products', products);
  return products[productId];
}

async function deleteProduct(productId) {
  const products = readCollection('products');
  delete products[productId];
  await writeCollection('products', products);
}

async function incrementProductViews(productId) {
  const products = readCollection('products');
  if (!products[productId]) return;
  products[productId].views = (products[productId].views || 0) + 1;
  await writeCollection('products', products);
}

async function decrementStock(productId) {
  const products = readCollection('products');
  const p = products[productId];
  if (!p || p.stock === -1 || p.stock === undefined) return;
  p.stock = Math.max(0, p.stock - 1);
  await writeCollection('products', products);
  return p.stock;
}

async function checkLowStock(productId) {
  const product = await getProduct(productId);
  if (!product || product.stock === -1 || product.stock === undefined) return null;

  const LOW_STOCK_THRESHOLD = 3;
  if (product.stock <= LOW_STOCK_THRESHOLD) {
    return { productName: product.name, stock: product.stock };
  }
  return null;
}

// ================= RATINGS & REVIEWS =================

async function addReview(productId, telegramId, userName, rating, comment) {
  const reviews = readCollection('reviews');
  if (!reviews[productId]) reviews[productId] = {};
  const id = generateId('rev_');
  reviews[productId][id] = { userId: String(telegramId), userName, rating, comment: comment || '', createdAt: Date.now() };
  await writeCollection('reviews', reviews);
  return id;
}

async function getProductReviews(productId) {
  const reviews = readCollection('reviews');
  return reviews[productId] || {};
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
  const coupons = readCollection('coupons');
  return coupons[code.toUpperCase()] || null;
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

  discount = Math.min(discount, orderAmount);
  return { valid: true, discount, coupon };
}

async function incrementCouponUsage(code) {
  const coupons = readCollection('coupons');
  const key = code.toUpperCase();
  if (!coupons[key]) return;
  coupons[key].usedCount = (coupons[key].usedCount || 0) + 1;
  await writeCollection('coupons', coupons);
}

async function createCoupon(code, data) {
  const coupons = readCollection('coupons');
  coupons[code.toUpperCase()] = { ...data, usedCount: 0, active: true, createdAt: Date.now() };
  await writeCollection('coupons', coupons);
}

async function toggleCoupon(code, active) {
  const coupons = readCollection('coupons');
  const key = code.toUpperCase();
  if (!coupons[key]) return;
  coupons[key].active = active;
  await writeCollection('coupons', coupons);
}

async function getAllCoupons() {
  return readCollection('coupons');
}

// ================= ORDERS =================

async function createOrder(orderData) {
  const orders = readCollection('orders');
  const id = generateId('ord_');
  // ZapUPI rejects order_id values with hyphens/underscores as order_id —
  // this clean alphanumeric ref is what gets sent to them.
  const payRef = 'ord' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const order = { ...orderData, id, payRef, createdAt: Date.now(), status: 'pending' };
  orders[id] = order;
  await writeCollection('orders', orders);
  return order;
}

async function updateOrderStatus(orderId, status, extra = {}) {
  const orders = readCollection('orders');
  if (!orders[orderId]) return;
  orders[orderId] = { ...orders[orderId], status, ...extra };
  await writeCollection('orders', orders);
}

async function getOrder(orderId) {
  const orders = readCollection('orders');
  return orders[orderId] || null;
}

async function getOrderByPayRef(payRef) {
  const orders = readCollection('orders');
  const entry = Object.entries(orders).find(([, o]) => o.payRef === payRef);
  return entry ? { ...entry[1], id: entry[0] } : null;
}

async function getUserOrders(telegramId) {
  const orders = readCollection('orders');
  telegramId = String(telegramId);
  const filtered = {};
  for (const [id, o] of Object.entries(orders)) {
    if (String(o.userId) === telegramId) filtered[id] = o;
  }
  return filtered;
}

async function getAllOrders() {
  return readCollection('orders');
}

async function hasUserBoughtProduct(telegramId, productId) {
  const orders = await getUserOrders(telegramId);
  return Object.values(orders).some(o =>
    o.productId === productId && (o.status === 'paid' || o.status === 'delivered')
  );
}

async function getBoughtOrder(telegramId, productId) {
  const orders = await getUserOrders(telegramId);
  return Object.values(orders).find(o =>
    o.productId === productId && (o.status === 'paid' || o.status === 'delivered')
  ) || null;
}

// ================= REFUNDS =================

async function requestRefund(orderId, reason) {
  await updateOrderStatus(orderId, undefined, {}); // no-op guard removed below
  const orders = readCollection('orders');
  if (!orders[orderId]) return;
  orders[orderId].refundStatus = 'requested';
  orders[orderId].refundReason = reason || '';
  orders[orderId].refundRequestedAt = Date.now();
  await writeCollection('orders', orders);
}

async function processRefund(orderId, approve) {
  const order = await getOrder(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');

  if (approve) {
    await creditWallet(order.userId, order.amount, 'refund');
    await updateOrderStatus(orderId, 'refunded', { refundStatus: 'approved', refundedAt: Date.now() });
  } else {
    await updateOrderStatus(orderId, order.status, { refundStatus: 'rejected' });
  }
}

// ================= SALES REPORTS =================

async function getSalesReport(periodDays) {
  const cutoff = Date.now() - (periodDays * 24 * 60 * 60 * 1000);
  const orders = readCollection('orders');
  const list = Object.values(orders).filter(o => o.createdAt >= cutoff && (o.status === 'paid' || o.status === 'delivered'));

  const totalSales = list.reduce((sum, o) => sum + (o.amount || 0), 0);
  const productCounts = {};
  list.forEach(o => { productCounts[o.productName] = (productCounts[o.productName] || 0) + 1; });

  const topProducts = Object.entries(productCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name} (${count} sold)`);

  return { totalSales, orderCount: list.length, topProducts };
}

// ================= REFERRAL =================

async function getReferralSettings() {
  const s = readCollection('referralSettings');
  return Object.keys(s).length ? s : { bonusAmount: 20, bonusType: 'flat' };
}

async function setReferralSettings(data) {
  await writeCollection('referralSettings', data);
}

async function processReferralBonus(buyerTelegramId, orderAmount) {
  const buyer = await getUser(buyerTelegramId);
  if (!buyer || buyer.hasFirstPurchase || !buyer.referredBy) return;

  const settings = await getReferralSettings();
  let bonus = settings.bonusType === 'percent'
    ? Math.round((orderAmount * settings.bonusAmount) / 100)
    : settings.bonusAmount;

  await creditWallet(buyer.referredBy, bonus, 'referral_bonus');

  const users = readCollection('users');
  users[String(buyerTelegramId)].hasFirstPurchase = true;
  await writeCollection('users', users);

  return { referrerId: buyer.referredBy, bonus };
}

// ================= PRO PLAN / VIP =================

async function getProPlanSettings() {
  const s = readCollection('proPlanSettings');
  return Object.keys(s).length ? s : { price: 1499, durationDays: 30, active: true, description: '30 days of unlimited downloads' };
}

async function setProPlanSettings(data) {
  await writeCollection('proPlanSettings', data);
}

async function activateProPlan(telegramId, durationDays) {
  const now = Date.now();
  const user = await getUser(telegramId);

  const currentExpiry = (user && user.vipExpiresAt && user.vipExpiresAt > now) ? user.vipExpiresAt : now;
  const newExpiry = currentExpiry + (durationDays * 24 * 60 * 60 * 1000);

  const users = readCollection('users');
  telegramId = String(telegramId);
  if (!users[telegramId]) return newExpiry;
  users[telegramId].isVip = true;
  users[telegramId].vipExpiresAt = newExpiry;
  users[telegramId].vipActivatedAt = now;
  await writeCollection('users', users);

  return newExpiry;
}

async function isUserVip(telegramId) {
  const user = await getUser(telegramId);
  if (!user || !user.isVip) return false;

  if (user.vipExpiresAt && user.vipExpiresAt < Date.now()) {
    const users = readCollection('users');
    if (users[String(telegramId)]) {
      users[String(telegramId)].isVip = false;
      await writeCollection('users', users);
    }
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
  const s = readCollection('botSettings');
  if (Object.keys(s).length) return s;
  return {
    welcomeMessage: '✨ *Welcome, {name}!* ✨\n\n💎 Quality you can count on, delivery you can rely on.\n\n🛍 *Curated Products* — paid & free\n💳 *Secure Payments* via UPI\n⚡ *Instant Delivery* after payment\n🛡 *Dedicated Support*, whenever you need it\n\n👇 Select an option below to begin',
    channels: [],
    supportTelegram: '',
    supportWhatsapp: '',
    botName: '',
    botDescription: '',
    maintenanceMode: false,
    maintenanceMessage: '🛠 Bot abhi maintenance mein hai. Thodi der baad try karo.',
    menuCustomButtons: [],
    menuLabels: {}
  };
}

async function updateBotSettings(updates) {
  const current = await getBotSettings();
  const merged = { ...current, ...updates };
  await writeCollection('botSettings', merged);
  return merged;
}

// ================= DAILY CHECK-IN =================

async function getCheckInSettings() {
  const s = readCollection('checkInSettings');
  return Object.keys(s).length ? s : { active: true, rewardAmount: 5 };
}

async function setCheckInSettings(data) {
  await writeCollection('checkInSettings', data);
}

async function performCheckIn(telegramId) {
  const settings = await getCheckInSettings();
  if (!settings.active) return { success: false, reason: 'disabled' };

  const user = await getUser(telegramId);
  const today = new Date().toDateString();
  const lastCheckIn = user?.lastCheckInDate;

  if (lastCheckIn === today) {
    return { success: false, reason: 'already_checked_in', streak: user.checkInStreak || 0 };
  }

  const yesterday = new Date(Date.now() - 86400000).toDateString();
  const streak = (lastCheckIn === yesterday) ? (user.checkInStreak || 0) + 1 : 1;

  const users = readCollection('users');
  telegramId = String(telegramId);
  users[telegramId].lastCheckInDate = today;
  users[telegramId].checkInStreak = streak;
  await writeCollection('users', users);

  const bonus = Math.min(settings.rewardAmount * Math.ceil(streak / 3), settings.rewardAmount * 5);
  await creditWallet(telegramId, bonus, 'daily_checkin');

  return { success: true, streak, bonus };
}

// ================= LEADERBOARD =================

async function getTopBuyers(limit = 10) {
  const orders = readCollection('orders');
  const spendByUser = {};
  Object.values(orders).forEach(o => {
    if (o.status === 'paid' || o.status === 'delivered') {
      spendByUser[o.userId] = (spendByUser[o.userId] || 0) + (o.amount || 0);
    }
  });

  const users = readCollection('users');
  return Object.entries(spendByUser)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([uid, spent]) => ({ telegramId: uid, name: users[uid]?.name || 'Unknown', totalSpent: spent }));
}

async function getTopReferrers(limit = 10) {
  const users = readCollection('users');
  const referralCounts = {};
  Object.entries(users).forEach(([uid, u]) => {
    if (u.referredBy) referralCounts[u.referredBy] = (referralCounts[u.referredBy] || 0) + 1;
  });

  return Object.entries(referralCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([uid, count]) => ({ telegramId: uid, name: users[uid]?.name || 'Unknown', referralCount: count }));
}

// ================= USER ANALYTICS =================

async function getUserAnalytics(telegramId) {
  const user = await getUser(telegramId);
  if (!user) return null;

  const orders = await getUserOrders(telegramId);
  const orderList = Object.values(orders);
  const paidOrders = orderList.filter(o => o.status === 'paid' || o.status === 'delivered');
  const totalSpent = paidOrders.reduce((sum, o) => sum + (o.amount || 0), 0);

  const allUsers = await getAllUsers();
  const referredCount = Object.values(allUsers).filter(u => u.referredBy === String(telegramId)).length;

  return { ...user, totalOrders: orderList.length, completedOrders: paidOrders.length, totalSpent, referredCount };
}

// ================= BROADCAST / DM QUEUES =================
// bot.js originally listened to Firebase's real-time child_added/child_changed
// events for these. Local mode has no such push mechanism, so bot.js uses
// these direct functions instead (see the updated queue-processing section).

async function queueBroadcast(data) {
  const queue = readCollection('broadcastQueue');
  const id = generateId('bc_');
  queue[id] = { ...data, id, sent: false, createdAt: Date.now() };
  await writeCollection('broadcastQueue', queue);
  return id;
}

async function queueDm(data) {
  const queue = readCollection('dmQueue');
  const id = generateId('dm_');
  queue[id] = { ...data, id, sent: false, createdAt: Date.now() };
  await writeCollection('dmQueue', queue);
  return id;
}

async function getBroadcastQueue() { return readCollection('broadcastQueue'); }
async function getDmQueue() { return readCollection('dmQueue'); }

async function updateBroadcastEntry(id, updates) {
  const queue = readCollection('broadcastQueue');
  if (!queue[id]) return;
  queue[id] = { ...queue[id], ...updates };
  await writeCollection('broadcastQueue', queue);
}

async function updateDmEntry(id, updates) {
  const queue = readCollection('dmQueue');
  if (!queue[id]) return;
  queue[id] = { ...queue[id], ...updates };
  await writeCollection('dmQueue', queue);
}

async function deleteBroadcastEntry(id) {
  const queue = readCollection('broadcastQueue');
  delete queue[id];
  await writeCollection('broadcastQueue', queue);
}

async function deleteDmEntry(id) {
  const queue = readCollection('dmQueue');
  delete queue[id];
  await writeCollection('dmQueue', queue);
}

// ================= BACKUP / RESTORE =================
// Since local storage can vanish on redeploy, these let an admin export
// everything to a single JSON file (and re-import it after a redeploy).

function getFullBackup() {
  const backup = {};
  for (const key of Object.keys(FILES)) {
    backup[key] = readCollection(key);
  }
  backup._exportedAt = new Date().toISOString();
  return backup;
}

async function restoreFromBackup(backupObj) {
  for (const key of Object.keys(FILES)) {
    if (backupObj[key]) {
      await writeCollection(key, backupObj[key]);
    }
  }
}

// ================= ADMIN CHECK =================

function isAdmin(telegramId) {
  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim());
  return adminIds.includes(String(telegramId));
}

// ================= MISC USER FIELD HELPERS =================
// Generic get/set for one-off per-user fields bot.js needs (seen-tracking
// markers, pending deep-link state) — avoids needing a dedicated function
// for every small piece of transient state.

async function setUserField(telegramId, field, value) {
  const users = readCollection('users');
  telegramId = String(telegramId);
  if (!users[telegramId]) return;
  users[telegramId][field] = value;
  await writeCollection('users', users);
}

async function getUserField(telegramId, field) {
  const user = await getUser(telegramId);
  return user ? user[field] : undefined;
}

async function clearUserField(telegramId, field) {
  await setUserField(telegramId, field, null);
}

async function getUserWalletTransactions(telegramId) {
  const txns = readCollection('walletTransactions');
  telegramId = String(telegramId);
  return Object.values(txns).filter(t => String(t.userId) === telegramId);
}

async function getPendingOrdersByMethod(paymentMethod, sinceTimestamp) {
  const orders = readCollection('orders');
  return Object.entries(orders).filter(([id, o]) =>
    o.status === 'pending' &&
    o.paymentMethod === paymentMethod &&
    (!sinceTimestamp || o.createdAt >= sinceTimestamp)
  );
}

module.exports = {
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
  createProduct,
  updateProduct,
  deleteProduct,
  incrementProductViews,
  decrementStock,
  checkLowStock,
  addReview,
  getProductReviews,
  getProductAvgRating,
  getCoupon,
  validateCoupon,
  incrementCouponUsage,
  createCoupon,
  toggleCoupon,
  getAllCoupons,
  createOrder,
  updateOrderStatus,
  getOrder,
  getOrderByPayRef,
  getUserOrders,
  getAllOrders,
  hasUserBoughtProduct,
  getBoughtOrder,
  requestRefund,
  processRefund,
  getSalesReport,
  getReferralSettings,
  setReferralSettings,
  processReferralBonus,
  getProPlanSettings,
  setProPlanSettings,
  activateProPlan,
  isUserVip,
  getVipDaysLeft,
  getBotSettings,
  updateBotSettings,
  getCheckInSettings,
  setCheckInSettings,
  performCheckIn,
  getTopBuyers,
  getTopReferrers,
  getUserAnalytics,
  queueBroadcast,
  queueDm,
  getBroadcastQueue,
  getDmQueue,
  updateBroadcastEntry,
  updateDmEntry,
  deleteBroadcastEntry,
  deleteDmEntry,
  getFullBackup,
  restoreFromBackup,
  setUserField,
  getUserField,
  clearUserField,
  getUserWalletTransactions,
  getPendingOrdersByMethod,
  isAdmin
};
