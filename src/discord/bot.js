// ============================================================================
// Discord 传输层 —— discord.js WebSocket gateway(无需公网 URL,出站连接)
// 与企业微信/Telegram 并存,复用同一个 onMessage(→ runAgent)。
// 收到文本(私聊 + @mention) → onMessage → { text, files } → 回复文字 + .txt 附件。
// ============================================================================
import { Client, GatewayIntentBits, Partials, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { findCoordinateById } from '../db/coordinates.js';
import { executeTool } from '../agent/tools/registerTools.js';
import { buildSpotListMessage, isAdminUser, isAllowedUser, parseRawCoords } from '../shared/spotFormat.js';

// ---- 坐标交互菜单:内存缓存 + 会话状态(与 Telegram 同样逻辑) ----
const STATE_TTL_MS = 30 * 60 * 1000;
const MAX_SPOT_NAME_LEN = 60;
const coordCache = new Map();
const pendingAddSpot = new Map();

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

  // 定期清理过期坐标缓存/pending 状态
  const sweepTimer = setInterval(() => {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, v] of coordCache) if (v.ts < cutoff) coordCache.delete(k);
    for (const [k, v] of pendingAddSpot) if (v.ts < cutoff) pendingAddSpot.delete(k);
  }, 10 * 60 * 1000);
  sweepTimer.unref?.();

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
    if (!isAllowedUser(config.discord.allowed, username, uid)) {
      console.log(`[discord] 拒绝(不在白名单): ${who} id=${uid}`);
      await msg.reply(
        `你还没被授权使用 fishHelper。把下面这行发给管理员加白名单:\n${username}  id=${uid}`
      ).catch(() => {});
      return;
    }

    // 输入提示
    msg.channel.sendTyping().catch(() => {});

    const isAdmin = isAdminUser('discord', username, uid);

    // ---- 裸坐标拦截:弹按钮菜单让用户选操作 ----
    const rawCoords = parseRawCoords(text);
    if (rawCoords) {
      console.log(`[discord] 裸坐标识别: ${rawCoords.lat}, ${rawCoords.lng}`);
      // 清掉上一轮未完成的"添加钓点"状态
      pendingAddSpot.delete(`${msg.channel.id}_${uid}`);
      const token = randomUUID().slice(0, 8);
      coordCache.set(token, { lat: rawCoords.lat, lng: rawCoords.lng, channelId: msg.channel.id, userId: uid, ts: Date.now() });
      const rows = [];
      const btns = [];
      if (isAdmin) btns.push({ label: '📍 添加钓点', id: `coord_${token}_add` });
      btns.push(
        { label: '🔍 查询现在', id: `coord_${token}_now` },
        { label: '📊 查询今天', id: `coord_${token}_today` },
        { label: '📅 查询明天', id: `coord_${token}_tomorrow` },
      );
      for (let i = 0; i < btns.length; i += 5) {
        const row = new ActionRowBuilder();
        for (const b of btns.slice(i, i + 5)) {
          row.addComponents(new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(ButtonStyle.Primary));
        }
        rows.push(row);
      }
      await msg.reply({ content: `收到坐标 (${rawCoords.lat.toFixed(5)}, ${rawCoords.lng.toFixed(5)})\n请选择操作:`, components: rows });
      return;
    }

    // ---- 检查 pending 添加钓点状态 ----
    const pendingKey = `${msg.channel.id}_${uid}`;
    const pending = pendingAddSpot.get(pendingKey);
    if (pending) {
      pendingAddSpot.delete(pendingKey);
      // 3 分钟内没输入名字 → 自动取消
      if (Date.now() - pending.ts > 3 * 60 * 1000) {
        await msg.reply('添加钓点已超时取消(3 分钟),请重新发送坐标。');
        return;
      }
      const commaIdx = text.indexOf(',');
      const spotName = (commaIdx > 0 ? text.slice(0, commaIdx) : text).trim();
      const spotNote = commaIdx > 0 ? text.slice(commaIdx + 1).trim() || null : null;
      if (!spotName) { await msg.reply('名字不能为空,请重新发送坐标再试。'); return; }
      if (spotName.length > MAX_SPOT_NAME_LEN) { await msg.reply(`名字太长(超过 ${MAX_SPOT_NAME_LEN} 字),请换个短点的。`); return; }
      try {
        const result = await executeTool('addCoordinate', { name: spotName, latitude: pending.lat, longitude: pending.lng, note: spotNote }, { isAdmin });
        if (result?.error) { await msg.reply(`添加钓点失败: ${result.message || '未知错误'}`); return; }
        const saved = result.coordinate;
        const lines = [`✅ 已保存钓点: ${saved.name}`, `坐标: (${saved.latitude}, ${saved.longitude})`];
        if (saved.state) lines.push(`州: ${saved.state}`);
        if (saved.distance != null) lines.push(`距离: ${saved.distance} mi`);
        if (saved.note) lines.push(`备注: ${saved.note}`);
        await msg.reply(lines.join('\n'));
      } catch (err) {
        console.error('[discord] 添加钓点失败:', err?.message || err);
        await msg.reply(`添加钓点失败: ${err?.message || '未知错误'}`);
      }
      return;
    }

    let result;
    try {
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
    let replyText = (result.text && String(result.text).trim()) || '(无内容)';

    // 如果有 spots 列表,渲染固定格式文字 + 按钮只显示序号+名字
    const components = [];
    if (Array.isArray(result.spots) && result.spots.length) {
      // Discord 要求 label 1-80 字符且 customId 必须有效,过滤掉没名字/没 id 的。
      // 正文和按钮用同一份过滤后的数组,序号天然对齐(不必反查原始下标)。
      const spots = result.spots
        .filter((s) => s && s.id != null && String(s.name || '').trim())
        .slice(0, 25); // Discord 最多 5 行 × 5 按钮 = 25

      // 按钮:序号 + 名字
      for (let i = 0; i < spots.length; i += 5) {
        const row = new ActionRowBuilder();
        spots.slice(i, i + 5).forEach((s, j) => {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`spot_${s.id}`)
              .setLabel(`${i + j + 1}. ${String(s.name).trim()}`.slice(0, 80))
              .setStyle(ButtonStyle.Primary)
          );
        });
        components.push(row);
      }

      // 聊天正文:模型引导语 + 代码渲染的固定格式列表
      replyText = buildSpotListMessage(result.text, spots, result.lang);
    }

    // 有坐标(非钓点列表):加地图链接按钮
    if (!components.length && result.coordinates) {
      const { latitude, longitude } = result.coordinates;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('📍 导航到这里')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`)
      );
      components.push(row);
    }

    try {
      // 如果超 2000 字符,分段发送
      const chunks = splitText(replyText, 2000);
      for (let i = 0; i < chunks.length; i++) {
        const opts = { content: chunks[i] };
        // 第一条带附件 + 按钮
        if (i === 0 && attachments.length) opts.files = attachments;
        if (i === 0 && components.length) opts.components = components;
        if (i === 0) {
          await msg.reply(opts);
        } else {
          await msg.channel.send(opts);
        }
      }
    } catch (err) {
      console.error('[discord] 回复失败:', err?.message || err);
    }
  });

  // ---- 按钮点击:坐标菜单 + 钓点选择 ----
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    const customId = interaction.customId;

    // ---- 坐标菜单按钮:coord_<token>_<action> ----
    if (customId.startsWith('coord_')) {
      const parts = customId.split('_'); // ['coord', token, action]
      const cacheToken = parts[1];
      const action = parts[2];
      const cached = coordCache.get(cacheToken);
      if (!cached) {
        await interaction.reply({ content: '坐标已过期,请重新发送。', ephemeral: true });
        return;
      }
      const username = interaction.user.username || '';
      const uid = interaction.user.id;
      if (cached.userId !== uid) {
        await interaction.reply({ content: '这不是你的坐标菜单。', ephemeral: true });
        return;
      }
      const isAdmin = isAdminUser('discord', username, uid);

      if (action === 'add') {
        if (!isAdmin) {
          await interaction.reply({ content: '只有管理员能添加钓点。', ephemeral: true });
          return;
        }
        pendingAddSpot.set(`${interaction.channel.id}_${uid}`, { lat: cached.lat, lng: cached.lng, ts: Date.now() });
        await interaction.reply(`请输入钓点名称和备注,格式:\n名字, 备注\n\n例如: Fort Adams, 石头堤坝尽头\n\n坐标: (${cached.lat.toFixed(5)}, ${cached.lng.toFixed(5)})`);
        return;
      }

      // 查询操作
      await interaction.deferReply();
      let queryText;
      if (action === 'now') queryText = `${cached.lat}, ${cached.lng} how is it now?`;
      else if (action === 'today') queryText = `${cached.lat}, ${cached.lng} how is it today?`;
      else queryText = `${cached.lat}, ${cached.lng} how is it tomorrow?`;

      try {
        const result = await onMessage({ text: queryText, userId: username || uid, chatId: interaction.channel.id, isAdmin });
        const r = typeof result === 'string' ? { text: result, files: [] } : result;
        const files = (r.files || []).map((f) => new AttachmentBuilder(Buffer.from(f.content, 'utf8'), { name: f.filename }));
        const chunks = splitText((r.text || '').trim() || '(无内容)', 2000);
        const mapComponents = [];
        if (r.coordinates) {
          mapComponents.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('📍 导航到这里').setStyle(ButtonStyle.Link)
              .setURL(`https://www.google.com/maps/dir/?api=1&destination=${r.coordinates.latitude},${r.coordinates.longitude}`)
          ));
        }
        await interaction.editReply({ content: chunks[0], files: files.length ? files : undefined, components: mapComponents.length ? mapComponents : undefined });
        for (let i = 1; i < chunks.length; i++) await interaction.followUp({ content: chunks[i] });
      } catch (err) {
        console.error('[discord] 坐标菜单处理异常:', err?.message || err);
        await interaction.editReply({ content: '抱歉,处理时出错了。' }).catch(() => {});
      }
      return;
    }

    // ---- 钓点选择按钮:spot_<id> → 触发今天分析 ----
    if (!customId.startsWith('spot_')) return;

    const spotId = Number(customId.slice(5));
    if (!spotId) return;

    await interaction.deferReply(); // 先告诉 Discord "正在处理"(防 3 秒超时)

    try {
      const spot = await findCoordinateById(spotId);
      if (!spot) {
        await interaction.editReply({ content: '钓点未找到,可能已被删除。' });
        return;
      }

      // 构造"今天怎么样"的请求,直接走 runAgent(复用 intent → analyze 快捷管道)
      const username = interaction.user.username || '';
      const uid = interaction.user.id;
      const isAdmin = isAdminUser('discord', username, uid);
      const query = `${spot.name} how is it today?`;
      const result = await onMessage({ text: query, userId: username || uid, chatId: interaction.channel.id, isAdmin });

      const r = typeof result === 'string' ? { text: result, files: [] } : result;
      const attachments = [];
      for (const f of r.files || []) {
        attachments.push(new AttachmentBuilder(Buffer.from(f.content, 'utf8'), { name: f.filename }));
      }
      const mapComponents = [];
      if (r.coordinates) {
        mapComponents.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('📍 导航到这里').setStyle(ButtonStyle.Link)
            .setURL(`https://www.google.com/maps/dir/?api=1&destination=${r.coordinates.latitude},${r.coordinates.longitude}`)
        ));
      }
      const chunks = splitText((r.text || '').trim() || '(无内容)', 2000);
      await interaction.editReply({ content: chunks[0], files: attachments.length ? attachments : undefined, components: mapComponents.length ? mapComponents : undefined });
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i] });
      }
    } catch (err) {
      console.error('[discord] 按钮处理异常:', err?.message || err);
      await interaction.editReply({ content: '抱歉,处理时出错了。' }).catch(() => {});
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
