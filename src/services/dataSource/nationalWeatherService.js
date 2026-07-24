// ============================================================================
// National Weather Service 数据源  (api.weather.gov)  ⚠️ 仅美国
// ----------------------------------------------------------------------------
// getNationalWeatherService(lat, lng, options) -> NationalWeatherServiceObject
//
// 【双模式,二选一】options.mode:
//   - 'prediction'(默认):未来逐小时预报(天气/风/阵风/降雨/雷暴/浪高/浪周期)
//        → prediction 有值,current = null
//   - 'current':当前小时的状况快照(同样字段,取"此刻")
//        → current 有值,prediction = null
//   两种模式的 alerts(活跃警报)都放在顶层,与模式无关。
//
// 【单位】options.unitSystem: 'english'(默认,°F/mph/ft)| 'metric'(°C/km·h⁻¹/m)。
//   - forecastHourly 支持 units=us/si(温度、风速跟着变)
//   - forecastGridData 恒为 SI(公制):阵风 km/h、浪高 m → 英制时代码换算
//
// 【浪从哪来?】NDBC 只有观测无预报;未来的浪高/浪周期来自 NWS 的 forecastGridData
//   (海洋/近岸网格点有 waveHeight/wavePeriod),合并进逐小时。
//
// 【实现要点】/points 坐标需 4 位小数(否则 301);逐小时 windSpeed 是 "7 mph" 字符串、
//   windDirection 是 "S" 方位词;阵风/雷暴/浪在 gridData(时间区间制,需按小时展开)。
// 【时间】统一 UTC。【调试】子请求 try/catch → errors[]。请求必须带 User-Agent。
// ============================================================================
import { config } from '../../config.js';

const FETCH_TIMEOUT_MS = 15000;
const KMH_TO_MPH = 0.621371;
const M_TO_FT = 3.28084;
const DEFAULT_HOURS = 24;

const UNIT_MAP = {
  metric: {
    temperature: 'degC', windSpeed: 'km/h', windGust: 'km/h', waveHeight: 'm',
    wavePeriod: 's', precipitationProbability: '%', thunderstormProbability: '%',
  },
  english: {
    temperature: 'degF', windSpeed: 'mph', windGust: 'mph', waveHeight: 'ft',
    wavePeriod: 's', precipitationProbability: '%', thunderstormProbability: '%',
  },
};

async function nwsFetch(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': config.nws.userAgent, Accept: 'application/geo+json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 带标签安全请求:出错记进 errors,返回 null */
async function safe(label, fn, errors) {
  try {
    return await fn();
  } catch (err) {
    errors.push({ step: label, message: err.message });
    return null;
  }
}

function round(n, d = 1) {
  if (n == null) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** 带偏移的时间 → UTC ISO8601(去毫秒);无效 → null */
function toUtc(t) {
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 某毫秒时间戳 → 整点键 "YYYY-MM-DDTHH:00:00Z" */
function hourKey(ms) {
  return new Date(ms).toISOString().slice(0, 13) + ':00:00Z';
}

/** 解析 NWS 风速 "7 mph" / "10 to 15 mph" → 数字(取上限);无则 null */
function parseWindSpeed(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.match(/(\d+)(?:\s*to\s*(\d+))?/);
  if (!m) return null;
  return m[2] ? Number(m[2]) : Number(m[1]);
}

/** ISO8601 duration(PT1H / P1DT14H)→ 毫秒 */
function durationToMs(dur) {
  const m = String(dur).match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
  if (!m) return 3600000;
  const [, d, h, min] = m;
  return ((Number(d || 0) * 24 + Number(h || 0)) * 60 + Number(min || 0)) * 60 * 1000 || 3600000;
}

/**
 * 把 gridData 的时间区间序列展开成 "整点 → 值" 映射。
 * gridData 每项 { validTime:"start/duration", value },一个值可能覆盖多个小时。
 * @param {function} conv 可选换算函数(如 km/h→mph)
 */
function expandSeries(series, conv = (v) => v) {
  const map = new Map();
  const values = series?.values;
  if (!Array.isArray(values)) return map;
  for (const v of values) {
    const [startStr, durStr] = String(v.validTime).split('/');
    const start = Date.parse(startStr);
    if (Number.isNaN(start)) continue;
    const end = start + durationToMs(durStr);
    for (let t = start; t < end; t += 3600000) {
      map.set(hourKey(t), v.value == null ? null : conv(v.value));
    }
  }
  return map;
}

const MARINE_EVENT_RE = /marine|small craft|hazardous seas|gale|storm warning|rip current|surf|beach|coastal/i;

export async function getNationalWeatherService(
  lat,
  lng,
  { mode = 'prediction', unitSystem = 'english', hours = DEFAULT_HOURS } = {}
) {
  const source = 'NWS';
  const errors = [];
  const units = UNIT_MAP[unitSystem] ? unitSystem : 'english';
  const isEnglish = units === 'english';

  try {
    // NWS 坐标精度上限 4 位小数
    const rlat = round(lat, 4);
    const rlng = round(lng, 4);
    const points = await safe('points', () => nwsFetch(`https://api.weather.gov/points/${rlat},${rlng}`), errors);
    if (!points) {
      // points 拿不到 = 非美国/无覆盖 → 整体不可用
      return { available: false, source, mode, reason: (errors[0] && errors[0].message) || 'points 失败', errors };
    }
    const p = points.properties;

    const result = {
      available: true,
      source,
      mode,
      grid: { office: p.gridId, gridX: p.gridX, gridY: p.gridY },
      timezone: p.timeZone || null, // IANA 时区(如 America/New_York),供上层本地化展示
      marineZone: p.forecastZone ? p.forecastZone.split('/').pop() : null, // 海区/陆区 zone id
      units: UNIT_MAP[units],
      alerts: [], // 活跃警报(顶层,与模式无关)
      prediction: null,
      current: null,
      errors,
    };

    // 逐小时预报(units=us/si 影响温度、风速)
    const hourlyUnits = isEnglish ? 'us' : 'si';
    const hourlyResp = await safe(
      'forecastHourly',
      () => nwsFetch(`${p.forecastHourly}?units=${hourlyUnits}`),
      errors
    );
    const periods = hourlyResp?.properties?.periods || [];

    // gridData:阵风/雷暴/浪。这些字段是"时间区间制"(一个值覆盖若干小时),
    // 用 expandSeries 展开成"整点 → 值"映射;英制时把 km/h→mph、m→ft。
    // 单独 try/catch:gridData 结构异常不应影响已经拿到的逐小时预报。
    let gustMap = new Map();
    let thunderMap = new Map();
    let waveMap = new Map();
    let wavePeriodMap = new Map();
    try {
      const grid = await safe('forecastGridData', () => nwsFetch(p.forecastGridData), errors);
      const gp = grid?.properties || {};
      gustMap = expandSeries(gp.windGust, (v) => (isEnglish ? round(v * KMH_TO_MPH) : round(v))); // 源 km/h
      thunderMap = expandSeries(gp.probabilityOfThunder); // %
      waveMap = expandSeries(gp.waveHeight, (v) => (isEnglish ? round(v * M_TO_FT, 2) : round(v, 2))); // 源 m
      wavePeriodMap = expandSeries(gp.wavePeriod); // s
    } catch (err) {
      errors.push({ step: 'gridData-parse', message: err.message });
    }

    // 把一条逐小时 period(NWS 原始)映射成我们的扁平结构,并合并 gridData 的阵风/雷暴/浪
    const buildEntry = (it) => {
      const time = toUtc(it.startTime);
      return {
        time,
        temperature: it.temperature ?? null,
        windSpeed: parseWindSpeed(it.windSpeed), // "7 mph"/"11 km/h" → 数字
        windDirection: it.windDirection || null, // 方位词 "S"
        windGust: gustMap.get(time) ?? null,
        precipitationProbability: it.probabilityOfPrecipitation?.value ?? null,
        thunderstormProbability: thunderMap.get(time) ?? null,
        waveHeight: waveMap.get(time) ?? null,
        wavePeriod: wavePeriodMap.get(time) ?? null,
        shortForecast: it.shortForecast || null,
      };
    };

    // 按模式填充 prediction 或 current(解析/映射单独 try/catch)
    try {
      if (mode === 'current') {
        // 取"此刻"所在的那一小时(找不到就用第一条)
        const now = Date.now();
        const cur =
          periods.find((it) => {
            const s = Date.parse(it.startTime);
            const e = Date.parse(it.endTime);
            return now >= s && now < e;
          }) || periods[0];
        result.current = cur ? buildEntry(cur) : null;
      } else {
        // 预测模式:未来 hours 条逐小时
        result.prediction = { hourly: periods.slice(0, hours).map(buildEntry) };
      }
    } catch (err) {
      errors.push({ step: 'build-hourly', message: err.message });
    }

    // 活跃警报(顶层,与模式无关);拉取 + 映射各自 try/catch
    const alertsResp = await safe(
      'alerts',
      () => nwsFetch(`https://api.weather.gov/alerts/active?point=${rlat},${rlng}`),
      errors
    );
    try {
      result.alerts = (alertsResp?.features || []).map((f) => {
        const a = f.properties;
        return {
          event: a.event,
          severity: a.severity,
          urgency: a.urgency,
          messageType: a.messageType,
          headline: a.headline,
          effective: toUtc(a.effective),
          expires: toUtc(a.expires),
          // 海/陆用事件名启发式判断(NWS 的 category 不区分海陆)
          isMarine: MARINE_EVENT_RE.test(a.event || ''),
          zones: (a.affectedZones || []).map((z) => z.split('/').pop()),
        };
      });
    } catch (err) {
      errors.push({ step: 'alerts-parse', message: err.message });
    }

    return result;
  } catch (err) {
    errors.push({ step: 'fatal', message: err.message });
    return { available: false, source, mode, reason: err.message, errors };
  }
}

export default getNationalWeatherService;
