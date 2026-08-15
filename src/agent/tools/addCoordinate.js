// ============================================================================
// tool: addCoordinate —— 新增/更新一个钓点坐标
//   按名唯一(忽略大小写);重名则更新其经纬度与备注(upsert)。
//   自动计算 state(反向地理编码)和 distance(从家开车距离)。
// ============================================================================
import { addCoordinate } from '../../db/coordinates.js';
import { config } from '../../config.js';

/** 用 Google Distance Matrix API 算开车距离(英里) */
async function getDrivingDistance(lat, lng) {
  const home = config.home;
  const apiKey = config.google.mapsApiKey;
  // 有 Google key 优先用;没有则降级 OSRM
  if (home && apiKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${home.lat},${home.lng}&destinations=${lat},${lng}&key=${apiKey}`;
      const res = await fetch(url);
      const data = await res.json();
      const el = data.rows?.[0]?.elements?.[0];
      if (el?.status === 'OK') {
        return Math.round((el.distance.value / 1609.34) * 10) / 10;
      }
    } catch (err) {
      console.error('[addCoordinate] Google Distance Matrix 失败,降级 OSRM:', err?.message || err);
    }
  }
  // 降级:OSRM(免费,无需 key)
  if (!home) return null;
  try {
    const url = `http://router.project-osrm.org/route/v1/driving/${home.lng},${home.lat};${lng},${lat}?overview=false`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code === 'Ok' && data.routes?.[0]) {
      return Math.round((data.routes[0].distance / 1609.34) * 10) / 10;
    }
  } catch (err) {
    console.error('[addCoordinate] OSRM 距离计算失败:', err?.message || err);
  }
  return null;
}

/** 用 Nominatim(OpenStreetMap)反向地理编码获取 state 缩写 */
async function reverseGeoState(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=5&addressdetails=1`;
    const res = await fetch(url, { headers: { 'User-Agent': config.nws.userAgent } });
    const data = await res.json();
    const state = data?.address?.state;
    if (state) return stateToAbbr(state);
  } catch (err) {
    console.error('[addCoordinate] Nominatim 反查州失败:', err?.message || err);
  }
  return null;
}

/** 美国州名 → 缩写 */
const STATE_ABBRS = {
  alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',
  connecticut:'CT',delaware:'DE',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',
  illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',
  maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',mississippi:'MS',
  missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV','new hampshire':'NH','new jersey':'NJ',
  'new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',ohio:'OH',
  oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',
  washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY',
};
function stateToAbbr(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  // 已经是缩写(2 字母)
  if (lower.length === 2 && Object.values(STATE_ABBRS).includes(lower.toUpperCase())) return lower.toUpperCase();
  return STATE_ABBRS[lower] || name;
}

export default {
  name: 'addCoordinate',
  adminOnly: true, // 仅管理员可添加/更新钓点(非管理员时此工具对模型隐藏 + 执行层拦截)
  description:
    'Save (or update) a fishing-spot coordinate in the database. Unique by name; if the name already exists, ' +
    'its coordinates and note are updated. Use when the user asks to save/remember a spot. ' +
    'State and driving distance from home are auto-calculated if not provided.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Spot name (unique key, case-insensitive)' },
      latitude: { type: 'number', description: 'Latitude, decimal degrees (e.g. 41.4800)' },
      longitude: { type: 'number', description: 'Longitude, decimal degrees (e.g. -71.3355)' },
      note: { type: 'string', description: 'Optional note (e.g. "best 1h before high tide")' },
      state: { type: 'string', description: 'US state abbreviation (e.g. "RI", "MA"). Auto-detected if omitted.' },
      distance: { type: 'number', description: 'Distance from home in miles. Auto-calculated if omitted.' },
    },
    required: ['name', 'latitude', 'longitude'],
    additionalProperties: false,
  },
  async execute({ name, latitude, longitude, note, state, distance } = {}) {
    // 自动填充 state 和 distance(并发,不阻塞彼此)
    const [autoState, autoDist] = await Promise.all([
      state ? Promise.resolve(state) : reverseGeoState(latitude, longitude),
      distance != null ? Promise.resolve(distance) : getDrivingDistance(latitude, longitude),
    ]);
    const saved = await addCoordinate({
      name, latitude, longitude, note,
      state: autoState || null,
      distance: autoDist != null ? autoDist : null,
    });
    return { saved: true, coordinate: saved };
  },
};
