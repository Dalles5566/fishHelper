// ============================================================================
// fishHelper 入口 —— 装配:配置校验 → 启动机器人 → 消息接入 agent → 优雅退出
// ----------------------------------------------------------------------------
// 数据流:企业微信 → bot(message.text)→ onMessage → runAgent(OpenAI+tools)→ 流式回复
// 常驻 WebSocket 客户端,不监听入站端口。
// ============================================================================
import { assertConfig, config } from './config.js';
import { startBot } from './wecom/bot.js';
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

  // 收到用户文本 → 交给 agent 处理,返回最终回复(bot 层负责流式发送)
  const client = startBot({
    notifyChatId: config.notify.chatId, // 启动上线后给这个 chatId 推部署通知
    onMessage: async ({ text, userId }) => {
      console.log(`[agent] 处理 ${userId}: ${text}`);
      return runAgent(text);
    },
  });

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
