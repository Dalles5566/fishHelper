// ============================================================================
// Discord 传输层 —— discord.js WebSocket gateway(无需公网 URL,出站连接)
// 与企业微信/Telegram 并存,复用同一个 onMessage(→ runAgent)。
// 收到文本(私聊 + @mention) → onMessage → { text, files } → 回复文字 + .txt 附件。
// ============================================================================
import { Client, GatewayIntentBits, Partials, AttachmentBuilder } from 'discord.js';
import { config } from '../config.js';

/**
 * 启动 Discord bot。未配置 token 则跳过并返回 null。
 * @param {{ onMessage: (m:{text:string,userId:string,chatId:string,isAdmin:boolean})=>Promise<{text:string,files:{filename:string,content:string}[]}|string> }} handlers
 * @returns {Client|null}
 */
export function startDiscord({ onMessage } = {}) {
  const token = config.discord.token;
  if (!token) {
    console.log('[discord] 未配置 DISCORD_BOT_TOKEN,跳过 Discord 传输');
    return null;
  }
  if (typeof onMessage !== 'function') throw new Error('startDiscord 需要 onMessage 处理函数');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel], // 需要 partial 才能收到未缓存 DM channel 的消息
  });

  client.once('ready', () => {
    console.log(`[discord] Discord bot 已上线: ${client.user.tag}`);
  });

  client.on('messageCreate', async (msg) => {
    // 忽略自身消息
    if (msg.author.id === client.user.id) return;
    // 忽略其它 bot
    if (msg.author.bot) return;

    // 判断是否应该响应:私聊(DM)或群里的消息都回
    // 忽略跟 bot 无关的系统消息(pin/join/boost 等)
    if (!msg.content) return;

    // 提取纯文本(如果被 @mention 就去掉 @mention 标记)
    let text = msg.content.trim();
    const isMentioned = msg.mentions.has(client.user);
    if (isMentioned) {
      text = text.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    }
    if (!text) return;

    const username = msg.author.username || '';
    const uid = msg.author.id;
    const who = username || uid;
    console.log(`[discord] 收到来自 ${who} (id=${uid}) 的消息: ${text}`);

    // 白名单检查(allowed 非空时生效)
    const allowed = config.discord.allowed;
    if (allowed.length && !allowed.includes(username.toLowerCase()) && !allowed.includes(uid)) {
      console.log(`[discord] 拒绝(不在白名单): ${who} id=${uid}`);
      await msg.reply(
        `你还没被授权使用 fishHelper。把下面这行发给管理员加白名单:\n${username}  id=${uid}`
      ).catch(() => {});
      return;
    }

    // 输入提示
    msg.channel.sendTyping().catch(() => {});

    let result;
    try {
      const isAdmin = config.admins.includes(`discord_${username.toLowerCase()}`) || config.admins.includes(`discord_${uid}`);
      result = await onMessage({ text, userId: who, chatId: msg.channel.id, isAdmin });
    } catch (err) {
      console.error('[discord] onMessage 处理异常:', err?.message || err);
      result = { text: '抱歉,处理时出错了,请稍后再试。', files: [] };
    }
    if (typeof result === 'string') result = { text: result, files: [] };

    // 发附件
    const attachments = [];
    for (const f of result.files || []) {
      try {
        attachments.push(new AttachmentBuilder(Buffer.from(f.content, 'utf8'), { name: f.filename }));
      } catch (err) {
        console.error(`[discord] 附件构建失败(${f.filename}):`, err?.message || err);
      }
    }

    // 发回复(Discord 单条上限 2000 字符,超了截断)
    const replyText = (result.text && String(result.text).trim()) || '(无内容)';
    try {
      // 如果超 2000 字符,分段发送
      const chunks = splitText(replyText, 2000);
      for (let i = 0; i < chunks.length; i++) {
        const opts = { content: chunks[i] };
        // 第一条带附件
        if (i === 0 && attachments.length) opts.files = attachments;
        if (i === 0) {
          await msg.reply(opts);
        } else {
          await msg.channel.send(opts);
        }
      }
      // 如果文字不超 2000 但有附件且还没发(不会走这,但兜底)
      if (chunks.length === 0 && attachments.length) {
        await msg.reply({ content: '(无内容)', files: attachments });
      }
    } catch (err) {
      console.error('[discord] 回复失败:', err?.message || err);
    }
  });

  client.login(token).catch((err) => {
    console.error('[discord] 登录失败:', err?.message || err);
  });

  return client;
}

/** 按最大长度切分文本(不切断行) */
function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // 在 maxLen 前找最后一个换行
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks;
}

export default startDiscord;
