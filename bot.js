require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fb = require('./localdb');
const zabupi = require('./zabupi');
const { setupAdminPanel } = require('./adminPanel');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

// In-memory temp state (for multi-step flows like "buy via wallet confirm")
const userState = {}; // { telegramId: { step, data } }

// ============ EDIT-IN-PLACE NAVIGATION ============
// We edit the previous bot message when possible so the chat stays clean.
// editMessageText fails on photo/media-group messages (Telegram limitation) —
// in that case we delete the old message and send a fresh one instead of
// leaving a stray photo behind, which is what caused the "jumpy" feel.

// Escapes Telegram Markdown (legacy) special characters in dynamic values
// (names, product titles, etc.) so user-generated or DB text never breaks
// message parsing. Use around any {variable} inserted into a Markdown string.
function mdEscape(text) {
  if (text === undefined || text === null) return '';
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// Sets up all /admin commands and callback handlers (products, orders,
// users, coupons, broadcast, settings, backup) — see adminPanel.js.
const adminPanel = setupAdminPanel(bot, fb, mdEscape);

async function smartReply(ctx, text, extra = {}) {
  const payload = { parse_mode: 'Markdown', ...extra };

  if (ctx.callbackQuery) {
    try {
      const edited = await ctx.editMessageText(text, payload);
      // editMessageText returns `true` for inline messages or the message
      // object for regular ones — normalize to the original message.
      return typeof edited === 'object' ? edited : ctx.callbackQuery.message;
    } catch (err) {
      // Can't edit (likely a photo message, or a Markdown parse error) —
      // clean up instead of stacking messages
      try { await ctx.deleteMessage(); } catch (e) { /* delete also failed, fine — we still send below */ }
    }
  }

  // Guaranteed to run if edit wasn't possible. If Markdown parsing itself is
  // the problem, retry once as plain text so the user always sees *something*.
  try {
    return await ctx.reply(text, payload);
  } catch (err) {
    return await ctx.reply(text, { ...extra, parse_mode: undefined });
  }
}

// ---- Navigation stack: tracks which screen to return to on "Back" ----
// Stored per-user in memory. Each screen push is just an action name string
// (e.g. 'menu_profile', 'cat_Bots') that we can re-trigger to go back.
const navStack = {}; // { telegramId: ['menu_home', 'menu_browse', 'cat_Bots'] }

function pushNav(telegramId, screen) {
  if (!navStack[telegramId]) navStack[telegramId] = [];
  const stack = navStack[telegramId];
  if (stack[stack.length - 1] !== screen) stack.push(screen);
  if (stack.length > 15) stack.shift(); // cap memory use per user
}

function popNav(telegramId) {
  const stack = navStack[telegramId];
  if (!stack || stack.length <= 1) return 'menu_home';
  stack.pop(); // remove current screen
  return stack[stack.length - 1] || 'menu_home';
}

function navButtons(extraRows, telegramId) {
  const stack = navStack[telegramId];
  const canGoBack = stack && stack.length > 1;
  const row = canGoBack
    ? [Markup.button.callback('⬅️ Back', 'nav_back'), Markup.button.callback('🏠 Home', 'menu_home')]
    : [Markup.button.callback('🏠 Home', 'menu_home')];
  return Markup.inlineKeyboard(extraRows ? [...extraRows, row] : [row]);
}

// ============ SEEN TRACKING (runs first, before any middleware that might
// short-circuit the request) ============
// Marks any pending DM/broadcast as "seen" whenever the user sends any
// update to the bot at all — this is the closest proxy Telegram's Bot API
// allows for read-receipts, since bots have no real access to that data.

bot.use(async (ctx, next) => {
  if (ctx.from) {
    try {
      const dmId = await fb.getUserField(ctx.from.id, 'lastUnseenDmId');
      if (dmId) {
        await fb.updateDmEntry(dmId, { seen: true, seenAt: Date.now() });
        await fb.clearUserField(ctx.from.id, 'lastUnseenDmId');
      }

      const bId = await fb.getUserField(ctx.from.id, 'lastUnseenBroadcastId');
      if (bId) {
        const queue = await fb.getBroadcastQueue();
        const current = queue[bId]?.seenCount || 0;
        await fb.updateBroadcastEntry(bId, { seenCount: current + 1 });
        await fb.clearUserField(ctx.from.id, 'lastUnseenBroadcastId');
      }
    } catch (e) { /* non-critical — never block the actual request */ }
  }
  return next();
});

// ============ BAN CHECK MIDDLEWARE ============

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  const banned = await fb.isUserBanned(ctx.from.id);
  if (banned) {
    return ctx.reply('🚫 Aapko is bot se block kar diya gaya hai. Support se contact karo agar galti lagti hai.');
  }
  return next();
});

// ============ MAINTENANCE MODE MIDDLEWARE ============

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();

  const settings = await fb.getBotSettings();
  if (!settings.maintenanceMode) return next();

  // Admins bypass maintenance mode so they can still manage the bot
  if (fb.isAdmin(ctx.from.id)) return next();

  const msg = settings.maintenanceMessage || '🛠 Bot abhi maintenance mein hai. Thodi der baad try karo.';
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(msg, { show_alert: true });
  } else {
    await ctx.reply(msg);
  }
  return; // block everything else
});

// ============ MANDATORY CHANNEL JOIN MIDDLEWARE (supports multiple channels) ============
// Blocks all bot interaction until user joins every required channel.
// Skips the check itself for the "check_joined" button so users can retry.

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();

  // Let the "I've Joined" button always through (it does the check itself)
  if (ctx.callbackQuery && ctx.callbackQuery.data === 'check_joined') return next();

  const settings = await fb.getBotSettings();
  const requiredChannels = (settings.channels || []).filter(c => c.required && c.username);
  if (requiredChannels.length === 0) return next();

  const notJoined = await getUnjoinedChannels(ctx.from.id, requiredChannels);
  if (notJoined.length > 0) {
    // If they arrived via a deep-link (e.g. a shared product URL), remember
    // it so we can send them there after they finish joining, instead of
    // dropping them on the generic main menu.
    if (ctx.startPayload) {
      await fb.setUserField(ctx.from.id, 'pendingDeepLink', ctx.startPayload);
    }
    await sendJoinPrompt(ctx, notJoined);
    return; // block everything else
  }

  return next();
});

async function checkChannelMembership(telegramId, channelUsername) {
  try {
    const handle = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`;
    const member = await bot.telegram.getChatMember(handle, telegramId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (err) {
    console.error(`Channel membership check failed for ${channelUsername}:`, err.message);
    // If the bot isn't an admin in the channel or channel is misconfigured,
    // fail open for that channel so a config mistake doesn't block everyone.
    return true;
  }
}

async function getUnjoinedChannels(telegramId, channels) {
  const results = [];
  for (const ch of channels) {
    const isMember = await checkChannelMembership(telegramId, ch.username);
    if (!isMember) results.push(ch);
  }
  return results;
}

async function sendJoinPrompt(ctx, channels) {
  const buttons = channels.map(ch => {
    const handle = ch.username.startsWith('@') ? ch.username.slice(1) : ch.username;
    return [Markup.button.url(`📢 Join ${ch.label || handle}`, `https://t.me/${handle}`)];
  });
  buttons.push([Markup.button.callback('✅ I\'ve Joined All', 'check_joined')]);

  await ctx.reply(
    `📢 *Ek chhota sa step baaki hai!*\n\nBot use karne se pehle neeche diye channel(s) join karo:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}

bot.action('check_joined', async (ctx) => {
  const settings = await fb.getBotSettings();
  const requiredChannels = (settings.channels || []).filter(c => c.required && c.username);
  const notJoined = await getUnjoinedChannels(ctx.from.id, requiredChannels);

  if (notJoined.length === 0) {
    await ctx.answerCbQuery('✅ Verified!');
    const telegramId = ctx.from.id;
    await fb.createUserIfNotExists(telegramId, ctx.from, null);

    // If they arrived via a product deep-link before joining, send them
    // straight to that product now instead of the generic main menu.
    const pendingPayload = await fb.getUserField(telegramId, 'pendingDeepLink');
    if (pendingPayload) {
      await fb.clearUserField(telegramId, 'pendingDeepLink');
      if (pendingPayload.startsWith('PROD_')) {
        const productId = pendingPayload.slice('PROD_'.length);
        const product = await fb.getProduct(productId);
        if (product) {
          await fb.incrementProductViews(productId);
          pushNav(telegramId, `viewproduct_${productId}`);
          return sendProductCard(ctx, productId, product);
        }
      }
    }

    await sendMainMenu(ctx);
  } else {
    await ctx.answerCbQuery('❌ Abhi bhi kuch channels join nahi kiye.', { show_alert: true });
  }
});

// ============ START / REGISTER ============

bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  const payload = ctx.startPayload; // e.g. REF123456 (referral) or PROD_<productId> (direct product link)

  const isProductLink = payload && payload.startsWith('PROD_');
  const referralCode = isProductLink ? null : payload;

  await fb.createUserIfNotExists(telegramId, ctx.from, referralCode);

  if (isProductLink) {
    const productId = payload.slice('PROD_'.length);
    const product = await fb.getProduct(productId);
    if (product) {
      await fb.incrementProductViews(productId);
      pushNav(telegramId, `viewproduct_${productId}`);
      return sendProductCard(ctx, productId, product);
    }
    // Product not found (deleted/invalid link) — fall through to normal menu
  }

  await sendMainMenu(ctx);
});

async function sendMainMenu(ctx) {
  const settings = await fb.getBotSettings();
  const text = settings.welcomeMessage.replace('{name}', ctx.from.first_name);

  await smartReply(ctx, text, mainMenu(settings));
}

// Default labels for the built-in menu buttons — admin can override any of
// these from the Bot Settings > Menu Buttons panel without touching code.
const DEFAULT_MENU_LABELS = {
  profile: '👤 My Profile',
  browse: '🛍 Browse Products',
  free: '🎁 Free Products',
  proplan: '👑 Pro Plan',
  purchases: '📦 My Purchases',
  orders: '📋 Order Status',
  referrals: '🔗 My Referrals',
  stats: '📊 My Stats',
  paymenthistory: '🧾 Payment History',
  support: '📞 Support',
  language: '🌐 Hindi / English',
  checkin: '🎯 Daily Check-in',
  leaderboard: '🏆 Leaderboard'
};

function mainMenu(settings) {
  const labels = { ...DEFAULT_MENU_LABELS, ...(settings?.menuLabels || {}) };

  const rows = [
    [Markup.button.callback(labels.profile, 'menu_profile')],
    [Markup.button.callback(labels.browse, 'menu_browse')],
    [Markup.button.callback(labels.free, 'menu_free')],
    [Markup.button.callback(labels.proplan, 'menu_proplan'), Markup.button.callback(labels.purchases, 'menu_purchases')],
    [Markup.button.callback(labels.orders, 'menu_orders'), Markup.button.callback(labels.referrals, 'menu_referrals')],
    [Markup.button.callback(labels.stats, 'menu_stats'), Markup.button.callback(labels.paymenthistory, 'menu_paymenthistory')],
    [Markup.button.callback(labels.checkin, 'menu_checkin'), Markup.button.callback(labels.leaderboard, 'menu_leaderboard')],
    [Markup.button.callback(labels.support, 'menu_support'), Markup.button.callback(labels.language, 'menu_language')]
  ];

  // Admin-configured custom link buttons on the main menu (e.g. "Join Community").
  // Supports multiple — each one is its own row.
  const customButtons = Array.isArray(settings?.menuCustomButtons) ? settings.menuCustomButtons : [];
  customButtons.forEach(btn => {
    if (btn.text && btn.url) rows.push([Markup.button.url(`🔗 ${btn.text}`, btn.url)]);
  });

  return Markup.inlineKeyboard(rows);
}

bot.action('menu_home', async (ctx) => {
  await ctx.answerCbQuery();
  navStack[ctx.from.id] = ['menu_home']; // reset stack — Home always starts fresh
  await sendMainMenu(ctx);
});

// ============ MY PROFILE ============

bot.action('menu_profile', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_profile');
  await renderProfile(ctx);
});

async function renderProfile(ctx) {
  const telegramId = ctx.from.id;
  let user = await fb.getUser(telegramId);

  // Safety net: user record should always exist after /start, but if it's
  // somehow missing, create it now instead of crashing the whole handler
  // silently (which was the root cause of "everything disappears").
  if (!user) {
    user = await fb.createUserIfNotExists(telegramId, ctx.from, null);
  }

  const balance = await fb.getWalletBalance(telegramId);
  const isVip = await fb.isUserVip(telegramId);
  const vipDays = isVip ? await fb.getVipDaysLeft(telegramId) : 0;
  const orders = await fb.getUserOrders(telegramId);
  const orderCount = Object.keys(orders).length;

  const vipLine = isVip ? `👑 VIP Active — ${vipDays} days left` : '👤 Free User';

  const msg = `👤 *My Profile*\n\n✨ Name: ${mdEscape(user.name)}\n🔖 Username: ${user.username ? '@' + mdEscape(user.username) : '-'}\n🆔 Telegram ID: \`${telegramId}\`\n\n${vipLine}\n💰 Wallet: ₹${balance}\n📦 Total Orders: ${orderCount}\n🔗 Referral Code: \`${user.referralCode}\``;

  await smartReply(ctx, msg, backButton(ctx));
}

function backButton(ctx) {
  const telegramId = ctx?.from?.id;
  const stack = telegramId ? navStack[telegramId] : null;
  const canGoBack = stack && stack.length > 1;

  const row = canGoBack
    ? [Markup.button.callback('⬅️ Back', 'nav_back'), Markup.button.callback('🏠 Home', 'menu_home')]
    : [Markup.button.callback('🏠 Home', 'menu_home')];

  return Markup.inlineKeyboard([row]);
}

// Generic handler: pops the nav stack and shows the previous screen directly.
// We call the underlying screen-render functions directly (not re-dispatching
// fake Telegram events, which is fragile). Supports both simple no-argument
// screens and dynamic ones (category name, product id) parsed from the target.
bot.action('nav_back', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from.id;
  const target = popNav(telegramId);

  // Dynamic targets: cat_<CategoryName>, viewproduct_<id>
  if (target.startsWith('cat_')) {
    const category = target.slice(4);
    return renderCategoryProducts(ctx, category);
  }
  if (target.startsWith('viewproduct_')) {
    const productId = target.slice('viewproduct_'.length);
    const product = await fb.getProduct(productId);
    if (product) return sendProductCard(ctx, productId, product);
    return sendMainMenu(ctx);
  }

  const screenRenderers = {
    menu_home: () => sendMainMenu(ctx),
    menu_profile: () => renderProfile(ctx),
    menu_browse: () => showCategories(ctx),
    menu_free: () => renderFreeProducts(ctx),
    menu_proplan: () => renderProPlan(ctx),
    menu_purchases: () => renderPurchases(ctx),
    menu_orders: () => renderOrderStatus(ctx),
    menu_referrals: () => sendReferralInfo(ctx),
    menu_stats: () => renderStats(ctx),
    menu_paymenthistory: () => renderPaymentHistory(ctx),
    menu_support: () => renderSupport(ctx),
    menu_language: () => renderLanguage(ctx),
    menu_checkin: () => renderCheckIn(ctx),
    menu_leaderboard: () => renderLeaderboard(ctx)
  };

  const renderer = screenRenderers[target];
  if (renderer) return renderer();
  return sendMainMenu(ctx);
});

// ============ PRO PLAN ============

bot.action('menu_proplan', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_proplan');
  await renderProPlan(ctx);
});

async function renderProPlan(ctx) {
  const telegramId = ctx.from.id;
  const settings = await fb.getProPlanSettings();
  const isVip = await fb.isUserVip(telegramId);

  if (isVip) {
    const daysLeft = await fb.getVipDaysLeft(telegramId);
    return smartReply(
      ctx,
      `👑 *You're already VIP!*\n\n✨ ${daysLeft} days remaining.\n\nWant to extend? Buy again to add more days.`,
      navButtons([[Markup.button.callback(`💳 Extend — ₹${settings.price}`, 'buyproplan')]], telegramId)
    );
  }

  const msg = `👑 *Upgrade to VIP*\n\n💰 ₹${settings.price} · ${settings.description}\n\n✨ *What you unlock:*\n✅ ${settings.durationDays} din unlimited downloads\n✅ Koi bhi paid product FREE\n✅ Wallet balance ki zarurat nahi\n✅ Naye products bhi free\n\n🛡 Secure UPI payment · Instant activation`;

  await smartReply(ctx, msg, navButtons([[Markup.button.callback(`💳 Upgrade Now — ₹${settings.price}`, 'buyproplan')]], telegramId));
}

bot.action('buyproplan', async (ctx) => {
  const telegramId = ctx.from.id;
  const settings = await fb.getProPlanSettings();

  await ctx.answerCbQuery('Generating payment link...');
  await smartReply(ctx, '⏳ *Payment link generate ho raha hai...*', navButtons([[Markup.button.callback('❌ Cancel', 'menu_home')]], telegramId));

  const order = await fb.createOrder({
    userId: String(telegramId),
    productId: 'PRO_PLAN',
    productName: `Pro Plan (${settings.durationDays} days)`,
    amount: settings.price,
    paymentMethod: 'zabupi',
    isProPlan: true,
    proPlanDuration: settings.durationDays
  });

  const payment = await zabupi.createPaymentOrder({
    orderId: order.payRef,
    amount: settings.price,
    userId: telegramId,
    userName: ctx.from.first_name,
    purpose: 'Pro Plan Subscription'
  });

  if (!payment.success) {
    await fb.updateOrderStatus(order.id, 'failed');
    console.error('ZapUPI Pro Plan payment failed for order', order.id, ':', payment.error);
    return smartReply(
      ctx,
      `❌ *Payment link generate nahi ho paya*\n\nWajah: ${mdEscape(typeof payment.error === 'string' ? payment.error : JSON.stringify(payment.error))}\n\nThodi der baad try karo ya support se contact karo.`,
      navButtons([[Markup.button.callback('🔄 Try Again', 'buyproplan')]], telegramId)
    );
  }

  await fb.updateOrderStatus(order.id, 'pending', { zabupiTxnId: payment.transactionId });

  await smartReply(
    ctx,
    `💳 *Pro Plan* — ₹${settings.price}\n\n✨ Pay karke turant VIP activate ho jayega ✅`,
    Markup.inlineKeyboard([
      [Markup.button.url('💳 Pay Now', payment.paymentUrl)],
      [Markup.button.callback('❌ Cancel Order', `cancelorder_${order.id}`), Markup.button.callback('🏠 Home', 'menu_home')]
    ])
  );
});

// ============ FREE PRODUCTS ============

bot.action('menu_free', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_free');
  await renderFreeProducts(ctx);
});

async function renderFreeProducts(ctx) {
  const telegramId = ctx.from.id;
  const all = await fb.getAllProducts(true);
  const freeEntries = Object.entries(all).filter(([id, p]) => p.price === 0);

  if (freeEntries.length === 0) {
    return smartReply(ctx, '🎁 Abhi koi free product available nahi hai. Jaldi aayega! 🙏', backButton(ctx));
  }

  const buttons = freeEntries.map(([id, p]) => [Markup.button.callback(`🎁 ${p.name} | FREE`, `viewproduct_${id}`)]);

  await smartReply(ctx, '✨ 「 *Free Products* 」\n\n✨ Tap any product to view full details.', navButtons(buttons, telegramId));
}

// ============ ORDER STATUS ============

bot.action('menu_orders', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_orders');
  await renderOrderStatus(ctx);
});

async function renderOrderStatus(ctx) {
  const telegramId = ctx.from.id;
  const orders = await fb.getUserOrders(telegramId);
  const list = Object.values(orders).sort((a, b) => b.createdAt - a.createdAt);

  if (list.length === 0) {
    return smartReply(ctx, '📋 Abhi tak koi order nahi hai.', backButton(ctx));
  }

  let msg = '✨ 「 *Order Status* 」\n\n';
  list.slice(0, 10).forEach(o => {
    const statusEmoji = o.status === 'delivered' ? '✅' : o.status === 'pending' ? '⏳' : o.status === 'failed' ? '❌' : o.status === 'refunded' ? '↩️' : '🔄';
    const statusLabel = o.status.charAt(0).toUpperCase() + o.status.slice(1);
    const dateStr = o.createdAt ? new Date(o.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
    msg += `${statusEmoji} *${mdEscape(o.productName)}*\n💰 ₹${o.amount} · _${statusLabel}_ · ${dateStr}\n\n`;
  });

  const refundable = list.find(o => o.status === 'delivered' && !o.refundStatus && o.productId !== 'PRO_PLAN' && o.productId !== 'WALLET_TOPUP');
  const buttons = [];
  if (refundable) {
    buttons.push([Markup.button.callback('↩️ Request Refund', `refund_${refundable.id}`)]);
  }

  await smartReply(ctx, msg.trim(), navButtons(buttons, telegramId));
}

// ============ MY STATS ============

bot.action('menu_stats', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_stats');
  await renderStats(ctx);
});

async function renderStats(ctx) {
  const telegramId = ctx.from.id;
  const orders = await fb.getUserOrders(telegramId);
  const list = Object.values(orders);
  const paidOrders = list.filter(o => o.status === 'paid' || o.status === 'delivered');
  const totalSpent = paidOrders.reduce((sum, o) => sum + (o.amount || 0), 0);
  const user = await fb.getUser(telegramId);

  const msg = `📊 *My Stats*\n\n🛒 Total Orders: *${list.length}*\n✅ Completed: *${paidOrders.length}*\n💰 Total Spent: *₹${totalSpent}*\n📅 Member since: ${new Date(user.joinedAt).toLocaleDateString()}`;

  await smartReply(ctx, msg, backButton(ctx));
}

// ============ PAYMENT HISTORY ============

bot.action('menu_paymenthistory', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_paymenthistory');
  await renderPaymentHistory(ctx);
});

async function renderPaymentHistory(ctx) {
  const telegramId = ctx.from.id;
  const orders = await fb.getUserOrders(telegramId);
  const paidOrders = Object.values(orders).filter(o => o.status === 'paid' || o.status === 'delivered');

  const txns = await fb.getUserWalletTransactions(telegramId);

  // Merge orders (ZapUPI + wallet purchases) and raw wallet transactions
  // (top-ups, referral bonuses, refunds) into one timeline.
  const entries = [
    ...paidOrders.map(o => ({
      createdAt: o.createdAt,
      label: `${o.paymentMethod === 'wallet' ? '💰' : '💳'} ${mdEscape(o.productName)} — ₹${o.amount}`
    })),
    ...txns.map(t => ({
      createdAt: t.createdAt,
      label: `${t.type === 'credit' ? '➕' : '➖'} ₹${t.amount} — ${t.reason}`
    }))
  ];

  if (entries.length === 0) {
    return smartReply(ctx, '🧾 Koi payment history nahi mili.', backButton(ctx));
  }

  let msg = '✨ 「 *Payment History* 」\n\n';
  entries.sort((a, b) => b.createdAt - a.createdAt).slice(0, 15).forEach(e => {
    const dateStr = new Date(e.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    msg += `${e.label}\n_${dateStr}_\n\n`;
  });

  await smartReply(ctx, msg.trim(), backButton(ctx));
}

// ============ LANGUAGE ============

bot.action('menu_language', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_language');
  await renderLanguage(ctx);
});

async function renderLanguage(ctx) {
  await smartReply(ctx, '🌐 Abhi sirf Hinglish support hai.\n\n✨ Full Hindi/English switch jaldi aa raha hai! 🙏', backButton(ctx));
}

// ============ DAILY CHECK-IN ============

bot.action('menu_checkin', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_checkin');
  await renderCheckIn(ctx);
});

async function renderCheckIn(ctx) {
  const telegramId = ctx.from.id;
  const settings = await fb.getCheckInSettings();

  if (!settings.active) {
    return smartReply(ctx, '🎯 Daily Check-in abhi available nahi hai.', backButton(ctx));
  }

  const result = await fb.performCheckIn(telegramId);

  if (!result.success && result.reason === 'already_checked_in') {
    return smartReply(
      ctx,
      `✅ *Aaj already check-in kar chuke ho!*\n\n🔥 Current Streak: *${result.streak} din*\n\nKal wapas aana aur streak jaari rakhna! ⏰`,
      backButton(ctx)
    );
  }

  if (!result.success) {
    return smartReply(ctx, '⚠️ Check-in abhi available nahi hai.', backButton(ctx));
  }

  await smartReply(
    ctx,
    `🎯 *Daily Check-in Successful!*\n\n💰 +₹${result.bonus} wallet mein add ho gaya\n🔥 Streak: *${result.streak} din*\n\n✨ Roz check-in karke streak badhao aur zyada bonus paao!`,
    backButton(ctx)
  );
}

// ============ LEADERBOARD ============

bot.action('menu_leaderboard', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_leaderboard');
  await renderLeaderboard(ctx);
});

async function renderLeaderboard(ctx) {
  const [topBuyers, topReferrers] = await Promise.all([
    fb.getTopBuyers(5),
    fb.getTopReferrers(5)
  ]);

  let msg = '🏆 「 *Leaderboard* 」\n\n';

  msg += '💰 *Top Buyers*\n';
  if (topBuyers.length === 0) {
    msg += '_Koi purchase abhi nahi hui_\n';
  } else {
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    topBuyers.forEach((b, i) => {
      msg += `${medals[i]} ${mdEscape(b.name)} — ₹${b.totalSpent}\n`;
    });
  }

  msg += '\n🔗 *Top Referrers*\n';
  if (topReferrers.length === 0) {
    msg += '_Koi referral abhi nahi hua_\n';
  } else {
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    topReferrers.forEach((r, i) => {
      msg += `${medals[i]} ${mdEscape(r.name)} — ${r.referralCount} referrals\n`;
    });
  }

  await smartReply(ctx, msg.trim(), backButton(ctx));
}

// ============ SUPPORT (menu action version) ============

bot.action('menu_support', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_support');
  await renderSupport(ctx);
});

async function renderSupport(ctx) {
  const telegramId = ctx.from.id;
  const settings = await fb.getBotSettings();

  let msg = `📞 *Customer Support*\n\n💫 Koi bhi issue ho, humse contact karo:\n\n`;
  const buttons = [];

  if (settings.supportTelegram) {
    const handle = settings.supportTelegram.replace('@', '');
    msg += `💬 Telegram: @${mdEscape(handle)}\n`;
    buttons.push([Markup.button.url('💬 Message on Telegram', `https://t.me/${handle}`)]);
  }
  if (settings.supportWhatsapp) {
    const number = settings.supportWhatsapp.replace(/[^0-9]/g, '');
    msg += `📱 WhatsApp: +${number}\n`;
    buttons.push([Markup.button.url('📱 Message on WhatsApp', `https://wa.me/${number}`)]);
  }
  if (!settings.supportTelegram && !settings.supportWhatsapp) {
    msg += 'Support details jaldi update honge.';
  }

  await smartReply(ctx, msg, navButtons(buttons, telegramId));
}

// ============ MY PURCHASES ============

bot.action('menu_purchases', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_purchases');
  await renderPurchases(ctx);
});

async function renderPurchases(ctx) {
  const telegramId = ctx.from.id;
  const orders = await fb.getUserOrders(telegramId);
  const delivered = Object.values(orders).filter(o => o.status === 'delivered').sort((a, b) => b.createdAt - a.createdAt);

  if (delivered.length === 0) {
    return smartReply(ctx, '📦 Abhi tak koi purchase nahi hai.', backButton(ctx));
  }

  const buttons = delivered.slice(0, 15)
    .filter(o => o.productId && o.productId !== 'PRO_PLAN' && o.productId !== 'WALLET_TOPUP')
    .map(o => [Markup.button.callback(`✅ ${o.productName} — ₹${o.amount}`, `redeliver_${o.id}`)]);

  await smartReply(ctx, '✨ 「 *My Purchases* 」\n\n✨ Tap to view or re-download:', navButtons(buttons, telegramId));
}

// ============ MY REFERRALS (menu action version) ============

bot.action('menu_referrals', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_referrals');
  await sendReferralInfo(ctx);
});

async function sendReferralInfo(ctx) {
  const telegramId = ctx.from.id;
  const user = await fb.getUser(telegramId);
  const settings = await fb.getReferralSettings();
  const botInfo = await bot.telegram.getMe();

  const allUsers = await fb.getAllUsers();
  const referredUsers = Object.values(allUsers).filter(u => u.referredBy === String(telegramId));
  const convertedCount = referredUsers.filter(u => u.hasFirstPurchase).length;

  const link = `https://t.me/${botInfo.username}?start=${user.referralCode}`;
  const bonusText = settings.bonusType === 'percent'
    ? `${settings.bonusAmount}% of their first purchase`
    : `₹${settings.bonusAmount}`;

  await smartReply(
    ctx,
    `✨ 「 *My Referrals* 」\n\n💎 Apne friends ko invite karo aur unki pehli purchase pe *${bonusText}* wallet bonus paao!\n\n👥 Total Referred: *${referredUsers.length}*\n✅ Converted (purchased): *${convertedCount}*\n\n🔗 Your referral link:\n\`${link}\``,
    backButton(ctx)
  );
}

// ============ BROWSE PRODUCTS ============

bot.action('menu_browse', async (ctx) => {
  await ctx.answerCbQuery();
  pushNav(ctx.from.id, 'menu_browse');
  await showCategories(ctx);
});

// ============ PRODUCTS / CATALOG (flat button list style) ============

async function showCategories(ctx) {
  const telegramId = ctx.from.id;
  const categories = await fb.getAllCategories();
  if (categories.length === 0) {
    return smartReply(ctx, '🛍 Abhi koi product available nahi hai. Jaldi aayega! 🙏', backButton(ctx));
  }

  const buttons = categories.map(cat => [Markup.button.callback(`📁 ${cat}`, `cat_${cat}`)]);
  buttons.push([Markup.button.callback('🏠 Home', 'menu_home')]);
  await smartReply(ctx, '🛍 *Browse Products*\n\nCategory choose karo:', Markup.inlineKeyboard(buttons));
}

bot.action(/^cat_(.+)$/, async (ctx) => {
  const category = ctx.match[1];
  const telegramId = ctx.from.id;
  const products = await fb.getProductsByCategory(category);
  const entries = Object.entries(products);

  if (entries.length === 0) {
    return ctx.answerCbQuery('Is category mein abhi product nahi hai.');
  }

  await ctx.answerCbQuery();
  pushNav(telegramId, `cat_${category}`);
  await renderCategoryProducts(ctx, category);
});

async function renderCategoryProducts(ctx, category) {
  const telegramId = ctx.from.id;
  const products = await fb.getProductsByCategory(category);
  const entries = Object.entries(products);

  if (entries.length === 0) {
    return smartReply(ctx, `📁 *${mdEscape(category)}*\n\nIs category mein abhi koi product nahi hai.`, backButton(ctx));
  }

  const buttons = entries.map(([id, p]) => {
    const priceLabel = p.price === 0 ? 'FREE' : `₹${p.price}`;
    return [Markup.button.callback(`🛒 ${p.name} | ${priceLabel}`, `viewproduct_${id}`)];
  });

  await smartReply(
    ctx,
    `📁 *${mdEscape(category)}*\n\n✨ Explore our full catalogue below — tap any product to view full details.`,
    navButtons(buttons, telegramId)
  );
}

// ---- Product detail view (tap from any flat list) ----
bot.action(/^viewproduct_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const product = await fb.getProduct(productId);

  if (!product) {
    await ctx.answerCbQuery('⚠️ Yeh product ab available nahi hai.', { show_alert: true });
    return smartReply(ctx, '⚠️ Yeh product remove kar diya gaya hai. Aapka purchase record safe hai — Order Status mein check kar sakte ho.', backButton(ctx));
  }

  await ctx.answerCbQuery();
  await fb.incrementProductViews(productId);
  pushNav(ctx.from.id, `viewproduct_${productId}`);
  await sendProductCard(ctx, productId, product);
});

// ---- Reusable product card sender (used by category browse + search) ----
// Deletes the message that triggered a callback (if any) before sending
// new content that can't use editMessageText (photos, media groups). This
// prevents old button-bearing messages from being left behind in the chat.
async function deleteTriggerMessage(ctx) {
  if (ctx.callbackQuery) {
    try { await ctx.deleteMessage(); } catch (e) { /* already gone or too old — fine */ }
  }
}

async function sendProductCard(ctx, id, p) {
  const telegramId = ctx.from.id;
  await deleteTriggerMessage(ctx);

  const { avg, count } = await fb.getProductAvgRating(id);
  const ratingLine = count > 0 ? `\n⭐ ${avg}/5 _(${count} reviews)_` : '';
  const stockLine = (p.stock !== undefined && p.stock !== -1) ? `\n📦 Stock: ${p.stock}` : '';
  const viewsLine = p.views ? `\n👁 ${p.views} views` : '';
  const priceLabel = p.price === 0 ? '*FREE* 🎁' : `*₹${p.price}*`;

  const caption = `✨ *${mdEscape(p.name)}*\n\n${mdEscape(p.description) || ''}\n\n💰 Price: ${priceLabel}${ratingLine}${stockLine}${viewsLine}`;

  const isFree = p.price === 0;
  const rows = [
    [isFree
      ? Markup.button.callback('📥 Download Free', `freedownload_${id}`)
      : Markup.button.callback('🛒 Buy Now', `buy_${id}`)],
    [Markup.button.callback('⭐ Reviews', `reviews_${id}`)]
  ];
  // Admin-configured custom button (e.g. "Join Community", "Watch Tutorial")
  if (p.customButtonText && p.customButtonUrl) {
    rows.push([Markup.button.url(`🔗 ${p.customButtonText}`, p.customButtonUrl)]);
  }

  const buttons = navButtons(rows, telegramId);

  // Support multiple images: an imageFileIds array (from the admin panel's
  // multi-photo upload), an imageUrls array, a single imageFileId, or a
  // single imageUrl — replyWithPhoto accepts URLs and file_ids interchangeably.
  const images = Array.isArray(p.imageFileIds) && p.imageFileIds.length > 0
    ? p.imageFileIds
    : (Array.isArray(p.imageUrls) && p.imageUrls.length > 0
      ? p.imageUrls
      : (p.imageFileId ? [p.imageFileId] : (p.imageUrl ? [p.imageUrl] : [])));

  if (images.length > 1) {
    const mediaGroup = images.map((url, i) => ({
      type: 'photo',
      media: url,
      caption: i === 0 ? caption : undefined,
      parse_mode: i === 0 ? 'Markdown' : undefined
    }));
    await ctx.replyWithMediaGroup(mediaGroup);
    await ctx.reply('👆 Product images', buttons);
  } else if (images.length === 1) {
    await ctx.replyWithPhoto(images[0], { caption, parse_mode: 'Markdown', ...buttons });
  } else {
    await ctx.reply(caption, { parse_mode: 'Markdown', ...buttons });
  }
}

// ============ SEARCH ============

bot.command('search', async (ctx) => {
  userState[ctx.from.id] = { step: 'awaiting_search_query' };
  await ctx.reply('🔍 Product ka naam type karo dhundhne ke liye:');
});

// ============ REVIEWS ============

bot.action(/^reviews_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  await ctx.answerCbQuery();

  const reviews = await fb.getProductReviews(productId);
  const list = Object.values(reviews).sort((a, b) => b.createdAt - a.createdAt);

  if (list.length === 0) {
    return ctx.reply(
      'Abhi koi review nahi hai. Purchase karne ke baad tum pehla review de sakte ho! 🙌',
      Markup.inlineKeyboard([[Markup.button.callback('✍️ Write a Review', `writereview_${productId}`)]])
    );
  }

  let msg = `⭐ *Reviews*\n\n`;
  list.slice(0, 8).forEach(r => {
    const stars = '⭐'.repeat(r.rating);
    msg += `${stars} — ${r.userName}\n${r.comment ? r.comment + '\n' : ''}\n`;
  });

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('✍️ Write a Review', `writereview_${productId}`)]])
  });
});

bot.action(/^writereview_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(
    'Rating do (1-5 stars):',
    Markup.inlineKeyboard([
      [1, 2, 3, 4, 5].map(n => Markup.button.callback('⭐'.repeat(n), `rate_${productId}_${n}`))
    ])
  );
});

bot.action(/^rate_(.+)_(\d)$/, async (ctx) => {
  const productId = ctx.match[1];
  const rating = parseInt(ctx.match[2]);
  await ctx.answerCbQuery();

  userState[ctx.from.id] = { step: 'awaiting_review_comment', data: { productId, rating } };
  await ctx.reply('Ek chhota comment likho (ya "skip" bhejo):');
});

// ============ BUY FLOW ============

bot.action(/^buy_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const product = await fb.getProduct(productId);
  const telegramId = ctx.from.id;

  if (!product || !product.active) {
    return ctx.answerCbQuery('Yeh product available nahi hai.');
  }

  // Already bought? Don't let them pay again — offer re-delivery instead.
  const boughtOrder = await fb.getBoughtOrder(telegramId, productId);
  if (boughtOrder) {
    await ctx.answerCbQuery();
    return ctx.reply(
      `✅ Yeh product aap pehle hi khareed chuke ho!\n\n*${mdEscape(product.name)}*\n\nDobara download karna hai?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📥 Re-download', `redeliver_${boughtOrder.id}`)],
          [Markup.button.callback('🏠 Home', 'menu_home')]
        ])
      }
    );
  }

  if (product.stock !== undefined && product.stock !== -1 && product.stock <= 0) {
    return ctx.answerCbQuery('Yeh product abhi out of stock hai.');
  }

  await ctx.answerCbQuery();

  // VIP users get every paid product free, instantly
  const isVip = await fb.isUserVip(telegramId);
  if (isVip && product.price > 0) {
    const order = await fb.createOrder({
      userId: String(telegramId),
      productId,
      productName: product.name,
      amount: 0,
      originalAmount: product.price,
      paymentMethod: 'vip_free',
      productSnapshot: {
        deliveryType: product.deliveryType,
        fileId: product.fileId || null,
        deliveryLink: product.deliveryLink || null
      }
    });
    await fb.updateOrderStatus(order.id, 'paid');
    await fb.decrementStock(productId);
    await checkAndAlertLowStock(productId);
    return deliverProduct(ctx, product, order.id);
  }

  await showOrderSummary(ctx, productId, product, null);
});

// ---- Free products: instant delivery, no payment flow at all ----
bot.action(/^freedownload_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const product = await fb.getProduct(productId);
  const telegramId = ctx.from.id;

  if (!product || !product.active) {
    return ctx.answerCbQuery('Yeh product available nahi hai.');
  }
  if (product.price !== 0) {
    // Safety net in case an old button/cached message still points here
    // for a product whose price was changed after the card was sent.
    return ctx.answerCbQuery('Yeh product ab free nahi hai.', { show_alert: true });
  }

  // Already have it? Offer re-download instead of creating a duplicate order.
  const boughtOrder = await fb.getBoughtOrder(telegramId, productId);
  if (boughtOrder) {
    await ctx.answerCbQuery();
    return ctx.reply(
      `✅ Yeh product aap pehle hi le chuke ho!\n\n*${mdEscape(product.name)}*\n\nDobara download karna hai?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📥 Re-download', `redeliver_${boughtOrder.id}`)],
          [Markup.button.callback('🏠 Home', 'menu_home')]
        ])
      }
    );
  }

  if (product.stock !== undefined && product.stock !== -1 && product.stock <= 0) {
    return ctx.answerCbQuery('Yeh product abhi out of stock hai.');
  }

  await ctx.answerCbQuery();

  const order = await fb.createOrder({
    userId: String(telegramId),
    productId,
    productName: product.name,
    amount: 0,
    originalAmount: 0,
    paymentMethod: 'free',
    productSnapshot: {
      deliveryType: product.deliveryType,
      fileId: product.fileId || null,
      deliveryLink: product.deliveryLink || null
    }
  });
  await fb.updateOrderStatus(order.id, 'paid');
  await fb.decrementStock(productId);
  await checkAndAlertLowStock(productId);
  await deliverProduct(ctx, product, order.id);
});

async function showOrderSummary(ctx, productId, product, appliedCoupon) {
  const telegramId = ctx.from.id;
  const balance = await fb.getWalletBalance(telegramId);

  let finalPrice = product.price;
  let couponLine = '';
  if (appliedCoupon) {
    finalPrice = Math.max(0, product.price - appliedCoupon.discount);
    couponLine = `\n🎟 Coupon \`${mdEscape(appliedCoupon.code)}\` applied: *-₹${appliedCoupon.discount}*`;
  }

  const couponSuffix = appliedCoupon ? `_${appliedCoupon.code}` : '';

  const rows = [
    [Markup.button.callback('💰 Pay via Wallet', `paywallet_${productId}${couponSuffix}`)],
    [Markup.button.callback('💳 Pay via ZapUPI', `payzabupi_${productId}${couponSuffix}`)]
  ];
  if (!appliedCoupon) {
    rows.push([Markup.button.callback('🎟 Apply Coupon', `applycoupon_${productId}`)]);
  }
  rows.push([Markup.button.callback('👑 Get Free with Pro Plan', 'menu_proplan')]);

  const text = `🧾 *Order Summary*\n\n✨ ${mdEscape(product.name)}\nPrice: ₹${product.price}${couponLine}\n\n💎 *Total: ₹${finalPrice}*\n💰 Wallet Balance: ₹${balance}\n\n👇 Payment method choose karo:`;

  await smartReply(ctx, text, navButtons(rows, telegramId));
}

bot.action(/^applycoupon_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  await ctx.answerCbQuery();
  userState[ctx.from.id] = { step: 'awaiting_coupon_code', data: { productId } };
  await ctx.reply('🎟 Coupon code type karo:');
});

// ---- Pay via Wallet ----
bot.action(/^paywallet_([^_]+)(?:_(.+))?$/, async (ctx) => {
  const productId = ctx.match[1];
  const couponCode = ctx.match[2];
  const telegramId = ctx.from.id;
  const product = await fb.getProduct(productId);

  if (!product) return ctx.answerCbQuery('Product not found.');

  if (productId !== 'PRO_PLAN' && await fb.hasUserBoughtProduct(telegramId, productId)) {
    await ctx.answerCbQuery();
    return smartReply(ctx, '✅ Yeh product aap pehle hi khareed chuke ho.', backButton(ctx));
  }

  let finalPrice = product.price;
  let couponUsed = null;
  if (couponCode) {
    const check = await fb.validateCoupon(couponCode, product.price);
    if (check.valid) {
      finalPrice = Math.max(0, product.price - check.discount);
      couponUsed = couponCode;
    }
  }

  const balance = await fb.getWalletBalance(telegramId);
  if (balance < finalPrice) {
    await ctx.answerCbQuery();
    return smartReply(
      ctx,
      `❌ *Insufficient wallet balance*\n\n💰 Balance: ₹${balance}\n💳 Required: ₹${finalPrice}\n\nZapUPI se add money karo pehle.`,
      navButtons([[Markup.button.callback('➕ Add Money', 'addmoney')]], telegramId)
    );
  }

  await ctx.answerCbQuery('Processing...');

  try {
    if (finalPrice > 0) await fb.debitWallet(telegramId, finalPrice, 'purchase');

    const order = await fb.createOrder({
      userId: String(telegramId),
      productId,
      productName: product.name,
      amount: finalPrice,
      originalAmount: product.price,
      couponUsed: couponUsed || null,
      paymentMethod: 'wallet',
      productSnapshot: {
        deliveryType: product.deliveryType,
        fileId: product.fileId || null,
        deliveryLink: product.deliveryLink || null
      }
    });

    await fb.updateOrderStatus(order.id, 'paid');
    if (couponUsed) await fb.incrementCouponUsage(couponUsed);
    await fb.processReferralBonus(telegramId, finalPrice);
    await fb.decrementStock(productId);
    await checkAndAlertLowStock(productId);

    await deliverProduct(ctx, product, order.id);
  } catch (err) {
    console.error(err);
    await smartReply(ctx, '❌ *Payment failed.*\n\nPlease try again ya support se contact karo.', backButton(ctx));
  }
});

// ---- Pay via Zabupi ----
bot.action(/^payzabupi_([^_]+)(?:_(.+))?$/, async (ctx) => {
  const productId = ctx.match[1];
  const couponCode = ctx.match[2];
  const telegramId = ctx.from.id;
  const product = await fb.getProduct(productId);

  if (!product) return ctx.answerCbQuery('Product not found.');

  if (productId !== 'PRO_PLAN' && await fb.hasUserBoughtProduct(telegramId, productId)) {
    await ctx.answerCbQuery();
    return smartReply(ctx, '✅ Yeh product aap pehle hi khareed chuke ho.', backButton(ctx));
  }

  let finalPrice = product.price;
  let couponUsed = null;
  if (couponCode) {
    const check = await fb.validateCoupon(couponCode, product.price);
    if (check.valid) {
      finalPrice = Math.max(0, product.price - check.discount);
      couponUsed = couponCode;
    }
  }

  await ctx.answerCbQuery('Generating payment link...');
  // Edit the SAME message through the whole flow (loading → result) so
  // nothing gets left behind in the chat.
  await smartReply(ctx, '⏳ *Payment link generate ho raha hai...*', navButtons([[Markup.button.callback('❌ Cancel', 'menu_home')]], telegramId));

  const order = await fb.createOrder({
    userId: String(telegramId),
    productId,
    productName: product.name,
    amount: finalPrice,
    originalAmount: product.price,
    couponUsed: couponUsed || null,
    paymentMethod: 'zabupi',
    productSnapshot: {
      deliveryType: product.deliveryType,
      fileId: product.fileId || null,
      deliveryLink: product.deliveryLink || null
    }
  });

  const payment = await zabupi.createPaymentOrder({
    orderId: order.payRef,
    amount: finalPrice,
    userId: telegramId,
    userName: ctx.from.first_name,
    purpose: product.name
  });

  if (!payment.success) {
    await fb.updateOrderStatus(order.id, 'failed');
    console.error('ZapUPI payment creation failed for order', order.id, ':', payment.error);
    return smartReply(
      ctx,
      `❌ *Payment link generate nahi ho paya*\n\nWajah: ${mdEscape(typeof payment.error === 'string' ? payment.error : JSON.stringify(payment.error))}\n\nThodi der baad try karo ya support se contact karo.`,
      navButtons([[Markup.button.callback('🔄 Try Again', `payzabupi_${productId}${couponCode ? '_' + couponCode : ''}`)]], telegramId)
    );
  }

  await fb.updateOrderStatus(order.id, 'pending', { zabupiTxnId: payment.transactionId });

  const sentMsg = await smartReply(
    ctx,
    `💳 *Payment link ready!*\n\n${mdEscape(product.name)} — ₹${finalPrice}\n\n👇 Neeche link pe click karke payment complete karo.\n\n✅ Payment hote hi (10-20 sec mein) product yahin turant deliver ho jaayega — payment ke baad browser tab band karke seedha Telegram pe wapas aa jao.`,
    Markup.inlineKeyboard([
      [Markup.button.url('💳 Pay Now', payment.paymentUrl)],
      [Markup.button.callback('❌ Cancel Order', `cancelorder_${order.id}`), Markup.button.callback('🏠 Home', 'menu_home')]
    ])
  );

  // Save this message's location so the background payment poller can edit
  // it directly into a success message once payment completes — instead of
  // leaving the "Pay Now" screen stuck in the chat.
  if (sentMsg) {
    await fb.updateOrderStatus(order.id, 'pending', {
      paymentMsgChatId: sentMsg.chat.id,
      paymentMsgId: sentMsg.message_id
    });
  }
});

// ---- Cancel a pending order ----
bot.action(/^cancelorder_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  await ctx.answerCbQuery();

  const order = await fb.getOrder(orderId);
  if (order && order.status === 'pending') {
    await fb.updateOrderStatus(orderId, 'failed', { cancelledByUser: true });
  }

  await smartReply(ctx, '❌ Order cancel kar diya gaya.', backButton(ctx));
});

// ---- Low stock alert helper ----
async function checkAndAlertLowStock(productId) {
  const alert = await fb.checkLowStock(productId);
  if (!alert) return;

  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(adminId, `⚠️ *Low Stock Alert*\n\n"${alert.productName}" — only ${alert.stock} left!`, { parse_mode: 'Markdown' });
    } catch (e) {}
  }
}

// ============ PRODUCT DELIVERY ============

// Redeliver now takes an orderId (not productId) so it can fall back to the
// order's saved productSnapshot if the admin has since deleted the product —
// this is what makes re-download keep working after deletion.
bot.action(/^redeliver_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  await ctx.answerCbQuery();

  const order = await fb.getOrder(orderId);
  if (!order) return ctx.reply('⚠️ Order not found.');

  // Security: only the buyer (or an admin) can re-trigger their own delivery
  if (String(order.userId) !== String(ctx.from.id) && !fb.isAdmin(ctx.from.id)) {
    return ctx.answerCbQuery('Not your order.', { show_alert: true });
  }

  const liveProduct = await fb.getProduct(order.productId);
  const product = liveProduct || {
    name: order.productName,
    ...order.productSnapshot
  };

  if (!product.deliveryType || (!product.fileId && !product.deliveryLink)) {
    return ctx.reply('⚠️ Delivery details is order ke liye available nahi hain. Support se contact karo.');
  }

  await deliverProduct(ctx, product, null, true);
});

async function deliverProduct(ctx, product, orderId, silent) {
  if (!silent) {
    // Edit the triggering message (e.g. "Processing...") to show delivery
    // status instead of stacking a new message on top of it.
    await smartReply(ctx, `✅ *Payment successful!*\n\nDelivering ${mdEscape(product.name)}...`, {});
  } else {
    await deleteTriggerMessage(ctx);
  }

  try {
    if (product.deliveryType === 'file' && product.fileId) {
      await ctx.replyWithDocument(product.fileId, {
        caption: `📦 ${product.name}\n\nThank you for your purchase! 🙏`
      });
    } else if (product.deliveryType === 'link' && product.deliveryLink) {
      // Sent as plain text (no Markdown parsing) — links often contain
      // underscores, asterisks, etc. which Telegram Markdown would otherwise
      // interpret as formatting and corrupt or hide the link entirely.
      await ctx.reply(
        `📦 ${product.name}\n\n🔗 Download Link:\n${product.deliveryLink}\n\nThank you for your purchase! 🙏`
      );
    } else {
      await ctx.reply('⚠️ Delivery content set nahi hai. Support se contact karo, jald hi resolve hoga.');
    }

    if (orderId) {
      await fb.updateOrderStatus(orderId, 'delivered', { deliveredAt: Date.now() });
    }
  } catch (err) {
    console.error('Delivery error:', err);
    await ctx.reply(
      '⚠️ *Delivery mein issue aaya.*\n\nAapka payment safe hai — support team ko turant inform kar diya gaya hai, jald hi resolve hoga.',
      { parse_mode: 'Markdown', ...backButton(ctx) }
    );

    const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const adminId of adminIds) {
      try {
        await bot.telegram.sendMessage(adminId, `🚨 *Delivery Failed*\n\nOrder: ${orderId || 'N/A'}\nProduct: ${mdEscape(product.name)}\nUser: ${ctx.from.id}\nError: ${mdEscape(err.message)}`, { parse_mode: 'Markdown' });
      } catch (e) {}
    }
  }
}

// ============ WALLET (accessible via /wallet command, add money still used in checkout) ============

bot.command('wallet', async (ctx) => {
  const balance = await fb.getWalletBalance(ctx.from.id);
  await ctx.reply(
    `💰 *Your Wallet*\n\nBalance: ₹${balance}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Money', 'addmoney')],
        [Markup.button.callback('🏠 Home', 'menu_home')]
      ])
    }
  );
});

bot.action('addmoney', async (ctx) => {
  await ctx.answerCbQuery();
  userState[ctx.from.id] = { step: 'awaiting_addmoney_amount' };
  await ctx.reply('Kitna amount add karna hai? (₹ mein number bhejo, e.g. 100)');
});

// ---- Refund request action (triggered from Order Status / My Purchases) ----
bot.action(/^refund_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  await ctx.answerCbQuery();
  userState[ctx.from.id] = { step: 'awaiting_refund_reason', data: { orderId } };
  await ctx.reply('Refund ka reason likho:');
});

// ============ ADMIN COMMANDS ============

bot.command('salesreport', async (ctx) => {
  if (!fb.isAdmin(ctx.from.id)) return;

  const weekly = await fb.getSalesReport(7);
  const monthly = await fb.getSalesReport(30);

  let msg = `📊 *Sales Report*\n\n`;
  msg += `*Last 7 days:*\n💰 ₹${weekly.totalSales} — ${weekly.orderCount} orders\n`;
  if (weekly.topProducts.length) msg += `Top: ${weekly.topProducts.join(', ')}\n`;
  msg += `\n*Last 30 days:*\n💰 ₹${monthly.totalSales} — ${monthly.orderCount} orders\n`;
  if (monthly.topProducts.length) msg += `Top: ${monthly.topProducts.join(', ')}\n`;

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('ban', async (ctx) => {
  if (!fb.isAdmin(ctx.from.id)) return;
  const parts = ctx.message.text.split(' ');
  const targetId = parts[1];
  const reason = parts.slice(2).join(' ');

  if (!targetId) return ctx.reply('Usage: /ban <telegram_id> <reason>');

  await fb.banUser(targetId, reason);
  await ctx.reply(`🚫 User ${targetId} banned.`);
});

bot.command('unban', async (ctx) => {
  if (!fb.isAdmin(ctx.from.id)) return;
  const targetId = ctx.message.text.split(' ')[1];

  if (!targetId) return ctx.reply('Usage: /unban <telegram_id>');

  await fb.unbanUser(targetId);
  await ctx.reply(`✅ User ${targetId} unbanned.`);
});

bot.command('msg', async (ctx) => {
  if (!fb.isAdmin(ctx.from.id)) return;
  const parts = ctx.message.text.split(' ');
  const targetId = parts[1];
  const message = parts.slice(2).join(' ');

  if (!targetId || !message) return ctx.reply('Usage: /msg <telegram_id> <message>');

  try {
    await bot.telegram.sendMessage(targetId, `📩 *Message from Admin:*\n\n${message}`, { parse_mode: 'Markdown' });
    await ctx.reply(`✅ Message sent to ${targetId}.`);
  } catch (err) {
    await ctx.reply(`❌ Failed to send — user may have blocked the bot.`);
  }
});

// Document handler: during the admin product wizard, this saves the file
// for delivery. Otherwise (outside a wizard), admins get the raw file_id
// as a fallback utility for manual use.
bot.on('document', async (ctx) => {
  if (!fb.isAdmin(ctx.from.id)) return;

  const handled = await adminPanel.handleAdminDocument(ctx);
  if (handled) return;

  await ctx.reply(`📎 File ID:\n\`${ctx.message.document.file_id}\`\n\nUse /admin → Products → Add Product to use this in the wizard.`, { parse_mode: 'Markdown' });
});

// Photo handler: during the admin product wizard, this saves the product
// image. Otherwise, admins get the raw file_id for manual broadcast/DM use.
bot.on('photo', async (ctx) => {
  if (!fb.isAdmin(ctx.from.id)) return;

  const handled = await adminPanel.handleAdminPhoto(ctx);
  if (handled) return;

  const sizes = ctx.message.photo;
  const largest = sizes[sizes.length - 1];
  await ctx.reply(`🖼 Photo File ID:\n\`${largest.file_id}\`\n\nUse /admin → Broadcast or Direct Message to attach images with this.`, { parse_mode: 'Markdown' });
});

// ============ TEXT HANDLER (for multi-step states) ============

bot.on('text', async (ctx) => {
  // Admin wizard steps take priority over the regular user-facing flows
  const adminHandled = await adminPanel.handleAdminText(ctx);
  if (adminHandled) return;

  const state = userState[ctx.from.id];
  if (!state) return; // ignore, no active flow

  if (state.step === 'awaiting_search_query') {
    delete userState[ctx.from.id];
    const query = ctx.message.text.trim();
    const results = await fb.searchProducts(query);
    const entries = Object.entries(results);

    if (entries.length === 0) {
      return ctx.reply(`🔍 Koi product "${query}" naam se nahi mila.`);
    }

    const buttons = entries.map(([id, p]) => {
      const priceLabel = p.price === 0 ? 'FREE' : `₹${p.price}`;
      return [Markup.button.callback(`🛒 ${p.name} | ${priceLabel}`, `viewproduct_${id}`)];
    });
    buttons.push([Markup.button.callback('🏠 Home', 'menu_home')]);

    await ctx.reply(`🔍 *${entries.length} result(s) for "${query}"*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    return;
  }

  if (state.step === 'awaiting_review_comment') {
    delete userState[ctx.from.id];
    const { productId, rating } = state.data;
    const comment = ctx.message.text.trim().toLowerCase() === 'skip' ? '' : ctx.message.text.trim();

    await fb.addReview(productId, ctx.from.id, ctx.from.first_name, rating, comment);
    return ctx.reply('✅ Review submit ho gaya, thank you! 🙏');
  }

  if (state.step === 'awaiting_coupon_code') {
    delete userState[ctx.from.id];
    const { productId } = state.data;
    const code = ctx.message.text.trim().toUpperCase();
    const product = await fb.getProduct(productId);

    if (!product) return ctx.reply('Product not found.');

    const check = await fb.validateCoupon(code, product.price);
    if (!check.valid) {
      await ctx.reply(`❌ ${check.reason}`);
      return showOrderSummary(ctx, productId, product, null);
    }

    await ctx.reply(`✅ Coupon applied! Discount: ₹${check.discount}`);
    return showOrderSummary(ctx, productId, product, { code, discount: check.discount });
  }

  if (state.step === 'awaiting_refund_reason') {
    delete userState[ctx.from.id];
    const { orderId } = state.data;
    const reason = ctx.message.text.trim();

    await fb.requestRefund(orderId, reason);
    await ctx.reply('✅ Refund request bhej diya gaya. Admin review karega jaldi.');

    const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const adminId of adminIds) {
      try {
        await bot.telegram.sendMessage(adminId, `↩️ *Refund Request*\n\nOrder: ${orderId}\nReason: ${reason}\n\nApprove/reject from admin panel.`, { parse_mode: 'Markdown' });
      } catch (e) {}
    }
    return;
  }

  if (state.step === 'awaiting_addmoney_amount') {
    const amount = parseInt(ctx.message.text.trim());

    if (isNaN(amount) || amount < 10) {
      return ctx.reply('❌ Valid amount daalo (minimum ₹10).');
    }

    delete userState[ctx.from.id];

    const order = await fb.createOrder({
      userId: String(ctx.from.id),
      productId: 'WALLET_TOPUP',
      productName: 'Wallet Top-up',
      amount,
      paymentMethod: 'zabupi'
    });

    const payment = await zabupi.createPaymentOrder({
      orderId: order.payRef,
      amount,
      userId: ctx.from.id,
      userName: ctx.from.first_name,
      purpose: 'Wallet Top-up'
    });

    if (!payment.success) {
      await fb.updateOrderStatus(order.id, 'failed');
      return ctx.reply('❌ Payment link generate nahi ho paya. Try again.');
    }

    await fb.updateOrderStatus(order.id, 'pending', { zabupiTxnId: payment.transactionId, isWalletTopup: true });

    await ctx.reply(
      `💳 Add ₹${amount} to wallet`,
      Markup.inlineKeyboard([[Markup.button.url('💳 Pay Now', payment.paymentUrl)]])
    );
  }
});

// ============ ADMIN API — Bot Profile Management ============
// Protected by ADMIN_API_SECRET (set in Railway env vars). admin.html calls
// these endpoints to change bot name/description/photo since the Telegram
// Bot API requires the bot token, which must never be exposed to the browser.

function checkAdminApiSecret(req, res) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_API_SECRET) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.post('/admin-api/set-bot-name', async (req, res) => {
  if (!checkAdminApiSecret(req, res)) return;
  try {
    const { name } = req.body;
    await bot.telegram.setMyName(name);
    res.json({ success: true });
  } catch (err) {
    console.error('setMyName failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin-api/set-bot-description', async (req, res) => {
  if (!checkAdminApiSecret(req, res)) return;
  try {
    const { description, shortDescription } = req.body;
    if (description) await bot.telegram.setMyDescription(description);
    if (shortDescription) await bot.telegram.setMyShortDescription(shortDescription);
    res.json({ success: true });
  } catch (err) {
    console.error('setMyDescription failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// NOTE: Telegram's Bot API has no method for a bot to change its own profile
// photo — that can only be done manually via @BotFather (/setuserpic).
// This endpoint is intentionally not implemented; admin.html shows a direct
// link to BotFather instead of a broken button.

// ============ ZABUPI (ZapUPI) WEBHOOK (Express server) ============

// Checks ZapUPI's real order status and processes delivery if paid. Shared
// by both the webhook endpoint (in case ZapUPI does call it) and the
// polling loop below (the reliable path, since webhook_url isn't in
// ZapUPI's documented create-order fields).
async function checkAndProcessOrder(orderId) {
  const order = await fb.getOrder(orderId);
  if (!order) return { processed: false, reason: 'not_found' };
  if (order.status === 'delivered' || order.status === 'paid') {
    return { processed: false, reason: 'already_done' };
  }

  const statusCheck = await zabupi.checkPaymentStatus(order.payRef || orderId);
  const statusData = statusCheck?.data || statusCheck;
  const status = statusData ? String(statusData.status).toLowerCase() : null;

  if (status === 'failed') {
    await fb.updateOrderStatus(orderId, 'failed');
    return { processed: true, reason: 'failed' };
  }
  if (status !== 'success') {
    return { processed: false, reason: 'still_pending' }; // keep polling
  }

  const transaction_id = statusData.txn_id || null;
  await fb.updateOrderStatus(orderId, 'paid', { zabupiTxnId: transaction_id });

  // Turn the "Pay Now / Cancel" message into a clean success confirmation —
  // removes the buttons so the user can't tap a stale Pay Now / Cancel after
  // payment already went through.
  await replacePaymentMessage(order, `✅ *Payment Successful!*\n\n💎 ${mdEscape(order.productName)} — ₹${order.amount}\n\nDelivering now...`);

  // Wallet top-up
  if (order.productId === 'WALLET_TOPUP' || order.isWalletTopup) {
    await fb.creditWallet(order.userId, order.amount, 'topup');
    await bot.telegram.sendMessage(order.userId, `✅ *₹${order.amount} added to your wallet!*\n\n💰 Naya balance check karne ke liye Wallet mein jao.`, { parse_mode: 'Markdown' });
    await fb.updateOrderStatus(orderId, 'delivered', { deliveredAt: Date.now() });
    return { processed: true, reason: 'topup_done' };
  }

  // Pro Plan subscription
  if (order.productId === 'PRO_PLAN' || order.isProPlan) {
    const duration = order.proPlanDuration || 30;
    const newExpiry = await fb.activateProPlan(order.userId, duration);
    await bot.telegram.sendMessage(
      order.userId,
      `👑 *Pro Plan Activated!*\n\n✨ Aap ab VIP hain — sab paid products FREE mein download kar sakte ho.\n\n📅 Expires: ${new Date(newExpiry).toLocaleDateString()}`,
      { parse_mode: 'Markdown' }
    );
    await fb.updateOrderStatus(orderId, 'delivered', { deliveredAt: Date.now() });
    return { processed: true, reason: 'proplan_done' };
  }

  // Regular product purchase
  const product = await fb.getProduct(order.productId);
  await fb.processReferralBonus(order.userId, order.amount);
  if (order.couponUsed) await fb.incrementCouponUsage(order.couponUsed);
  await fb.decrementStock(order.productId);
  await checkAndAlertLowStock(order.productId);

  if (product) {
    try {
      if (product.deliveryType === 'file' && product.fileId) {
        await bot.telegram.sendDocument(order.userId, product.fileId, {
          caption: `📦 *${product.name}*\n\n🙏 Thank you for your purchase!`,
          parse_mode: 'Markdown'
        });
      } else if (product.deliveryType === 'link' && product.deliveryLink) {
        // Plain text (no Markdown) — links often contain underscores/asterisks
        // which Markdown parsing would otherwise corrupt or hide.
        await bot.telegram.sendMessage(
          order.userId,
          `✅ Payment successful!\n\n📦 ${product.name}\n\n🔗 Download Link:\n${product.deliveryLink}\n\n🙏 Thank you!`
        );
      }
      await fb.updateOrderStatus(orderId, 'delivered', { deliveredAt: Date.now() });
    } catch (deliveryErr) {
      console.error('Delivery error:', deliveryErr);
    }
  }

  return { processed: true, reason: 'delivered' };
}

// Edits the original "Pay Now / Cancel" message (tracked via
// paymentMsgChatId/paymentMsgId) into a clean confirmation with no buttons.
// Falls back to a fresh message if the original can't be edited/found.
async function replacePaymentMessage(order, text) {
  if (order.paymentMsgChatId && order.paymentMsgId) {
    try {
      await bot.telegram.editMessageText(order.paymentMsgChatId, order.paymentMsgId, undefined, text, { parse_mode: 'Markdown' });
      return;
    } catch (err) {
      // message too old / already changed — fall through to a fresh message
    }
  }
  try {
    await bot.telegram.sendMessage(order.userId, text, { parse_mode: 'Markdown' });
  } catch (err) { /* user may have blocked the bot */ }
}

// ---- Polling loop: ZapUPI's documented create-order payload has no
// webhook_url field, so we can't rely on a push callback. Every 20s we
// check all pending ZapUPI orders from the last hour and process any that
// have completed. This is the reliable confirmation path.
setInterval(async () => {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000; // only check orders from the last hour
    const pending = await fb.getPendingOrdersByMethod('zabupi', cutoff);

    for (const [orderId] of pending) {
      await checkAndProcessOrder(orderId);
    }
  } catch (err) {
    console.error('Payment polling error:', err);
  }
}, 20000);

app.post('/webhook/zabupi', async (req, res) => {
  try {
    const payRef = req.body.order_id;
    if (!payRef) return res.status(400).send('Missing order_id');

    const order = await fb.getOrderByPayRef(payRef);
    if (!order) return res.status(404).send('Order not found');

    await checkAndProcessOrder(order.id);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error');
  }
});

// Premium auto-redirect landing pages. These are OUR pages — if ZapUPI ever
// starts honoring a redirect field, or if you link users here manually,
// this sends them straight back into the bot instead of leaving them
// stranded on a static confirmation page.
function redirectPage({ icon, title, message, autoRedirect = true }) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  *{box-sizing:border-box; margin:0; padding:0;}
  body{
    background:#0d1117; color:#e6edf3; font-family:'Segoe UI', system-ui, sans-serif;
    min-height:100vh; display:flex; align-items:center; justify-content:center; text-align:center; padding:24px;
  }
  .card{ max-width:380px; }
  .icon{ font-size:64px; margin-bottom:20px; }
  h1{ font-size:22px; margin-bottom:12px; }
  p{ color:#7d8b9a; font-size:14px; line-height:1.6; margin-bottom:28px; }
  a.btn{
    display:inline-block; background:#5eead4; color:#04120f; text-decoration:none;
    padding:14px 32px; border-radius:8px; font-weight:700; font-size:15px;
  }
  .spinner{ width:20px; height:20px; border:3px solid #232b36; border-top-color:#5eead4; border-radius:50%; margin:0 auto 16px; animation:spin 0.8s linear infinite; }
  @keyframes spin{ to{ transform:rotate(360deg); } }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    ${autoRedirect ? '<div class="spinner"></div><p style="margin-top:-20px; font-size:12px;">Redirecting to Telegram...</p>' : ''}
    <a class="btn" href="tg://resolve?domain=${process.env.BOT_USERNAME || ''}" id="openBot">Open Bot</a>
  </div>
  <script>
    const botUsername = ${JSON.stringify(process.env.BOT_USERNAME || '')};
    if (botUsername) {
      const link = 'https://t.me/' + botUsername;
      document.getElementById('openBot').href = link;
      ${autoRedirect ? 'setTimeout(() => { window.location.href = link; }, 1200);' : ''}
    }
  </script>
</body></html>`;
}

app.get('/payment-success', (req, res) => {
  res.send(redirectPage({
    icon: '✅',
    title: 'Payment Received!',
    message: 'Your payment is being confirmed. Your product will be delivered in the bot within a few seconds.'
  }));
});

app.get('/payment-failed', (req, res) => {
  res.send(redirectPage({
    icon: '❌',
    title: 'Payment Failed',
    message: 'Something went wrong with your payment. Please return to the bot and try again.'
  }));
});

app.get('/payment-timeout', (req, res) => {
  res.send(redirectPage({
    icon: '⏱️',
    title: 'Payment Timed Out',
    message: 'The payment session expired. Please return to the bot and try again.'
  }));
});

app.get('/', (req, res) => res.send('Bot server running ✅'));

// ============ QUEUE PROCESSING (polling-based) ============
// Local JSON storage has no real-time push events like Firebase's
// child_added/child_changed — instead, we poll the broadcast/DM queues and
// the products list every few seconds and process anything new.

async function processBroadcastQueue() {
  const queue = await fb.getBroadcastQueue();

  for (const [id, data] of Object.entries(queue)) {
    // ---- Handle unsend requests ----
    if (data.deleteRequested && !data.deleted) {
      const sentMessages = data.sentMessages || {};
      const entries = Object.entries(sentMessages);
      if (entries.length === 0) {
        await fb.updateBroadcastEntry(id, { deleted: true, deleteError: 'No message references saved' });
        continue;
      }
      let unsentCount = 0;
      for (const [uid, ref] of entries) {
        try { await bot.telegram.deleteMessage(ref.chatId, ref.messageId); unsentCount++; }
        catch (err) { /* too old (48h+) or already gone — skip */ }
        await new Promise(r => setTimeout(r, 50));
      }
      await fb.updateBroadcastEntry(id, { deleted: true, deletedAt: Date.now(), unsentCount });
      console.log(`🗑️ Broadcast unsent from ${unsentCount}/${entries.length} chats`);
      continue;
    }

    // ---- Handle new (unsent) broadcasts ----
    if (data.sent) continue;

    const users = await fb.getAllUsers();
    const userIds = Object.keys(users);

    const inlineKeyboard = [];
    if (data.buttonText && data.buttonUrl) inlineKeyboard.push([{ text: data.buttonText, url: data.buttonUrl }]);
    if (data.isPopup) inlineKeyboard.push([{ text: '❌ Close', callback_data: 'closepopup' }]);
    const extra = { parse_mode: 'Markdown' };
    if (inlineKeyboard.length > 0) extra.reply_markup = { inline_keyboard: inlineKeyboard };

    const prefix = data.isPopup ? '🔔 *Notification*' : '📢 *Announcement*';
    const fileIds = Array.isArray(data.fileIds) ? data.fileIds : [];
    const imageIds = Array.isArray(data.imageIds) ? data.imageIds : [];

    let successCount = 0;
    const sentMessages = {};

    for (const uid of userIds) {
      try {
        let sentMsg;
        if (imageIds.length > 0) {
          sentMsg = await bot.telegram.sendPhoto(uid, imageIds[0], { caption: `${prefix}\n\n${data.message}`, ...extra });
          for (const imgId of imageIds.slice(1)) {
            try { await bot.telegram.sendPhoto(uid, imgId); } catch (e) {}
          }
        } else {
          sentMsg = await bot.telegram.sendMessage(uid, `${prefix}\n\n${data.message}`, extra);
        }
        for (const fid of fileIds) {
          try { await bot.telegram.sendDocument(uid, fid); } catch (e) {}
        }
        sentMessages[uid] = { chatId: sentMsg.chat.id, messageId: sentMsg.message_id };
        successCount++;
        await fb.setUserField(uid, 'lastUnseenBroadcastId', id);
      } catch (e) { /* user blocked bot — skip */ }
      await new Promise(r => setTimeout(r, 50));
    }

    await fb.updateBroadcastEntry(id, {
      sent: true, sentAt: Date.now(), sentCount: successCount,
      targetCount: userIds.length, seenCount: 0, sentMessages
    });
    console.log(`📢 Broadcast sent to ${successCount}/${userIds.length} users`);
  }
}

async function processDmQueue() {
  const queue = await fb.getDmQueue();

  for (const [id, data] of Object.entries(queue)) {
    // ---- Handle unsend requests ----
    if (data.deleteRequested && !data.deleted) {
      if (!data.sentChatId || !data.sentMessageId) {
        await fb.updateDmEntry(id, { deleted: true, deleteError: 'No message reference saved' });
        continue;
      }
      try {
        await bot.telegram.deleteMessage(data.sentChatId, data.sentMessageId);
        await fb.updateDmEntry(id, { deleted: true, deletedAt: Date.now() });
      } catch (err) {
        await fb.updateDmEntry(id, { deleted: true, deleteError: err.message });
      }
      continue;
    }

    // ---- Handle new (unsent) DMs ----
    if (data.sent || !data.userId || !data.message) continue;

    const inlineKeyboard = [];
    if (data.buttonText && data.buttonUrl) inlineKeyboard.push([{ text: data.buttonText, url: data.buttonUrl }]);
    if (data.isPopup) inlineKeyboard.push([{ text: '❌ Close', callback_data: 'closepopup' }]);
    const extra = { parse_mode: 'Markdown' };
    if (inlineKeyboard.length > 0) extra.reply_markup = { inline_keyboard: inlineKeyboard };

    try {
      const prefix = data.isPopup ? '🔔 *Notification*' : '📩 *Message from Admin:*';
      const fileIds = Array.isArray(data.fileIds) ? data.fileIds : [];
      const imageIds = Array.isArray(data.imageIds) ? data.imageIds : [];
      let sentMsg;

      if (imageIds.length > 0) {
        sentMsg = await bot.telegram.sendPhoto(data.userId, imageIds[0], { caption: `${prefix}\n\n${data.message}`, ...extra });
        for (const imgId of imageIds.slice(1)) {
          try { await bot.telegram.sendPhoto(data.userId, imgId); } catch (e) {}
        }
      } else {
        sentMsg = await bot.telegram.sendMessage(data.userId, `${prefix}\n\n${data.message}`, extra);
      }
      for (const fid of fileIds) {
        try { await bot.telegram.sendDocument(data.userId, fid); } catch (e) {}
      }

      await fb.updateDmEntry(id, {
        sent: true, sentAt: Date.now(), success: true,
        sentChatId: sentMsg.chat.id, sentMessageId: sentMsg.message_id
      });
      await fb.setUserField(data.userId, 'lastUnseenDmId', id);
    } catch (err) {
      await fb.updateDmEntry(id, { sent: true, sentAt: Date.now(), success: false, error: err.message });
    }
  }
}

async function processNewProductNotifications() {
  const products = await fb.getAllProducts(false);

  for (const [id, product] of Object.entries(products)) {
    if (!product.active || product.notifiedNewProduct) continue;
    // Only notify for products created in the last 2 minutes — protects
    // against re-notifying on bot restart for older products.
    if (!product.createdAt || Date.now() - product.createdAt > 2 * 60 * 1000) continue;

    await fb.updateProduct(id, { notifiedNewProduct: true });

    const users = await fb.getAllUsers();
    const userIds = Object.keys(users);
    const priceLabel = product.price === 0 ? 'FREE 🎁' : `₹${product.price}`;

    for (const uid of userIds) {
      try {
        await bot.telegram.sendMessage(
          uid,
          `🆕 *New Product Added!*\n\n✨ ${mdEscape(product.name)}\n💰 ${priceLabel}\n\n${mdEscape(product.description || '')}`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '👀 View Product', callback_data: `viewproduct_${id}` }]] } }
        );
      } catch (e) {}
      await new Promise(r => setTimeout(r, 50));
    }
    console.log(`🆕 New product notification sent for "${product.name}"`);
  }
}

setInterval(async () => {
  try { await processBroadcastQueue(); } catch (err) { console.error('Broadcast queue error:', err); }
}, 5000);

setInterval(async () => {
  try { await processDmQueue(); } catch (err) { console.error('DM queue error:', err); }
}, 5000);

setInterval(async () => {
  try { await processNewProductNotifications(); } catch (err) { console.error('Product notification error:', err); }
}, 10000);

// Closes a popup-style message by deleting it
bot.action('closepopup', async (ctx) => {
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch (e) {}
});

// ============ START SERVERS ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Webhook server running on port ${PORT}`));

// ============ GLOBAL ERROR HANDLER ============
// Without this, any unhandled error in a handler (bad data, network blip,
// etc.) fails completely silently — the user sees nothing happen at all,
// which is what caused "My Profile" to appear to do nothing. This ensures
// something is always shown, and logs the real error for debugging.

bot.catch(async (err, ctx) => {
  console.error('❌ Unhandled bot error:', err);
  try {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('⚠️ Something went wrong, please try again.', { show_alert: true });
    }
    await ctx.reply('⚠️ Kuch galat ho gaya. Please /start dobara karo ya thodi der baad try karo.');
  } catch (e) {
    // Even the fallback failed (e.g. user blocked bot) — nothing more we can do
  }
});

bot.launch().then(() => console.log('🤖 Bot started successfully'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
