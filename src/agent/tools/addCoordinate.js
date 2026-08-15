// ============================================================================
// tool: addCoordinate —— 新增/更新一个钓点坐标
//   按名唯一(忽略大小写);重名则更新其经纬度与备注(upsert)。
//   未显式给出时自动补:state(Nominatim 反查)、distance(Google 优先,OSRM 兜底)。
// ============================================================================
import { addCoordinate } from '../../db/coordinates.js';
import { config } from '../../config.js';
import { fetchWithTimeout } from '../../shared/httpFetch.js';

const M_PER_MILE = 1609.34;

/** 米 → 英里(保留 1 位小数) */
const toMiles = (meters) => Math.round((meters / M_PER_MILE) * 10) / 10;

/**
 * 开车距离(英里):Google Distance Matrix 优先,失败/未配置则降级 OSRM。
 * 注意 Google 的应用层错误(REQUEST_DENIED / OVER_QUERY_LIMIT)是 HTTP 200,
 * 必须看 body 里的 status,并打日志——否则"key 失效"和"没数据"表现一样。
 */
async function getDrivingDistance(lat, lng) {
  const home = config.home;
  if (!home) return null;
  const apiKey = config.google.mapsApiKey;

  if (apiKey) {
    try {
      const url =
        'https://maps.googleapis.com/maps/api/distancematrix/json' +
        `?origins=${home.lat},${home.lng}&destinations=${lat},${lng}&key=${apiKey}`;
      const res = await fetchWithTimeout(url);
      const data = await res.json();
      if (data.status !== 'OK') {
        console.error(
          `[addCoordinate] Google Distance Matrix 拒绝: status=${data.status} ${data.error_message || ''}`
        );
      } else {
        const el = data.rows?.[0]?.elements?.[0];
        if (el?.status === 'OK') return toMiles(el.distance.value);
        console.error(`[addCoordinate] Google 未返回路线: element status=${el?.status || 'missing'}`);
      }
    } catch (err) {
      console.error('[addCoordinate] Google Distance Matrix 失败,降级 OSRM:', err?.message || err);
    }
  }

  // 降级:OSRM 公共实例(免费无需 key;走 https,不把家坐标明文发出去)
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/${home.lng},${home.lat};${lng},${lat}` +
      '?overview=false';
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    if (data.code === 'Ok' && data.routes?.[0]) return toMiles(data.routes[0].distance);
    console.error(`[addCoordinate] OSRM 未返回路线: code=${data.code}`);
  } catch (err) {
    console.error('[addCoordinate] OSRM 距离计算失败:', err?.message || err);
  }
  return null;
}

/** 用 Nominatim(OpenStreetMap)反向地理编码取所在州 */
async function reverseGeoState(lat, lng) {
  try {
    const url =
      'https://nominatim.openstreetmap.org/reverse' +
      `?lat=${lat}&lon=${lng}&format=json&zoom=5&addressdetails=1`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': config.nws.userAgent } });
    const data = await res.json();
    return data?.address?.state || null;
  } catch (err) {
    console.error('[addCoordinate] Nominatim 反查州失败:', err?.message || err);
    return null;
  }
}

/** 美国州名 → 缩写 */
const STATE_ABBRS = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC', 'puerto rico': 'PR',
};
const ABBR_SET = new Set(Object.values(STATE_ABBRS));

/**
 * 州名归一化 → 2 字母缩写。全名、已是缩写、非美国地区(取前 2 字母大写)都能处理。
 * 对模型传入的 state 和自动反查的 state 一视同仁(保证字段格式一致)。
 */
function stateToAbbr(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper.length === 2 && ABBR_SET.has(upper)) return upper;
  const mapped = STATE_ABBRS[raw.toLowerCase()];
  if (mapped) return mapped;
  // 未知地区(非美国):统一截成 2 字母,避免字段语义从"州缩写"漂成"行政区全名"
  return upper.slice(0, 2);
}

export default {
  name: 'addCoordinate',
  adminOnly: true, // 仅管理员可添加/更新钓点(非管理员时此工具对模型隐藏 + 执行层拦截)
  description:
    'Save (or update) a fishing-spot coordinate in the database. Unique by name; if the name already exists, ' +
    'its coordinates and note are updated. Use when the user asks to save/remember a spot. ' +
    'State and driving distance from home are auto-calculated when omitted.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Spot name (unique key, case-insensitive)' },
      latitude: { type: 'number', description: 'Latitude, decimal degrees (e.g. 41.4800)' },
      longitude: { type: 'number', description: 'Longitude, decimal degrees (e.g. -71.3355)' },
      note: { type: 'string', description: 'Optional note (e.g. "best 1h before high tide")' },
      state: { type: 'string', description: 'US state abbreviation (e.g. "RI", "MA"). Auto-detected if omitted.' },
      distance: { type: 'number', description: 'Driving distance from home in miles. Auto-calculated if omitted.' },
    },
    required: ['name', 'latitude', 'longitude'],
    additionalProperties: false,
  },
  async execute({ name, latitude, longitude, note, state, distance } = {}) {
    // 缺失项自动补全(两个外部请求并发,互不阻塞;任一失败只让该字段为 null)
    const [rawState, autoDistance] = await Promise.all([
      state ? Promise.resolve(state) : reverseGeoState(latitude, longitude),
      distance != null ? Promise.resolve(distance) : getDrivingDistance(latitude, longitude),
    ]);
    const saved = await addCoordinate({
      name,
      latitude,
      longitude,
      note,
      state: stateToAbbr(rawState), // 归一化统一套在两个来源上(模型传的 / 自动反查的)
      distance: autoDistance ?? null,
    });
    return { saved: true, coordinate: saved };
  },
};
