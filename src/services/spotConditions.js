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
import { getNoaaCoops } from './dataSource/noaaCoops.js';
import { getNoaaNdbc } from './dataSource/noaaNdbc.js';
import { getStormglass } from './dataSource/stormglass.js';
import {
  nearestCoopsTideStation,
  nearestCoopsCurrentStation,
  nearestNdbcStation,
} from './stations.js';

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

/** 取第一个非空值(coops 优先、源兜底的取值器)*/
function pick(...vals) {
  for (const v of vals) if (v != null) return v;
  return null;
}

/**
 * nws 风速单位 → 统一口径:english=节(knots),metric=米/秒(m/s)。
 * nws 原生:english=mph,metric=km/h。coops 原生已是节/(m·s),无需换算。
 * 仅在 coops 缺、用 nws 兜底时调用,避免单位混用。
 */
function nwsWindToCanon(v, unitSystem) {
  if (v == null) return null;
  const val = unitSystem === 'metric' ? v / 3.6 : v * 0.868976; // km/h→m/s / mph→knots
  return Math.round(val * 100) / 100;
}

/**
 * 组装"现在"快照(拍平,来源见注释)。取值规则:
 *   风/温/阵风:coops 实测优先 → nws 兜底(风速已统一单位)
 *   水温:stormglass 优先 → coops → ndbc 兜底
 *   浪高/浪周期/浪向:每个字段独立 stormglass → nws → ndbc 兜底
 *   天气描述/降雨/雷暴/警报:仅 nws
 * 时间转钓点本地时。
 */
function coopsCurrentToCanon(v, unitSystem) {
  if (v == null) return null;
  return unitSystem === 'metric' ? Math.round((v / 100) * 100) / 100 : v; // cm/s → m/s
}

function selectWaveFields(sources) {
  const select = (field) => {
    for (const source of sources) {
      if (source[field] != null) {
        return { value: source[field], source: source.source, observedAt: source.observedAt ?? null };
      }
    }
    return { value: null, source: null, observedAt: null };
  };

  const height = select('height');
  const period = select('period');
  const direction = select('direction');
  const selected = [height, period, direction].filter((field) => field.value != null);
  const sourceNames = [...new Set(selected.map((field) => field.source))];
  const observedTimes = [...new Set(selected.map((field) => field.observedAt).filter(Boolean))];

  return {
    height: height.value,
    period: period.value,
    direction: direction.value,
    heightSource: height.source,
    periodSource: period.source,
    directionSource: direction.source,
    heightObservedAt: height.observedAt,
    periodObservedAt: period.observedAt,
    directionObservedAt: direction.observedAt,
    source: sourceNames.length === 1 ? sourceNames[0] : sourceNames.length > 1 ? 'Mixed' : null,
    observedAt: observedTimes.length === 1 ? observedTimes[0] : null,
  };
}

export function selectCurrentWave(stormglassCurrent, nwsCurrent, ndbc) {
  return selectWaveFields([
    {
      height: stormglassCurrent?.waveHeight ?? null,
      period: stormglassCurrent?.wavePeriod ?? null,
      direction: stormglassCurrent?.waveDirection ?? null,
      source: 'Stormglass',
      observedAt: stormglassCurrent?.time ?? null,
    },
    {
      height: nwsCurrent?.waveHeight ?? null,
      period: nwsCurrent?.wavePeriod ?? null,
      direction: nwsCurrent?.waveDirection ?? null,
      source: 'NWS',
      observedAt: nwsCurrent?.time ?? null,
    },
    {
      height: ndbc?.waveHeight ?? null,
      period: ndbc?.wavePeriod ?? null,
      direction: ndbc?.waveDirection ?? null,
      source: 'NOAA NDBC',
      observedAt: ndbc?.observedAt ?? null,
    },
  ]);
}

function buildCurrent(coops, nws, ndbc, stormglass, tz, unitSystem) {
  const c = coops?.current || null; // coops 实测快照
  const n = nws?.current || null; // nws 当前小时
  const w = c?.wind || null;
  const sg = stormglass?.current || null; // stormglass 水温/潮流/海浪
  const wave = selectCurrentWave(sg, n, ndbc);

  return {
    observedAt: toLocal(c?.time, tz) || toLocal(n?.time, tz) || toLocal(sg?.time, tz) || toLocal(ndbc?.observedAt, tz),

    // ── 潮位(coops 实测,含气象余差)──
    waterLevel: c?.waterLevel ?? null,

    // ── 温度 ──
    airTemp: pick(c?.airTemp, n?.temperature), // coops 实测 → nws 兜底
    waterTemp: pick(sg?.waterTemperature, c?.waterTemp, ndbc?.seaSurfaceTemp), // stormglass → coops → ndbc
    airPressure: c?.airPressure ?? null, // 仅 coops

    // ── 风(coops 优先 → nws 兜底;speed/gust 统一单位)──
    wind: {
      speed: pick(w?.speed, nwsWindToCanon(n?.windSpeed, unitSystem)),
      direction: w?.direction ?? null, // 度数仅 coops
      cardinal: pick(w?.cardinal, n?.windDirection), // 方位词
      gust: pick(w?.gust, nwsWindToCanon(n?.windGust, unitSystem)),
    },

    // ── 天气(仅 nws)──
    shortForecast: n?.shortForecast ?? null,
    precipitationProbability: n?.precipitationProbability ?? null,
    thunderstormProbability: n?.thunderstormProbability ?? null,

    // ── 浪:每个字段独立 Stormglass → NWS → NDBC 兜底 ──
    waveHeight: wave.height,
    wavePeriod: wave.period,
    waveDirection: wave.direction,
    waveHeightSource: wave.heightSource,
    wavePeriodSource: wave.periodSource,
    waveDirectionSource: wave.directionSource,
    waveHeightObservedAt: toLocal(wave.heightObservedAt, tz),
    wavePeriodObservedAt: toLocal(wave.periodObservedAt, tz),
    waveDirectionObservedAt: toLocal(wave.directionObservedAt, tz),
    waveSource: wave.source,
    waveObservedAt: toLocal(wave.observedAt, tz),

    // ── 潮流(stormglass 优先 → coops 兜底)──
    tidalCurrentSpeed: pick(sg?.currentSpeed, coopsCurrentToCanon(c?.tidalCurrentSpeed, unitSystem)),
    tidalCurrentDirection: pick(sg?.currentDirection, c?.tidalCurrentDirection),

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
 * 把 coops.prediction 的高低潮极值整理成**按时间排序的事件清单**(而非 first/second 命名,避免歧义)。
 * 返回 [{ type:'High'|'Low', time(本地), height }, ...],按时间升序。空则 []。
 * "下一次高潮" = 清单里 type='High' 且时间晚于当前时间的第一条(由分析层判断)。
 */
function localizeExtremes(pred, tz, filterDate = null) {
  let evs = [];
  if (Array.isArray(pred?.extremes) && pred.extremes.length) {
    // 首选 coops 返回的【全部】事件
    evs = pred.extremes
      .filter((e) => e && e.time)
      .map((e) => ({ type: e.type, _utc: e.time, time: toLocal(e.time, tz), height: e.height }));
  } else {
    // 兜底:旧的 first/second 字段
    const add = (e, type) => {
      if (e && e.time) evs.push({ type, _utc: e.time, time: toLocal(e.time, tz), height: e.height });
    };
    add(pred?.firstHighTide, 'High');
    add(pred?.secondHighTide, 'High');
    add(pred?.firstLowTide, 'Low');
    add(pred?.secondLowTide, 'Low');
  }
  evs.sort((a, b) => new Date(a._utc) - new Date(b._utc));
  let out = evs.map(({ type, time, height }) => ({ type, time, height })); // 去掉内部 _utc
  // filterDate('YYYY-MM-DD',钓点本地日期):只保留当天事件(未来某天=当天 0点–24点)
  if (filterDate) out = out.filter((e) => typeof e.time === 'string' && e.time.slice(0, 10) === filterDate);
  return out;
}

/** 就近解析潮汐/潮流站；只有 current 需要额外解析 NDBC 浮标。 */
async function resolveStations(lat, lng, errors, { includeBuoy = true } = {}) {
  const [tideStation, currentStation, buoyStation] = await Promise.all([
    settle('coopsTideStation', nearestCoopsTideStation(lat, lng), errors),
    settle('coopsCurrentStation', nearestCoopsCurrentStation(lat, lng), errors),
    includeBuoy
      ? settle('ndbcStation', nearestNdbcStation(lat, lng), errors)
      : Promise.resolve(null),
  ]);
  return { tideStation, currentStation, buoyStation };
}

// ----------------------------------------------------------------------------
// tool: queryCurrentWeather —— "现在这里怎么样"的实测快照
// ----------------------------------------------------------------------------
/**
 * 组装未来预测时间线(拍平,来源见注释)。
 *   时间轴:coops / nws / stormglass 三源小时并集，任何来源都能独立形成行。
 *   潮位来自 coops；天气/风来自 nws；水温来自 stormglass；潮流和海浪逐字段优先
 *   stormglass，再使用各自可用的 NOAA/NWS 字段兜底。
 *   风速统一成节/(m·s),与 current 块口径一致。
 *   tideExtremes(未来窗口高低潮)来自 coops;alerts 来自 nws。
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

function selectPredictedWave(stormglassHour, nwsHour) {
  return selectWaveFields([
    {
      height: stormglassHour?.waveHeight ?? null,
      period: stormglassHour?.wavePeriod ?? null,
      direction: stormglassHour?.waveDirection ?? null,
      source: 'Stormglass',
      observedAt: stormglassHour?.time ?? null,
    },
    {
      height: nwsHour?.waveHeight ?? null,
      period: nwsHour?.wavePeriod ?? null,
      direction: nwsHour?.waveDirection ?? null,
      source: 'NWS',
      observedAt: nwsHour?.time ?? null,
    },
  ]);
}

export function buildPredict(coops, nws, stormglass, tz, unitSystem, filterDate = null) {
  const cMap = hourlyMap(coops?.prediction?.hourly);
  const nMap = hourlyMap(nws?.prediction?.hourly);
  const sgMap = hourlyMap(stormglass?.prediction?.hourly);

  // 三个来源都能独立形成时间轴。使用并集，避免某个来源失败或覆盖时段不同时丢数据。
  const keys = [...new Set([...cMap.keys(), ...nMap.keys(), ...sgMap.keys()])].sort();

  const hourly = keys
    .map((key) => {
      const c = cMap.get(key) || {};
      const n = nMap.get(key) || {};
      const sg = sgMap.get(key) || {};
      const localTime = toLocal(key, tz);
      const wave = selectPredictedWave(sg, n);
      return {
        time: localTime,
        // ── 潮位(coops)──
        waterLevel: c.waterLevel ?? null,
        // ── 天气/风(nws);风速统一单位 ──
        temperature: n.temperature ?? null,
        windSpeed: nwsWindToCanon(n.windSpeed, unitSystem),
        windDirection: n.windDirection ?? null,
        windGust: nwsWindToCanon(n.windGust, unitSystem),
        precipitationProbability: n.precipitationProbability ?? null,
        thunderstormProbability: n.thunderstormProbability ?? null,
        shortForecast: n.shortForecast ?? null,
        // ── 潮流(stormglass 优先 → coops 兜底;metric CO-OPS cm/s → m/s)──
        tidalCurrentSpeed: pick(sg.currentSpeed, coopsCurrentToCanon(c.speed, unitSystem)),
        tidalCurrentDirection: pick(sg.currentDirection, c.direction),
        // ── 水温(stormglass)──
        waterTemperature: sg.waterTemperature ?? null,
        // ── 浪:每个字段独立 Stormglass → NWS 兜底 ──
        waveHeight: wave.height,
        wavePeriod: wave.period,
        waveDirection: wave.direction,
        waveHeightSource: wave.heightSource,
        wavePeriodSource: wave.periodSource,
        waveDirectionSource: wave.directionSource,
        waveSource: wave.source,
      };
    })
    .filter((entry) => !filterDate || entry.time?.slice(0, 10) === filterDate);

  return {
    // 未来窗口内高低潮(时间转本地;未来某天按 filterDate 过滤到当天 0–24 点)
    tideExtremes: localizeExtremes(coops?.prediction, tz, filterDate),
    hourly,
    alerts: nws?.alerts || [],
    units:
      unitSystem === 'metric'
        ? { waterLevel: 'm', tidalCurrentSpeed: 'm/s', waterTemperature: 'degC', temp: 'degC', windSpeed: 'm/s', waveHeight: 'm', wavePeriod: 's', direction: 'deg' }
        : { waterLevel: 'ft', tidalCurrentSpeed: 'knots', waterTemperature: 'degF', temp: 'degF', windSpeed: 'knots', waveHeight: 'ft', wavePeriod: 's', direction: 'deg' },
  };
}

export async function getCurrentConditions(lat, lng, { name = null, note = null, unitSystem = 'english' } = {}) {
  assertCoordinates(lat, lng);
  const units = normalizeUnitSystem(unitSystem);
  const errors = [];

  // 不依赖站点的来源立即并发启动；CO-OPS/NDBC 等站点解析完成后再启动。
  const stationsPromise = resolveStations(lat, lng, errors);
  const stormglassPromise = settle('stormglass', getStormglass(lat, lng, { mode: 'current', unitSystem: units }), errors);
  const nwsPromise = settle('nationalWeatherService', getNationalWeatherService(lat, lng, { mode: 'current', unitSystem: units }), errors);
  const astronomyPromise = settle('astronomy', getAstronomy(lat, lng, {}), errors);
  const bathymetryPromise = settle('noaaBathymetry', getNoaaBathymetry(lat, lng, { unitSystem: units }), errors);
  const usgsPromise = settle('usgsWaterData', getUsgsWaterData(lat, lng, { mode: 'current', unitSystem: units }), errors);

  const { tideStation, currentStation, buoyStation } = await stationsPromise;
  const [stormglass, nws, coops, coopsTide, ndbc, astronomy, bathymetry, usgs] = await Promise.all([
    stormglassPromise,
    nwsPromise,
    settle('noaaCoops', getNoaaCoops(lat, lng, { tideStation, currentStation, mode: 'current', unitSystem: units }), errors),
    settle('noaaCoopsTide', getNoaaCoops(lat, lng, { tideStation, currentStation, mode: 'prediction', unitSystem: units }), errors),
    settle('noaaNdbc', getNoaaNdbc(lat, lng, { buoyStation, mode: 'current', unitSystem: units }), errors),
    astronomyPromise,
    bathymetryPromise,
    usgsPromise,
  ]);

  collectSourceErrors(errors, stormglass, nws, coops, coopsTide, ndbc, astronomy, bathymetry, usgs);
  const timezone = nws?.timezone || DEFAULT_TIMEZONE;
  return {
    name,
    note,
    latitude: lat,
    longitude: lng,
    currentTime: toLocal(new Date().toISOString(), timezone),
    tideExtremes: localizeExtremes(coopsTide?.prediction, timezone),
    currentTideAndWeather: buildCurrent(coops, nws, ndbc, stormglass, timezone, units),
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
  const coopsDate = isFutureDay ? targetDate : undefined;
  const coopsHours = isFutureDay ? 30 : 24;

  // 预测不需要 NDBC；其余不依赖站点的来源与站点解析同时启动。
  const stationsPromise = resolveStations(lat, lng, errors, { includeBuoy: false });
  const stormglassPromise = settle(
    'stormglass',
    getStormglass(lat, lng, { mode: 'prediction', unitSystem: units, date: isFutureDay ? targetDate : undefined }),
    errors
  );
  const nwsPromise = settle(
    'nationalWeatherService',
    getNationalWeatherService(lat, lng, { mode: 'prediction', unitSystem: units, date: isFutureDay ? targetDate : undefined }),
    errors
  );
  const astronomyPromise = settle('astronomy', getAstronomy(lat, lng, { date: targetDate }), errors);
  const bathymetryPromise = settle('noaaBathymetry', getNoaaBathymetry(lat, lng, { unitSystem: units }), errors);
  const usgsPromise = settle('usgsWaterData', getUsgsWaterData(lat, lng, { mode: 'current', unitSystem: units }), errors);

  const { tideStation, currentStation } = await stationsPromise;
  const [stormglass, nws, coops, astronomy, bathymetry, usgs] = await Promise.all([
    stormglassPromise,
    nwsPromise,
    settle(
      'noaaCoops',
      getNoaaCoops(lat, lng, { tideStation, currentStation, date: coopsDate, hours: coopsHours, mode: 'prediction', unitSystem: units }),
      errors
    ),
    astronomyPromise,
    bathymetryPromise,
    usgsPromise,
  ]);

  collectSourceErrors(errors, stormglass, nws, coops, astronomy, bathymetry, usgs);
  const timezone = nws?.timezone || DEFAULT_TIMEZONE;
  return {
    name,
    note,
    latitude: lat,
    longitude: lng,
    date: astronomy?.date || targetDate || null,
    currentTime: toLocal(new Date().toISOString(), timezone),
    predictTideAndWeather: buildPredict(coops, nws, stormglass, timezone, units, isFutureDay ? targetDate : null),
    common: buildCommon(astronomy, bathymetry, usgs, timezone),
    errors,
  };
}
