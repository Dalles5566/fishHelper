// 企业微信智能机器人层：封装 @wecom/aibot-node-sdk 的 WebSocket 长连接
// 只负责传输：建连、事件监听、流式回复。业务处理通过注入的 onMessage 解耦。
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import { config } from '../config.js';

const WELCOME_TEXT = '您好！我是钓鱼助手 🎣 告诉我钓点名字，我帮你查风向、风速和涨退潮时间；也可以让我保存新的钓点坐标。';
const THINKING_TEXT = '正在查询，请稍候…';
const ERROR_TEXT = '抱歉，处理时出错了，请稍后再试。';

/**
 * 创建并启动机器人。
 * @param {object} handlers
 * @param {(input: { text: string, userId: string, frame: object }) => Promise<string>} handlers.onMessage
 *        收到文本消息时调用，返回要回复的最终文本。
 * @returns {WSClient}
 */
export function startBot({ onMessage, notifyChatId = '' } = {}) {
  if (typeof onMessage !== 'function') {
    throw new Error('startBot 需要传入 onMessage 处理函数');
  }

  const client = new WSClient({
    botId: config.wecom.botId,
    secret: config.wecom.botSecret,
  });

  // ---- 连接生命周期日志 ----
  client.on('connected', () => console.log('[bot] WebSocket 已连接'));

  // 部署通知:本进程首次认证成功时,主动推一条"已更新上线"给 notifyChatId。
  // 用 deployNotified 保证只发一次(authenticated 在每次断线重连都会触发,不能重复推)。
  let deployNotified = false;
  client.on('authenticated', () => {
    console.log('[bot] 认证成功，机器人已上线');
    if (notifyChatId && !deployNotified) {
      deployNotified = true;
      const sha = (process.env.GIT_SHA || 'dev').slice(0, 7);
      const when = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'America/New_York', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date());
      // 主动发送(aibot_send_msg)不支持纯 text,用 markdown
      const content = `fishHelper 已更新上线 ✅\n> commit=\`${sha}\`\n> 上线时间=${when}(美东)`;
      client
        .sendMessage(notifyChatId, { msgtype: 'markdown', markdown: { content } })
        .then(() => console.log(`[bot] 部署通知已推送给 ${notifyChatId} (commit=${sha})`))
        .catch((err) => console.error('[bot] 部署通知发送失败:', err?.message || err));
    }
  });
  client.on('disconnected', (reason) => console.warn(`[bot] 连接断开: ${reason}`));
  client.on('reconnecting', (attempt) => console.warn(`[bot] 正在第 ${attempt} 次重连…`));
  client.on('error', (err) => console.error('[bot] 错误:', err?.message || err));

  // ---- 进入会话：发欢迎语（需 5s 内回复）----
  client.on('event.enter_chat', (frame) => {
    client
      .replyWelcome(frame, { msgtype: 'text', text: { content: WELCOME_TEXT } })
      .catch((err) => console.error('[bot] 欢迎语发送失败:', err?.message || err));
  });

  // ---- 文本消息：流式回复 ----
  client.on('message.text', async (frame) => {
    const text = frame?.body?.text?.content?.trim() || '';
    const userId = frame?.body?.from?.userid || '';
    console.log(`[bot] 收到来自 ${userId} 的消息: ${text}`);

    if (!text) return;

    const streamId = generateReqId('stream');
    // 先发一条“正在查询”，让用户知道已收到（不结束流）
    try {
      await client.replyStream(frame, streamId, THINKING_TEXT, false);
    } catch (err) {
      console.error('[bot] 首次流式回复失败:', err?.message || err);
    }

    // 调业务处理，拿最终结果（{ text, files } 或纯字符串）
    let result;
    try {
      const isAdmin = config.admins.includes(`wecom_${String(userId).toLowerCase()}`);
      result = await onMessage({ text, userId, frame, isAdmin });
    } catch (err) {
      console.error('[bot] onMessage 处理异常:', err?.message || err);
      result = { text: ERROR_TEXT, files: [] };
    }
    // 兼容旧的字符串返回
    if (typeof result === 'string') result = { text: result, files: [] };
    const files = Array.isArray(result?.files) ? result.files : [];
    const finalText = (result?.text && String(result.text).trim()) || ERROR_TEXT;

    // 先把长数据作为文件附件发出去（上传临时素材 → 被动回复媒体消息）
    for (const f of files) {
      try {
        const media = await client.uploadMedia(Buffer.from(f.content, 'utf8'), {
          type: 'file',
          filename: f.filename,
        });
        await client.replyMedia(frame, 'file', media.media_id);
      } catch (err) {
        console.error(`[bot] 附件发送失败(${f.filename}):`, err?.message || err);
      }
    }

    // 再结束这条流式文本消息（finish=true）
    try {
      await client.replyStream(frame, streamId, finalText, true);
    } catch (err) {
      console.error('[bot] 最终流式回复失败:', err?.message || err);
    }
  });

  client.connect();
  return client;
}
