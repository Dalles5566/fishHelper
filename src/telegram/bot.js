// ============================================================================
// Telegram 传输层 —— long polling(无需公网 URL/域名/备案,只出不进)
// 与企业微信机器人并存,复用同一个 onMessage(→ runAgent)。
// 收到文本 → onMessage 返回 { text, files } → 先发 .txt 附件(sendDocument)再发文字。
// ============================================================================
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { findCoordinateById } from '../db/coordinates.js';
import { executeTool } from '../agent/tools/registerTools.js';
import { buildSpotListMessage, isAdminUser, isAllowedUser, parseRawCoords } from '../shared/spotFormat.js';

// ---- 坐标交互菜单:内存缓存 + 会话状态 ----
const STATE_TTL_MS = 30 * 60 * 1000; // 坐标缓存/待输入状态的存活时间
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_SPOT_NAME_LEN = 60; // 过长的名字在按钮 label 上会被截断到认不出

/**
 * 缓存坐标 { [token]: { lat, lng, chatId, userId, ts } } —— 按钮回调时取回坐标。
 * key 用随机 token 而非自增整数:进程重启后自增会从头发号,旧消息上的按钮会命中
 * 新坐标,静默给出"看着正常但地点错了"的报告(比报错更难发现)。
 */
const coordCache = new Map();
/** 等待用户输入"名字, 备注" { [chatId_userId]: { lat, lng, ts } } */
const pendingAddSpot = new Map();

/** 会话状态 key(同一 chat 里按用户隔离) */
const stateKey = (chatId, userId) => `${chatId}_${userId}`;

/** 缓存坐标并生成操作菜单按钮 */
function buildCoordMenu(lat, lng, chatId, userId, isAdmin) {
  const token = randomUUID().slice(0, 8); // 随机短 token,重启后不会与旧按钮撞号
  coordCache.set(token, { lat, lng, chatId: String(chatId), userId: String(userId), ts: Date.now() });
  const buttons = [];
  if (isAdmin) buttons.push([{ text: '📍 添加钓点', callback_data: `coord_${token}_add` }]);
  buttons.push(
    [{ text: '🔍 查询现在', callback_data: `coord_${token}_now` }],
    [{ text: '📊 查询今天', callback_data: `coord_${token}_today` }],
    [{ text: '📅 查询明天', callback_data: `coord_${token}_tomorrow` }],
  );
  return {
    text: `收到坐标 (${lat.toFixed(5)}, ${lng.toFixed(5)})\n请选择操作:`,
    reply_markup: JSON.stringify({ inline_keyboard: buttons }),
  };
}

/** 解析"名字, 备注"(只在第一个逗号切分;名字里的逗号请写在备注侧) */
function parseSpotNameNote(text) {
  const commaIdx = text.indexOf(',');
  const name = (commaIdx > 0 ? text.slice(0, commaIdx) : text).trim();
  const note = commaIdx > 0 ? text.slice(commaIdx + 1).trim() || null : null;
  return { name, note };
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

  // 定期清理过期的坐标缓存/待输入状态。unref() 让它不拖住进程退出。
  const sweepTimer = setInterval(() => {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, v] of coordCache) if (v.ts < cutoff) coordCache.delete(k);
    for (const [k, v] of pendingAddSpot) if (v.ts < cutoff) pendingAddSpot.delete(k);
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

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
        const cached = coordCache.get(cacheToken);
        if (!cached) {
          call('answerCallbackQuery', { callback_query_id: cb.id, text: '坐标已过期,请重新发送' }).catch(() => {});
          return;
        }
        const username = cb.from?.username || '';
        const uid = String(cb.from?.id || '');
        // 群里别人也能看到这个菜单:只让发坐标的本人操作(权限之外的"这是我的菜单"语义)
        if (cached.userId !== uid) {
          call('answerCallbackQuery', { callback_query_id: cb.id, text: '这不是你的坐标菜单' }).catch(() => {});
          return;
        }
        const isAdmin = isAdminUser('tg', username, uid);

        if (action === 'add') {
          // 添加钓点:需要管理员权限
          if (!isAdmin) {
            call('answerCallbackQuery', { callback_query_id: cb.id, text: '只有管理员能添加钓点' }).catch(() => {});
            return;
          }
          call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
          // 存入 pending 状态,等用户下一条消息输入"名字,备注"
          pendingAddSpot.set(stateKey(cbChatId, uid), { lat: cached.lat, lng: cached.lng, ts: Date.now() });
          await sendMessage(cbChatId, `请输入钓点名称和备注,格式:\n名字, 备注\n\n例如: Fort Adams, 石头堤坝尽头\n\n坐标: (${cached.lat.toFixed(5)}, ${cached.lng.toFixed(5)})`);
          return;
        }

        // 查询操作:now / today / tomorrow
        call('answerCallbackQuery', { callback_query_id: cb.id, text: '正在分析...' }).catch(() => {});
        call('sendChatAction', { chat_id: cbChatId, action: 'typing' }).catch(() => {});

        let queryText;
        if (action === 'now') queryText = `${cached.lat}, ${cached.lng} 现在怎么样?`;
        else if (action === 'today') queryText = `${cached.lat}, ${cached.lng} 今天怎么样?`;
        else queryText = `${cached.lat}, ${cached.lng} 明天怎么样?`;

        try {
          const result = await onMessage({ text: queryText, userId: username || uid, chatId: String(cbChatId), isAdmin });
          const r = typeof result === 'string' ? { text: result, files: [] } : result;
          for (const f of r.files || []) {
            await sendDocument(cbChatId, f.filename, f.content).catch(() => {});
          }
          await sendLongMessage(cbChatId, (r.text && String(r.text).trim()) || '(无内容)');
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
        const spot = await findCoordinateById(spotId);
        if (!spot) {
          await sendMessage(cbChatId, '钓点未找到,可能已被删除。');
          return;
        }
        const username = cb.from?.username || '';
        const uid = String(cb.from?.id || '');
        const isAdmin = isAdminUser('tg', username, uid);
        const queryText = `${spot.name} 今天怎么样?`;
        const result = await onMessage({ text: queryText, userId: username || uid, chatId: String(cbChatId), isAdmin });
        const r = typeof result === 'string' ? { text: result, files: [] } : result;
        for (const f of r.files || []) {
          await sendDocument(cbChatId, f.filename, f.content).catch(() => {});
        }
        await sendLongMessage(cbChatId, (r.text && String(r.text).trim()) || '(无内容)');
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
      const menu = buildCoordMenu(lat, lng, chatId, uid, isAdminUser('tg', username, uid));
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

    const isAdmin = isAdminUser('tg', username, uid);
    const pendingKey = stateKey(chatId, uid);

    // ---- 裸坐标拦截:弹操作菜单而不是直接走 agent ----
    //   必须排在 pending 检查【之前】:否则 pending 期间发坐标会被当成"名字, 备注",
    //   存出 name="41.48" / note="-71.33" 这种垃圾数据。
    const rawCoords = parseRawCoords(text);
    if (rawCoords) {
      console.log(`[tg] 裸坐标识别: ${rawCoords.lat}, ${rawCoords.lng}`);
      pendingAddSpot.delete(pendingKey); // 新坐标作废上一轮未完成的添加
      const menu = buildCoordMenu(rawCoords.lat, rawCoords.lng, chatId, uid, isAdmin);
      await sendMessage(chatId, menu.text, { reply_markup: menu.reply_markup });
      return;
    }

    // ---- 检查 pending 添加钓点状态:用户点了"添加钓点"后,下一条消息作为"名字, 备注" ----
    const pending = pendingAddSpot.get(pendingKey);
    if (pending) {
      pendingAddSpot.delete(pendingKey);
      // 3 分钟内没输入名字 → 自动取消
      if (Date.now() - pending.ts > 3 * 60 * 1000) {
        await sendMessage(chatId, '添加钓点已超时取消(3 分钟),请重新发送坐标。');
        return;
      }
      const { name: spotName, note: spotNote } = parseSpotNameNote(text);
      if (!spotName) {
        await sendMessage(chatId, '名字不能为空,请重新发送位置或坐标再试。');
        return;
      }
      if (spotName.length > MAX_SPOT_NAME_LEN) {
        await sendMessage(chatId, `名字太长(超过 ${MAX_SPOT_NAME_LEN} 字),请换个短点的,再重新发送位置。`);
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
        const saved = result.coordinate;
        const lines = [`✅ 已保存钓点: ${saved.name}`, `坐标: (${saved.latitude}, ${saved.longitude})`];
        if (saved.state) lines.push(`州: ${saved.state}`);
        if (saved.distance != null) lines.push(`距离: ${saved.distance} mi`);
        if (saved.note) lines.push(`备注: ${saved.note}`);
        await sendMessage(chatId, lines.join('\n'));
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
      result = await onMessage({ text, userId: who, chatId: String(chatId), isAdmin });
    } catch (err) {
      console.error('[tg] onMessage 处理异常:', err?.message || err);
      result = { text: '抱歉,处理时出错了,请稍后再试。', files: [] };
    }
    if (typeof result === 'string') result = { text: result, files: [] };

    for (const f of result.files || []) {
      try {
        await sendDocument(chatId, f.filename, f.content);
      } catch (err) {
        console.error(`[tg] 附件发送失败(${f.filename}):`, err?.message || err);
      }
    }
    try {
      const extra = {};
      // 有 spots 列表:代码渲染固定格式正文(保留模型引导语)+ 按钮只显示序号+名字
      if (Array.isArray(result.spots) && result.spots.length) {
        const spots = result.spots.filter((s) => s && s.id != null && String(s.name || '').trim());
        extra.reply_markup = JSON.stringify({
          inline_keyboard: spots.slice(0, 20).map((s, i) => [
            { text: `${i + 1}. ${s.name}`, callback_data: `spot_${s.id}` },
          ]),
        });
        await sendLongMessage(chatId, buildSpotListMessage(result.text, spots), extra);
      } else {
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
