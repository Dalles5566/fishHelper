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
import {
  nearestCoopsTideStation,
  nearestCoopsCurrentStation,
  nearestNdbcStation,
} from './stations.js';

/** 安全执行:未预期抛错收进 errors,返回兜底对象而非崩溃 */
async function settle(label, promise, errors) {
  try {
    return await promise;
  } catch (err) {
    errors.push({ source: label, message: err.message });
    return { available: false, source: label, reason: err.message };
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
 *   水温:coops 优先 → ndbc(海表温)兜底
 *   浪高/浪周期:nws 优先 → ndbc 兜底;浪向仅 ndbc
 *   天气描述/降雨/雷暴/警报:仅 nws
 * 时间转钓点本地时。
 */
function buildCurrent(coops, nws, ndbc, tz, unitSystem) {
  const c = coops?.current || null; // coops 实测快照
  const n = nws?.current || null; // nws 当前小时
  const w = c?.wind || null;

  return {
    observedAt: toLocal(c?.time, tz) || toLocal(n?.time, tz),

    // ── 潮位(coops 实测,含气象余差)──
    waterLevel: c?.waterLevel ?? null,

    // ── 温度 ──
    airTemp: pick(c?.airTemp, n?.temperature), // coops 实测 → nws 兜底
    waterTemp: pick(c?.waterTemp, ndbc?.seaSurfaceTemp), // coops → ndbc 海表温兜底
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

    // ── 浪(nws 预报优先 → ndbc 实测兜底;浪向仅 ndbc)──
    waveHeight: pick(n?.waveHeight, ndbc?.waveHeight),
    wavePeriod: pick(n?.wavePeriod, ndbc?.wavePeriod),
    waveDirection: ndbc?.waveDirection ?? null,

    // ── 警报(仅 nws)──
    alerts: nws?.alerts || [],

    // 单位口径(合并后统一)
    units:
      unitSystem === 'metric'
        ? { waterLevel: 'm', temp: 'degC', airPressure: 'hPa', windSpeed: 'm/s', waveHeight: 'm', wavePeriod: 's', direction: 'deg' }
        : { waterLevel: 'ft', temp: 'degF', airPressure: 'hPa', windSpeed: 'knots', waveHeight: 'ft', wavePeriod: 's', direction: 'deg' },
  };
}

/**
 * 把 coops.prediction 的高低潮极值整理成**按时间排序的事件清单**(而非 first/second 命名,避免歧义)。
 * 返回 [{ type:'High'|'Low', time(本地), height }, ...],按时间升序。空则 []。
 * "下一次高潮" = 清单里 type='High' 且时间晚于当前时间的第一条(由分析层判断)。
 */
function localizeExtremes(pred, tz) {
  const evs = [];
  const add = (e, type) => {
    if (e && e.time) evs.push({ type, _utc: e.time, time: toLocal(e.time, tz), height: e.height });
  };
  add(pred?.firstHighTide, 'High');
  add(pred?.secondHighTide, 'High');
  add(pred?.firstLowTide, 'Low');
  add(pred?.secondLowTide, 'Low');
  evs.sort((a, b) => new Date(a._utc) - new Date(b._utc));
  return evs.map(({ type, time, height }) => ({ type, time, height })); // 去掉内部 _utc
}

/** 就近解析三类站点(潮汐/潮流/浮标),一次解析、后续复用 */
async function resolveStations(lat, lng, errors) {
  const [tideStation, currentStation, buoyStation] = await Promise.all([
    settle('coopsTideStation', nearestCoopsTideStation(lat, lng), errors),
    settle('coopsCurrentStation', nearestCoopsCurrentStation(lat, lng), errors),
    settle('ndbcStation', nearestNdbcStation(lat, lng), errors),
  ]);
  return { tideStation, currentStation, buoyStation };
}

// ----------------------------------------------------------------------------
// tool: queryCurrentWeather —— "现在这里怎么样"的实测快照
// ----------------------------------------------------------------------------
/**
 * 组装未来预测时间线(拍平,来源见注释)。
 *   时间轴:coops 与 nws 逐小时时间的**交集**(保证每行时间一致、两源都有);
 *          若只有一个源有数据,则用它自己的时间轴。
 *   潮位/潮流来自 coops;温/风/浪/天气来自 nws(predict 两源不重叠,无兜底)。
 *   风速统一成节/(m·s),与 current 块口径一致。
 *   tideExtremes(未来窗口高低潮)来自 coops;alerts 来自 nws。
 */
function buildPredict(coops, nws, tz, unitSystem) {
  const cHourly = coops?.prediction?.hourly || [];
  const nHourly = nws?.prediction?.hourly || [];
  const cMap = new Map(cHourly.map((h) => [h.time, h]));
  const nMap = new Map(nHourly.map((h) => [h.time, h]));

  // 时间轴:两源都在 → 交集(时间完全对齐);否则退回可用那一侧
  let keys;
  if (cMap.size && nMap.size) keys = [...cMap.keys()].filter((k) => nMap.has(k));
  else keys = [...new Set([...cMap.keys(), ...nMap.keys()])];
  keys.sort();

  const hourly = keys.map((k) => {
    const c = cMap.get(k) || {};
    const n = nMap.get(k) || {};
    return {
      time: toLocal(k, tz),
      // ── 潮位(coops)──
      waterLevel: c.waterLevel ?? null,
      // ── 天气/风(nws);风速统一单位 ──
      temperature: n.temperature ?? null,
      windSpeed: nwsWindToCanon(n.windSpeed, unitSystem),
      windDirection: n.windDirection ?? null,
      // ── 潮流(coops,常 null;仅谐波潮流站有)紧跟风向 ──
      tidalCurrentSpeed: c.speed ?? null,
      tidalCurrentDirection: c.direction ?? null,
      windGust: nwsWindToCanon(n.windGust, unitSystem),
      precipitationProbability: n.precipitationProbability ?? null,
      thunderstormProbability: n.thunderstormProbability ?? null,
      waveHeight: n.waveHeight ?? null,
      wavePeriod: n.wavePeriod ?? null,
      shortForecast: n.shortForecast ?? null,
    };
  });

  return {
    // 未来窗口内高低潮(时间转本地)
    tideExtremes: localizeExtremes(coops?.prediction, tz),
    hourly,
    alerts: nws?.alerts || [],
    units:
      unitSystem === 'metric'
        ? { waterLevel: 'm', tidalCurrentSpeed: 'cm/s', temp: 'degC', windSpeed: 'm/s', waveHeight: 'm', wavePeriod: 's', direction: 'deg' }
        : { waterLevel: 'ft', tidalCurrentSpeed: 'knots', temp: 'degF', windSpeed: 'knots', waveHeight: 'ft', wavePeriod: 's', direction: 'deg' },
  };
}

export async function getCurrentConditions(lat, lng, { name = null, note = null, unitSystem = 'english' } = {}) {
  const errors = [];
  const { tideStation, currentStation, buoyStation } = await resolveStations(lat, lng, errors);

  // 各源并发。coops 拉两次:current(实测快照)+ prediction(仅为拿"下一次高低潮")
  const [nws, coops, coopsTide, ndbc, astronomy, bathymetry, usgs] = await Promise.all([
    settle('nationalWeatherService', getNationalWeatherService(lat, lng, { mode: 'current', unitSystem }), errors),
    settle('noaaCoops', getNoaaCoops(lat, lng, { tideStation, currentStation, mode: 'current', unitSystem }), errors),
    settle('noaaCoopsTide', getNoaaCoops(lat, lng, { tideStation, currentStation, mode: 'prediction', unitSystem }), errors),
    settle('noaaNdbc', getNoaaNdbc(lat, lng, { buoyStation, mode: 'current', unitSystem }), errors),
    settle('astronomy', getAstronomy(lat, lng, {}), errors),
    settle('noaaBathymetry', getNoaaBathymetry(lat, lng, { unitSystem }), errors),
    settle('usgsWaterData', getUsgsWaterData(lat, lng, { mode: 'current', unitSystem }), errors),
  ]);

  const timezone = nws?.timezone || null; // 内部转本地时用;不再作为顶层字段输出
  return {
    name, // 钓点名(来自数据库,裸坐标查询时为 null)
    note, // 钓点备注(来自数据库)
    latitude: lat,
    longitude: lng,
    currentTime: toLocal(new Date().toISOString(), timezone), // 请求当下的钓点本地时间
    // 下一次高低潮(即使问"现在"也附上,方便报"下一次涨潮几点、潮位多少")
    tideExtremes: localizeExtremes(coopsTide?.prediction, timezone),
    currentTideAndWeather: buildCurrent(coops, nws, ndbc, timezone, unitSystem),
    common: buildCommon(astronomy, bathymetry, usgs, timezone),
    errors,
  };
}

// ----------------------------------------------------------------------------
// tool: predictWeather —— "未来某天/等下怎样、涨还是退"的预测
// ----------------------------------------------------------------------------
export async function getPredictConditions(lat, lng, { name = null, note = null, date, unitSystem = 'english' } = {}) {
  const errors = [];
  // 预测不用浮标(NDBC 无预报),只取潮汐/潮流站
  const { tideStation, currentStation } = await resolveStations(lat, lng, errors);

  // 预测源(coops 潮 + nws 天气)并发 + 常驻块
  const [nws, coops, astronomy, bathymetry, usgs] = await Promise.all([
    settle('nationalWeatherService', getNationalWeatherService(lat, lng, { mode: 'prediction', unitSystem }), errors),
    // hours=30:从目标日 UTC 0点起拉 30h,确保覆盖目标日本地 00:00–24:00 全天潮汐(含晚间)
    settle('noaaCoops', getNoaaCoops(lat, lng, { tideStation, currentStation, date, hours: 30, mode: 'prediction', unitSystem }), errors),
    settle('astronomy', getAstronomy(lat, lng, { date }), errors),
    settle('noaaBathymetry', getNoaaBathymetry(lat, lng, { unitSystem }), errors),
    settle('usgsWaterData', getUsgsWaterData(lat, lng, { mode: 'current', unitSystem }), errors),
  ]);

  const timezone = nws?.timezone || null; // 内部转本地时用;不再作为顶层字段输出
  return {
    name, // 钓点名(来自数据库,裸坐标查询时为 null)
    note, // 钓点备注(来自数据库)
    latitude: lat,
    longitude: lng,
    date: astronomy?.date || null,
    currentTime: toLocal(new Date().toISOString(), timezone), // 请求当下的钓点本地时间
    predictTideAndWeather: buildPredict(coops, nws, timezone, unitSystem),
    common: buildCommon(astronomy, bathymetry, usgs, timezone),
    errors,
  };
}
