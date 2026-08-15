// ============================================================================
// 传输层共享:钓点列表的固定格式渲染 + 管理员判定
//   Telegram / Discord / 企业微信 都用这里,避免各写一份格式化逻辑(改一处漏一处)。
// ============================================================================
import { config } from '../config.js';

/**
 * 把钓点列表渲染成固定格式的聊天正文(不交给 LLM 措辞,保证稳定)。
 * @param {Array} spots
 * @param {'zh'|'en'} [lang='en']
 * @returns {string}
 */
export function formatSpotList(spots, lang = 'en') {
  const noteLabel = lang === 'zh' ? '备注' : 'Note';
  return spots
    .map((s, i) => {
      const lines = [`${i + 1}. ${s.name}${s.state ? ` (${s.state})` : ''}`];
      if (s.note) lines.push(`${noteLabel}: ${s.note}`);
      const dist = [];
      if (s.distance != null) dist.push(`${s.distance} mi`);
      if (s.drivingDuration) dist.push(s.drivingDuration);
      if (dist.length) lines.push(dist.join(' | '));
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * 聊天正文 = 模型引导语(如"找到 3 个相近的钓点,你指哪个") + 固定格式列表。
 * 多候选澄清场景下模型那句话是有用上下文,不能整个丢掉。
 * @param {string|null|undefined} modelText runAgent 返回的 text
 * @param {Array} spots
 * @returns {string}
 */
export function buildSpotListMessage(modelText, spots, lang = 'en') {
  const list = formatSpotList(spots, lang);
  const lead = String(modelText ?? '').trim();
  const isShortLead = lead && lead.length <= 200 && lead.split('\n').length <= 3;
  return isShortLead ? `${lead}\n\n${list}` : list;
}

/**
 * 统一的管理员判定:ADMINS 里带平台前缀(TG_/WECOM_/DISCORD_),用户名或数字 id 命中即可。
 * @param {'tg'|'wecom'|'discord'} platform
 * @param {string} username
 * @param {string|number} uid
 * @returns {boolean}
 */
export function isAdminUser(platform, username, uid) {
  const p = String(platform).toLowerCase();
  const u = String(username ?? '').toLowerCase();
  const id = String(uid ?? '');
  return (
    (!!u && config.admins.includes(`${p}_${u}`)) ||
    (!!id && config.admins.includes(`${p}_${id}`))
  );
}

/**
 * 白名单判定:allowed 为空 = 对所有人开放;否则用户名或数字 id 命中才放行。
 * @param {string[]} allowed 已 lowercase 的白名单
 * @param {string} username
 * @param {string|number} uid
 */
export function isAllowedUser(allowed, username, uid) {
  if (!allowed.length) return true;
  const u = String(username ?? '').toLowerCase();
  const id = String(uid ?? '');
  return (!!u && allowed.includes(u)) || (!!id && allowed.includes(id));
}


/**
 * 检测文本是否为裸坐标(如 "41.48, -71.33" / "(41.48, -71.33)" / "41.48 -71.33")。
 * 至少一侧带小数点(避免 "1 2" / "5, 10" 误判成坐标)。
 * @param {string} text
 * @returns {{ lat: number, lng: number } | null}
 */
export function parseRawCoords(text) {
  const m = String(text).match(/^\s*\(?(-?\d+\.?\d*)\s*[,\s]\s*(-?\d+\.?\d*)\)?\s*$/);
  if (!m) return null;
  if (!m[1].includes('.') && !m[2].includes('.')) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// ============================================================================
// 会话状态 / 语言 / 按钮 —— Telegram 与 Discord 共用(避免改一处漏一处)
// ============================================================================

/** 坐标缓存与待输入状态的存活时间。取 14 分钟:Discord interaction token 15 分钟过期,
 *  缓存不能比它活得久,否则点旧按钮会命中缓存然后在回复时抛 Unknown interaction。 */
export const STATE_TTL_MS = 14 * 60 * 1000;
/** 清理扫描间隔 */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** 钓点名长度上限(过长在按钮 label 上会被截断到认不出) */
export const MAX_SPOT_NAME_LEN = 60;
/** 点了"添加钓点"后多久没输入名字就自动取消 */
export const PENDING_ADD_TIMEOUT_MS = 3 * 60 * 1000;

/** 会话状态 key(同一会话里按用户隔离) */
export const stateKey = (chatId, userId) => `${chatId}_${userId}`;

/** 含中文字符→zh,否则 en */
export function detectLang(text) {
  return /[\u4e00-\u9fff]/.test(String(text ?? '')) ? 'zh' : 'en';
}

/**
 * 按语言构造"按钮点击后"的查询文本。
 * 注意:文本里的时间词决定上游 intent 提取出的 mode/date,中英两套措辞要各自能被正确解析。
 * @param {string} spotLabel 钓点名或 "lat, lng"
 * @param {'now'|'today'|'tomorrow'} timeKey
 * @param {'zh'|'en'} lang
 */
export function buildQuery(spotLabel, timeKey, lang) {
  if (lang === 'zh') {
    if (timeKey === 'now') return `${spotLabel} 现在怎么样?`;
    if (timeKey === 'today') return `${spotLabel} 今天怎么样?`;
    return `${spotLabel} 明天怎么样?`;
  }
  if (timeKey === 'now') return `${spotLabel} how is it now?`;
  if (timeKey === 'today') return `${spotLabel} how is it today?`;
  return `${spotLabel} how is it tomorrow?`;
}

/**
 * 导航按钮的文案 + URL(各传输层再包成自己的按钮类型)。
 * @param {{latitude:number, longitude:number}|null|undefined} coordinates
 * @param {'zh'|'en'} [lang]
 * @returns {{ label: string, url: string } | null} 无坐标返回 null
 */
export function navButton(coordinates, lang = 'en') {
  if (!coordinates || coordinates.latitude == null || coordinates.longitude == null) return null;
  return {
    label: lang === 'zh' ? '📍 开始出发咯!钓鱼佬' : "📍 Let's roll, fish bum!",
    url: `https://www.google.com/maps/dir/?api=1&destination=${coordinates.latitude},${coordinates.longitude}`,
  };
}

/**
 * 解析"名字, 备注"(只在第一个逗号切分,中英文逗号都认;名字里的逗号请写在备注侧)。
 * @param {string} text
 * @returns {{ name: string, note: string|null }}
 */
export function parseSpotNameNote(text) {
  const s = String(text ?? '');
  const idxes = [s.indexOf(','), s.indexOf('，')].filter((i) => i > 0);
  const commaIdx = idxes.length ? Math.min(...idxes) : -1;
  const name = (commaIdx > 0 ? s.slice(0, commaIdx) : s).trim();
  const note = commaIdx > 0 ? s.slice(commaIdx + 1).trim() || null : null;
  return { name, note };
}

/**
 * 校验待保存的钓点名。返回 null = 通过,否则返回该回给用户的错误提示。
 * @param {string} name
 * @param {'zh'|'en'} [lang]
 */
export function validateSpotName(name, lang = 'zh') {
  if (!name) {
    return lang === 'zh' ? '名字不能为空,请重新发送位置或坐标再试。' : 'Name cannot be empty. Send the location again.';
  }
  if (name.length > MAX_SPOT_NAME_LEN) {
    return lang === 'zh'
      ? `名字太长(超过 ${MAX_SPOT_NAME_LEN} 字),请换个短点的,再重新发送位置。`
      : `Name too long (over ${MAX_SPOT_NAME_LEN} chars). Pick a shorter one and resend the location.`;
  }
  if (parseRawCoords(name)) {
    return lang === 'zh' ? '钓点名不能是坐标,请给它起个名字。' : "A spot name can't be coordinates. Give it a real name.";
  }
  return null;
}

/**
 * 已保存钓点 → 回执文案(名字/坐标/州/距离/备注)。
 * @param {object} saved addCoordinate 返回的行
 * @param {'zh'|'en'} [lang]
 */
export function formatSavedSpot(saved, lang = 'zh') {
  const zh = lang === 'zh';
  const lines = [
    `✅ ${zh ? '已保存钓点' : 'Spot saved'}: ${saved.name}`,
    `${zh ? '坐标' : 'Coords'}: (${saved.latitude}, ${saved.longitude})`,
  ];
  if (saved.state) lines.push(`${zh ? '州' : 'State'}: ${saved.state}`);
  if (saved.distance != null) lines.push(`${zh ? '距离' : 'Distance'}: ${saved.distance} mi`);
  if (saved.note) lines.push(`${zh ? '备注' : 'Note'}: ${saved.note}`);
  return lines.join('\n');
}

/**
 * 提示用户输入"名字, 备注"的文案。
 * @param {{lat:number,lng:number}} coord
 * @param {'zh'|'en'} [lang]
 */
export function askSpotNamePrompt(coord, lang = 'zh') {
  const at = `(${coord.lat.toFixed(5)}, ${coord.lng.toFixed(5)})`;
  return lang === 'zh'
    ? `请输入钓点名称和备注,格式:\n名字, 备注\n\n例如: Fort Adams, 石头堤坝尽头\n\n坐标: ${at}`
    : `Send the spot name and an optional note, formatted as:\nName, Note\n\ne.g. Fort Adams, end of the rock jetty\n\nCoords: ${at}`;
}

/** 坐标菜单的标题文案 */
export function coordMenuTitle(lat, lng, lang = 'zh') {
  const at = `(${lat.toFixed(5)}, ${lng.toFixed(5)})`;
  return lang === 'zh' ? `收到坐标 ${at}\n请选择操作:` : `Got coordinates ${at}\nPick an action:`;
}

/**
 * 坐标菜单的按钮定义(各传输层按自己的 API 渲染)。
 * @param {string} token coordCache 的 key
 * @param {boolean} isAdmin 管理员才有"添加钓点"
 * @param {'zh'|'en'} [lang]
 * @returns {{ label: string, id: string }[]}
 */
export function coordMenuButtons(token, isAdmin, lang = 'zh') {
  const zh = lang === 'zh';
  const btns = [];
  if (isAdmin) btns.push({ label: zh ? '📍 添加钓点' : '📍 Add spot', id: `coord_${token}_add` });
  btns.push(
    { label: zh ? '🔍 查询现在' : '🔍 Right now', id: `coord_${token}_now` },
    { label: zh ? '📊 查询今天' : '📊 Today', id: `coord_${token}_today` },
    { label: zh ? '📅 查询明天' : '📅 Tomorrow', id: `coord_${token}_tomorrow` },
  );
  return btns;
}
