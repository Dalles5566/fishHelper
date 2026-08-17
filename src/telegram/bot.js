// ============================================================================
// Telegram 传输层 —— long polling(无需公网 URL/域名/备案,只出不进)
// 与企业微信机器人并存,复用同一个 onMessage(→ runAgent)。
// 收到文本 → onMessage 返回 { text, files } → 先发 .txt 附件(sendDocument)再发文字。
// ============================================================================
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { findCoordinateById } from '../db/coordinates.js';
import { executeTool } from '../agent/tools/registerTools.js';
import {
  buildSpotListMessage, isAdminUser, isAllowedUser, parseRawCoords,
  detectLang, buildQuery, navButton, stateKey, parseSpotNameNote, validateSpotName,
  formatSavedSpot, askSpotNamePrompt, coordMenuTitle, coordMenuButtons,
  STATE_TTL_MS, SWEEP_INTERVAL_MS, PENDING_ADD_TIMEOUT_MS,
} from '../shared/spotFormat.js';

/** 坐标缓存 { [token]: { lat, lng, chatId, userId, ts } } */
const coordCache = new Map();
/** 等待用户输入"名字, 备注" { [chatId_userId]: { lat, lng, ts } } */
const pendingAddSpot = new Map();
/** 记住每个用户最后一次文字消息的语言 { [uid]: { lang, ts } } */
const userLang = new Map();

/** 缓存坐标并生成操作菜单(按钮 + 标题,语言跟随用户) */
function buildCoordMenu(lat, lng, chatId, userId, isAdmin, lang) {
  const token = randomUUID().slice(0, 8); // 随机短 token,重启后不会与旧按钮撞号
  coordCache.set(token, { lat, lng, chatId: String(chatId), userId: String(userId), ts: Date.now() });
  return {
    text: coordMenuTitle(lat, lng, lang),
    reply_markup: JSON.stringify({
      // 每行 1 个按钮(Telegram 单按钮会撑满整行,可读性最好)
      inline_keyboard: coordMenuButtons(token, isAdmin, lang).map((b) => [{ text: b.label, callback_data: b.id }]),
    }),
  };
}

/** 把导航按钮包成 Telegram 的 reply_markup(无坐标返回空对象) */
function navExtra(coordinates, lang) {
  const nav = navButton(coordinates, lang);
  if (!nav) return {};
  return { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: nav.label, url: nav.url }]] }) };
}

/** 未授权用户的统一回复(文本和位置两条路径都用,行为一致) */
const denyText = (username, uid) =>
  `大哥,你还没被授权使用 fishHelper。把下面这行发给管理员加白名单:\n@${username || '(无用户名)'}  id=${uid}`;

const api = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

/**
 * 启动 Telegram bot。未配置 token 则跳过并返回 null。
 * @param {{ onMessage: (m:{text:string,userId:string,chatId:string})=>Promise<{text:string,files:{filename:string,content:string}[]}|string> }} handlers
 * @returns {{ stop:()=>void, sendMessage:Function, sendDocument:Function } | null}
 */
export function startTelegram({ onMessage } = {}) {
  const token = config.telegram.token;
  if (!token) {
    console.log('[tg] 未配置 TELEGRAM_BOT_TOKEN,跳过 Telegram 传输');
    return null;
  }
  if (typeof onMessage !== 'function') throw new Error('startTelegram 需要 onMessage 处理函数');

  let offset = 0;
  let running = true;

  // 定期清理过期状态。unref() 让它不拖住进程退出。
  const sweepTimer = setInterval(() => {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, v] of coordCache) if (v.ts < cutoff) coordCache.delete(k);
    for (const [k, v] of pendingAddSpot) if (v.ts < cutoff) pendingAddSpot.delete(k);
    const langCutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [k, v] of userLang) if (v.ts < langCutoff) userLang.delete(k);
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  /** 取用户语言(无记录时用默认语言) */
  const langOf = (uid) => userLang.get(uid)?.lang || config.defaultLang;

  async function call(method, body, isForm = false) {
    const opts = { method: 'POST' };
    if (isForm) {
      opts.body = body; // FormData,fetch 自动带 multipart 边界
    } else {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(api(token, method), opts);
    const data = await res.json();
    if (!data.ok) throw new Error(`${method} 失败: ${data.description || res.status}`);
    return data.result;
  }

  // Telegram 单条文本上限 4096
  const sendMessage = (chatId, text, extra = {}) =>
    call('sendMessage', { chat_id: chatId, text: String(text || '').slice(0, 4096), ...extra });

  /**
   * 发长文本:超 4096 自动按行切分成多条(避免尾部被静默截断)。
   * extra(如 reply_markup 按钮)只挂在最后一条上。
   */
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

  async function handle(update) {
    // ---- 按钮回调 ----
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data || '';
      const cbChatId = cb.message?.chat?.id;
      if (!cbChatId) {
        call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
        return;
      }

      // ---- 坐标菜单回调:coord_<token>_<action> ----
      if (data.startsWith('coord_')) {
        const parts = data.split('_'); // ['coord', token, action]
        const cacheToken = parts[1];
        const action = parts[2]; // 'add' | 'now' | 'today' | 'tomorrow'
        const username = cb.from?.username || '';
        const uid = String(cb.from?.id || '');
        const cached = coordCache.get(cacheToken);
        // 菜单渲染时就存了语言,按钮点击直接沿用(不从 userLang 重查)
        const lang = cached?.lang || langOf(uid);
        if (!cached) {
          const msg = lang === 'zh' ? '坐标已过期,请重新发送' : 'Coordinates expired, send them again';
          call('answerCallbackQuery', { callback_query_id: cb.id, text: msg }).catch(() => {});
          return;
        }
        // 群里别人也能看到这个菜单:只让发坐标的本人操作(权限之外的"这是我的菜单"语义)
        if (cached.userId !== uid) {
          const msg = lang === 'zh' ? '这不是你的坐标菜单' : "This isn't your menu";
          call('answerCallbackQuery', { callback_query_id: cb.id, text: msg }).catch(() => {});
          return;
        }
        const isAdmin = isAdminUser('tg', username, uid);

        if (action === 'add') {
          // 添加钓点:需要管理员权限
          if (!isAdmin) {
            const msg = lang === 'zh' ? '只有管理员能添加钓点' : 'Admins only';
            call('answerCallbackQuery', { callback_query_id: cb.id, text: msg }).catch(() => {});
            return;
          }
          call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
          // 先把提示发出去,成功了再挂 pending —— 否则提示发失败用户不知情,
          // 却已进入"下一条消息当钓点名"的状态
          await sendMessage(cbChatId, askSpotNamePrompt(cached, lang));
          pendingAddSpot.set(stateKey(cbChatId, uid), { lat: cached.lat, lng: cached.lng, ts: Date.now() });
          return;
        }

        // 查询操作:now / today / tomorrow
        const analyzing = lang === 'zh' ? '正在分析...' : 'Analyzing...';
        call('answerCallbackQuery', { callback_query_id: cb.id, text: analyzing }).catch(() => {});
        call('sendChatAction', { chat_id: cbChatId, action: 'typing' }).catch(() => {});

        const queryText = buildQuery(`${cached.lat}, ${cached.lng}`, action, lang);

        try {
          const result = await onMessage({ text: queryText, userId: username || uid, chatId: String(cbChatId), isAdmin, lang });
          const r = typeof result === 'string' ? { text: result, files: [], lang } : result;
          for (const f of r.files || []) {
            await sendDocument(cbChatId, f.filename, f.content).catch(() => {});
          }
          await sendLongMessage(cbChatId, (r.text && String(r.text).trim()) || '(无内容)', navExtra(r.coordinates, r.lang || lang));
        } catch (err) {
          console.error('[tg] 坐标菜单回调异常:', err?.message || err);
          await sendMessage(cbChatId, '抱歉,处理时出错了。').catch(() => {});
        }
        return;
      }

      // ---- 钓点选择回调:spot_<id> → 触发今天 prediction 分析 ----
      if (!data.startsWith('spot_')) {
        call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
        return;
      }
      // 应答回调(防止 Telegram 显示"加载中")
      call('answerCallbackQuery', { callback_query_id: cb.id, text: '正在分析...' }).catch(() => {});
      call('sendChatAction', { chat_id: cbChatId, action: 'typing' }).catch(() => {});

      const spotId = Number(data.slice(5));
      if (!Number.isFinite(spotId) || spotId <= 0) return; // 防 NaN 打到数据库
      try {
        const username = cb.from?.username || '';
        const uid = String(cb.from?.id || '');
        const lang = langOf(uid);
        const spot = await findCoordinateById(spotId);
        if (!spot) {
          await sendMessage(cbChatId, lang === 'zh' ? '钓点未找到,可能已被删除。' : 'Spot not found, it may have been deleted.');
          return;
        }
        const isAdmin = isAdminUser('tg', username, uid);
        const queryText = buildQuery(spot.name, 'today', lang);
        const result = await onMessage({ text: queryText, userId: username || uid, chatId: String(cbChatId), isAdmin, lang });
        const r = typeof result === 'string' ? { text: result, files: [], lang } : result;
        for (const f of r.files || []) {
          await sendDocument(cbChatId, f.filename, f.content).catch(() => {});
        }
        await sendLongMessage(cbChatId, (r.text && String(r.text).trim()) || '(无内容)', navExtra(r.coordinates, r.lang || lang));
      } catch (err) {
        console.error('[tg] 按钮回调处理异常:', err?.message || err);
        await sendMessage(cbChatId, '抱歉,处理时出错了。').catch(() => {});
      }
      return;
    }

    // ---- 普通消息(文本 / Location) ----
    const msg = update.message || update.edited_message;
    const chatId = msg?.chat?.id;
    if (chatId == null) return;
    const username = msg?.from?.username || '';
    const uid = String(msg?.from?.id || '');
    const who = username || uid;

    // ---- Location 消息:弹出操作菜单 ----
    if (msg?.location) {
      const lat = msg.location.latitude;
      const lng = msg.location.longitude;
      console.log(`[tg] 收到来自 ${who} 的位置: ${lat}, ${lng}`);
      if (!isAllowedUser(config.telegram.allowed, username, uid)) {
        console.log(`[tg] 拒绝位置(不在白名单): ${who} id=${uid}`);
        await sendMessage(chatId, denyText(username, uid)).catch(() => {});
        return;
      }
      // 新坐标作废上一轮未完成的"添加钓点":否则下一条文本会被存到旧坐标上
      pendingAddSpot.delete(stateKey(chatId, uid));
      // 位置消息没有自然语言可检测,用该用户上一次的语言(无记录则用默认)
      const lang = langOf(uid);
      const menu = buildCoordMenu(lat, lng, chatId, uid, isAdminUser('tg', username, uid), lang);
      await sendMessage(chatId, menu.text, { reply_markup: menu.reply_markup });
      return;
    }

    const text = msg?.text?.trim();
    if (!text) return;
    console.log(`[tg] 收到来自 ${who} (id=${uid}) 的消息: ${text}`);

    // 白名单:allowed 非空时,只放行用户名或数字 id 命中的人(省 OpenAI 额度)
    if (!isAllowedUser(config.telegram.allowed, username, uid)) {
      console.log(`[tg] 拒绝(不在白名单): ${who} id=${uid}`);
      await sendMessage(chatId, denyText(username, uid)).catch(() => {});
      return;
    }

    // 记住用户语言(按钮回调时用)。放在白名单之后:否则任何陌生人发一条消息
    // 都会在这个 Map 里留下条目。
    const lang = detectLang(text);

    const isAdmin = isAdminUser('tg', username, uid);
    const pendingKey = stateKey(chatId, uid);

    // ---- 裸坐标拦截:弹操作菜单而不是直接走 agent ----
    const rawCoords = parseRawCoords(text);
    if (rawCoords) {
      console.log(`[tg] 裸坐标识别: ${rawCoords.lat}, ${rawCoords.lng}`);
      pendingAddSpot.delete(pendingKey);
      const menuLang = langOf(uid);
      const menu = buildCoordMenu(rawCoords.lat, rawCoords.lng, chatId, uid, isAdmin, menuLang);
      await sendMessage(chatId, menu.text, { reply_markup: menu.reply_markup });
      return;
    }

    // 走到这里说明不是裸坐标 → 记住语言(按钮回调时用)
    userLang.set(uid, { lang, ts: Date.now() });

    const pending = pendingAddSpot.get(pendingKey);
    if (pending) {
      pendingAddSpot.delete(pendingKey);
      // 超时未输入名字 → 自动取消(防把正常提问当钓点名存进去)
      if (Date.now() - pending.ts > PENDING_ADD_TIMEOUT_MS) {
        await sendMessage(chatId, lang === 'zh'
          ? '添加钓点已超时取消(3 分钟),请重新发送坐标。'
          : 'Add-spot timed out (3 min). Send the coordinates again.');
        return;
      }
      const { name: spotName, note: spotNote } = parseSpotNameNote(text);
      const nameErr = validateSpotName(spotName, lang);
      if (nameErr) {
        await sendMessage(chatId, nameErr);
        return;
      }
      try {
        // 走 executeTool 而不是直连 tool.execute:adminOnly 的权限校验只有一处真源
        const result = await executeTool(
          'addCoordinate',
          { name: spotName, latitude: pending.lat, longitude: pending.lng, note: spotNote },
          { isAdmin }
        );
        if (result?.error) {
          await sendMessage(chatId, `添加钓点失败: ${result.message || '未知错误'}`);
          return;
        }
        await sendMessage(chatId, formatSavedSpot(result.coordinate, lang));
      } catch (err) {
        console.error('[tg] 添加钓点失败:', err?.message || err);
        await sendMessage(chatId, `添加钓点失败: ${err?.message || '未知错误'}`);
      }
      return;
    }

    // 输入中... 提示(失败无所谓)
    call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    let result;
    try {
      result = await onMessage({ text, userId: who, chatId: String(chatId), isAdmin, lang });
    } catch (err) {
      console.error('[tg] onMessage 处理异常:', err?.message || err);
      result = { text: lang === 'zh' ? '抱歉,处理时出错了,请稍后再试。' : 'Sorry, something went wrong. Try again later.', files: [], lang };
    }
    if (typeof result === 'string') result = { text: result, files: [], lang };
    if (!result.lang) result.lang = lang; // 兜底路径也带上语言,避免下游 fallback 到英文

    for (const f of result.files || []) {
      try {
        await sendDocument(chatId, f.filename, f.content);
      } catch (err) {
        console.error(`[tg] 附件发送失败(${f.filename}):`, err?.message || err);
      }
    }
    try {
      // 有 spots 列表:代码渲染固定格式正文(保留模型引导语)+ 按钮只显示序号+名字
      if (Array.isArray(result.spots) && result.spots.length) {
        const spots = result.spots.filter((s) => s && s.id != null && String(s.name || '').trim());
        const extra = {
          reply_markup: JSON.stringify({
            inline_keyboard: spots.slice(0, 20).map((s, i) => [
              { text: `${i + 1}. ${s.name}`, callback_data: `spot_${s.id}` },
            ]),
          }),
        };
        await sendLongMessage(chatId, buildSpotListMessage(result.text, spots, result.lang), extra);
      } else {
        // 有坐标:加导航按钮
        const extra = navExtra(result.coordinates, result.lang);
        await sendLongMessage(chatId, (result.text && String(result.text).trim()) || '(无内容)', extra);
      }
    } catch (err) {
      console.error('[tg] 文本发送失败:', err?.message || err);
    }
  }

  async function loop() {
    console.log('[tg] Telegram bot 已启动(long polling)');
    while (running) {
      try {
        // 长轮询,最多挂起 30s;offset 用上一条 update_id+1 确认已消费
        const updates = await call('getUpdates', { offset, timeout: 30 });
        for (const u of updates) {
          // handle 内部已有 try/catch;这里再兜一层,保证单条出错不影响后续 update,
          // 且 offset 一定推进(不会卡在同一条上无限重试)
          try {
            await handle(u);
          } catch (err) {
            console.error('[tg] 处理 update 失败(已跳过):', err?.message || err);
          }
          offset = u.update_id + 1;
        }
      } catch (err) {
        console.error('[tg] 轮询出错,3s 后重试:', err?.message || err);
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

/** 按最大长度切分文本(尽量不切断行) */
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
