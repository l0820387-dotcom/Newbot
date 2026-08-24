// ============================================================
// ADMIN PANEL (Telegram-based, replaces admin.html)
// ============================================================
// Everything the old web admin.html did is now available via /admin inside
// the bot itself — no browser, no Firebase client SDK, no separate hosting.
// All actions require the user's Telegram ID to be in ADMIN_TELEGRAM_IDS.

const { Markup } = require('telegraf');

function setupAdminPanel(bot, fb, mdEscape) {
  const adminState = {}; // { telegramId: { step, data } } — separate from user-facing userState

  // Full owners (ADMIN_TELEGRAM_IDS) always pass. Staff pass a lighter check
  // since their menu is filtered by permission — isAdmin() itself just gates
  // "can open the panel at all", not which buttons they see.
  function isAdmin(ctx) {
    return fb.isAdmin(ctx.from.id);
  }

  async function isAdminOrStaff(ctx) {
    if (fb.isAdmin(ctx.from.id)) return true;
    return await fb.isStaff(ctx.from.id);
  }

  async function isOwner(ctx) {
    return fb.isAdmin(ctx.from.id); // only full owners, never staff
  }

  // ============ MAIN ADMIN MENU ============

  bot.command('admin', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    delete adminState[ctx.from.id];
    await sendAdminMenu(ctx);
  });

  async function sendAdminMenu(ctx) {
    const owner = await isOwner(ctx);
    const perms = owner ? null : await fb.getStaffPermissions(ctx.from.id);
    const has = (p) => owner || perms.includes(p);

    const text = owner ? '🛠 *Admin Control Panel*\n\nChoose a section:' : '🛠 *Staff Panel*\n\nChoose a section:';
    const rows = [];
    if (has('products')) rows.push([Markup.button.callback('📦 Products', 'admin_products'), Markup.button.callback('🧾 Orders', 'admin_orders')]);
    if (has('users')) rows.push([Markup.button.callback('👥 Users', 'admin_users'), Markup.button.callback('↩️ Refunds', 'admin_refunds')]);
    if (has('coupons')) rows.push([Markup.button.callback('🎟 Coupons', 'admin_coupons'), Markup.button.callback('🔗 Referral', 'admin_referral')]);
    if (has('broadcast')) rows.push([Markup.button.callback('📢 Broadcast', 'admin_broadcast'), Markup.button.callback('📩 Direct Message', 'admin_dm')]);
    if (has('broadcast')) rows.push([Markup.button.callback('📜 Message History', 'admin_msghistory')]);
    if (owner) rows.push([Markup.button.callback('⚙️ Bot Settings', 'admin_settings'), Markup.button.callback('🔘 Menu Buttons', 'admin_menubuttons')]);
    if (owner) rows.push([Markup.button.callback('👑 Pro Plan', 'admin_proplan'), Markup.button.callback('🎯 Check-in', 'admin_checkin')]);
    if (has('products')) rows.push([Markup.button.callback('📊 Sales Report', 'admin_report'), Markup.button.callback('🏆 Leaderboard', 'admin_leaderboard')]);
    if (owner) rows.push([Markup.button.callback('🧑‍💼 Staff', 'admin_staff'), Markup.button.callback('💾 Backup Data', 'admin_backup')]);
    else if (has('products')) rows.push([Markup.button.callback('💾 Backup Data', 'admin_backup')]);

    const buttons = Markup.inlineKeyboard(rows);
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
    if (!(await isAdminOrStaff(ctx))) return;
    await ctx.answerCbQuery();
    delete adminState[ctx.from.id];
    await sendAdminMenu(ctx);
  });

  // ============ PRODUCTS ============

  bot.action('admin_products', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
    const productId = ctx.match[1];
    await ctx.answerCbQuery();
    const botInfo = await bot.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=PROD_${productId}`;
    await ctx.reply(`🔗 *Share Link*\n\n\`${link}\`\n\nTap to copy, or forward this message.`, { parse_mode: 'Markdown' });
  });

  bot.action(/^admin_delprod_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
    const productId = ctx.match[1];
    await fb.deleteProduct(productId);
    await ctx.answerCbQuery('🗑️ Deleted');
    await ctx.editMessageText('🗑️ Product deleted.', adminBackButton('admin_products'));
  });

  // ---- Add / Edit product flow (conversational) ----

  bot.action('admin_addproduct', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'prod_name', data: { isEdit: false } };
    await ctx.reply('📦 *Add Product*\n\nStep 1/8 — Product name?', { parse_mode: 'Markdown' });
  });

  bot.action(/^admin_editprod_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    const productId = ctx.match[1];
    const p = await fb.getProduct(productId);
    if (!p) return ctx.answerCbQuery('Not found.');
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'prod_name', data: { isEdit: true, productId, ...p } };
    await ctx.reply(`✏️ *Edit Product*\n\nCurrent name: ${mdEscape(p.name)}\n\nStep 1/8 — New name? (or send "skip" to keep current)`, { parse_mode: 'Markdown' });
  });

  // ============ ORDERS ============

  bot.action('admin_orders', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
    await ctx.answerCbQuery();
    await sendOrdersMenu(ctx, ctx.match[1]);
  });

  // ============ USERS ============

  bot.action('admin_users', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
    const telegramId = ctx.match[1];
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_wallet_amount', data: { telegramId } };
    await ctx.reply('💰 Enter new wallet balance (₹):');
  });

  bot.action(/^admin_banuser_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
// ============================================================
// ADMIN PANEL (Telegram-based, replaces admin.html)
// ============================================================
// Everything the old web admin.html did is now available via /admin inside
// the bot itself — no browser, no Firebase client SDK, no separate hosting.
// All actions require the user's Telegram ID to be in ADMIN_TELEGRAM_IDS.

const { Markup } = require('telegraf');

function setupAdminPanel(bot, fb, mdEscape) {
  const adminState = {}; // { telegramId: { step, data } } — separate from user-facing userState

  // Full owners (ADMIN_TELEGRAM_IDS) always pass. Staff pass a lighter check
  // since their menu is filtered by permission — isAdmin() itself just gates
  // "can open the panel at all", not which buttons they see.
  function isAdmin(ctx) {
    return fb.isAdmin(ctx.from.id);
  }

  async function isAdminOrStaff(ctx) {
    if (fb.isAdmin(ctx.from.id)) return true;
    return await fb.isStaff(ctx.from.id);
  }

  async function isOwner(ctx) {
    return fb.isAdmin(ctx.from.id); // only full owners, never staff
  }

  // ============ MAIN ADMIN MENU ============

  bot.command('admin', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    delete adminState[ctx.from.id];
    await sendAdminMenu(ctx);
  });

  async function sendAdminMenu(ctx) {
    const owner = await isOwner(ctx);
    const perms = owner ? null : await fb.getStaffPermissions(ctx.from.id);
    const has = (p) => owner || perms.includes(p);

    const text = owner ? '🛠 *Admin Control Panel*\n\nChoose a section:' : '🛠 *Staff Panel*\n\nChoose a section:';
    const rows = [];
    if (has('products')) rows.push([Markup.button.callback('📦 Products', 'admin_products'), Markup.button.callback('🧾 Orders', 'admin_orders')]);
    if (has('users')) rows.push([Markup.button.callback('👥 Users', 'admin_users'), Markup.button.callback('↩️ Refunds', 'admin_refunds')]);
    if (has('coupons')) rows.push([Markup.button.callback('🎟 Coupons', 'admin_coupons'), Markup.button.callback('🔗 Referral', 'admin_referral')]);
    if (has('broadcast')) rows.push([Markup.button.callback('📢 Broadcast', 'admin_broadcast'), Markup.button.callback('📩 Direct Message', 'admin_dm')]);
    if (has('broadcast')) rows.push([Markup.button.callback('📜 Message History', 'admin_msghistory')]);
    if (owner) rows.push([Markup.button.callback('⚙️ Bot Settings', 'admin_settings'), Markup.button.callback('🔘 Menu Buttons', 'admin_menubuttons')]);
    if (owner) rows.push([Markup.button.callback('👑 Pro Plan', 'admin_proplan'), Markup.button.callback('🎯 Check-in', 'admin_checkin')]);
    if (has('products')) rows.push([Markup.button.callback('📊 Sales Report', 'admin_report'), Markup.button.callback('🏆 Leaderboard', 'admin_leaderboard')]);
    if (owner) rows.push([Markup.button.callback('🧑‍💼 Staff', 'admin_staff'), Markup.button.callback('💾 Backup Data', 'admin_backup')]);
    else if (has('products')) rows.push([Markup.button.callback('💾 Backup Data', 'admin_backup')]);

    const buttons = Markup.inlineKeyboard(rows);
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
    if (!(await isAdminOrStaff(ctx))) return;
    await ctx.answerCbQuery();
    delete adminState[ctx.from.id];
    await sendAdminMenu(ctx);
  });

  // ============ PRODUCTS ============

  bot.action('admin_products', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
    const productId = ctx.match[1];
    await ctx.answerCbQuery();
    const botInfo = await bot.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=PROD_${productId}`;
    await ctx.reply(`🔗 *Share Link*\n\n\`${link}\`\n\nTap to copy, or forward this message.`, { parse_mode: 'Markdown' });
  });

  bot.action(/^admin_delprod_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
    const productId = ctx.match[1];
    await fb.deleteProduct(productId);
    await ctx.answerCbQuery('🗑️ Deleted');
    await ctx.editMessageText('🗑️ Product deleted.', adminBackButton('admin_products'));
  });

  // ---- Add / Edit product flow (conversational) ----

  bot.action('admin_addproduct', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'prod_name', data: { isEdit: false } };
    await ctx.reply('📦 *Add Product*\n\nStep 1/8 — Product name?', { parse_mode: 'Markdown' });
  });

  bot.action(/^admin_editprod_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    const productId = ctx.match[1];
    const p = await fb.getProduct(productId);
    if (!p) return ctx.answerCbQuery('Not found.');
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'prod_name', data: { isEdit: true, productId, ...p } };
    await ctx.reply(`✏️ *Edit Product*\n\nCurrent name: ${mdEscape(p.name)}\n\nStep 1/8 — New name? (or send "skip" to keep current)`, { parse_mode: 'Markdown' });
  });

  // ============ ORDERS ============

  bot.action('admin_orders', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
    await ctx.answerCbQuery();
    await sendOrdersMenu(ctx, ctx.match[1]);
  });

  // ============ USERS ============

  bot.action('admin_users', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
    const telegramId = ctx.match[1];
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_wallet_amount', data: { telegramId } };
    await ctx.reply('💰 Enter new wallet balance (₹):');
  });

  bot.action(/^admin_banuser_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    const telegramId = ctx.match[1];
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_ban_reason', data: { telegramId } };
    await ctx.reply('🚫 Ban reason:');
  });

  bot.action(/^admin_unban_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    const telegramId = ctx.match[1];
    await fb.unbanUser(telegramId);
    await ctx.answerCbQuery('✅ Unbanned');
    await ctx.reply(`✅ User ${telegramId} unbanned.`);
  });

  bot.action(/^admin_msguser_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    const telegramId = ctx.match[1];
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'dm_message', data: { telegramId } };
    await ctx.reply('📩 Type the message to send:');
  });

  // ============ REFUNDS ============

  bot.action('admin_refunds', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    await ctx.answerCbQuery();
    await sendRefundsList(ctx);
  });

  async function sendRefundsList(ctx) {
    const orders = await fb.getAllOrders();
    const pending = Object.entries(orders).filter(([, o]) => o.refundStatus === 'requested');

    let text = `↩️ *Pending Refund Requests* (${pending.length})\n\n`;
    if (pending.length === 0) text += '_No pending refund requests._';

    const buttons = pending.slice(0, 15).map(([id, o]) => [
      Markup.button.callback(`${o.productName} — ₹${o.amount} (${o.userId})`, `admin_refund_${id}`)
    ]);
    buttons.push([Markup.button.callback('⬅️ Back', 'admin_home')]);

    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
    catch (e) { await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
  }

  bot.action(/^admin_refund_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    const orderId = ctx.match[1];
    const order = await fb.getOrder(orderId);
    if (!order) return ctx.answerCbQuery('Not found.');
    await ctx.answerCbQuery();

    const text = `↩️ *Refund Request*\n\n📦 ${mdEscape(order.productName)}\n💰 ₹${order.amount}\n👤 User: \`${order.userId}\`\n📝 Reason: ${mdEscape(order.refundReason || 'not given')}`;
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Approve (refund to wallet)', `admin_approverefund_${orderId}`)],
        [Markup.button.callback('❌ Reject', `admin_rejectrefund_${orderId}`)],
        [Markup.button.callback('⬅️ Back', 'admin_refunds')]
      ])
    });
  });

  bot.action(/^admin_approverefund_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    const orderId = ctx.match[1];
    await fb.processRefund(orderId, true);
    await ctx.answerCbQuery('✅ Refund approved');
    await ctx.editMessageText('✅ Refund approved and credited to user\'s wallet.', adminBackButton('admin_refunds'));
  });

  bot.action(/^admin_rejectrefund_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    const orderId = ctx.match[1];
    await fb.processRefund(orderId, false);
    await ctx.answerCbQuery('❌ Refund rejected');
    await ctx.editMessageText('❌ Refund request rejected.', adminBackButton('admin_refunds'));
  });

  // ============ COUPONS ============

  bot.action('admin_coupons', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
    const code = ctx.match[1];
    const coupon = await fb.getCoupon(code);
    if (!coupon) return ctx.answerCbQuery('Not found.');
    await fb.toggleCoupon(code, !coupon.active);
    await ctx.answerCbQuery(coupon.active ? '🚫 Disabled' : '✅ Enabled');
    await sendCouponsList(ctx);
  });

  bot.action('admin_addcoupon', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'coupon_code', data: {} };
    await ctx.reply('🎟 *New Coupon*\n\nStep 1/4 — Coupon code? (e.g. WELCOME50)', { parse_mode: 'Markdown' });
  });

  // ============ REFERRAL SETTINGS ============

  bot.action('admin_referral', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    const settings = await fb.getReferralSettings();
    await ctx.reply(
      `🔗 *Referral Settings*\n\nBonus Type: ${settings.bonusType}\nBonus Amount: ${settings.bonusType === 'percent' ? settings.bonusAmount + '%' : '₹' + settings.bonusAmount}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit', 'admin_editreferral')], [Markup.button.callback('⬅️ Back', 'admin_home')]]) }
    );
  });

  bot.action('admin_editreferral', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'referral_type', data: {} };
    await ctx.reply('Bonus type? Reply "flat" (₹) or "percent" (%)', Markup.keyboard(['flat', 'percent']).oneTime().resize());
  });

  // ============ BROADCAST ============

  bot.action('admin_broadcast', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'bc_message', data: {} };
    await ctx.reply('📢 *Broadcast*\n\nType the message to send to all users:', { parse_mode: 'Markdown', ...adminBackButton('admin_home') });
  });

  // ============ DIRECT MESSAGE ============

  bot.action('admin_dm', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'dm_userid', data: {} };
    await ctx.reply('📩 *Direct Message*\n\nEnter the Telegram ID to message:', { parse_mode: 'Markdown', ...adminBackButton('admin_home') });
  });

  // ============ BOT SETTINGS ============

  bot.action('admin_settings', async (ctx) => {
    if (!(await isOwner(ctx))) return;
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
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_welcome_message' };
    await ctx.reply('✏️ Send the new welcome message. Use {name} for the user\'s first name:');
  });

  bot.action('admin_togglemaintenance', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const settings = await fb.getBotSettings();
    await fb.updateBotSettings({ maintenanceMode: !settings.maintenanceMode });
    await ctx.answerCbQuery(settings.maintenanceMode ? '🟢 Maintenance OFF' : '🔴 Maintenance ON');
  });

  bot.action('admin_channels', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    await sendChannelsMenu(ctx);
  });

  async function sendChannelsMenu(ctx) {
    const settings = await fb.getBotSettings();
    const channels = settings.channels || [];
    let text = '📢 *Required Channels*\n\n';
    if (channels.length === 0) text += '_None set._';

    const buttons = channels.map((c, i) => [
      Markup.button.callback(`${c.required ? '✅' : '⬜'} @${c.username}`, `admin_togglechannel_${i}`),
      Markup.button.callback('🗑', `admin_removechannel_${i}`)
    ]);
    buttons.push([Markup.button.callback('➕ Add Channel', 'admin_addchannel')]);
    buttons.push([Markup.button.callback('⬅️ Back', 'admin_settings')]);

    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
    catch (e) { await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
  }

  bot.action('admin_addchannel', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_channel_username', data: {} };
    await ctx.reply('Send a channel username (without @) to add it as required. Make sure the bot is an admin in that channel!');
  });

  bot.action(/^admin_togglechannel_(\d+)$/, async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const idx = parseInt(ctx.match[1]);
    const settings = await fb.getBotSettings();
    const channels = settings.channels || [];
    if (channels[idx]) channels[idx].required = !channels[idx].required;
    await fb.updateBotSettings({ channels });
    await ctx.answerCbQuery('Updated');
    await sendChannelsMenu(ctx);
  });

  bot.action(/^admin_removechannel_(\d+)$/, async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const idx = parseInt(ctx.match[1]);
    const settings = await fb.getBotSettings();
    const channels = settings.channels || [];
    channels.splice(idx, 1);
    await fb.updateBotSettings({ channels });
    await ctx.answerCbQuery('🗑️ Removed');
    await sendChannelsMenu(ctx);
  });

  bot.action('admin_setsupport', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_support_telegram', data: {} };
    await ctx.reply('💬 Send support Telegram username (without @), or "skip":');
  });

  // ============ MENU BUTTONS MANAGER ============

  const MENU_LABEL_KEYS = {
    profile: '👤 My Profile', browse: '🛍 Browse Products', free: '🎁 Free Products',
    proplan: '👑 Pro Plan', purchases: '📦 My Purchases', orders: '📋 Order Status',
    referrals: '🔗 My Referrals', stats: '📊 My Stats', paymenthistory: '🧾 Payment History',
    support: '📞 Support', language: '🌐 Hindi / English', checkin: '🎯 Daily Check-in',
    leaderboard: '🏆 Leaderboard'
  };

  bot.action('admin_menubuttons', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    await sendMenuButtonsMenu(ctx);
  });

  async function sendMenuButtonsMenu(ctx) {
    const settings = await fb.getBotSettings();
    const customButtons = settings.menuCustomButtons || [];

    let text = '🔘 *Menu Buttons Manager*\n\nRename any built-in button, or add unlimited custom link buttons to the main menu.';

    const buttons = [
      [Markup.button.callback('✏️ Rename Built-in Buttons', 'admin_renamebuttons')],
      [Markup.button.callback('➕ Add Custom Link Button', 'admin_addmenubutton')]
    ];
    customButtons.forEach((btn, i) => {
      buttons.push([Markup.button.callback(`🔗 ${btn.text}`, 'noop'), Markup.button.callback('🗑', `admin_removemenubutton_${i}`)]);
    });
    buttons.push([Markup.button.callback('⬅️ Back', 'admin_home')]);

    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
    catch (e) { await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
  }

  bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

  bot.action('admin_renamebuttons', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    const settings = await fb.getBotSettings();
    const labels = { ...MENU_LABEL_KEYS, ...(settings.menuLabels || {}) };

    const buttons = Object.keys(MENU_LABEL_KEYS).map(key => [Markup.button.callback(labels[key], `admin_renamebtn_${key}`)]);
    buttons.push([Markup.button.callback('⬅️ Back', 'admin_menubuttons')]);
    await ctx.reply('Tap a button to rename it:', Markup.inlineKeyboard(buttons));
  });

  bot.action(/^admin_renamebtn_(.+)$/, async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const key = ctx.match[1];
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_button_rename', data: { key } };
    await ctx.reply(`New label for this button? (include emoji if you want one)`);
  });

  bot.action('admin_addmenubutton', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'menubutton_text', data: {} };
    await ctx.reply('🔗 Button text? (e.g. "Join Community")');
  });

  bot.action(/^admin_removemenubutton_(\d+)$/, async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const idx = parseInt(ctx.match[1]);
    const settings = await fb.getBotSettings();
    const customButtons = settings.menuCustomButtons || [];
    customButtons.splice(idx, 1);
    await fb.updateBotSettings({ menuCustomButtons: customButtons });
    await ctx.answerCbQuery('🗑️ Removed');
    await sendMenuButtonsMenu(ctx);
  });

  // ============ DAILY CHECK-IN SETTINGS ============

  bot.action('admin_checkin', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    const settings = await fb.getCheckInSettings();
    await ctx.reply(
      `🎯 *Daily Check-in*\n\nStatus: ${settings.active ? '✅ Active' : '🚫 Disabled'}\nBase Reward: ₹${settings.rewardAmount}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(settings.active ? '🚫 Disable' : '✅ Enable', 'admin_togglecheckin')],
          [Markup.button.callback('✏️ Edit Reward', 'admin_editcheckinreward')],
          [Markup.button.callback('⬅️ Back', 'admin_home')]
        ])
      }
    );
  });

  bot.action('admin_togglecheckin', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const settings = await fb.getCheckInSettings();
    await fb.setCheckInSettings({ ...settings, active: !settings.active });
    await ctx.answerCbQuery(settings.active ? '🚫 Disabled' : '✅ Enabled');
  });

  bot.action('admin_editcheckinreward', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_checkin_reward', data: {} };
    await ctx.reply('💰 New base reward amount (₹)?');
  });

  // ============ MESSAGE HISTORY ============

  bot.action('admin_msghistory', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    await ctx.answerCbQuery();
    await ctx.reply('📜 *Message History*\n\nChoose which history to view:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📩 DM History', 'admin_dmhistory_0')],
        [Markup.button.callback('📢 Broadcast History', 'admin_bchistory_0')],
        [Markup.button.callback('⬅️ Back', 'admin_home')]
      ])
    });
  });

  bot.action(/^admin_dmhistory_(\d+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    const page = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    const queue = await fb.getDmQueue();
    const entries = Object.entries(queue).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
    const pageSize = 5;
    const pageItems = entries.slice(page * pageSize, (page + 1) * pageSize);

    let text = `📩 *DM History* (${entries.length} total)\n\n`;
    if (pageItems.length === 0) text += '_No messages yet._';
    const buttons = [];
    pageItems.forEach(([id, d]) => {
      const status = d.sent ? (d.success !== false ? '✅' : '❌') : '⏳';
      const seen = d.seen ? '👁' : '';
      text += `${status}${seen} \`${d.userId}\` — ${(d.message || '').slice(0, 40)}\n`;
      if (d.sentChatId && !d.deleted) buttons.push([Markup.button.callback(`🗑 Unsend to ${d.userId}`, `admin_unsenddm_${id}`)]);
    });
    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Prev', `admin_dmhistory_${page - 1}`));
    if ((page + 1) * pageSize < entries.length) navRow.push(Markup.button.callback('Next ➡️', `admin_dmhistory_${page + 1}`));
    if (navRow.length) buttons.push(navRow);
    buttons.push([Markup.button.callback('⬅️ Back', 'admin_msghistory')]);

    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
    catch (e) { await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
  });

  bot.action(/^admin_unsenddm_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    const id = ctx.match[1];
    await fb.updateDmEntry(id, { deleteRequested: true });
    await ctx.answerCbQuery('📤 Unsend requested — processing...');
  });

  bot.action(/^admin_bchistory_(\d+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    const page = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    const queue = await fb.getBroadcastQueue();
    const entries = Object.entries(queue).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
    const pageSize = 5;
    const pageItems = entries.slice(page * pageSize, (page + 1) * pageSize);

    let text = `📢 *Broadcast History* (${entries.length} total)\n\n`;
    if (pageItems.length === 0) text += '_No broadcasts yet._';
    const buttons = [];
    pageItems.forEach(([id, b]) => {
      const status = b.sent ? `✅ ${b.sentCount ?? 0}/${b.targetCount ?? '?'}` : '⏳ sending...';
      text += `${status} 👁${b.seenCount || 0} — ${(b.message || '').slice(0, 35)}\n`;
      if (b.sentMessages && !b.deleted) buttons.push([Markup.button.callback('🗑 Unsend from everyone', `admin_unsendbc_${id}`)]);
    });
    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Prev', `admin_bchistory_${page - 1}`));
    if ((page + 1) * pageSize < entries.length) navRow.push(Markup.button.callback('Next ➡️', `admin_bchistory_${page + 1}`));
    if (navRow.length) buttons.push(navRow);
    buttons.push([Markup.button.callback('⬅️ Back', 'admin_msghistory')]);

    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
    catch (e) { await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
  });

  bot.action(/^admin_unsendbc_(.+)$/, async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    const id = ctx.match[1];
    await fb.updateBroadcastEntry(id, { deleteRequested: true });
    await ctx.answerCbQuery('📤 Unsend requested — processing for all recipients...');
  });

  // ============ STAFF SYSTEM ============

  bot.action('admin_staff', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    await sendStaffMenu(ctx);
  });

  async function sendStaffMenu(ctx) {
    const staff = await fb.getAllStaff();
    const entries = Object.entries(staff);

    let text = `🧑‍💼 *Staff* (${entries.length})\n\nStaff can access Products, Orders, Users, Refunds, Coupons, Broadcast, and Message History — but not Bot Settings, Pro Plan, Menu Buttons, Check-in settings, or Staff management.\n\n`;
    if (entries.length === 0) text += '_No staff added yet._';
    entries.forEach(([id, s]) => { text += `👤 \`${id}\`\n`; });

    const buttons = [[Markup.button.callback('➕ Add Staff', 'admin_addstaff')]];
    entries.forEach(([id]) => buttons.push([Markup.button.callback(`🗑 Remove ${id}`, `admin_removestaff_${id}`)]));
    buttons.push([Markup.button.callback('⬅️ Back', 'admin_home')]);

    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
    catch (e) { await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
  }

  bot.action('admin_addstaff', async (ctx) => {
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'awaiting_staff_id', data: {} };
    await ctx.reply('🧑‍💼 Enter the Telegram ID to make staff:');
  });

  bot.action(/^admin_removestaff_(.+)$/, async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const id = ctx.match[1];
    await fb.removeStaff(id);
    await ctx.answerCbQuery('🗑️ Removed');
    await sendStaffMenu(ctx);
  });

  // ============ PRO PLAN ============

  bot.action('admin_proplan', async (ctx) => {
    if (!(await isOwner(ctx))) return;
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
    if (!(await isOwner(ctx))) return;
    await ctx.answerCbQuery();
    adminState[ctx.from.id] = { step: 'proplan_price', data: {} };
    await ctx.reply('👑 New price (₹)?');
  });

  // ============ SALES REPORT ============

  bot.action('admin_report', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
    await ctx.answerCbQuery();
    const weekly = await fb.getSalesReport(7);
    const monthly = await fb.getSalesReport(30);
    const text = `📊 *Sales Report*\n\n*Last 7 days:*\n💰 ₹${weekly.totalSales} — ${weekly.orderCount} orders\n${weekly.topProducts.join('\n')}\n\n*Last 30 days:*\n💰 ₹${monthly.totalSales} — ${monthly.orderCount} orders\n${monthly.topProducts.join('\n')}`;
    await ctx.reply(text, { parse_mode: 'Markdown', ...adminBackButton() });
  });

  // ============ LEADERBOARD ============

  bot.action('admin_leaderboard', async (ctx) => {
    if (!(await isAdminOrStaff(ctx))) return;
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
    if (!(await isAdminOrStaff(ctx))) return;
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

    // ---- Direct Message wizard: userid -> message -> image? -> file? -> button? -> popup? -> send
    if (state.step === 'dm_userid') {
      state.data.telegramId = text;
      state.step = 'dm_message';
      await ctx.reply('📩 Now type the message:');
      return true;
    }
    if (state.step === 'dm_message') {
      state.data.message = text;
      state.step = 'dm_image';
      await ctx.reply('🖼 Send a photo to attach (or type "skip"):');
      return true;
    }
    if (state.step === 'dm_image') {
      if (text.toLowerCase() === 'skip') {
        state.step = 'dm_file';
        await ctx.reply('📎 Send a file to attach (or type "skip"):');
        return true;
      }
      await ctx.reply('⚠️ Send a photo, or type "skip".');
      return true;
    }
    if (state.step === 'dm_file') {
      if (text.toLowerCase() === 'skip') {
        state.step = 'dm_button';
        await ctx.reply('🔗 Add a button? Send as `Button Text | https://url.com`, or type "skip":', { parse_mode: 'Markdown' });
        return true;
      }
      await ctx.reply('⚠️ Send a file, or type "skip".');
      return true;
    }
    if (state.step === 'dm_button') {
      if (text.toLowerCase() !== 'skip') {
        const parts = text.split('|').map(s => s.trim());
        if (parts.length === 2) { state.data.buttonText = parts[0]; state.data.buttonUrl = parts[1]; }
      }
      state.step = 'dm_popup';
      await ctx.reply('🔔 Send as popup notification (with a Close ❌ button)? Reply "yes" or "no":', Markup.keyboard(['yes', 'no']).oneTime().resize());
      return true;
    }
    if (state.step === 'dm_popup') {
      state.data.isPopup = text.toLowerCase() === 'yes';
      await fb.queueDm({
        userId: state.data.telegramId, message: state.data.message,
        imageIds: state.data.imageId ? [state.data.imageId] : null,
        fileIds: state.data.fileId ? [state.data.fileId] : null,
        buttonText: state.data.buttonText || null, buttonUrl: state.data.buttonUrl || null,
        isPopup: state.data.isPopup
      });
      delete adminState[ctx.from.id];
      await ctx.reply('📩 Message queued — sending shortly.', Markup.removeKeyboard());
      return true;
    }

    // ---- Broadcast wizard: message -> image? -> file? -> button? -> popup? -> send
    if (state.step === 'bc_message') {
      state.data.message = text;
      state.step = 'bc_image';
      await ctx.reply('🖼 Send a photo to attach (or type "skip"):');
      return true;
    }
    if (state.step === 'bc_image') {
      if (text.toLowerCase() === 'skip') {
        state.step = 'bc_file';
        await ctx.reply('📎 Send a file to attach (or type "skip"):');
        return true;
      }
      await ctx.reply('⚠️ Send a photo, or type "skip".');
      return true;
    }
    if (state.step === 'bc_file') {
      if (text.toLowerCase() === 'skip') {
        state.step = 'bc_button';
        await ctx.reply('🔗 Add a button? Send as `Button Text | https://url.com`, or type "skip":', { parse_mode: 'Markdown' });
        return true;
      }
      await ctx.reply('⚠️ Send a file, or type "skip".');
      return true;
    }
    if (state.step === 'bc_button') {
      if (text.toLowerCase() !== 'skip') {
        const parts = text.split('|').map(s => s.trim());
        if (parts.length === 2) { state.data.buttonText = parts[0]; state.data.buttonUrl = parts[1]; }
      }
      state.step = 'bc_popup';
      await ctx.reply('🔔 Send as popup notification (with a Close ❌ button)? Reply "yes" or "no":', Markup.keyboard(['yes', 'no']).oneTime().resize());
      return true;
    }
    if (state.step === 'bc_popup') {
      state.data.isPopup = text.toLowerCase() === 'yes';
      await fb.queueBroadcast({
        message: state.data.message,
        imageIds: state.data.imageId ? [state.data.imageId] : null,
        fileIds: state.data.fileId ? [state.data.fileId] : null,
        buttonText: state.data.buttonText || null, buttonUrl: state.data.buttonUrl || null,
        isPopup: state.data.isPopup
      });
      delete adminState[ctx.from.id];
      await ctx.reply('📢 Broadcast queued — sending to all users shortly.', Markup.removeKeyboard());
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

    // ---- Menu button rename ----
    if (state.step === 'awaiting_button_rename') {
      const settings = await fb.getBotSettings();
      const menuLabels = { ...(settings.menuLabels || {}) };
      menuLabels[state.data.key] = text;
      await fb.updateBotSettings({ menuLabels });
      delete adminState[ctx.from.id];
      await ctx.reply(`✅ Button renamed to "${text}"`);
      return true;
    }

    // ---- Add custom menu button wizard ----
    if (state.step === 'menubutton_text') {
      state.data.text = text;
      state.step = 'menubutton_url';
      await ctx.reply('🔗 Button URL?');
      return true;
    }
    if (state.step === 'menubutton_url') {
      const settings = await fb.getBotSettings();
      const customButtons = [...(settings.menuCustomButtons || []), { text: state.data.text, url: text }];
      await fb.updateBotSettings({ menuCustomButtons: customButtons });
      delete adminState[ctx.from.id];
      await ctx.reply(`✅ Custom button "${state.data.text}" added to main menu.`);
      return true;
    }

    // ---- Check-in reward edit ----
    if (state.step === 'awaiting_checkin_reward') {
      const amount = parseInt(text);
      if (isNaN(amount) || amount < 0) { await ctx.reply('⚠️ Valid amount daalo.'); return true; }
      const settings = await fb.getCheckInSettings();
      await fb.setCheckInSettings({ ...settings, rewardAmount: amount });
      delete adminState[ctx.from.id];
      await ctx.reply(`✅ Check-in reward set to ₹${amount}.`);
      return true;
    }

    // ---- Add staff ----
    if (state.step === 'awaiting_staff_id') {
      await fb.addStaff(text, ['products', 'orders', 'users', 'coupons', 'broadcast']);
      delete adminState[ctx.from.id];
      await ctx.reply(`✅ User \`${text}\` added as staff.`, { parse_mode: 'Markdown' });
      return true;
    }

    // ---- Referral settings wizard ----
    if (state.step === 'referral_type') {
      const type = text.toLowerCase();
      if (type !== 'flat' && type !== 'percent') { await ctx.reply('⚠️ Reply "flat" or "percent".'); return true; }
      state.data.bonusType = type;
      state.step = 'referral_amount';
      await ctx.reply(`Bonus amount? (${type === 'flat' ? '₹' : '%'})`, Markup.removeKeyboard());
      return true;
    }
    if (state.step === 'referral_amount') {
      const amount = parseInt(text);
      if (isNaN(amount)) { await ctx.reply('⚠️ Valid number daalo.'); return true; }
      await fb.setReferralSettings({ bonusType: state.data.bonusType, bonusAmount: amount });
      delete adminState[ctx.from.id];
      await ctx.reply(`✅ Referral bonus set: ${state.data.bonusType === 'percent' ? amount + '%' : '₹' + amount}`);
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
    const imageFileIds = d.imageFileIds && d.imageFileIds.length > 0 ? d.imageFileIds : (d.imageFileId ? [d.imageFileId] : []);
    const productData = {
      name: d.name, price: d.price, category: d.category,
      description: d.description || '', stock: d.stock,
      deliveryType: d.deliveryType,
      fileId: d.fileId || '',
      deliveryLink: d.deliveryLink || '',
      imageUrl: '',
      imageFileId: imageFileIds[0] || null,
      imageFileIds: imageFileIds.length > 0 ? imageFileIds : null
    };

    if (d.isEdit) {
      await fb.updateProduct(d.productId, productData);
      await ctx.reply(`✅ Product updated: *${mdEscape(d.name)}*${imageFileIds.length > 1 ? ` (${imageFileIds.length} images)` : ''}`, { parse_mode: 'Markdown' });
    } else {
      await fb.createProduct(productData);
      await ctx.reply(`✅ Product added: *${mdEscape(d.name)}*${imageFileIds.length > 1 ? ` (${imageFileIds.length} images)` : ''}\n\nUsers will be notified automatically! 🆕`, { parse_mode: 'Markdown' });
    }
    delete adminState[ctx.from.id];
  }

  // Called from bot.js's document/photo handlers when an admin is mid-wizard
  async function handleAdminDocument(ctx) {
    const state = adminState[ctx.from.id];
    if (!state) return false;

    if (state.step === 'prod_deliveryvalue' && state.data.deliveryType === 'file') {
      state.data.fileId = ctx.message.document.file_id;
      state.step = 'prod_image';
      await ctx.reply('✅ File saved.\n\nStep 8/8 — Send a product image (photo), or type "skip":');
      return true;
    }

    if (state.step === 'dm_file') {
      state.data.fileId = ctx.message.document.file_id;
      state.step = 'dm_button';
      await ctx.reply('✅ File attached.\n\n🔗 Add a button? Send as `Button Text | https://url.com`, or type "skip":', { parse_mode: 'Markdown' });
      return true;
    }
    if (state.step === 'bc_file') {
      state.data.fileId = ctx.message.document.file_id;
      state.step = 'bc_button';
      await ctx.reply('✅ File attached.\n\n🔗 Add a button? Send as `Button Text | https://url.com`, or type "skip":', { parse_mode: 'Markdown' });
      return true;
    }

    return false;
  }

  async function handleAdminPhoto(ctx) {
    const state = adminState[ctx.from.id];
    if (!state) return false;
    const sizes = ctx.message.photo;
    const fileId = sizes[sizes.length - 1].file_id;
    const mediaGroupId = ctx.message.media_group_id || null;

    if (state.step === 'prod_image') {
      // Telegram's multi-select photo picker sends each photo as a SEPARATE
      // message sharing the same media_group_id — not one message with many
      // photos. We collect them into an array and only finalize once, after
      // a short debounce window (so the last photo in the album has time to
      // arrive) instead of finalizing on the very first photo received.
      if (!state.data.imageFileIds) state.data.imageFileIds = [];
      state.data.imageFileIds.push(fileId);

      if (!mediaGroupId) {
        // Single photo, no album — finalize immediately as before.
        await finalizeProduct(ctx, state);
        return true;
      }

      // Part of an album — debounce so we catch all photos in the group
      // before creating the product once with every image attached.
      if (state.data._mediaGroupTimer) clearTimeout(state.data._mediaGroupTimer);
      state.data._mediaGroupId = mediaGroupId;
      state.data._mediaGroupTimer = setTimeout(async () => {
        if (!adminState[ctx.from.id]) return; // already finalized/cancelled
        await finalizeProduct(ctx, state);
      }, 1200);
      return true;
    }

    if (state.step === 'dm_image') {
      state.data.imageId = fileId;
      state.step = 'dm_file';
      await ctx.reply('✅ Photo attached.\n\n📎 Send a file to attach (or type "skip"):');
      return true;
    }
    if (state.step === 'bc_image') {
      state.data.imageId = fileId;
      state.step = 'bc_file';
      await ctx.reply('✅ Photo attached.\n\n📎 Send a file to attach (or type "skip"):');
      return true;
    }

    return false;
  }

  return { handleAdminText, handleAdminDocument, handleAdminPhoto, isAdmin, isAdminOrStaff, adminState };
}

module.exports = { setupAdminPanel };
