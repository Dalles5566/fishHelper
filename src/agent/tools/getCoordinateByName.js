// ============================================================================
// tool: getCoordinateByName —— 查询已保存的钓点坐标
//   给 name → 按名精确查(忽略大小写);不给 name → 返回全部钓点列表(带实时开车时间)。
//   典型用法:用户说"xxx 今天怎样",agent 先用本 tool 拿到 {name,lat,lng,note},
//   再把这些传给 getCurrentWeather / getPredictWeather。
// ============================================================================
import { listCoordinates, findCoordinateByName, searchCoordinates } from '../../db/coordinates.js';
import { config } from '../../config.js';
import { fetchWithTimeout } from '../../shared/httpFetch.js';

const MAX_DESTINATIONS = 25; // Google Distance Matrix 单请求目的地上限
const DURATION_TTL_MS = 5 * 60 * 1000; // 路况粒度到分钟级即可,5 分钟内复用(省额度/省钱)

/**
 * 开车时间缓存:key = 目的地 id 列表指纹,value = { at, durations:Map<id,string> }。
 * 列钓点可能只是模型解析钓点名的中间步骤,不加缓存会重复付费(departure_time=now 走高价档)。
 */
let durationCache = null;

/**
 * 用 Google Distance Matrix 批量查"从家到各钓点"的实时开车时间(含路况)。
 * 未配置 key / 家坐标,或请求失败 → 返回空 Map(调用方降级为不显示时间)。
 * @returns {Promise<Map<number, string>>} id → 形如 "35 mins"
 */
async function getDrivingDurations(spots) {
  const home = config.home;
  const apiKey = config.google.mapsApiKey;
  if (!home || !apiKey || !spots.length) return new Map();

  const targets = spots.slice(0, MAX_DESTINATIONS);
  const cacheKey = targets.map((s) => s.id).join(',');
  if (durationCache && durationCache.key === cacheKey && Date.now() - durationCache.at < DURATION_TTL_MS) {
    return durationCache.durations;
  }

  const destinations = targets.map((s) => `${s.latitude},${s.longitude}`).join('|');
  const url =
    'https://maps.googleapis.com/maps/api/distancematrix/json' +
    `?origins=${home.lat},${home.lng}&destinations=${destinations}&departure_time=now&key=${apiKey}`;

  try {
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    // 应用层错误(key 失效/超配额)是 HTTP 200,必须看 body.status 并打日志
    if (data.status !== 'OK') {
      console.error(
        `[getCoordinateByName] Google Distance Matrix 拒绝: status=${data.status} ${data.error_message || ''}`
      );
      return new Map();
    }

    const durations = new Map();
    const elements = data.rows?.[0]?.elements || [];
    for (let i = 0; i < elements.length && i < targets.length; i++) {
      const el = elements[i];
      if (el.status !== 'OK') continue;
      // duration_in_traffic 含实时路况;缺失(如 departure_time 被忽略)则退回 duration
      const dur = el.duration_in_traffic || el.duration;
      if (dur?.text) durations.set(targets[i].id, dur.text);
    }
    durationCache = { key: cacheKey, at: Date.now(), durations };
    return durations;
  } catch (err) {
    console.error('[getCoordinateByName] Google Distance Matrix 失败:', err?.message || err);
    return new Map();
  }
}

export default {
  name: 'getCoordinateByName',
  description:
    'Look up saved fishing-spot coordinates. With name: try exact match first, then fuzzy (partial) match on ' +
    'name OR note -- so part of a name (e.g. "ProvinceTown") or a note nickname (e.g. "军校"/"基佬村") also works. ' +
    'Returns a single {name,latitude,longitude,note}, or multiple candidate matches; without name, returns all ' +
    'spots sorted nearest-first with real-time driving duration from home. ' +
    'Use it to resolve a spot name into coordinates before calling the weather/fishing tools.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Spot name or part of it (a note nickname also works). Omit to list all spots.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ name } = {}) {
    if (name && name.trim()) {
      const term = name.trim();
      // ① 精确匹配优先
      const exact = await findCoordinateByName(term);
      if (exact) return exact;
      // ② 模糊匹配(名字/备注部分匹配)
      const matches = await searchCoordinates(term);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        return { matches, message: `找到 ${matches.length} 个可能的钓点,请让用户确认是哪一个` };
      }
      return { found: false, name: term, message: `未找到与「${term}」相关的钓点` };
    }
    // 列全部钓点(已按距离近→远排序)+ 实时开车时间
    const all = await listCoordinates();
    const durations = await getDrivingDurations(all);
    const coordinates = all.map((s) => {
      const drivingDuration = durations.get(s.id);
      return drivingDuration ? { ...s, drivingDuration } : s;
    });
    return { count: coordinates.length, coordinates };
  },
};
