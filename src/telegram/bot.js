// ============================================================================
// Telegram 传输层 —— long polling（无需公网 URL/域名/备案，只出不进）
// 与企业微信/Discord 并存，复用同一个 onMessage（→ runAgent）。
//
// 简化设计：
// - 普通文字消息 → 直接发 onMessage（agentCore 处理一切：钓点查询/添加/分析）
// - 裸坐标文本 或 Telegram Location 消息 → 弹 8 按钮（4 中 + 4 英）
// - 用户点按钮 → 构造自然语言发 onMessage
// - 语言由用户点的按钮决定（中文按钮=中文，英文按钮=英文）
// - 不做语言检测/记忆、不调 executeTool、不依赖 spotFormat.js
// ============================================================================
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

/** 坐标缓存 { [token]: { lat, lng, chatId, userId, ts } } */
const coordCache = new Map();
/** 等待用户输入"名字, 备注" { [chatId_userId]: { lat, lng, lang, ts } } */
const pendingAddSpot = new Map();

const COORD_TTL_MS = 14 * 60 * 1000; // 14 分钟过期
const PENDING_TTL_MS = 3 * 60 * 1000; // 3 分钟超时
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const api = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

/**
 * 检测文本是否为裸坐标（如 "41.48, -71.33" / "(41.48, -71.33)" / "41.48 -71.33"）。
 * 至少一侧带小数点（避免 "1 2" 误判）。
 */
function parseRawCoords(text) {
  const m = String(text).match(/^\s*\(?(-?\d+\.?\d*)\s*[,\s]\s*(-?\d+\.?\d*)\)?\s*$/);
  if (!m) return null;
  if (!m[1].includes('.') && !m[2].includes('.')) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** 白名单判定：allowed 为空 = 开放；否则用户名或 id 命中才放行 */
function isAllowed(username, uid) {
  const allowed = config.telegram.allowed;
  if (!allowed.length) return true;
  const u = String(username ?? '').toLowerCase();
  const id = String(uid ?? '');
  return (!!u && allowed.includes(u)) || (!!id && allowed.includes(id));
}

/** 管理员判定 */
function isAdmin(username, uid) {
  const u = String(username ?? '').toLowerCase();
  const id = String(uid ?? '');
  return (
    (!!u && config.admins.includes(`tg_${u}`)) ||
    (!!id && config.admins.includes(`tg_${id}`))
  );
}

/**
 * 构建坐标操作菜单的 8 按钮（4 中 + 4 英），只有管理员能看到"添加钓点"。
 */
function buildCoordButtons(token, showAdd) {
  const buttons = [];
  // 中文按钮
  if (showAdd) buttons.push([{ text: '📍 添加钓点', callback_data: `c_${token}_add_zh` }]);
  buttons.push(
    [{ text: '🔍 查询现在', callback_data: `c_${token}_now_zh` }],
    [{ text: '📊 查询今天', callback_data: `c_${token}_today_zh` }],
    [{ text: '📅 查询明天', callback_data: `c_${token}_tomorrow_zh` }],
  );
  // 英文按钮
  if (showAdd) buttons.push([{ text: '📍 Add Fishing Spot', callback_data: `c_${token}_add_en` }]);
  buttons.push(
    [{ text: '🔍 Check Current Condition', callback_data: `c_${token}_now_en` }],
    [{ text: '📊 Check Today Condition', callback_data: `c_${token}_today_en` }],
    [{ text: '📅 Check Tomorrow Condition', callback_data: `c_${token}_tomorrow_en` }],
  );
  return buttons;
}

/**
 * 启动 Telegram bot。未配置 token 则跳过并返回 null。
 */
export function startTelegram({ onMessage } = {}) {
  const token = config.telegram.token;
  if (!token) {
    console.log('[tg] 未配置 TELEGRAM_BOT_TOKEN，跳过 Telegram 传输');
    return null;
  }
  if (typeof onMessage !== 'function') throw new Error('startTelegram 需要 onMessage 处理函数');

  let offset = 0;
  let running = true;

  // 定期清理过期缓存
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of coordCache) if (now - v.ts > COORD_TTL_MS) coordCache.delete(k);
    for (const [k, v] of pendingAddSpot) if (now - v.ts > PENDING_TTL_MS) pendingAddSpot.delete(k);
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  // ---- Telegram API helpers ----
  async function call(method, body, isForm = false) {
    const opts = { method: 'POST' };
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(api(token, method), opts);
    const data = await res.json();
    if (!data.ok) throw new Error(`${method} 失败: ${data.description || res.status}`);
    return data.result;
  }

  const sendMessage = (chatId, text, extra = {}) =>
    call('sendMessage', { chat_id: chatId, text: String(text || '').slice(0, 4096), ...extra });

  async function sendLongMessage(chatId, text, extra = {}) {
    const chunks = splitText(String(text || '') || '(无内容)', 4096);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await sendMessage(chatId, chunks[i], isLast ? extra : {});
    }
  }

  const sendDocument = (chatId, filename, content) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([content], { type: 'text/plain' }), filename);
    return call('sendDocument', form, true);
  };

  // ---- 导航按钮 ----
  function navMarkup(coordinates, lang) {
    if (!coordinates || coordinates.latitude == null || coordinates.longitude == null) return {};
    const label = lang === 'zh' ? '📍 开始出发咯！钓鱼佬' : "📍 Let's roll, fish bum!";
    const url = `https://www.google.com/maps/dir/?api=1&destination=${coordinates.latitude},${coordinates.longitude}`;
    return { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: label, url }]] }) };
  }

  // ---- 处理坐标：弹 8 按钮 ----
  function handleCoords(chatId, lat, lng, username, uid) {
    const cacheToken = randomUUID().slice(0, 8);
    coordCache.set(cacheToken, { lat, lng, chatId: String(chatId), userId: String(uid), ts: Date.now() });
    const showAdd = isAdmin(username, uid);
    const title = `📍 (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
    return sendMessage(chatId, title, {
      reply_markup: JSON.stringify({ inline_keyboard: buildCoordButtons(cacheToken, showAdd) }),
    });
  }

  // ---- 处理 update ----
  async function handle(update) {
    // ==== 按钮回调 ====
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data || '';
      const cbChatId = cb.message?.chat?.id;
      if (!cbChatId) {
        call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
        return;
      }

      // ---- 钓点选择按钮: spot_<id>_<lang> ----
      if (data.startsWith('spot_')) {
        const parts = data.split('_'); // ['spot', id, lang]
        const spotId = Number(parts[1]);
        const lang = parts[2] || 'en';
        const username = cb.from?.username || '';
        const uid = String(cb.from?.id || '');
        const adminFlag = isAdmin(username, uid);

        if (!Number.isFinite(spotId) || spotId <= 0) {
          call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
          return;
        }

        const analyzing = lang === 'zh' ? '正在分析...' : 'Analyzing...';
        call('answerCallbackQuery', { callback_query_id: cb.id, text: analyzing }).catch(() => {});
        call('sendChatAction', { chat_id: cbChatId, action: 'typing' }).catch(() => {});

        try {
          // 用 spot id 查名字,构造自然语言查询
          const { findCoordinateById } = await import('../db/coordinates.js');
          const spot = await findCoordinateById(spotId);
          if (!spot) {
            const msg = lang === 'zh' ? '钓点未找到，可能已被删除。' : 'Spot not found, it may have been deleted.';
            await sendMessage(cbChatId, msg);
            return;
          }
          const queryText = lang === 'zh'
            ? `${spot.name} 今天怎么样?`
            : `${spot.name} how is it today?`;
          const result = await onMessage({ text: queryText, userId: username || uid, chatId: String(cbChatId), isAdmin: adminFlag, lang });
          await sendReply(cbChatId, result, lang);
        } catch (err) {
          console.error('[tg] 钓点按钮异常:', err?.message || err);
          const errMsg = lang === 'zh' ? '抱歉，处理时出错了。' : 'Sorry, something went wrong.';
          await sendMessage(cbChatId, errMsg).catch(() => {});
        }
        return;
      }

      // 格式: c_<token>_<action>_<lang>
      if (!data.startsWith('c_')) {
        call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
        return;
      }

      const parts = data.split('_'); // ['c', token, action, lang]
      const cacheToken = parts[1];
      const action = parts[2]; // 'add' | 'now' | 'today' | 'tomorrow'
      const lang = parts[3] || 'en'; // 'zh' | 'en'
      const username = cb.from?.username || '';
      const uid = String(cb.from?.id || '');

      const cached = coordCache.get(cacheToken);
      if (!cached) {
        const msg = lang === 'zh' ? '坐标已过期，请重新发送。' : 'Coordinates expired, send them again.';
        call('answerCallbackQuery', { callback_query_id: cb.id, text: msg }).catch(() => {});
        return;
      }

      // 只有发坐标的本人能操作
      if (cached.userId !== uid) {
        const msg = lang === 'zh' ? '这不是你的坐标菜单。' : "This isn't your menu.";
        call('answerCallbackQuery', { callback_query_id: cb.id, text: msg }).catch(() => {});
        return;
      }

      const adminFlag = isAdmin(username, uid);
      const coordStr = `(${cached.lat}, ${cached.lng})`;

      // ---- 添加钓点 ----
      if (action === 'add') {
        if (!adminFlag) {
          const msg = lang === 'zh' ? '只有管理员能添加钓点。' : 'Admins only.';
          call('answerCallbackQuery', { callback_query_id: cb.id, text: msg }).catch(() => {});
          return;
        }
        call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
        const prompt = lang === 'zh'
          ? `请输入钓点名称和备注，格式：\n名字, 备注\n\n例如: Fort Adams, 石头堤坝尽头\n\n坐标: ${coordStr}`
          : `Send the spot name and an optional note:\nName, Note\n\ne.g. Fort Adams, end of the rock jetty\n\nCoords: ${coordStr}`;
        await sendMessage(cbChatId, prompt);
        pendingAddSpot.set(`${cbChatId}_${uid}`, { lat: cached.lat, lng: cached.lng, lang, ts: Date.now() });
        return;
      }

      // ---- 查询操作 ----
      const analyzing = lang === 'zh' ? '正在分析...' : 'Analyzing...';
      call('answerCallbackQuery', { callback_query_id: cb.id, text: analyzing }).catch(() => {});
      call('sendChatAction', { chat_id: cbChatId, action: 'typing' }).catch(() => {});

      let queryText;
      if (lang === 'zh') {
        if (action === 'now') queryText = `查询${coordStr}现况`;
        else if (action === 'today') queryText = `查询${coordStr}今天状况`;
        else queryText = `查询${coordStr}明天状况`;
      } else {
        if (action === 'now') queryText = `Check current condition at ${coordStr}`;
        else if (action === 'today') queryText = `Check today's condition at ${coordStr}`;
        else queryText = `Check tomorrow's condition at ${coordStr}`;
      }

      try {
        const result = await onMessage({ text: queryText, userId: username || uid, chatId: String(cbChatId), isAdmin: adminFlag, lang });
        await sendReply(cbChatId, result, lang);
      } catch (err) {
        console.error('[tg] 按钮查询异常:', err?.message || err);
        const errMsg = lang === 'zh' ? '抱歉，处理时出错了。' : 'Sorry, something went wrong.';
        await sendMessage(cbChatId, errMsg).catch(() => {});
      }
      return;
    }

    // ==== 普通消息 ====
    const msg = update.message || update.edited_message;
    const chatId = msg?.chat?.id;
    if (chatId == null) return;
    const username = msg?.from?.username || '';
    const uid = String(msg?.from?.id || '');
    const who = username || uid;

    // ---- Location 消息 → 弹按钮 ----
    if (msg?.location) {
      const { latitude: lat, longitude: lng } = msg.location;
      console.log(`[tg] 收到来自 ${who} 的位置: ${lat}, ${lng}`);
      if (!isAllowed(username, uid)) {
        await sendMessage(chatId, denyText(username, uid)).catch(() => {});
        return;
      }
      // 新坐标取消上一轮 pending
      pendingAddSpot.delete(`${chatId}_${uid}`);
      await handleCoords(chatId, lat, lng, username, uid);
      return;
    }

    const text = msg?.text?.trim();
    if (!text) return;
    console.log(`[tg] 收到来自 ${who} (id=${uid}) 的消息: ${text}`);

    // 白名单
    if (!isAllowed(username, uid)) {
      console.log(`[tg] 拒绝(不在白名单): ${who} id=${uid}`);
      await sendMessage(chatId, denyText(username, uid)).catch(() => {});
      return;
    }

    const adminFlag = isAdmin(username, uid);
    const pendingKey = `${chatId}_${uid}`;

    // ---- 裸坐标 → 弹按钮（排在 pending 检查之前） ----
    const rawCoords = parseRawCoords(text);
    if (rawCoords) {
      console.log(`[tg] 裸坐标识别: ${rawCoords.lat}, ${rawCoords.lng}`);
      pendingAddSpot.delete(pendingKey);
      await handleCoords(chatId, rawCoords.lat, rawCoords.lng, username, uid);
      return;
    }

    // ---- 检查 pending 添加钓点 ----
    const pending = pendingAddSpot.get(pendingKey);
    if (pending) {
      pendingAddSpot.delete(pendingKey);
      if (Date.now() - pending.ts > PENDING_TTL_MS) {
        const timeoutMsg = pending.lang === 'zh'
          ? '添加钓点已超时取消（3 分钟），请重新发送坐标。'
          : 'Add-spot timed out (3 min). Send the coordinates again.';
        await sendMessage(chatId, timeoutMsg);
        return;
      }
      // 解析 "名字, 备注"
      const commaIdx = Math.min(
        ...[text.indexOf(','), text.indexOf('，')].filter((i) => i > 0).concat([Infinity])
      );
      const spotName = (commaIdx < Infinity ? text.slice(0, commaIdx) : text).trim();
      const spotNote = commaIdx < Infinity ? text.slice(commaIdx + 1).trim() || null : null;

      if (!spotName) {
        const errMsg = pending.lang === 'zh' ? '名字不能为空，请重新发送坐标再试。' : 'Name cannot be empty. Send the location again.';
        await sendMessage(chatId, errMsg);
        return;
      }

      // 构造自然语言发给 agentCore
      const coordStr = `(${pending.lat}, ${pending.lng})`;
      let addText;
      if (pending.lang === 'zh') {
        addText = `添加${coordStr}钓点, 名字:${spotName}`;
        if (spotNote) addText += `, 备注:${spotNote}`;
      } else {
        addText = `Add fishing spot at ${coordStr}, name: ${spotName}`;
        if (spotNote) addText += `, note: ${spotNote}`;
      }

      call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      try {
        const result = await onMessage({ text: addText, userId: who, chatId: String(chatId), isAdmin: adminFlag, lang: pending.lang });
        await sendReply(chatId, result, pending.lang);
      } catch (err) {
        console.error('[tg] 添加钓点异常:', err?.message || err);
        const errMsg = pending.lang === 'zh' ? '添加钓点失败，请稍后重试。' : 'Failed to add spot. Try again later.';
        await sendMessage(chatId, errMsg).catch(() => {});
      }
      return;
    }

    // ---- 普通文本 → 直接发 onMessage（agentCore 处理一切） ----
    // 检测语言：含中文字符→zh，否则→en（agentCore 用它决定回复语言）
    const lang = /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en';

    call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    let result;
    try {
      result = await onMessage({ text, userId: who, chatId: String(chatId), isAdmin: adminFlag, lang });
    } catch (err) {
      console.error('[tg] onMessage 处理异常:', err?.message || err);
      result = { text: '抱歉，处理时出错了，请稍后再试。 / Sorry, something went wrong.', files: [] };
    }

    await sendReply(chatId, result, lang);
  }

  /** 统一发送 onMessage 返回结果（附件 + 文字 + 钓点按钮/导航按钮） */
  async function sendReply(chatId, result, lang) {
    const r = typeof result === 'string' ? { text: result, files: [] } : result;
    const effLang = r.lang || lang || 'en';

    // 发附件
    for (const f of r.files || []) {
      try {
        await sendDocument(chatId, f.filename, f.content);
      } catch (err) {
        console.error(`[tg] 附件发送失败(${f.filename}):`, err?.message || err);
      }
    }

    // 有 spots 列表 → 渲染钓点选择按钮（每行 1 个，callback_data 带 lang）
    if (Array.isArray(r.spots) && r.spots.length) {
      const spots = r.spots.filter((s) => s && s.id != null && String(s.name || '').trim());
      const buttons = spots.slice(0, 20).map((s, i) => [
        { text: `${i + 1}. ${s.name}${s.state ? ` (${s.state})` : ''}`, callback_data: `spot_${s.id}_${effLang}` },
      ]);
      // 构造正文：序号列表 + 备注/距离
      const listText = spots.slice(0, 20).map((s, i) => {
        const lines = [`${i + 1}. ${s.name}${s.state ? ` (${s.state})` : ''}`];
        if (s.note) lines.push(`   ${effLang === 'zh' ? '备注' : 'Note'}: ${s.note}`);
        const dist = [];
        if (s.distance != null) dist.push(`${s.distance} mi`);
        if (s.drivingDuration) dist.push(s.drivingDuration);
        if (dist.length) lines.push(`   ${dist.join(' | ')}`);
        return lines.join('\n');
      }).join('\n\n');
      const extra = { reply_markup: JSON.stringify({ inline_keyboard: buttons }) };
      await sendLongMessage(chatId, listText || '(无内容)', extra);
      return;
    }

    // 发文字 + 导航按钮
    const extra = navMarkup(r.coordinates, effLang);
    await sendLongMessage(chatId, (r.text && String(r.text).trim()) || '(无内容)', extra);
  }

  // ---- long polling 循环 ----
  async function loop() {
    console.log('[tg] Telegram bot 已启动(long polling)');
    while (running) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 30 });
        for (const u of updates) {
          try {
            await handle(u);
          } catch (err) {
            console.error('[tg] 处理 update 失败(已跳过):', err?.message || err);
          }
          offset = u.update_id + 1;
        }
      } catch (err) {
        console.error('[tg] 轮询出错，3s 后重试:', err?.message || err);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    console.log('[tg] Telegram 轮询已停止');
  }
  loop();

  return {
    stop: () => {
      running = false;
      clearInterval(sweepTimer);
    },
    sendMessage,
    sendDocument,
  };
}

/** 未授权用户回复 */
function denyText(username, uid) {
  return `You are not authorized to use fishHelper.\n你还没被授权使用 fishHelper。\n\nSend this to the admin / 把这行发给管理员:\n@${username || '(no username)'} id=${uid}`;
}

/** 按最大长度切分文本（尽量不切断行） */
function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks;
}

export default startTelegram;
