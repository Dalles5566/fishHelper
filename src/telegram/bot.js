// ============================================================================
// Telegram 传输层 —— long polling(无需公网 URL/域名/备案,只出不进)
// 与企业微信机器人并存,复用同一个 onMessage(→ runAgent)。
// 收到文本 → onMessage 返回 { text, files } → 先发 .txt 附件(sendDocument)再发文字。
// ============================================================================
import { config } from '../config.js';

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
  const sendMessage = (chatId, text) =>
    call('sendMessage', { chat_id: chatId, text: String(text || '').slice(0, 4096) });

  const sendDocument = (chatId, filename, content) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([content], { type: 'text/plain' }), filename);
    return call('sendDocument', form, true);
  };

  async function handle(update) {
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
      await sendMessage(chatId, (result.text && String(result.text).trim()) || '(无内容)');
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
          offset = u.update_id + 1;
          await handle(u);
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

export default startTelegram;
