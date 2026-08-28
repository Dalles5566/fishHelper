// ============================================================================
// Stormglass 数据源 (stormglass.io)
// ----------------------------------------------------------------------------
// getStormglass(lat, lng, options) -> StormglassObject
//
// 【用途】按坐标直查 waterTemperature / currentSpeed / currentDirection / waveHeight / wavePeriod / waveDirection。
//   不依赖站号,数据来自全球海洋模型(ECMWF/NOAA 等多源融合),比 CO-OPS 按最近站更精确。
//   作为优先数据源:与其他来源并发请求,合并时优先采用 Stormglass,缺失再用 CO-OPS/NDBC 兜底。
//
// 【请求计费】一次 API 调用(不管请求几个 params)= 1 次请求。具体配额以账户计划为准。
//
// 【Key 顺序耗尽】支持多 key(STORMGLASS_API_KEYS=key1,key2,key3):
//   Key #1 用满(used>=每日上限)或收到 402 前不用 Key #2。配额状态存 Redis,
//   进程重启仍保留;每天美东(America/New_York)午夜 00:00 自动重置(Redis TTL)。
//   402=今日耗尽(即使 used 很小也 not available);403=无效 key(本进程内存禁用)。
//   状态管理见 stormglassKeys.js。
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
import { selectAvailableKey, recordSuccess, markExhausted } from './stormglassKeys.js';

const API_BASE = 'https://api.stormglass.io/v2/weather/point';
const PARAMS = 'waterTemperature,currentSpeed,currentDirection,waveHeight,wavePeriod,waveDirection,airTemperature,windSpeed,windDirection,gust,pressure';

// ── Key 轮换状态 ──
// 配额状态(used/402 耗尽)存 Redis,见 stormglassKeys.js;每日美东午夜自动重置。
// 403(无效 key)不是配额问题,不进 Redis,只在本进程内内存禁用。
const invalidSet = new Set(); // 403:进程生命周期内禁用

/**
 * 顺序耗尽式 key 请求:
 * - 从 Key #1 开始,用满(used>=limit)或收到 402 前不切下一个。
 * - 成功 → used +1;402 → 标记耗尽(即使 used 很小也不可用);403 → 内存禁用。
 * - 状态存 Redis;Redis 连不上直接抛错(不做内存兜底)。
 */
async function fetchWithKeyRotation(url, errors) {
  const keys = config.stormglass?.apiKeys || [];
  if (!keys.length) {
    console.warn('[stormglass] 未配置 STORMGLASS_API_KEYS，跳过 Stormglass，改用 CO-OPS/NDBC 兜底');
    errors.push({ source: 'Stormglass', message: 'STORMGLASS_API_KEYS not configured' });
    return null;
  }

  const attempted = new Set();
  while (attempted.size < keys.length) {
    // 从 Redis 顺序选第一个可用 key(未 402 且 used<limit)
    const picked = await selectAvailableKey();
    if (picked == null) break;
    const { index, used, limit } = picked;
    if (attempted.has(index) || invalidSet.has(index)) {
      // 已试过或本进程禁用(403)→ 跳过,避免死循环
      attempted.add(index);
      continue;
    }
    attempted.add(index);

    let res;
    try {
      res = await fetchWithTimeout(url, { headers: { Authorization: keys[index] } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[stormglass] Key #${index + 1} 网络/超时错误: ${message}`);
      errors.push({ source: 'Stormglass', message });
      return null;
    }

    if (res.status === 402) {
      await markExhausted(index);
      console.warn(`[stormglass] Key #${index + 1}/${keys.length} 今日配额耗尽 (HTTP 402)，标记 not available，切换下一个 key`);
      errors.push({ source: 'Stormglass', message: `Key #${index + 1} daily quota exhausted (HTTP 402)` });
      continue;
    }

    if (res.status === 429) {
      console.warn(`[stormglass] Key #${index + 1}/${keys.length} 被限流 (HTTP 429)，切换下一个 key`);
      errors.push({ source: 'Stormglass', message: `Key #${index + 1} rate limited (HTTP 429)` });
      continue;
    }

    if (res.status === 403) {
      invalidSet.add(index);
      console.warn(`[stormglass] Key #${index + 1}/${keys.length} 无效/过期 (HTTP 403)，本进程内禁用该 key`);
      errors.push({ source: 'Stormglass', message: `Key #${index + 1} returned 403 (invalid/expired)` });
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[stormglass] Key #${index + 1} 请求失败 HTTP ${res.status}，放弃`);
      errors.push({ source: 'Stormglass', message: `HTTP ${res.status}: ${text.slice(0, 200)}` });
      return null;
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      console.error(`[stormglass] Key #${index + 1} 返回非法 JSON: ${err.message}`);
      errors.push({ source: 'Stormglass', message: `Invalid JSON response: ${err.message}` });
      return null;
    }

    const newUsed = await recordSuccess(index);
    console.log(`[stormglass] 使用 Key #${index + 1}/${keys.length}（今日 ${newUsed}/${limit}，请求前 ${used}/${limit}）请求成功`);
    return body;
  }

  console.warn(`[stormglass] 所有 ${keys.length} 个 API key 今日均不可用（配额用满或 402 耗尽），本次改用 CO-OPS/NDBC 兜底`);
  errors.push({ source: 'Stormglass', message: `所有 ${keys.length} 个 API key 今日均不可用` });
  return null;
}

// ── 单位换算 ──

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

/** m → ft */
function mToFt(v) {
  if (v == null) return null;
  return Math.round(v * 3.28084 * 100) / 100;
}

function assertRequest(lat, lng, mode, unitSystem, date) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RangeError('latitude must be between -90 and 90');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new RangeError('longitude must be between -180 and 180');
  if (mode !== 'current' && mode !== 'prediction') throw new TypeError("mode must be 'current' or 'prediction'");
  if (unitSystem !== 'english' && unitSystem !== 'metric') throw new TypeError("unitSystem must be 'english' or 'metric'");
  if (date != null) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError('date must use YYYY-MM-DD format');
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new RangeError(`invalid calendar date: ${date}`);
    }
  }
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHour(hour, isEnglish) {
  const timeMs = Date.parse(hour?.time);
  if (Number.isNaN(timeMs)) return null;
  const wt = numberOrNull(hour?.waterTemperature?.sg);
  const cs = numberOrNull(hour?.currentSpeed?.sg);
  const cd = numberOrNull(hour?.currentDirection?.sg);
  const wh = numberOrNull(hour?.waveHeight?.sg);
  const wp = numberOrNull(hour?.wavePeriod?.sg);
  const wd = numberOrNull(hour?.waveDirection?.sg);
  // 气象:气温、风速、风向、阵风、气压
  const at = numberOrNull(hour?.airTemperature?.sg);
  const ws = numberOrNull(hour?.windSpeed?.sg);
  const wdir = numberOrNull(hour?.windDirection?.sg);
  const gust = numberOrNull(hour?.gust?.sg);
  const pressure = numberOrNull(hour?.pressure?.sg);
  return {
    time: hour.time,
    waterTemperature: isEnglish ? cToF(wt) : wt,
    currentSpeed: isEnglish ? msToKnots(cs) : cs,
    currentDirection: cd,
    waveHeight: isEnglish ? mToFt(wh) : wh,
    wavePeriod: wp,
    waveDirection: wd,
    airTemperature: isEnglish ? cToF(at) : at,
    windSpeed: isEnglish ? msToKnots(ws) : ws,
    windDirection: wdir,
    windGust: isEnglish ? msToKnots(gust) : gust,
    pressure, // hPa,两种单位口径都用 hPa
  };
}

function hasMarineData(hour) {
  return hour && [
    hour.waterTemperature,
    hour.currentSpeed,
    hour.currentDirection,
    hour.waveHeight,
    hour.wavePeriod,
    hour.waveDirection,
    hour.airTemperature,
    hour.windSpeed,
    hour.windDirection,
    hour.windGust,
    hour.pressure,
  ].some((value) => value != null);
}

function unitsFor(isEnglish) {
  return isEnglish
    ? { waterTemperature: 'degF', currentSpeed: 'knots', currentDirection: 'deg', waveHeight: 'ft', wavePeriod: 's', waveDirection: 'deg', airTemperature: 'degF', windSpeed: 'knots', windDirection: 'deg', windGust: 'knots', pressure: 'hPa' }
    : { waterTemperature: 'degC', currentSpeed: 'm/s', currentDirection: 'deg', waveHeight: 'm', wavePeriod: 's', waveDirection: 'deg', airTemperature: 'degC', windSpeed: 'm/s', windDirection: 'deg', windGust: 'm/s', pressure: 'hPa' };
}

/**
 * 从 Stormglass 获取水温、潮流和海浪数据。
 * @param {number} lat
 * @param {number} lng
 * @param {{mode?:'current'|'prediction', unitSystem?:'english'|'metric', date?:string}} options
 */
export async function getStormglass(lat, lng, { mode = 'current', unitSystem = 'english', date } = {}) {
  assertRequest(lat, lng, mode, unitSystem, date);
  const source = 'Stormglass';
  const errors = [];
  const now = new Date();

  let startDate;
  let endDate;
  if (mode === 'current') {
    // Current 只需要当前附近的小时，前后各两小时足够选最近值，避免下载 30 小时。
    startDate = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    endDate = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  } else {
    startDate = date ? new Date(`${date}T00:00:00Z`) : now;
    endDate = new Date(startDate.getTime() + 30 * 60 * 60 * 1000);
  }

  const query = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    params: PARAMS,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    source: 'sg',
  });
  const coordStr = `${lat},${lng}`;
  console.log(`[stormglass] 请求 ${mode} ${coordStr}${date ? ` date=${date}` : ''}`);
  const startedAt = Date.now();
  const body = await fetchWithKeyRotation(`${API_BASE}?${query}`, errors);
  const elapsedMs = Date.now() - startedAt;

  if (!body) {
    console.warn(`[stormglass] ${mode} ${coordStr} 无返回 (${elapsedMs}ms): ${errors.at(-1)?.message || 'request failed'}`);
    return { available: false, source, reason: errors.at(-1)?.message || 'request failed', errors };
  }
  if (!Array.isArray(body.hours)) {
    console.warn(`[stormglass] ${mode} ${coordStr} 响应异常: hours 不是数组`);
    errors.push({ source, message: 'Invalid response: hours must be an array' });
    return { available: false, source, reason: 'Invalid hours response', errors };
  }

  const isEnglish = unitSystem === 'english';
  const hourly = body.hours
    .map((hour) => normalizeHour(hour, isEnglish))
    .filter((hour) => hasMarineData(hour));
  if (!hourly.length) {
    console.warn(`[stormglass] ${mode} ${coordStr} 无可用海洋数据 (${elapsedMs}ms)`);
    return { available: false, source, reason: 'No usable marine data returned', errors };
  }
  console.log(`[stormglass] ${mode} ${coordStr} 成功，${hourly.length} 小时数据 (${elapsedMs}ms)`);

  if (mode === 'current') {
    const nowMs = Date.now();
    let closest = hourly[0];
    let minDiff = Math.abs(Date.parse(closest.time) - nowMs);
    for (const hour of hourly.slice(1)) {
      const diff = Math.abs(Date.parse(hour.time) - nowMs);
      if (diff < minDiff) {
        closest = hour;
        minDiff = diff;
      }
    }
    return {
      available: true,
      source,
      mode,
      current: closest,
      units: unitsFor(isEnglish),
      errors,
    };
  }

  return {
    available: true,
    source,
    mode,
    prediction: { hourly },
    units: unitsFor(isEnglish),
    errors,
  };
}
