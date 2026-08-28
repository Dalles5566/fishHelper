// WorldTides 潮汐数据源 (worldtides.info)
// ----------------------------------------------------------------------------
// getWorldTides(lat, lng, options) -> WorldTidesObject
//
// 【用途】按坐标直查潮汐:高低潮(extremes)+ 逐小时潮位(heights)。
//   不依赖站点(内部用最近的谐波常数站),取代 NOAA CO-OPS 的潮位/高低潮。
//
// 【计费】按请求计 credits;一次请求同时要 heights + extremes 会多算一点 credit。
//
// 【单位】WorldTides 潮高原生为**米**。english 转成英尺(×3.28084),metric 保持米。
//   datum=CD(海图基准面):相对涨落对钓鱼判断足够。
//
// 【返回结构】对齐 CO-OPS 的 prediction 形状,便于 spotConditions 直接复用:
//   {
//     available, source, mode:'prediction',
//     prediction: {
//       extremes: [{ time(UTC ISO 'Z'), height, type:'High'|'Low' }],  // 按时间升序
//       hourly:   [{ time(UTC ISO 'Z'), waterLevel }],
//     },
//     units: { waterLevel, height },
//     errors: [],
//   }
// ============================================================================
import { fetchWithTimeout } from '../../shared/httpFetch.js';
import { config } from '../../config.js';

const API_BASE = 'https://www.worldtides.info/api/v3';
const M_TO_FT = 3.28084;

/** 米 → 英尺(保留 2 位);metric 保持米 */
function toUnit(meters, isEnglish) {
  if (meters == null || !Number.isFinite(Number(meters))) return null;
  const v = Number(meters);
  return isEnglish ? Math.round(v * M_TO_FT * 100) / 100 : Math.round(v * 100) / 100;
}

/** WorldTides 的 unix 秒 → UTC ISO8601('...Z',去毫秒) */
function toIsoUtc(dt) {
  if (dt == null || !Number.isFinite(Number(dt))) return null;
  return new Date(Number(dt) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * @param {number} lat
 * @param {number} lng
 * @param {{unitSystem?:'english'|'metric', date?:string, hours?:number}} options
 *   date 指定则从该 UTC 日 00:00 起;否则从现在起。hours 为窗口小时数(默认 30)。
 */
export async function getWorldTides(lat, lng, { unitSystem = 'english', date, hours = 30 } = {}) {
  const source = 'WorldTides';
  const errors = [];
  const key = config.worldTides?.apiKey || '';

  if (!key) {
    errors.push({ source, message: 'WORLDTIDES_API_KEY not configured' });
    return { available: false, source, reason: 'WORLDTIDES_API_KEY not configured', errors };
  }

  const startSec = Math.floor((date ? new Date(`${date}T00:00:00Z`).getTime() : Date.now()) / 1000);
  const length = Math.max(3600, Math.round(hours * 3600));
  const isEnglish = unitSystem === 'english';

  const query = new URLSearchParams({
    heights: '',
    extremes: '',
    lat: String(lat),
    lon: String(lng),
    datum: 'CD',
    step: '3600', // 逐小时潮位
    start: String(startSec),
    length: String(length),
    key,
  });

  let body;
  try {
    const res = await fetchWithTimeout(`${API_BASE}?${query}`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      errors.push({ source, message: `HTTP ${res.status}: ${text.slice(0, 200)}` });
      return { available: false, source, reason: `HTTP ${res.status}`, errors };
    }
    body = await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ source, message });
    return { available: false, source, reason: message, errors };
  }

  // WorldTides 出错时返回 { status: 4xx, error: "..." }
  if (body?.error) {
    errors.push({ source, message: String(body.error).slice(0, 200) });
    return { available: false, source, reason: String(body.error), errors };
  }

  const extremes = Array.isArray(body.extremes)
    ? body.extremes
        .map((e) => ({
          time: toIsoUtc(e.dt),
          height: toUnit(e.height, isEnglish),
          // WorldTides type 为 "High"/"Low"，与上层期望一致；兜底归一化
          type: /high/i.test(e.type) ? 'High' : /low/i.test(e.type) ? 'Low' : e.type,
        }))
        .filter((e) => e.time)
    : [];

  const hourly = Array.isArray(body.heights)
    ? body.heights
        .map((h) => ({ time: toIsoUtc(h.dt), waterLevel: toUnit(h.height, isEnglish) }))
        .filter((h) => h.time)
    : [];

  if (!extremes.length && !hourly.length) {
    return { available: false, source, reason: 'No tide data returned', errors };
  }

  return {
    available: true,
    source,
    mode: 'prediction',
    prediction: { extremes, hourly },
    units: isEnglish ? { waterLevel: 'ft', height: 'ft' } : { waterLevel: 'm', height: 'm' },
    errors,
  };
}

export default getWorldTides;
