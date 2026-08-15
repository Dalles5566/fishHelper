// ============================================================================
// 传输层共享:钓点列表的固定格式渲染 + 管理员判定
//   Telegram / Discord / 企业微信 都用这里,避免各写一份格式化逻辑(改一处漏一处)。
// ============================================================================
import { config } from '../config.js';

/**
 * 把钓点列表渲染成固定格式的聊天正文(不交给 LLM 措辞,保证稳定)。
 * 每条:
 *   1. 名字 (州)
 *   备注: xxx
 *   12.9 mi | 35 mins
 * @param {Array<{name:string,state?:string,note?:string,distance?:number,drivingDuration?:string}>} spots
 * @returns {string}
 */
export function formatSpotList(spots) {
  return spots
    .map((s, i) => {
      const lines = [`${i + 1}. ${s.name}${s.state ? ` (${s.state})` : ''}`];
      if (s.note) lines.push(`Note: ${s.note}`);
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
export function buildSpotListMessage(modelText, spots) {
  const list = formatSpotList(spots);
  const lead = String(modelText ?? '').trim();
  // 模型文本自己就是一份列表(含编号/换行很多)时不重复展示,只保留短引导语
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
