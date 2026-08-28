// ============================================================================
// SpotConditions 编排层 —— 把各数据源"挑选 + 重组",给上层两个 tool 用
// ----------------------------------------------------------------------------
// 两个入口(对应 AI 的两个 tool,AI 按问题自己选):
//
//   getCurrentConditions(lat, lng, { name, note, unitSystem })  → tool: getCurrentWeather
//     回答"现在这里怎么样":实测潮位/天气/风/浪快照 + 下一次高低潮(tideExtremes)。
//     { name, note, latitude, longitude, currentTime, tideExtremes,
//       currentTideAndWeather:{...}, common:{...}, errors:[] }
//
//   getPredictConditions(lat, lng, { name, note, date, unitSystem })  → tool: predictWeather
//     回答"未来某天/等下怎样、涨还是退":逐小时时间线 + 高低潮。
//     { name, note, latitude, longitude, date, currentTime,
//       predictTideAndWeather:{...}, common:{...}, errors:[] }
//
// options.name / options.note: 钓点名与备注,来自数据库(coordinates 表),上层查库后传入;
//   裸坐标查询时为 null。
// options.unitSystem: 'english'(默认,ft/knots/°F)| 'metric'(m/(m·s)/°C)
// 时区/单位不在顶层输出:时间已带本地偏移(如 -04:00),各块自带 units。
//
// 【common(常驻块,两个入口共用)】astronomy / bathymetry / usgs 挑出的字段**扁平**放一起:
//     astronomy → sunrise/sunset/moonrise/moonset/moonPhase/moonIllumination
//     bathymetry → locationDepth
//     usgs → riverDischarge/gaugeHeight/riverTemperature
// 【时间】各数据源层用 UTC,本层统一用 toLocal() 转成钓点本地时。
// ============================================================================
import { getAstronomy } from './dataSource/astronomy.js';
import { getUsgsWaterData } from './dataSource/usgsWaterData.js';
import { getNoaaBathymetry } from './dataSource/noaaBathymetry.js';
import { getNationalWeatherService } from './dataSource/nationalWeatherService.js';
import { getStormglass } from './dataSource/stormglass.js';
import { getWorldTides } from './dataSource/worldTides.js';

export const DEFAULT_TIMEZONE = 'America/New_York';
const MAX_FORECAST_DAYS = 7;

function assertCoordinates(lat, lng) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError('latitude must be a finite number between -90 and 90');
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new RangeError('longitude must be a finite number between -180 and 180');
  }
}

function normalizeUnitSystem(unitSystem) {
  if (unitSystem !== 'english' && unitSystem !== 'metric') {
    throw new TypeError("unitSystem must be 'english' or 'metric'");
  }
  return unitSystem;
}

/** 严格验证 YYYY-MM-DD，并限制在 NWS 可用的 7 天预测窗口内。 */
export function validatePredictionDate(date, now = new Date()) {
  if (date == null || date === '') return null;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TypeError('date must use YYYY-MM-DD format');
  }
  const target = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(target.getTime()) || target.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`invalid calendar date: ${date}`);
  }
  const todayText = now.toLocaleDateString('en-CA', { timeZone: DEFAULT_TIMEZONE });
  const today = new Date(`${todayText}T00:00:00Z`);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) throw new RangeError(`prediction date ${date} is in the past`);
  if (diffDays > MAX_FORECAST_DAYS) {
    throw new RangeError(`prediction date ${date} is beyond the ${MAX_FORECAST_DAYS}-day forecast window`);
  }
  return date;
}

function recordError(errors, error) {
  const normalized = {
    ...error,
    source: String(error?.source || 'unknown'),
    message: String(error?.message || 'unknown error').slice(0, 500),
  };
  const duplicate = errors.some(
    (item) => item.source === normalized.source && item.step === normalized.step && item.message === normalized.message
  );
  if (!duplicate) errors.push(normalized);
}

/** 把数据源自行捕获的错误上浮到最终 conditions.errors。 */
export function collectSourceErrors(errors, ...results) {
  for (const result of results) {
    for (const error of result?.errors || []) {
      recordError(errors, { ...error, source: error.source || result.source || 'unknown' });
    }
  }
}

/** 安全执行:未预期抛错收进 errors,返回兜底对象而非崩溃 */
async function settle(label, promise, errors) {
  try {
    return await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordError(errors, { source: label, message });
    return { available: false, source: label, reason: message, errors: [] };
  }
}

/**
 * UTC ISO8601("...Z") → 钓点本地时 ISO8601(带偏移,如 "2026-07-24T05:32:34-04:00")。
 * tz 为 IANA 时区名(如 "America/New_York");无 tz 时原样返回 UTC。
 * 用 Intl 拿到该时刻在该时区的本地"墙上时间"和偏移量,自动处理夏令时。
 */
function toLocal(utcIso, tz) {
  if (!utcIso) return null;
  if (!tz) return utcIso;
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return utcIso;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
    .formatToParts(d)
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  // 偏移量 = 本地墙上时间(当成 UTC)- 实际 UTC
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offMin = Math.round((asUtc - d.getTime()) / 60000);
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${oh}:${om}`;
}

/** 组装常驻块(扁平;字段来源见注释)。时间用 tz 转成钓点本地时 */
function buildCommon(astronomy, bathymetry, usgs, tz) {
  return {
    // ── 日月(astronomy / suncalc)时间转本地 ──
    sunrise: toLocal(astronomy?.sunrise, tz),
    sunset: toLocal(astronomy?.sunset, tz),
    moonrise: toLocal(astronomy?.moonrise, tz),
    moonset: toLocal(astronomy?.moonset, tz),
    moonPhase: astronomy?.moonPhase ?? null, // { value(0..1), name(英), nameZh(中) };满月/新月≈大潮
    moonIllumination: astronomy?.moonIllumination ?? null, // 月照率 %(满月→大潮、鱼口活跃;非能见度)

    // ── 水深(NOAA NCEI DEM)──
    locationDepth: bathymetry?.depth ?? null,

    // ── 河流(USGS Water Data,海钓多为 null)──
    riverDischarge: usgs?.riverDischarge ?? null,
    gaugeHeight: usgs?.gaugeHeight ?? null,
    riverTemperature: usgs?.waterTemperature ?? null, // 河流水温(区别于海水水温)
  };
}

/**
 * 组装"现在"快照(拍平,来源见注释)。取值规则:
 *   气温/风/阵风/气压/水温/潮流/浪:Stormglass(无兜底)
 *   潮位/高低潮:WorldTides
 *   天气描述/降雨/雷暴/警报:仅 NWS
 * 时间转钓点本地时。
 */
/** 度数 → 方位词 (N/NE/E/SE/S/SW/W/NW);无效返回 null */
function degToCardinal(deg) {
  if (deg == null || !Number.isFinite(Number(deg))) return null;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const normalized = ((Number(deg) % 360) + 360) % 360;
  return dirs[Math.round(normalized / 45) % 8];
}

/** 从逐时潮位里取最接近当前时刻的一条 waterLevel。 */
function nearestWaterLevel(hourly, now = Date.now()) {
  if (!Array.isArray(hourly) || !hourly.length) return { level: null, time: null };
  let best = null;
  let bestDiff = Infinity;
  for (const h of hourly) {
    const t = Date.parse(h.time);
    if (Number.isNaN(t) || h.waterLevel == null) continue;
    const diff = Math.abs(t - now);
    if (diff < bestDiff) { bestDiff = diff; best = h; }
  }
  return best ? { level: best.waterLevel, time: best.time } : { level: null, time: null };
}

function buildCurrent(worldTides, nws, stormglass, tz, unitSystem) {
  const n = nws?.current || null; // nws 当前小时(天气/降雨/雷暴/警报)
  const sg = stormglass?.current || null; // stormglass 水温/潮流/浪/气温/风/气压
  const wl = nearestWaterLevel(worldTides?.prediction?.hourly);

  return {
    observedAt: toLocal(sg?.time, tz) || toLocal(n?.time, tz),

    // ── 潮位(WorldTides,取最接近当前时刻)──
    waterLevel: wl.level,

    // ── 温度(气温=stormglass;水温=stormglass)──
    airTemp: sg?.airTemperature ?? null,
    waterTemp: sg?.waterTemperature ?? null,
    airPressure: sg?.pressure ?? null, // stormglass

    // ── 风(stormglass;cardinal 由度数换算)──
    wind: {
      speed: sg?.windSpeed ?? null,
      direction: sg?.windDirection ?? null,
      cardinal: degToCardinal(sg?.windDirection),
      gust: sg?.windGust ?? null,
    },

    // ── 天气(仅 nws)──
    shortForecast: n?.shortForecast ?? null,
    precipitationProbability: n?.precipitationProbability ?? null,
    thunderstormProbability: n?.thunderstormProbability ?? null,

    // ── 浪(仅 stormglass,无兜底)──
    waveHeight: sg?.waveHeight ?? null,
    wavePeriod: sg?.wavePeriod ?? null,
    waveDirection: sg?.waveDirection ?? null,

    // ── 潮流(仅 stormglass,无兜底)──
    tidalCurrentSpeed: sg?.currentSpeed ?? null,
    tidalCurrentDirection: sg?.currentDirection ?? null,

    // ── 警报(仅 nws)──
    alerts: nws?.alerts || [],

    // 单位口径(合并后统一)
    units:
      unitSystem === 'metric'
        ? { waterLevel: 'm', temp: 'degC', airPressure: 'hPa', windSpeed: 'm/s', waveHeight: 'm', wavePeriod: 's', direction: 'deg', currentSpeed: 'm/s' }
        : { waterLevel: 'ft', temp: 'degF', airPressure: 'hPa', windSpeed: 'knots', waveHeight: 'ft', wavePeriod: 's', direction: 'deg', currentSpeed: 'knots' },
  };
}

/**
 * 把 WorldTides 的 extremes 整理成**按时间排序的事件清单**。
 * 返回 [{ type:'High'|'Low', time(本地), height }, ...],按时间升序。空则 []。
 * "下一次高潮" = 清单里 type='High' 且时间晚于当前时间的第一条(由分析层判断)。
 */
function localizeExtremes(pred, tz, filterDate = null) {
  const evs = (Array.isArray(pred?.extremes) ? pred.extremes : [])
    .filter((e) => e && e.time)
    .map((e) => ({ type: e.type, _utc: e.time, time: toLocal(e.time, tz), height: e.height }));
  evs.sort((a, b) => new Date(a._utc) - new Date(b._utc));
  let out = evs.map(({ type, time, height }) => ({ type, time, height })); // 去掉内部 _utc
  // filterDate('YYYY-MM-DD',钓点本地日期):只保留当天事件(未来某天=当天 0点–24点)
  if (filterDate) out = out.filter((e) => typeof e.time === 'string' && e.time.slice(0, 10) === filterDate);
  return out;
}

// ----------------------------------------------------------------------------
// tool: queryCurrentWeather —— "现在这里怎么样"的实测快照
// ----------------------------------------------------------------------------
/**
 * 组装未来预测时间线(拍平,来源见注释)。
 *   时间轴:worldTides / nws / stormglass 三源小时并集，任何来源都能独立形成行。
 *   潮位/高低潮来自 WorldTides；气温/风/气压/水温/潮流来自 Stormglass；
 *   天气描述/降雨/雷暴/警报来自 NWS；海浪逐字段 Stormglass → NWS 兜底。
 *   tideExtremes(未来窗口高低潮)来自 WorldTides;alerts 来自 nws。
 */
function normalizeHourKey(time) {
  if (!time) return null;
  const parsed = new Date(time);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 13) + ':00:00Z';
}

function hourlyMap(hourly) {
  const map = new Map();
  for (const entry of hourly || []) {
    const key = normalizeHourKey(entry?.time);
    if (key) map.set(key, entry);
  }
  return map;
}

export function buildPredict(worldTides, nws, stormglass, tz, unitSystem, filterDate = null) {
  const tMap = hourlyMap(worldTides?.prediction?.hourly); // WorldTides 逐时潮位
  const nMap = hourlyMap(nws?.prediction?.hourly);
  const sgMap = hourlyMap(stormglass?.prediction?.hourly);

  // 三个来源都能独立形成时间轴。使用并集，避免某个来源失败或覆盖时段不同时丢数据。
  const keys = [...new Set([...tMap.keys(), ...nMap.keys(), ...sgMap.keys()])].sort();

  const hourly = keys
    .map((key) => {
      const t = tMap.get(key) || {};
      const n = nMap.get(key) || {};
      const sg = sgMap.get(key) || {};
      const localTime = toLocal(key, tz);
      return {
        time: localTime,
        // ── 潮位(WorldTides)──
        waterLevel: t.waterLevel ?? null,
        // ── 气温/风(stormglass)──
        temperature: sg.airTemperature ?? null,
        windSpeed: sg.windSpeed ?? null,
        windDirection: sg.windDirection ?? null,
        windGust: sg.windGust ?? null,
        airPressure: sg.pressure ?? null,
        // ── 天气/降雨/雷暴(仅 nws)──
        precipitationProbability: n.precipitationProbability ?? null,
        thunderstormProbability: n.thunderstormProbability ?? null,
        shortForecast: n.shortForecast ?? null,
        // ── 潮流(仅 stormglass,无兜底)──
        tidalCurrentSpeed: sg.currentSpeed ?? null,
        tidalCurrentDirection: sg.currentDirection ?? null,
        // ── 水温(stormglass)──
        waterTemperature: sg.waterTemperature ?? null,
        // ── 浪(仅 stormglass,无兜底)──
        waveHeight: sg.waveHeight ?? null,
        wavePeriod: sg.wavePeriod ?? null,
        waveDirection: sg.waveDirection ?? null,
      };
    })
    .filter((entry) => !filterDate || entry.time?.slice(0, 10) === filterDate);

  return {
    // 未来窗口内高低潮(时间转本地;未来某天按 filterDate 过滤到当天 0–24 点)
    tideExtremes: localizeExtremes(worldTides?.prediction, tz, filterDate),
    hourly,
    alerts: nws?.alerts || [],
    units:
      unitSystem === 'metric'
        ? { waterLevel: 'm', tidalCurrentSpeed: 'm/s', waterTemperature: 'degC', temp: 'degC', airPressure: 'hPa', windSpeed: 'm/s', waveHeight: 'm', wavePeriod: 's', direction: 'deg' }
        : { waterLevel: 'ft', tidalCurrentSpeed: 'knots', waterTemperature: 'degF', temp: 'degF', airPressure: 'hPa', windSpeed: 'knots', waveHeight: 'ft', wavePeriod: 's', direction: 'deg' },
  };
}

export async function getCurrentConditions(lat, lng, { name = null, note = null, unitSystem = 'english' } = {}) {
  assertCoordinates(lat, lng);
  const units = normalizeUnitSystem(unitSystem);
  const errors = [];

  // 全部按坐标直查,无需站点解析,直接并发。
  const [stormglass, nws, worldTides, astronomy, bathymetry, usgs] = await Promise.all([
    settle('stormglass', getStormglass(lat, lng, { mode: 'current', unitSystem: units }), errors),
    settle('nationalWeatherService', getNationalWeatherService(lat, lng, { mode: 'current', unitSystem: units }), errors),
    settle('worldTides', getWorldTides(lat, lng, { unitSystem: units }), errors),
    settle('astronomy', getAstronomy(lat, lng, {}), errors),
    settle('noaaBathymetry', getNoaaBathymetry(lat, lng, { unitSystem: units }), errors),
    settle('usgsWaterData', getUsgsWaterData(lat, lng, { mode: 'current', unitSystem: units }), errors),
  ]);

  collectSourceErrors(errors, stormglass, nws, worldTides, astronomy, bathymetry, usgs);
  const timezone = nws?.timezone || DEFAULT_TIMEZONE;
  return {
    name,
    note,
    latitude: lat,
    longitude: lng,
    currentTime: toLocal(new Date().toISOString(), timezone),
    tideExtremes: localizeExtremes(worldTides?.prediction, timezone),
    currentTideAndWeather: buildCurrent(worldTides, nws, stormglass, timezone, units),
    common: buildCommon(astronomy, bathymetry, usgs, timezone),
    errors,
  };
}

// ----------------------------------------------------------------------------
// tool: predictWeather —— "未来某天/等下怎样、涨还是退"的预测
// ----------------------------------------------------------------------------
export async function getPredictConditions(lat, lng, { name = null, note = null, date, unitSystem = 'english' } = {}) {
  assertCoordinates(lat, lng);
  const units = normalizeUnitSystem(unitSystem);
  const targetDate = validatePredictionDate(date);
  const errors = [];

  const etToday = new Date().toLocaleDateString('en-CA', { timeZone: DEFAULT_TIMEZONE });
  const isFutureDay = !!targetDate && targetDate !== etToday;
  const tideHours = isFutureDay ? 30 : 24;

  // 全部按坐标直查,无需站点解析,直接并发。
  const [stormglass, nws, worldTides, astronomy, bathymetry, usgs] = await Promise.all([
    settle('stormglass', getStormglass(lat, lng, { mode: 'prediction', unitSystem: units, date: isFutureDay ? targetDate : undefined }), errors),
    settle('nationalWeatherService', getNationalWeatherService(lat, lng, { mode: 'prediction', unitSystem: units, date: isFutureDay ? targetDate : undefined }), errors),
    settle('worldTides', getWorldTides(lat, lng, { unitSystem: units, date: isFutureDay ? targetDate : undefined, hours: tideHours }), errors),
    settle('astronomy', getAstronomy(lat, lng, { date: targetDate }), errors),
    settle('noaaBathymetry', getNoaaBathymetry(lat, lng, { unitSystem: units }), errors),
    settle('usgsWaterData', getUsgsWaterData(lat, lng, { mode: 'current', unitSystem: units }), errors),
  ]);

  collectSourceErrors(errors, stormglass, nws, worldTides, astronomy, bathymetry, usgs);
  const timezone = nws?.timezone || DEFAULT_TIMEZONE;
  return {
    name,
    note,
    latitude: lat,
    longitude: lng,
    date: astronomy?.date || targetDate || null,
    currentTime: toLocal(new Date().toISOString(), timezone),
    predictTideAndWeather: buildPredict(worldTides, nws, stormglass, timezone, units, isFutureDay ? targetDate : null),
    common: buildCommon(astronomy, bathymetry, usgs, timezone),
    errors,
  };
}
