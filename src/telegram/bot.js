// ============================================================================
// Telegram 传输层 —— long polling(无需公网 URL/域名/备案,只出不进)
// 与企业微信机器人并存,复用同一个 onMessage(→ runAgent)。
// 收到文本 → onMessage 返回 { text, files } → 先发 .txt 附件(sendDocument)再发文字。
// ============================================================================
import { config } from '../config.js';
import { findCoordinateById } from '../db/coordinates.js';

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
    // ---- 按钮回调:钓点选择 → 触发今天 prediction 分析 ----
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data || '';
      const cbChatId = cb.message?.chat?.id;
      if (!data.startsWith('spot_') || !cbChatId) {
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

    // ---- 普通文本消息 ----
    const msg = update.message || update.edited_message;
    const text = msg?.text?.trim();
    const chatId = msg?.chat?.id;
    if (!text || chatId == null) return;
    const username = msg.from?.username || '';
    const uid = String(msg.from?.id || '');
    const who = username || uid;
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

    // 输入中... 提示(失败无所谓)
    call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    let result;
    try {
      const isAdmin = config.admins.includes(`tg_${username.toLowerCase()}`) || config.admins.includes(`tg_${uid}`);
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
          inline_keyboard: result.spots.slice(0, 20).map((s) => [
            { text: String(s.name), callback_data: `spot_${s.id}` },
          ]),
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
