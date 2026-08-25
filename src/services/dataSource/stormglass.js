// ============================================================================
// Stormglass 数据源 (stormglass.io)
// ----------------------------------------------------------------------------
// getStormglass(lat, lng, options) -> StormglassObject
//
// 【用途】按坐标直查 waterTemperature / currentSpeed / currentDirection。
//   不依赖站号,数据来自全球海洋模型(ECMWF/NOAA 等多源融合),比 CO-OPS 按最近站更精确。
//   作为优先数据源:spotConditions 先调 Stormglass,缺失时再用 CO-OPS/NDBC 兜底。
//
// 【请求计费】一次 API 调用(不管请求几个 params)= 1 次请求。免费 10 次/天。
//   加 2 小时内存缓存(同坐标不重复请求)。
//
// 【返回格式】Stormglass 返回 { hours: [ { time, waterTemperature:{sg:...}, ... } ] }
//   每个参数下有多个源(sg/noaa/meto 等),我们统一取 'sg'(Stormglass AI 最优选源)。
//
// 【双模式】
//   mode='current':只取当前小时的值(最近一条)
//   mode='prediction':返回逐小时数组(未来 24h 或目标日)
// ============================================================================
import { fetchWithTimeout } from '../../shared/httpFetch.js';
import { config } from '../../config.js';

const API_BASE = 'https://api.stormglass.io/v2/weather/point';
const PARAMS = 'waterTemperature,currentSpeed,currentDirection';

// 内存缓存:key = "lat,lng" 四舍五入到 3 位(~100m 精度),value = { ts, data }
const cache = new Map();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时

function cacheKey(lat, lng) {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

/** 清理过期缓存(每次调用时顺便扫一下) */
function sweep() {
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [k, v] of cache) if (v.ts < cutoff) cache.delete(k);
}

/** degC → degF */
function cToF(v) {
  if (v == null) return null;
  return Math.round(((v * 9) / 5 + 32) * 10) / 10;
}

/** m/s → knots */
function msToKnots(v) {
  if (v == null) return null;
  return Math.round(v * 1.94384 * 100) / 100;
}

/**
 * 从 Stormglass 获取水温和潮流数据。
 * @param {number} lat
 * @param {number} lng
 * @param {{mode?:'current'|'prediction', unitSystem?:'english'|'metric', date?:string}} options
 */
export async function getStormglass(lat, lng, { mode = 'current', unitSystem = 'english', date } = {}) {
  const source = 'Stormglass';
  const errors = [];
  const apiKey = config.stormglass?.apiKey;

  if (!apiKey) {
    return { available: false, source, reason: 'STORMGLASS_API_KEY not configured', errors };
  }

  // 检查缓存
  sweep();
  const key = cacheKey(lat, lng);
  const cached = cache.get(key);
  let hours;

  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    hours = cached.data;
  } else {
    // 请求 Stormglass API
    const now = new Date();
    const start = date ? `${date}T00:00:00Z` : now.toISOString();
    const endDate = date ? new Date(`${date}T00:00:00Z`) : now;
    const end = new Date(endDate.getTime() + 30 * 60 * 60 * 1000).toISOString(); // +30h 覆盖整天

    const url = `${API_BASE}?lat=${lat}&lng=${lng}&params=${PARAMS}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&source=sg`;

    try {
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: apiKey },
      });
      if (res.status === 402 || res.status === 429) {
        errors.push({ source, message: `API limit reached (HTTP ${res.status})` });
        return { available: false, source, reason: `API limit (${res.status})`, errors };
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        errors.push({ source, message: `HTTP ${res.status}: ${text.slice(0, 200)}` });
        return { available: false, source, reason: `HTTP ${res.status}`, errors };
      }
      const body = await res.json();
      hours = body.hours || [];
      // 存入缓存
      cache.set(key, { ts: Date.now(), data: hours });
    } catch (err) {
      errors.push({ source, message: err.message });
      return { available: false, source, reason: err.message, errors };
    }
  }

  if (!hours.length) {
    return { available: false, source, reason: 'No data returned', errors };
  }

  const isEnglish = unitSystem === 'english';

  if (mode === 'current') {
    // 取最接近当前时间的一条
    const now = Date.now();
    let closest = hours[0];
    let minDiff = Math.abs(new Date(closest.time).getTime() - now);
    for (const h of hours) {
      const diff = Math.abs(new Date(h.time).getTime() - now);
      if (diff < minDiff) { closest = h; minDiff = diff; }
    }
    const wt = closest.waterTemperature?.sg ?? null;
    const cs = closest.currentSpeed?.sg ?? null;
    const cd = closest.currentDirection?.sg ?? null;

    return {
      available: true,
      source,
      mode,
      current: {
        time: closest.time,
        waterTemperature: isEnglish ? cToF(wt) : wt,
        currentSpeed: isEnglish ? msToKnots(cs) : cs,
        currentDirection: cd,
      },
      units: isEnglish
        ? { waterTemperature: 'degF', currentSpeed: 'knots', currentDirection: 'deg' }
        : { waterTemperature: 'degC', currentSpeed: 'm/s', currentDirection: 'deg' },
      errors,
    };
  }

  // mode === 'prediction': 返回逐小时数组
  const hourly = hours.map((h) => {
    const wt = h.waterTemperature?.sg ?? null;
    const cs = h.currentSpeed?.sg ?? null;
    const cd = h.currentDirection?.sg ?? null;
    return {
      time: h.time,
      waterTemperature: isEnglish ? cToF(wt) : wt,
      currentSpeed: isEnglish ? msToKnots(cs) : cs,
      currentDirection: cd,
    };
  });

  return {
    available: true,
    source,
    mode,
    prediction: { hourly },
    units: isEnglish
      ? { waterTemperature: 'degF', currentSpeed: 'knots', currentDirection: 'deg' }
      : { waterTemperature: 'degC', currentSpeed: 'm/s', currentDirection: 'deg' },
    errors,
  };
}
