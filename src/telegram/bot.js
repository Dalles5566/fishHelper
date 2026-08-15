// ============================================================================
// Telegram 传输层 —— long polling(无需公网 URL/域名/备案,只出不进)
// 与企业微信机器人并存,复用同一个 onMessage(→ runAgent)。
// 收到文本 → onMessage 返回 { text, files } → 先发 .txt 附件(sendDocument)再发文字。
// ============================================================================
import { config } from '../config.js';
import { findCoordinateById } from '../db/coordinates.js';
import addCoordinateTool from '../agent/tools/addCoordinate.js';

// ---- 坐标交互菜单:内存缓存 + 会话状态 ----
let coordSeq = 0;
/** 缓存坐标 { [shortId]: { lat, lng, chatId, userId, ts } } —— 用于按钮回调时取回坐标 */
const coordCache = new Map();
/** 等待用户输入钓点名 { [chatId_userId]: { lat, lng, ts } } */
const pendingAddSpot = new Map();

// 每 10 分钟清理超过 30 分钟的缓存条目(防内存泄漏)
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of coordCache) if (v.ts < cutoff) coordCache.delete(k);
  for (const [k, v] of pendingAddSpot) if (v.ts < cutoff) pendingAddSpot.delete(k);
}, 10 * 60 * 1000);

/** 检测文本是否为裸坐标(如 "41.48, -71.33" / "(41.48, -71.33)" / "41.48 -71.33") */
function parseRawCoords(text) {
  const m = String(text).match(/^\s*\(?(-?\d+\.?\d*)\s*[,\s]\s*(-?\d+\.?\d*)\)?\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** 缓存坐标并生成操作菜单按钮 */
function buildCoordMenu(lat, lng, chatId, userId, isAdmin) {
  const id = ++coordSeq;
  coordCache.set(id, { lat, lng, chatId, userId, ts: Date.now() });
  const buttons = [];
  if (isAdmin) buttons.push([{ text: '📍 添加钓点', callback_data: `coord_${id}_add` }]);
  buttons.push(
    [{ text: '🔍 查询现在', callback_data: `coord_${id}_now` }],
    [{ text: '📊 查询今天', callback_data: `coord_${id}_today` }],
    [{ text: '📅 查询明天', callback_data: `coord_${id}_tomorrow` }],
  );
  return {
    text: `收到坐标 (${lat.toFixed(5)}, ${lng.toFixed(5)})\n请选择操作:`,
    reply_markup: JSON.stringify({ inline_keyboard: buttons }),
  };
}

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

      // ---- 坐标菜单回调:coord_<id>_<action> ----
      if (data.startsWith('coord_')) {
        const parts = data.split('_'); // ['coord', id, action]
        const cacheId = Number(parts[1]);
        const action = parts[2]; // 'add' | 'now' | 'today' | 'tomorrow'
        const cached = coordCache.get(cacheId);
        if (!cached) {
          call('answerCallbackQuery', { callback_query_id: cb.id, text: '坐标已过期,请重新发送' }).catch(() => {});
          return;
        }
        const username = cb.from?.username || '';
        const uid = String(cb.from?.id || '');
        const isAdmin = config.admins.includes(`tg_${username.toLowerCase()}`) || config.admins.includes(`tg_${uid}`);

        if (action === 'add') {
          // 添加钓点:需要管理员权限
          if (!isAdmin) {
            call('answerCallbackQuery', { callback_query_id: cb.id, text: '只有管理员能添加钓点' }).catch(() => {});
            return;
          }
          call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
          // 存入 pending 状态,等用户下一条消息输入"名字,备注"
          const key = `${cbChatId}_${uid}`;
          pendingAddSpot.set(key, { lat: cached.lat, lng: cached.lng, ts: Date.now() });
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
        const isAdmin = config.admins.includes(`tg_${username.toLowerCase()}`) || config.admins.includes(`tg_${uid}`);
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
      // 白名单检查
      const allowed = config.telegram.allowed;
      if (allowed.length && !allowed.includes(username.toLowerCase()) && !allowed.includes(uid)) return;
      const isAdmin = config.admins.includes(`tg_${username.toLowerCase()}`) || config.admins.includes(`tg_${uid}`);
      const menu = buildCoordMenu(lat, lng, chatId, uid, isAdmin);
      await sendMessage(chatId, menu.text, { reply_markup: menu.reply_markup });
      return;
    }

    const text = msg?.text?.trim();
    if (!text) return;
    console.log(`[tg] 收到来自 ${who} (id=${uid}) 的消息: ${text}`);

    // 白名单:allowed 非空时,只放行用户名或数字 id 命中的人(省 OpenAI 额度)
    const allowed = config.telegram.allowed;
    if (allowed.length && !allowed.includes(username.toLowerCase()) && !allowed.includes(uid)) {
      console.log(`[tg] 拒绝(不在白名单): ${who} id=${uid}`);
      await sendMessage(
        chatId,
        `大哥,你还没被授权使用 fishHelper。把下面这行发给管理员加白名单:\n@${username || '(无用户名)'}  id=${uid}`
      ).catch(() => {});
      return;
    }

    const isAdmin = config.admins.includes(`tg_${username.toLowerCase()}`) || config.admins.includes(`tg_${uid}`);

    // ---- 检查 pending 添加钓点状态:用户点了"添加钓点"后,下一条消息作为"名字,备注" ----
    const pendingKey = `${chatId}_${uid}`;
    const pending = pendingAddSpot.get(pendingKey);
    if (pending) {
      pendingAddSpot.delete(pendingKey);
      // 解析"名字, 备注"格式
      const commaIdx = text.indexOf(',');
      let spotName, spotNote;
      if (commaIdx > 0) {
        spotName = text.slice(0, commaIdx).trim();
        spotNote = text.slice(commaIdx + 1).trim() || null;
      } else {
        spotName = text.trim();
        spotNote = null;
      }
      if (!spotName) {
        await sendMessage(chatId, '名字不能为空,请重新发送位置或坐标再试。');
        return;
      }
      try {
        const result = await addCoordinateTool.execute({ name: spotName, latitude: pending.lat, longitude: pending.lng, note: spotNote });
        const saved = result.coordinate;
        let msg = `✅ 已保存钓点: ${saved.name}\n坐标: (${saved.latitude}, ${saved.longitude})`;
        if (saved.state) msg += `\n州: ${saved.state}`;
        if (saved.distance != null) msg += `\n距离: ${saved.distance} mi`;
        if (saved.note) msg += `\n备注: ${saved.note}`;
        await sendMessage(chatId, msg);
      } catch (err) {
        console.error('[tg] 添加钓点失败:', err?.message || err);
        await sendMessage(chatId, `添加钓点失败: ${err?.message || '未知错误'}`);
      }
      return;
    }

    // ---- 裸坐标拦截:弹操作菜单而不是直接走 agent ----
    const rawCoords = parseRawCoords(text);
    if (rawCoords) {
      console.log(`[tg] 裸坐标识别: ${rawCoords.lat}, ${rawCoords.lng}`);
      const menu = buildCoordMenu(rawCoords.lat, rawCoords.lng, chatId, uid, isAdmin);
      await sendMessage(chatId, menu.text, { reply_markup: menu.reply_markup });
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
      // 如果有 spots 列表,渲染 inline keyboard(每行一个按钮)
      if (Array.isArray(result.spots) && result.spots.length) {
        extra.reply_markup = JSON.stringify({
          inline_keyboard: result.spots.slice(0, 20).map((s) => {
            let label = String(s.name);
            const parts = [];
            if (s.distance != null) parts.push(`${s.distance} mi`);
            if (s.drivingDuration) parts.push(s.drivingDuration);
            if (parts.length) label += ` (${parts.join(' · ')})`;
            return [{ text: label, callback_data: `spot_${s.id}` }];
          }),
        });
      }
      await sendLongMessage(chatId, (result.text && String(result.text).trim()) || '(无内容)', extra);
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

  return { stop: () => { running = false; }, sendMessage, sendDocument };
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
