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
  dmQueue: 'dmQueue.json',
  staff: 'staff.json'
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

// Runs a read-modify-write cycle as ONE atomic step through the same
// per-collection queue used by writeCollection. This is critical: without
// it, two concurrent operations on the same collection (e.g. two products
// being created back-to-back, or an image-album debounce firing while
// another write is in flight) can both read the same stale snapshot and
// the second write silently discards the first — this was the root cause
// of products vanishing ("product not found") and other data loss.
// `mutator(collectionObj)` mutates the object in place (or returns a new one);
// its return value is passed back to the caller.
async function updateCollectionAtomic(key, mutator) {
  const prev = writeQueues[key] || Promise.resolve();
  const resultHolder = {};
  const next = prev.then(async () => {
    const current = readCollection(key);
    const result = await mutator(current);
    const toSave = result && result.__replaceWith !== undefined ? result.__replaceWith : current;
    await new Promise((resolve, reject) => {
      const fp = filePath(key);
      const tmp = fp + '.tmp';
      fs.writeFile(tmp, JSON.stringify(toSave, null, 2), (err) => {
        if (err) return reject(err);
        fs.rename(tmp, fp, (err2) => err2 ? reject(err2) : resolve());
      });
    });
    resultHolder.value = result && result.__value !== undefined ? result.__value : result;
  });
  writeQueues[key] = next.catch(() => {});
  await next;
  return resultHolder.value;
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
  telegramId = String(telegramId);

  // Referral lookup happens outside the atomic block (read-only, fine to
  // race) — the actual user creation is the atomic part that matters.
  let referredBy = null;
  if (referredByCode) {
    const referrer = await getUserByReferralCode(referredByCode);
    if (referrer && referrer.telegramId != telegramId) {
      referredBy = referrer.telegramId;
    }
  }

  return updateCollectionAtomic('users', (users) => {
    if (users[telegramId]) return { __value: users[telegramId] };

    const newUser = {
      telegramId,
      name: tgUser.first_name || '',
      username: tgUser.username || '',
      joinedAt: Date.now(),
      walletBalance: 0,
      referralCode: generateReferralCode(telegramId),
      referredBy,
      hasFirstPurchase: false
    };
    users[telegramId] = newUser;
    return { __value: newUser };
  });
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
  telegramId = String(telegramId);
  const updated = await updateCollectionAtomic('users', (users) => {
    if (!users[telegramId]) return { __value: 0 }; // safety: user must exist
    const current = users[telegramId].walletBalance || 0;
    const newBalance = current + amount;
    users[telegramId].walletBalance = newBalance;
    return { __value: newBalance };
  });

  await logWalletTxn(telegramId, amount, 'credit', reason);
  return updated;
}

async function debitWallet(telegramId, amount, reason) {
  telegramId = String(telegramId);
  const updated = await updateCollectionAtomic('users', (users) => {
    const current = users[telegramId]?.walletBalance || 0;
    if (current < amount) {
      throw new Error('INSUFFICIENT_BALANCE');
    }
    const newBalance = current - amount;
    users[telegramId].walletBalance = newBalance;
    return { __value: newBalance };
  });

  await logWalletTxn(telegramId, amount, 'debit', reason);
  return updated;
}

async function logWalletTxn(telegramId, amount, type, reason) {
  const id = generateId('txn_');
  await updateCollectionAtomic('walletTransactions', (txns) => {
    txns[id] = { userId: String(telegramId), amount, type, reason, createdAt: Date.now() };
  });
}

// ================= USER BAN SYSTEM =================

async function banUser(telegramId, reason) {
  telegramId = String(telegramId);
  await updateCollectionAtomic('users', (users) => {
    if (!users[telegramId]) return;
    users[telegramId].banned = true;
    users[telegramId].banReason = reason || 'No reason given';
    users[telegramId].bannedAt = Date.now();
  });
}

async function unbanUser(telegramId) {
  telegramId = String(telegramId);
  await updateCollectionAtomic('users', (users) => {
    if (!users[telegramId]) return;
    users[telegramId].banned = false;
    users[telegramId].banReason = null;
    users[telegramId].bannedAt = null;
  });
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
  const id = generateId('prod_');
  const product = { ...data, views: 0, active: true, createdAt: Date.now() };
  await updateCollectionAtomic('products', (products) => {
    products[id] = product;
  });
  return { id, ...product };
}

async function updateProduct(productId, updates) {
  return updateCollectionAtomic('products', (products) => {
    if (!products[productId]) return { __value: null };
    products[productId] = { ...products[productId], ...updates };
    return { __value: products[productId] };
  });
}

async function deleteProduct(productId) {
  await updateCollectionAtomic('products', (products) => {
    delete products[productId];
  });
}

async function incrementProductViews(productId) {
  await updateCollectionAtomic('products', (products) => {
    if (!products[productId]) return;
    products[productId].views = (products[productId].views || 0) + 1;
  });
}

async function decrementStock(productId) {
  return updateCollectionAtomic('products', (products) => {
    const p = products[productId];
    if (!p || p.stock === -1 || p.stock === undefined) return { __value: undefined };
    p.stock = Math.max(0, p.stock - 1);
    return { __value: p.stock };
  });
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
  const id = generateId('rev_');
  await updateCollectionAtomic('reviews', (reviews) => {
    if (!reviews[productId]) reviews[productId] = {};
    reviews[productId][id] = { userId: String(telegramId), userName, rating, comment: comment || '', createdAt: Date.now() };
  });
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
  const key = code.toUpperCase();
  await updateCollectionAtomic('coupons', (coupons) => {
    if (!coupons[key]) return;
    coupons[key].usedCount = (coupons[key].usedCount || 0) + 1;
  });
}

async function createCoupon(code, data) {
  await updateCollectionAtomic('coupons', (coupons) => {
    coupons[code.toUpperCase()] = { ...data, usedCount: 0, active: true, createdAt: Date.now() };
  });
}

async function toggleCoupon(code, active) {
  const key = code.toUpperCase();
  await updateCollectionAtomic('coupons', (coupons) => {
    if (!coupons[key]) return;
    coupons[key].active = active;
  });
}

async function getAllCoupons() {
  return readCollection('coupons');
}

// ================= ORDERS =================

async function createOrder(orderData) {
  const id = generateId('ord_');
  // ZapUPI rejects order_id values with hyphens/underscores as order_id —
  // this clean alphanumeric ref is what gets sent to them.
  const payRef = 'ord' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const order = { ...orderData, id, payRef, createdAt: Date.now(), status: 'pending' };

  await updateCollectionAtomic('orders', (orders) => {
    orders[id] = order;
  });
  return order;
}

async function updateOrderStatus(orderId, status, extra = {}) {
  await updateCollectionAtomic('orders', (orders) => {
    if (!orders[orderId]) return;
    orders[orderId] = { ...orders[orderId], status, ...extra };
  });
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
  await updateCollectionAtomic('orders', (orders) => {
    if (!orders[orderId]) return;
    orders[orderId].refundStatus = 'requested';
    orders[orderId].refundReason = reason || '';
    orders[orderId].refundRequestedAt = Date.now();
  });
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

  await updateCollectionAtomic('users', (users) => {
    if (users[String(buyerTelegramId)]) users[String(buyerTelegramId)].hasFirstPurchase = true;
  });

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
  telegramId = String(telegramId);
  const now = Date.now();

  return updateCollectionAtomic('users', (users) => {
    if (!users[telegramId]) return { __value: now + (durationDays * 24 * 60 * 60 * 1000) };
    const currentExpiry = (users[telegramId].vipExpiresAt && users[telegramId].vipExpiresAt > now) ? users[telegramId].vipExpiresAt : now;
    const newExpiry = currentExpiry + (durationDays * 24 * 60 * 60 * 1000);
    users[telegramId].isVip = true;
    users[telegramId].vipExpiresAt = newExpiry;
    users[telegramId].vipActivatedAt = now;
    return { __value: newExpiry };
  });
}

async function isUserVip(telegramId) {
  const user = await getUser(telegramId);
  if (!user || !user.isVip) return false;

  if (user.vipExpiresAt && user.vipExpiresAt < Date.now()) {
    await updateCollectionAtomic('users', (users) => {
      if (users[String(telegramId)]) users[String(telegramId)].isVip = false;
    });
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

async function updateBotSetting
