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
// 【Key 轮换】支持多 key(STORMGLASS_API_KEYS=key1,key2,key3):
//   402 表示日配额耗尽;429 按 Retry-After 短暂冷却;403 禁用无效 key。
//   round-robin + in-flight 计数避免并发请求同时冲击同一 key。
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
const PARAMS = 'waterTemperature,currentSpeed,currentDirection,waveHeight,wavePeriod,waveDirection';

// ── Key 轮换状态 ──
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const exhaustedSet = new Set(); // 402:当天配额耗尽
const invalidSet = new Set(); // 403:进程生命周期内禁用
const cooldownUntil = new Map(); // 429:短期限流恢复时间
const inFlight = new Map(); // 每个 key 当前并发数
let nextKeyIndex = 0;
let lastResetDay = todayUTC();
let activeKeys = null;

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function maybeResetDaily() {
  const today = todayUTC();
  if (today !== lastResetDay) {
    exhaustedSet.clear();
    cooldownUntil.clear();
    lastResetDay = today;
  }
}

function syncKeyConfiguration(keys) {
  if (keys === activeKeys) return;
  activeKeys = keys;
  exhaustedSet.clear();
  invalidSet.clear();
  cooldownUntil.clear();
  inFlight.clear();
  nextKeyIndex = 0;
}

function retryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const until = Date.parse(raw);
  return Number.isNaN(until) ? DEFAULT_RATE_LIMIT_COOLDOWN_MS : Math.max(1000, until - Date.now());
}

/** 选择当前负载最低的可用 key，并用 round-robin 打破同负载平局。 */
function selectKeyIndex(keys, attempted) {
  const now = Date.now();
  const candidates = [];
  for (let offset = 0; offset < keys.length; offset++) {
    const index = (nextKeyIndex + offset) % keys.length;
    if (attempted.has(index) || exhaustedSet.has(index) || invalidSet.has(index)) continue;
    if ((cooldownUntil.get(index) || 0) > now) continue;
    candidates.push({ index, load: inFlight.get(index) || 0, offset });
  }
  candidates.sort((a, b) => a.load - b.load || a.offset - b.offset);
  const selected = candidates[0]?.index;
  if (selected != null) nextKeyIndex = (selected + 1) % keys.length;
  return selected ?? null;
}

/**
 * 带并发协调的 key 轮换请求：
 * - 402 视为当天配额耗尽；403 视为无效 key；429 只按 Retry-After/短冷却暂停。
 * - round-robin + in-flight 负载避免并发请求同时冲击同一个 key。
 */
async function fetchWithKeyRotation(url, errors) {
  maybeResetDaily();
  const keys = config.stormglass?.apiKeys || [];
  syncKeyConfiguration(keys);

  if (!keys.length) {
    errors.push({ source: 'Stormglass', message: 'STORMGLASS_API_KEYS not configured' });
    return null;
  }

  const attempted = new Set();
  while (attempted.size < keys.length) {
    const index = selectKeyIndex(keys, attempted);
    if (index == null) break;
    attempted.add(index);
    inFlight.set(index, (inFlight.get(index) || 0) + 1);

    try {
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: keys[index] },
      });

      if (res.status === 402) {
        exhaustedSet.add(index);
        errors.push({ source: 'Stormglass', message: `Key #${index + 1} daily quota exhausted (HTTP 402)` });
        continue;
      }

      if (res.status === 429) {
        const waitMs = retryAfterMs(res);
        cooldownUntil.set(index, Date.now() + waitMs);
        errors.push({ source: 'Stormglass', message: `Key #${index + 1} rate limited; retry after ${Math.ceil(waitMs / 1000)}s` });
        continue;
      }

      if (res.status === 403) {
        invalidSet.add(index);
        errors.push({ source: 'Stormglass', message: `Key #${index + 1} returned 403 (invalid/expired)` });
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        errors.push({ source: 'Stormglass', message: `HTTP ${res.status}: ${text.slice(0, 200)}` });
        return null;
      }

      try {
        return await res.json();
      } catch (err) {
        errors.push({ source: 'Stormglass', message: `Invalid JSON response: ${err.message}` });
        return null;
      }
    } catch (err) {
      errors.push({ source: 'Stormglass', message: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      const remaining = Math.max(0, (inFlight.get(index) || 1) - 1);
      if (remaining) inFlight.set(index, remaining);
      else inFlight.delete(index);
    }
  }

  const state = exhaustedSet.size >= keys.length
    ? `所有 ${keys.length} 个 API key 今日配额均已耗尽`
    : '当前没有可用 API key（限流冷却或 key 无效）';
  errors.push({ source: 'Stormglass', message: state });
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
  return {
    time: hour.time,
    waterTemperature: isEnglish ? cToF(wt) : wt,
    currentSpeed: isEnglish ? msToKnots(cs) : cs,
    currentDirection: cd,
    waveHeight: isEnglish ? mToFt(wh) : wh,
    wavePeriod: wp,
    waveDirection: wd,
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
  ].some((value) => value != null);
}

function unitsFor(isEnglish) {
  return isEnglish
    ? { waterTemperature: 'degF', currentSpeed: 'knots', currentDirection: 'deg', waveHeight: 'ft', wavePeriod: 's', waveDirection: 'deg' }
    : { waterTemperature: 'degC', currentSpeed: 'm/s', currentDirection: 'deg', waveHeight: 'm', wavePeriod: 's', waveDirection: 'deg' };
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
  const body = await fetchWithKeyRotation(`${API_BASE}?${query}`, errors);

  if (!body) {
    return { available: false, source, reason: errors.at(-1)?.message || 'request failed', errors };
  }
  if (!Array.isArray(body.hours)) {
    errors.push({ source, message: 'Invalid response: hours must be an array' });
    return { available: false, source, reason: 'Invalid hours response', errors };
  }

  const isEnglish = unitSystem === 'english';
  const hourly = body.hours
    .map((hour) => normalizeHour(hour, isEnglish))
    .filter((hour) => hasMarineData(hour));
  if (!hourly.length) {
    return { available: false, source, reason: 'No usable marine data returned', errors };
  }

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
