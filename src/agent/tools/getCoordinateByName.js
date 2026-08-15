// ============================================================================
// tool: getCoordinateByName —— 查询已保存的钓点坐标
//   给 name → 按名精确查(忽略大小写);不给 name → 返回全部钓点列表。
//   典型用法:用户说"xxx 今天怎样",agent 先用本 tool 拿到 {name,lat,lng,note},
//   再把这些传给 getCurrentWeather / getPredictWeather。
// ============================================================================
import { listCoordinates, findCoordinateByName, searchCoordinates } from '../../db/coordinates.js';
import { config } from '../../config.js';

/**
 * 用 Google Distance Matrix API 批量查实时开车时间(含路况)。
 * 返回 Map<id, { duration, durationText }> 或空 Map(未配置/失败时)。
 */
async function getDrivingDurations(spots) {
  const home = config.home;
  const apiKey = config.google.mapsApiKey;
  if (!home || !apiKey || !spots.length) return new Map();

  // Distance Matrix 支持最多 25 个目的地
  const destinations = spots.slice(0, 25).map((s) => `${s.latitude},${s.longitude}`).join('|');
  const origin = `${home.lat},${home.lng}`;
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin}&destinations=${destinations}&departure_time=now&key=${apiKey}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK') return new Map();

    const results = new Map();
    const elements = data.rows?.[0]?.elements || [];
    for (let i = 0; i < elements.length && i < spots.length; i++) {
      const el = elements[i];
      if (el.status === 'OK') {
        // duration_in_traffic 含路况;没有则用 duration
        const dur = el.duration_in_traffic || el.duration;
        results.set(spots[i].id, { duration: dur.value, durationText: dur.text });
      }
    }
    return results;
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
    'Returns a single {name,latitude,longitude,note}, or multiple candidate matches; without name, returns all spots ' +
    'with real-time driving duration from home. ' +
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
    // 列全部钓点 + 实时开车时间
    const all = await listCoordinates();
    const durations = await getDrivingDurations(all);
    const coordinates = all.map((s) => {
      const dur = durations.get(s.id);
      return dur ? { ...s, drivingDuration: dur.durationText } : s;
    });
    return { count: coordinates.length, coordinates };
  },
};
