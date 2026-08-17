// ============================================================
// ADMIN PANEL (Telegram-based, replaces admin.html)
// ============================================================
// Everything the old web admin.html did is now available via /admin inside
// the bot itself — no browser, no Firebase client SDK, no separate hosting.
// All actions require the user's Telegram ID to be in ADMIN_TELEGRAM_IDS.

const { Markup } = require('telegraf');

function setupAdminPanel(bot, fb, mdEscape) {
  const adminState = {}; // { telegramId: { step, data } } — separate from user-facing userState

  function isAdmin(ctx) {
    return fb.isAdmin(ctx.from.id);
  }

  // ============ MAIN ADMIN MENU ============

  bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx)) return;
    delete adminState[ctx.from.id];
    await sendAdminMenu(ctx);
  });

  async function sendAdminMenu(ctx) {
    const text = '🛠 *Admin Control Panel*\n\nChoose a section:';
    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('📦 Products', 'admin_products'), Markup.button.callback('🧾 Orders', 'admin_orders')],
      [Markup.button.callback('👥 Users', 'admin_users'), Markup.button.callback('🎟 Coupons', 'admin_coupons')],
      [Markup.button.callback('📢 Broadcast', 'admin_broadcast'), Markup.button.callback('📩 Direct Message', 'admin_dm')],
      [Markup.button.callback('⚙️ Bot Settings', 'admin_settings'), Markup.button.callback('👑 Pro Plan', 'admin_proplan')],
      [Markup.button.callback('📊 Sales Report', 'admin_report'), Markup.button.callback('🏆 Leaderboard', 'admin_leaderboard')],
      [Markup.button.callback('💾 Backup Data', 'admin_backup')]
    ]);
    if (ctx.callbackQuery) {
      try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buttons }); return; }
      catch (e) { try { await ctx.deleteMessage(); } catch (e2) {} }
    }
    await ctx.reply(text, { parse_mode: 'Markdown', ...buttons });
  }

  function adminBackButton(target = 'admin_home') {
    return Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', target)]]);
  }

  bot.action('admin_home', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    delete adminState[ctx.from.id];
    await sendAdminMenu(ctx);
  });

  // ============ PRODUCTS ============

  bot.action('admin_products', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await sendProductsList(ctx);
  });

  async function sendProductsList(ctx) {
    const products = await fb.getAllProducts(false);
    const entries = Object.entries(products);

    let text = `📦 *Products* (${entries.length})\n\n`;
    if (entries.length === 0) {
      text += '_No products yet._';
    } else {
      entries.slice(0, 20).forEach(([id, p]) => {
        text += `${p.active ? '✅' : '🙈'} *${mdEscape(p.name)}* — ₹${p.price} | 👁 ${p.views || 0}${p.stock !== undefined && p.stock !== -1 ? ` | 📦 ${p.stock}` : ''}\n`;
      });
      if (entries.length > 20) text += `\n_...and ${entries.length - 20} more_`;
    }

    const buttons = [[Markup.button.callback('➕ Add Product', 'admin_addproduct')]];
    entries.slice(0, 20).forEach(([id, p]) => {
      buttons.push([Markup.button.callback(`✏️ ${p.name.slice(0, 25)}`, `admin_prod_${id}`)]);
    });
    buttons.push([Markup.button.callback('⬅️ Back', 'admin_home')]);

    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
    catch (e) { await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
  }

  bot.action(/^admin_prod_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const productId = ctx.match[1];
    const p = await fb.getProduct(productId);
    if (!p) return ctx.answerCbQuery('Product not found.');
    await ctx.answerCbQuery();

    const text = `📦 *${mdEscape(p.name)}*\n\n💰 ₹${p.price}\n📁 ${p.category}\n${p.deliveryType === 'file' ? '📎 File delivery' : '🔗 Link delivery'}\n📦 Stock: ${p.stock === -1 || p.stock === undefined ? 'Unlimited' : p.stock}\n👁 ${p.views || 0} views\n${p.active ? '✅ Active' : '🙈 Hidden'}\n\n${mdEscape(p.description || '')}`;

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Edit', `admin_editprod_${productId}`)],
      [Markup.button.callback(p.active ? '🙈 Hide' : '✅ Show', `admin_toggleprod_${productId}`)],
      [Markup.button.callback('🔗 Get Share Link', `admin_prodlink_${productId}`)],
      [Markup.button.callback('🗑 Delete', `admin_delprod_${productId}`)],
      [Markup.button.callback('⬅️ Back', 'admin_products')]
    ]);

    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buttons }); }
    catch (e) { await ctx.reply(text, { parse_mode: 'Markdown', ...buttons }); }
  });

  bot.action(/^admin_toggleprod_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const productId = ctx.match[1];
    const p = await fb.getProduct(productId);
    if (!p) return ctx.answerCbQuery('Not found.');
    await fb.updateProduct(productId, { active: !p.active });
    await ctx.answerCbQuery(p.active ? '🙈 Hidden' : '✅ Shown');
    const updated = await fb.getProduct(productId);
    const text = `📦 *${mdEscape(updated.name)}*\n\n💰 ₹${updated.price}\n${updated.active ? '✅ Active' : '🙈 Hidden'}`;
    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Edit', `admin_editprod_${productId}`)],
      [Markup.button.callback(updated.active ? '🙈 Hide' : '✅ Show', `admin_toggleprod_${productId}`)],
      [Markup.button.callback('🔗 Get Share Link', `admin_prodlink_${productId}`)],
      [Markup.button.callback('🗑 Delete', `admin_delprod_${productId}`)],
      [Markup.button.callback('⬅️ Back', 'admin_products')]
    ]);
    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buttons }); } catch (e) {}
  });

  bot.action(/^admin_prodlink_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const productId = ctx.match[1];
    await ctx.answerCbQuery();
    const botInfo = await bot.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=PROD_${productId}`;
    await ctx.reply(`🔗 *Share Link*\n\n\`${link}\`\n\nTap to copy, or forward this message.`, { parse_mode: 'Markdown' });
  });

  bot.action(/^admin_delprod_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const productId = ctx.match[1];
    const p = await fb.getProduct(productId);
    if (!p) return ctx.answerCbQuery('Not found.');

    const orders = await fb.getAllOrders();
    const orderCount = Object.values(orders).filter(o => o.productId === productId).length;

    await ctx.answerCbQuery();
    const warning = orderCount > 0
      ? `⚠️ *${orderCount} user(s) purchased this product.*\n\nTheir order history keeps the product name, but re-download uses a saved snapshot — deleting is generally safe. Delete anyway?`
      : `Delete "${mdEscape(p.name)}" permanently?`;

    await ctx.reply(warning, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Delete', `admin_confirmdelprod_${productId}`)],
        [Markup.button.callback('❌ Cancel', `admin_prod_${productId}`)]
      ])
    });
  });

  bot.action(/^admin_confirmdelprod_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const productId = ctx.match[1];
    await fb.deleteProduct(productId);
    await ctx.answerCbQuery('🗑️ Deleted');
    await ctx.editMessageText('🗑️ Product deleted.', adminBackButton('admin_products'));
  });

  // ---- Add / Edit product flow (conversational) ----

  bot.action('admin_addproduct', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'prod_name', data: { isEdit: false } };
    await ctx.reply('📦 *Add Product*\n\nStep 1/8 — Product name?', { parse_mode: 'Markdown' });
  });

  bot.action(/^admin_editprod_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const productId = ctx.match[1];
    const p = await fb.getProduct(productId);
    if (!p) return ctx.answerCbQuery('Not found.');
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'prod_name', data: { isEdit: true, productId, ...p } };
    await ctx.reply(`✏️ *Edit Product*\n\nCurrent name: ${mdEscape(p.name)}\n\nStep 1/8 — New name? (or send "skip" to keep current)`, { parse_mode: 'Markdown' });
  });

  // ============ ORDERS ============

  bot.action('admin_orders', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await sendOrdersMenu(ctx);
  });

  async function sendOrdersMenu(ctx, filter = 'all') {
    const orders = await fb.getAllOrders();
    let list = Object.entries(orders).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
    if (filter !== 'all') list = list.filter(([, o]) => o.status === filter);

    let text = `🧾 *Orders* (${list.length}${filter !== 'all' ? ` ${filter}` : ''})\n\n`;
    if (list.length === 0) {
      text += '_No orders in this category._';
    } else {
      list.slice(0, 15).forEach(([id, o]) => {
        const emoji = o.status === 'delivered' ? '✅' : o.status === 'pending' ? '⏳' : o.status === 'failed' ? '❌' : o.status === 'refunded' ? '↩️' : '🔄';
        text += `${emoji} ${mdEscape(o.productName)} — ₹${o.amount} _(${o.userId})_\n`;
      });
      if (list.length > 15) text += `\n_...and ${list.length - 15} more_`;
    }

    const buttons = Markup.inlineKeyboard([
      [
        Markup.button.callback('All', 'admin_orderf_all'),
        Markup.button.callback('✅ Success', 'admin_orderf_delivered'),
        Markup.button.callback('⏳ Pending', 'admin_orderf_pending')
      ],
      [
        Markup.button.callback('❌ Failed', 'admin_orderf_failed'),
        Markup.button.callback('↩️ Refunded', 'admin_orderf_refunded')
      ],
      [Markup.button.callback('⬅️ Back', 'admin_home')]
    ]);

    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buttons }); }
    catch (e) { await ctx.reply(text, { parse_mode: 'Markdown', ...buttons }); }
  }

  bot.action(/^admin_orderf_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await sendOrdersMenu(ctx, ctx.match[1]);
  });

  // ============ USERS ============

  bot.action('admin_users', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_user_lookup' };
    await ctx.reply('👥 *Users*\n\nSend a Telegram ID to view details, or use:\n/ban <id> <reason>\n/unban <id>\n/msg <id> <message>', {
      parse_mode: 'Markdown',
      ...adminBackButton('admin_home')
    });
  });

  async function sendUserDetails(ctx, telegramId) {
    const analytics = await fb.getUserAnalytics(telegramId);
    if (!analytics) return ctx.reply('⚠️ User not found.');

    const isVip = analytics.isVip && analytics.vipExpiresAt > Date.now();
    const text = `👤 *${mdEscape(analytics.name)}* ${analytics.username ? '(@' + mdEscape(analytics.username) + ')' : ''}\n\n` +
      `🆔 \`${telegramId}\`\n💰 Wallet: ₹${analytics.walletBalance || 0}\n📦 Orders: ${analytics.totalOrders} (${analytics.completedOrders} completed)\n💎 Total Spent: ₹${analytics.totalSpent}\n🔗 Referred: ${analytics.referredCount} users\n${isVip ? '👑 VIP Active' : '👤 Not VIP'}\n${analytics.banned ? '🚫 Banned' : '✅ Active'}`;

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💰 Adjust Wallet', `admin_wallet_${telegramId}`)],
        [analytics.banned ? Markup.button.callback('✅ Unban', `admin_unban_${telegramId}`) : Markup.button.callback('🚫 Ban', `admin_banuser_${telegramId}`)],
        [Markup.button.callback('📩 Message', `admin_msguser_${telegramId}`)],
        [Markup.button.callback('⬅️ Back', 'admin_home')]
      ])
    });
  }

  bot.action(/^admin_wallet_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const telegramId = ctx.match[1];
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_wallet_amount', data: { telegramId } };
    await ctx.reply('💰 Enter new wallet balance (₹):');
  });

  bot.action(/^admin_banuser_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const telegramId = ctx.match[1];
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_ban_reason', data: { telegramId } };
    await ctx.reply('🚫 Ban reason:');
  });

  bot.action(/^admin_unban_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const telegramId = ctx.match[1];
    await fb.unbanUser(telegramId);
    await ctx.answerCbQuery('✅ Unbanned');
    await ctx.reply(`✅ User ${telegramId} unbanned.`);
  });

  bot.action(/^admin_msguser_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const telegramId = ctx.match[1];
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_dm_message', data: { telegramId } };
    await ctx.reply('📩 Type the message to send:');
  });

  // ============ COUPONS ============

  bot.action('admin_coupons', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await sendCouponsList(ctx);
  });

  async function sendCouponsList(ctx) {
    const coupons = await fb.getAllCoupons();
    const entries = Object.entries(coupons);

    let text = `🎟 *Coupons* (${entries.length})\n\n`;
    entries.forEach(([code, c]) => {
      text += `${c.active ? '✅' : '🚫'} \`${code}\` — ${c.discountType === 'percent' ? c.discountValue + '%' : '₹' + c.discountValue} off (used ${c.usedCount || 0}${c.usageLimit ? '/' + c.usageLimit : ''})\n`;
    });
    if (entries.length === 0) text += '_No coupons yet._';

    const buttons = [[Markup.button.callback('➕ Create Coupon', 'admin_addcoupon')]];
    entries.forEach(([code]) => {
      buttons.push([Markup.button.callback(`${code}`, `admin_coupon_${code}`)]);
    });
    buttons.push([Markup.button.callback('⬅️ Back', 'admin_home')]);

    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
    catch (e) { await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
  }

  bot.action(/^admin_coupon_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const code = ctx.match[1];
    const coupon = await fb.getCoupon(code);
    if (!coupon) return ctx.answerCbQuery('Not found.');
    await ctx.answerCbQuery();
    await ctx.reply(`🎟 \`${code}\`\n\n${coupon.active ? '✅ Active' : '🚫 Disabled'}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(coupon.active ? '🚫 Disable' : '✅ Enable', `admin_togglecoupon_${code}`)],
        [Markup.button.callback('⬅️ Back', 'admin_coupons')]
      ])
    });
  });

  bot.action(/^admin_togglecoupon_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const code = ctx.match[1];
    const coupon = await fb.getCoupon(code);
    if (!coupon) return ctx.answerCbQuery('Not found.');
    await fb.toggleCoupon(code, !coupon.active);
    await ctx.answerCbQuery(coupon.active ? '🚫 Disabled' : '✅ Enabled');
    await sendCouponsList(ctx);
  });

  bot.action('admin_addcoupon', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'coupon_code', data: {} };
    await ctx.reply('🎟 *New Coupon*\n\nStep 1/4 — Coupon code? (e.g. WELCOME50)', { parse_mode: 'Markdown' });
  });

  // ============ BROADCAST ============

  bot.action('admin_broadcast', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'broadcast_message', data: {} };
    await ctx.reply('📢 *Broadcast*\n\nType the message to send to all users:', { parse_mode: 'Markdown', ...adminBackButton('admin_home') });
  });

  // ============ DIRECT MESSAGE ============

  bot.action('admin_dm', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'dm_userid', data: {} };
    await ctx.reply('📩 *Direct Message*\n\nEnter the Telegram ID to message:', { parse_mode: 'Markdown', ...adminBackButton('admin_home') });
  });

  // ============ BOT SETTINGS ============

  bot.action('admin_settings', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const settings = await fb.getBotSettings();
    const text = `⚙️ *Bot Settings*\n\n🛠 Maintenance: ${settings.maintenanceMode ? 'ON 🔴' : 'OFF 🟢'}\n📢 Required Channels: ${(settings.channels || []).filter(c => c.required).length}\n💬 Support TG: ${settings.supportTelegram ? '@' + mdEscape(settings.supportTelegram) : 'not set'}\n📱 Support WA: ${settings.supportWhatsapp || 'not set'}`;

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Welcome Message', 'admin_setwelcome')],
          [Markup.button.callback(settings.maintenanceMode ? '🟢 Disable Maintenance' : '🔴 Enable Maintenance', 'admin_togglemaintenance')],
          [Markup.button.callback('📢 Manage Channels', 'admin_channels')],
          [Markup.button.callback('💬 Set Support Info', 'admin_setsupport')],
          [Markup.button.callback('⬅️ Back', 'admin_home')]
        ])
      });
    } catch (e) { await ctx.reply(text, { parse_mode: 'Markdown' }); }
  });

  bot.action('admin_setwelcome', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_welcome_message' };
    await ctx.reply('✏️ Send the new welcome message. Use {name} for the user\'s first name:');
  });

  bot.action('admin_togglemaintenance', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const settings = await fb.getBotSettings();
    await fb.updateBotSettings({ maintenanceMode: !settings.maintenanceMode });
    await ctx.answerCbQuery(settings.maintenanceMode ? '🟢 Maintenance OFF' : '🔴 Maintenance ON');
  });

  bot.action('admin_channels', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const settings = await fb.getBotSettings();
    const channels = settings.channels || [];
    let text = '📢 *Required Channels*\n\n';
    channels.forEach((c, i) => { text += `${i + 1}. @${c.username} ${c.required ? '(required)' : '(optional)'}\n`; });
    if (channels.length === 0) text += '_None set._';

    adminState[ctx.from.id] = { step: 'awaiting_channel_username', data: {} };
    await ctx.reply(text + '\n\nSend a channel username (without @) to add it as required:', { parse_mode: 'Markdown', ...adminBackButton('admin_settings') });
  });

  bot.action('admin_setsupport', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_support_telegram', data: {} };
    await ctx.reply('💬 Send support Telegram username (without @), or "skip":');
  });

  // ============ PRO PLAN ============

  bot.action('admin_proplan', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const settings = await fb.getProPlanSettings();
    await ctx.reply(`👑 *Pro Plan Settings*\n\n💰 Price: ₹${settings.price}\n📅 Duration: ${settings.durationDays} days`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Edit', 'admin_editproplan')],
        [Markup.button.callback('⬅️ Back', 'admin_home')]
      ])
    });
  });

  bot.action('admin_editproplan', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'proplan_price', data: {} };
    await ctx.reply('👑 New price (₹)?');
  });

  // ============ SALES REPORT ============

  bot.action('admin_report', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const weekly = await fb.getSalesReport(7);
    const monthly = await fb.getSalesReport(30);
    const text = `📊 *Sales Report*\n\n*Last 7 days:*\n💰 ₹${weekly.totalSales} — ${weekly.orderCount} orders\n${weekly.topProducts.join('\n')}\n\n*Last 30 days:*\n💰 ₹${monthly.totalSales} — ${monthly.orderCount} orders\n${monthly.topProducts.join('\n')}`;
    await ctx.reply(text, { parse_mode: 'Markdown', ...adminBackButton() });
  });

  // ============ LEADERBOARD ============

  bot.action('admin_leaderboard', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const [buyers, referrers] = await Promise.all([fb.getTopBuyers(5), fb.getTopReferrers(5)]);
    let text = '🏆 *Leaderboard*\n\n💰 *Top Buyers*\n';
    buyers.forEach((b, i) => { text += `${i + 1}. ${mdEscape(b.name)} — ₹${b.totalSpent}\n`; });
    text += '\n🔗 *Top Referrers*\n';
    referrers.forEach((r, i) => { text += `${i + 1}. ${mdEscape(r.name)} — ${r.referralCount}\n`; });
    await ctx.reply(text, { parse_mode: 'Markdown', ...adminBackButton() });
  });

  // ============ BACKUP ============

  bot.action('admin_backup', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery('Generating backup...');
    const backup = fb.getFullBackup();
    const json = JSON.stringify(backup, null, 2);
    const buffer = Buffer.from(json, 'utf8');
    await ctx.replyWithDocument(
      { source: buffer, filename: `backup_${new Date().toISOString().slice(0, 10)}.json` },
      { caption: '💾 Full data backup. Keep this safe — local storage is wiped on every redeploy!' }
    );
  });

  // ============ SHARED TEXT HANDLER FOR ALL WIZARDS ============
  // Returns true if it handled the message (so bot.js's own text handler
  // knows to skip its own processing for this update).

  async function handleAdminText(ctx) {
    const state = adminState[ctx.from.id];
    if (!state || !isAdmin(ctx)) return false;

    const text = ctx.message.text.trim();

    // ---- Product add/edit wizard ----
    if (state.step && state.step.startsWith('prod_')) {
      return handleProductWizard(ctx, state, text);
    }

    // ---- Coupon creation wizard ----
    if (state.step && state.step.startsWith('coupon_')) {
      return handleCouponWizard(ctx, state, text);
    }

    // ---- Pro Plan edit wizard ----
    if (state.step === 'proplan_price') {
      const price = parseInt(text);
      if (isNaN(price)) { await ctx.reply('⚠️ Valid number daalo.'); return true; }
      state.data.price = price;
      state.step = 'proplan_duration';
      await ctx.reply('📅 Duration (days)?');
      return true;
    }
    if (state.step === 'proplan_duration') {
      const days = parseInt(text);
      if (isNaN(days)) { await ctx.reply('⚠️ Valid number daalo.'); return true; }
      await fb.setProPlanSettings({ price: state.data.price, durationDays: days, active: true });
      delete adminState[ctx.from.id];
      await ctx.reply(`✅ Pro Plan updated: ₹${state.data.price} for ${days} days.`);
      return true;
    }

    // ---- Simple single-step flows ----
    if (state.step === 'awaiting_wallet_amount') {
      const amount = parseInt(text);
      if (isNaN(amount) || amount < 0) { await ctx.reply('⚠️ Valid amount daalo.'); return true; }
      const users = await fb.getAllUsers();
      const current = users[state.data.telegramId]?.walletBalance || 0;
      const delta = amount - current;
      if (delta > 0) await fb.creditWallet(state.data.telegramId, delta, 'admin_adjustment');
      else if (delta < 0) await fb.debitWallet(state.data.telegramId, -delta, 'admin_adjustment').catch(() => {});
      delete adminState[ctx.from.id];
      await ctx.reply(`✅ Wallet set to ₹${amount}.`);
      return true;
    }

    if (state.step === 'awaiting_ban_reason') {
      await fb.banUser(state.data.telegramId, text);
      delete adminState[ctx.from.id];
      await ctx.reply(`🚫 User ${state.data.telegramId} banned.\nReason: ${text}`);
      return true;
    }

    if (state.step === 'awaiting_dm_message') {
      await fb.queueDm({ userId: state.data.telegramId, message: text });
      delete adminState[ctx.from.id];
      await ctx.reply('📩 Message queued — sending shortly.');
      return true;
    }

    if (state.step === 'broadcast_message') {
      await fb.queueBroadcast({ message: text });
      delete adminState[ctx.from.id];
      await ctx.reply('📢 Broadcast queued — sending to all users shortly.');
      return true;
    }

    if (state.step === 'dm_userid') {
      state.data.telegramId = text;
      state.step = 'dm_message';
      await ctx.reply('📩 Now type the message:');
      return true;
    }
    if (state.step === 'dm_message') {
      await fb.queueDm({ userId: state.data.telegramId, message: text });
      delete adminState[ctx.from.id];
      await ctx.reply('📩 Message queued.');
      return true;
    }

    if (state.step === 'awaiting_welcome_message') {
      await fb.updateBotSettings({ welcomeMessage: text });
      delete adminState[ctx.from.id];
      await ctx.reply('✅ Welcome message updated.');
      return true;
    }

    if (state.step === 'awaiting_channel_username') {
      const settings = await fb.getBotSettings();
      const channels = settings.channels || [];
      const username = text.replace('@', '');
      channels.push({ username, label: username, required: true });
      await fb.updateBotSettings({ channels });
      delete adminState[ctx.from.id];
      await ctx.reply(`✅ Channel @${username} added as required. Make sure the bot is an admin in that channel!`);
      return true;
    }

    if (state.step === 'awaiting_support_telegram') {
      if (text.toLowerCase() !== 'skip') {
        await fb.updateBotSettings({ supportTelegram: text.replace('@', '') });
      }
      state.step = 'awaiting_support_whatsapp';
      await ctx.reply('📱 Send support WhatsApp number (with country code), or "skip":');
      return true;
    }
    if (state.step === 'awaiting_support_whatsapp') {
      if (text.toLowerCase() !== 'skip') {
        await fb.updateBotSettings({ supportWhatsapp: text.replace(/[^0-9]/g, '') });
      }
      delete adminState[ctx.from.id];
      await ctx.reply('✅ Support info updated.');
      return true;
    }

    if (state.step === 'awaiting_user_lookup') {
      delete adminState[ctx.from.id];
      await sendUserDetails(ctx, text);
      return true;
    }

    return false;
  }

  // ---- Coupon creation wizard ----
  async function handleCouponWizard(ctx, state, text) {
    switch (state.step) {
      case 'coupon_code':
        state.data.code = text.toUpperCase();
        state.step = 'coupon_type';
        await ctx.reply('Step 2/4 — Discount type? Reply "flat" (₹ amount) or "percent" (%)', Markup.keyboard(['flat', 'percent']).oneTime().resize());
        return true;

      case 'coupon_type': {
        const type = text.toLowerCase();
        if (type !== 'flat' && type !== 'percent') { await ctx.reply('⚠️ Reply "flat" or "percent".'); return true; }
        state.data.discountType = type;
        state.step = 'coupon_value';
        await ctx.reply(`Step 3/4 — Discount value? (${type === 'flat' ? '₹ amount' : '% amount'})`, Markup.removeKeyboard());
        return true;
      }

      case 'coupon_value': {
        const value = parseInt(text);
        if (isNaN(value)) { await ctx.reply('⚠️ Valid number daalo.'); return true; }
        state.data.discountValue = value;
        state.step = 'coupon_limit';
        await ctx.reply('Step 4/4 — Usage limit? (number, or "unlimited")');
        return true;
      }

      case 'coupon_limit': {
        const limit = text.toLowerCase() === 'unlimited' ? null : parseInt(text);
        await fb.createCoupon(state.data.code, {
          discountType: state.data.discountType,
          discountValue: state.data.discountValue,
          usageLimit: isNaN(limit) ? null : limit,
          minAmount: 0
        });
        delete adminState[ctx.from.id];
        await ctx.reply(`✅ Coupon \`${state.data.code}\` created!`, { parse_mode: 'Markdown' });
        return true;
      }

      default:
        return false;
    }
  }

  // ---- Product add/edit wizard steps ----
  async function handleProductWizard(ctx, state, text) {
    const skip = text.toLowerCase() === 'skip' && state.data.isEdit;

    switch (state.step) {
      case 'prod_name':
        if (!skip) state.data.name = text;
        state.step = 'prod_price';
        await ctx.reply(`Step 2/8 — Price (₹, 0 for free)?${state.data.isEdit ? ` Current: ${state.data.price}` : ''}`);
        return true;

      case 'prod_price': {
        if (!skip) {
          const price = parseInt(text);
          if (isNaN(price)) { await ctx.reply('⚠️ Valid number daalo.'); return true; }
          state.data.price = price;
        }
        state.step = 'prod_category';
        await ctx.reply(`Step 3/8 — Category?${state.data.isEdit ? ` Current: ${state.data.category}` : ''}`);
        return true;
      }

      case 'prod_category':
        if (!skip) state.data.category = text;
        state.step = 'prod_description';
        await ctx.reply('Step 4/8 — Description? (or "skip")');
        return true;

      case 'prod_description':
        if (text.toLowerCase() !== 'skip') state.data.description = text;
        state.step = 'prod_stock';
        await ctx.reply('Step 5/8 — Stock quantity? (-1 for unlimited)');
        return true;

      case 'prod_stock': {
        const stock = parseInt(text);
        state.data.stock = isNaN(stock) ? -1 : stock;
        state.step = 'prod_deliverytype';
        await ctx.reply('Step 6/8 — Delivery type? Reply "file" or "link"', Markup.keyboard(['file', 'link']).oneTime().resize());
        return true;
      }

      case 'prod_deliverytype': {
        const type = text.toLowerCase();
        if (type !== 'file' && type !== 'link') { await ctx.reply('⚠️ Reply "file" or "link".'); return true; }
        state.data.deliveryType = type;
        state.step = 'prod_deliveryvalue';
        if (type === 'file') {
          await ctx.reply('Step 7/8 — Now send the FILE (as document) you want delivered:', Markup.removeKeyboard());
        } else {
          await ctx.reply('Step 7/8 — Send the download link (URL):', Markup.removeKeyboard());
        }
        return true;
      }

      case 'prod_deliveryvalue':
        if (state.data.deliveryType === 'link') {
          state.data.deliveryLink = text;
          state.step = 'prod_image';
          await ctx.reply('Step 8/8 — Send a product image (photo), or type "skip":');
          return true;
        }
        await ctx.reply('⚠️ Please send the file as a document, not text.');
        return true;

      case 'prod_image':
        if (text.toLowerCase() === 'skip') {
          await finalizeProduct(ctx, state);
          return true;
        }
        await ctx.reply('⚠️ Send a photo, or type "skip".');
        return true;

      default:
        return false;
    }
  }

  async function finalizeProduct(ctx, state) {
    const d = state.data;
    const productData = {
      name: d.name, price: d.price, category: d.category,
      description: d.description || '', stock: d.stock,
      deliveryType: d.deliveryType,
      fileId: d.fileId || '',
      deliveryLink: d.deliveryLink || '',
      imageUrl: '',
      imageFileId: d.imageFileId || null
    };

    if (d.isEdit) {
      await fb.updateProduct(d.productId, productData);
      await ctx.reply(`✅ Product updated: *${mdEscape(d.name)}*`, { parse_mode: 'Markdown' });
    } else {
      await fb.createProduct(productData);
      await ctx.reply(`✅ Product added: *${mdEscape(d.name)}*\n\nUsers will be notified automatically! 🆕`, { parse_mode: 'Markdown' });
    }
    delete adminState[ctx.from.id];
  }

  // Called from bot.js's document/photo handlers when an admin is mid-wizard
  async function handleAdminDocument(ctx) {
    const state = adminState[ctx.from.id];
    if (!state || state.step !== 'prod_deliveryvalue' || state.data.deliveryType !== 'file') return false;
    state.data.fileId = ctx.message.document.file_id;
    state.step = 'prod_image';
    await ctx.reply('✅ File saved.\n\nStep 8/8 — Send a product image (photo), or type "skip":');
    return true;
  }

  async function handleAdminPhoto(ctx) {
    const state = adminState[ctx.from.id];
    if (!state || state.step !== 'prod_image') return false;
    const sizes = ctx.message.photo;
    state.data.imageFileId = sizes[sizes.length - 1].file_id;
    await finalizeProduct(ctx, state);
    return true;
  }

  return { handleAdminText, handleAdminDocument, handleAdminPhoto, isAdmin, adminState };
}

module.exports = { setupAdminPanel };
