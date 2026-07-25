// ============================================================================
// fishHelper 入口 —— 装配:配置校验 → 启动机器人 → 消息接入 agent → 优雅退出
// ----------------------------------------------------------------------------
// 数据流:企业微信 → bot(message.text)→ onMessage → runAgent(OpenAI+tools)→ 流式回复
// 常驻 WebSocket 客户端,不监听入站端口。
// ============================================================================
import { assertConfig, config } from './config.js';
import { startBot } from './wecom/bot.js';
import { startTelegram } from './telegram/bot.js';
import { runAgent } from './agent/agentCore.js';
import { pool } from './db/pool.js';

function main() {
  // 缺关键配置(botId/secret/OpenAI key/DB)时早失败,给清晰报错
  try {
    assertConfig();
  } catch (err) {
    console.error('[启动失败] 配置检查未通过:', err.message);
    process.exit(1);
  }

  // 共用的消息处理:任何传输层收到文本都走这里 → agent → { text, files }
  const onMessage = async ({ text, userId, isAdmin = false }) => {
    console.log(`[agent] 处理 ${userId}${isAdmin ? '(管理员)' : ''}: ${text}`);
    return runAgent(text, { isAdmin });
  };

  // 传输层一:企业微信智能机器人(WS 长连接)。notifyChatId 传入才会发企业微信部署通知;
  // 现在部署通知只发 Telegram,故不传(留空)。
  const client = startBot({
    notifyChatId: config.notify.chatId,
    onMessage,
  });

  // 传输层二:Telegram(可选,配了 TELEGRAM_BOT_TOKEN 才启用)
  const telegram = startTelegram({ onMessage });

  // 部署通知 → 只发 Telegram(配了 DEPLOY_NOTIFY_TG_CHATID 且 telegram 启用时)
  if (telegram && config.notify.telegramChatId) {
    const sha = (process.env.GIT_SHA || 'dev').slice(0, 7);
    const when = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'America/New_York', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
    telegram
      .sendMessage(config.notify.telegramChatId, `大哥,fishHelper 已更新上线 ✅\ncommit=${sha}\n上线时间=${when}(美东)`)
      .then(() => console.log(`[tg] 部署通知已推送给 ${config.notify.telegramChatId} (commit=${sha})`))
      .catch((err) => console.error('[tg] 部署通知发送失败:', err?.message || err));
  }

  console.log(`[fishHelper] 已启动,等待消息…(commit=${process.env.GIT_SHA || 'dev'})`);

  // ---- 优雅退出:断开连接、关连接池,只执行一次 ----
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[fishHelper] 收到 ${signal},正在关闭…`);
    try {
      // SDK 可能提供 disconnect / close,存在才调
      if (typeof client?.disconnect === 'function') client.disconnect();
      else if (typeof client?.close === 'function') client.close();
      telegram?.stop();
    } catch (err) {
      console.error('[fishHelper] 断开连接出错:', err?.message || err);
    }
    try {
      await pool.end();
    } catch (err) {
      console.error('[fishHelper] 关闭连接池出错:', err?.message || err);
    }
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 兜底:未捕获异常不静默退出,记录后继续(WebSocket 客户端保持在线)
  process.on('unhandledRejection', (reason) => {
    console.error('[fishHelper] 未处理的 Promise 异常:', reason);
  });
}

main();
