// ============================================================================
// Discord 传输层 —— discord.js WebSocket gateway(无需公网 URL,出站连接)
// 与企业微信/Telegram 并存,复用同一个 onMessage(→ runAgent)。
// 收到文本(私聊 + 群消息) → onMessage → { text, files } → 回复文字 + .txt 附件。
// 交互:裸坐标弹操作菜单、钓点列表按钮、分析结果带导航按钮(逻辑与 Telegram 对齐,
// 共用 shared/spotFormat.js 里的文案与状态约定)。
// ============================================================================
import {
  Client, GatewayIntentBits, Partials, AttachmentBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} from 'discord.js';
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

const MAX_MSG_LEN = 2000; // Discord 单条消息上限
const MAX_SPOT_BUTTONS = 25; // 最多 5 行 × 5 按钮
const BUTTONS_PER_ROW = 5;

/** 坐标缓存 { [token]: { lat, lng, channelId, userId, ts } } */
const coordCache = new Map();
/** 等待用户输入"名字, 备注" { [channelId_userId]: { lat, lng, ts } } */
const pendingAddSpot = new Map();
/** 用户最后一次文字消息的语言 { [uid]: { lang, ts } } */
const userLang = new Map();

/** 把导航按钮包成 Discord 的 ActionRow 数组(无坐标返回空数组) */
function navRows(coordinates, lang) {
  const nav = navButton(coordinates, lang);
  if (!nav) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel(nav.label).setStyle(ButtonStyle.Link).setURL(nav.url)
    ),
  ];
}

/**
 * 启动 Discord bot。未配置 token 则跳过并返回 null。
 * @param {{ onMessage: (m:{text:string,userId:string,chatId:string,isAdmin:boolean,lang?:string})=>Promise<{text:string,files:{filename:string,content:string}[]}|string> }} handlers
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

  // 定期清理过期坐标缓存/pending 状态/语言记忆。unref() 让它不拖住进程退出。
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

  client.on('messageCreate', async (msg) => {
    if (msg.author.id === client.user.id) return; // 忽略自身
    if (msg.author.bot) return; // 忽略其它 bot
    if (!msg.content) return; // 忽略系统消息(pin/join/boost 等)

    // 提取纯文本(去掉 @mention 标记)
    let text = msg.content.trim();
    if (msg.mentions.has(client.user)) {
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

    // 记住语言(放在白名单之后:否则陌生人一条消息就会在 Map 里留条目)
    const lang = detectLang(text);

    const isAdmin = isAdminUser('discord', username, uid);
    const pendingKey = stateKey(msg.channel.id, uid);

    // ---- 裸坐标拦截:弹按钮菜单让用户选操作 ----
    //   排在 pending 检查【之前】:否则 pending 期间发坐标会被当成"名字, 备注"
    //   裸坐标不写 userLang:发坐标不代表切语言,沿用上次记住的。
    const rawCoords = parseRawCoords(text);
    if (rawCoords) {
      console.log(`[discord] 裸坐标识别: ${rawCoords.lat}, ${rawCoords.lng}`);
      pendingAddSpot.delete(pendingKey); // 新坐标作废上一轮未完成的添加
      const menuLang = langOf(uid); // 用上次记住的语言(不是从坐标文本 detect 的)
      const cacheToken = randomUUID().slice(0, 8);
      coordCache.set(cacheToken, {
        lat: rawCoords.lat, lng: rawCoords.lng, channelId: msg.channel.id, userId: uid, lang: menuLang, ts: Date.now(),
      });
      // 最多 4 个按钮,放一行即可
      const row = new ActionRowBuilder().addComponents(
        ...coordMenuButtons(cacheToken, isAdmin, menuLang).map((b) =>
          new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(ButtonStyle.Primary)
        )
      );
      await msg.reply({ content: coordMenuTitle(rawCoords.lat, rawCoords.lng, menuLang), components: [row] });
      return;
    }

    // 走到这里说明不是裸坐标 → 记住语言(按钮回调时用)
    userLang.set(uid, { lang, ts: Date.now() });

    // ---- 检查 pending 添加钓点状态 ----
    const pending = pendingAddSpot.get(pendingKey);
    if (pending) {
      pendingAddSpot.delete(pendingKey);
      if (Date.now() - pending.ts > PENDING_ADD_TIMEOUT_MS) {
        await msg.reply(lang === 'zh'
          ? '添加钓点已超时取消(3 分钟),请重新发送坐标。'
          : 'Add-spot timed out (3 min). Send the coordinates again.');
        return;
      }
      const { name: spotName, note: spotNote } = parseSpotNameNote(text);
      const nameErr = validateSpotName(spotName, lang);
      if (nameErr) {
        await msg.reply(nameErr);
        return;
      }
      try {
        // 走 executeTool:adminOnly 的权限校验只有一处真源
        const result = await executeTool(
          'addCoordinate',
          { name: spotName, latitude: pending.lat, longitude: pending.lng, note: spotNote },
          { isAdmin }
        );
        if (result?.error) {
          await msg.reply(`添加钓点失败: ${result.message || '未知错误'}`);
          return;
        }
        await msg.reply(formatSavedSpot(result.coordinate, lang));
      } catch (err) {
        console.error('[discord] 添加钓点失败:', err?.message || err);
        await msg.reply(`添加钓点失败: ${err?.message || '未知错误'}`);
      }
      return;
    }

    msg.channel.sendTyping().catch(() => {}); // 输入提示

    let result;
    try {
      result = await onMessage({ text, userId: who, chatId: msg.channel.id, isAdmin, lang });
    } catch (err) {
      console.error('[discord] onMessage 处理异常:', err?.message || err);
      result = {
        text: lang === 'zh' ? '抱歉,处理时出错了,请稍后再试。' : 'Sorry, something went wrong. Try again later.',
        files: [], lang,
      };
    }
    if (typeof result === 'string') result = { text: result, files: [], lang };
    if (!result.lang) result.lang = lang; // 兜底路径也带上语言

    // 附件
    const attachments = [];
    for (const f of result.files || []) {
      try {
        attachments.push(new AttachmentBuilder(Buffer.from(f.content, 'utf8'), { name: f.filename }));
      } catch (err) {
        console.error(`[discord] 附件构建失败(${f.filename}):`, err?.message || err);
      }
    }

    let replyText = (result.text && String(result.text).trim()) || '(无内容)';
    let components = [];

    if (Array.isArray(result.spots) && result.spots.length) {
      // 钓点列表:正文和按钮用同一份过滤后的数组,序号天然对齐
      const spots = result.spots
        .filter((s) => s && s.id != null && String(s.name || '').trim())
        .slice(0, MAX_SPOT_BUTTONS);
      for (let i = 0; i < spots.length; i += BUTTONS_PER_ROW) {
        const row = new ActionRowBuilder();
        spots.slice(i, i + BUTTONS_PER_ROW).forEach((s, j) => {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`spot_${s.id}`)
              .setLabel(`${i + j + 1}. ${String(s.name).trim()}`.slice(0, 80))
              .setStyle(ButtonStyle.Primary)
          );
        });
        components.push(row);
      }
      replyText = buildSpotListMessage(result.text, spots, result.lang);
    } else {
      // 单点分析结果:加导航按钮
      components = navRows(result.coordinates, result.lang);
    }

    try {
      const chunks = splitText(replyText, MAX_MSG_LEN);
      for (let i = 0; i < chunks.length; i++) {
        const opts = { content: chunks[i] };
        if (i === 0 && attachments.length) opts.files = attachments;
        if (i === 0 && components.length) opts.components = components;
        if (i === 0) await msg.reply(opts);
        else await msg.channel.send(opts);
      }
    } catch (err) {
      console.error('[discord] 回复失败:', err?.message || err);
    }
  });

  // ---- 按钮点击:坐标菜单 + 钓点选择 ----
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    const customId = interaction.customId;
    const username = interaction.user.username || '';
    const uid = interaction.user.id;
    const isAdmin = isAdminUser('discord', username, uid);
    // interaction token 15 分钟过期,所有回复都要兜底
    const ephemeral = (content) =>
      interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});

    // ---- 坐标菜单按钮:coord_<token>_<action> ----
    if (customId.startsWith('coord_')) {
      const [, cacheToken, action] = customId.split('_');
      const cached = coordCache.get(cacheToken);
      // 菜单渲染时就存了语言,按钮点击直接沿用
      const lang = cached?.lang || langOf(uid);
      if (!cached) {
        await ephemeral(lang === 'zh' ? '坐标已过期,请重新发送。' : 'Coordinates expired, send them again.');
        return;
      }
      // 群里别人也看得到这个菜单:只让发坐标的本人操作
      if (cached.userId !== uid) {
        await ephemeral(lang === 'zh' ? '这不是你的坐标菜单。' : "This isn't your menu.");
        return;
      }

      if (action === 'add') {
        if (!isAdmin) {
          await ephemeral(lang === 'zh' ? '只有管理员能添加钓点。' : 'Admins only.');
          return;
        }
        // 先回执成功再挂 pending:reply 失败(token 过期/channel 为 null)时用户不知情,
        // 却已进入"下一条消息当钓点名"的状态
        try {
          await interaction.reply(askSpotNamePrompt(cached, lang));
        } catch (err) {
          console.error('[discord] 添加钓点提示发送失败,不挂 pending:', err?.message || err);
          return;
        }
        pendingAddSpot.set(stateKey(interaction.channel.id, uid), {
          lat: cached.lat, lng: cached.lng, ts: Date.now(),
        });
        return;
      }

      // 查询操作:now / today / tomorrow
      try {
        await interaction.deferReply(); // 防 3 秒超时
      } catch (err) {
        console.error('[discord] deferReply 失败(interaction 可能已过期):', err?.message || err);
        return;
      }
      const queryText = buildQuery(`${cached.lat}, ${cached.lng}`, action, lang);
      try {
        const result = await onMessage({
          text: queryText, userId: username || uid, chatId: interaction.channel.id, isAdmin, lang,
        });
        await editReplyWithChunks(interaction, result, lang);
      } catch (err) {
        console.error('[discord] 坐标菜单处理异常:', err?.message || err);
        await interaction.editReply({ content: '抱歉,处理时出错了。' }).catch(() => {});
      }
      return;
    }

    // ---- 钓点选择按钮:spot_<id> → 触发今天分析 ----
    if (!customId.startsWith('spot_')) return;
    const spotId = Number(customId.slice(5));
    if (!Number.isFinite(spotId) || spotId <= 0) return; // 防 NaN 打到数据库
    const lang = langOf(uid); // 用上次记住的语言

    try {
      await interaction.deferReply();
    } catch (err) {
      console.error('[discord] deferReply 失败(interaction 可能已过期):', err?.message || err);
      return;
    }

    try {
      const spot = await findCoordinateById(spotId);
      if (!spot) {
        await interaction.editReply({
          content: lang === 'zh' ? '钓点未找到,可能已被删除。' : 'Spot not found, it may have been deleted.',
        }).catch(() => {});
        return;
      }
      // 复用 intent → analyze 快捷管道
      const query = buildQuery(spot.name, 'today', lang);
      const result = await onMessage({
        text: query, userId: username || uid, chatId: interaction.channel.id, isAdmin, lang,
      });
      await editReplyWithChunks(interaction, result, lang);
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

/**
 * 把 onMessage 结果发到已 defer 的 interaction 上:附件 + 导航按钮 + 超长分段。
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object|string} result
 * @param {'zh'|'en'} lang 传输层已知的语言(result 没带时用它兜底)
 */
async function editReplyWithChunks(interaction, result, lang) {
  const r = typeof result === 'string' ? { text: result, files: [], lang } : result;
  const effLang = r.lang || lang;
  const files = (r.files || []).map(
    (f) => new AttachmentBuilder(Buffer.from(f.content, 'utf8'), { name: f.filename })
  );
  const components = navRows(r.coordinates, effLang);
  const chunks = splitText((r.text || '').trim() || '(无内容)', MAX_MSG_LEN);
  await interaction.editReply({
    content: chunks[0],
    files: files.length ? files : undefined,
    components: components.length ? components : undefined,
  });
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i] }).catch(() => {});
  }
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

export default startDiscord;
