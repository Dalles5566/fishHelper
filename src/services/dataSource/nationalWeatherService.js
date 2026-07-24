// National Weather Service (api.weather.gov) —— 天气/风/阵风/降雨/雷暴/警报
// getNationalWeatherService(lat, lng) -> NationalWeatherServiceObject
//
// 实现要点（真实请求验证得出）：
//   - /points 坐标需四舍五入到 4 位小数，否则返回 301 重定向
//   - 逐小时 windSpeed 是 "7 mph" 字符串、windDirection 是 "S" 方位词
//   - 阵风/雷暴概率不在逐小时里，需查 forecastGridData（单位 km/h，转 mph）
//   - 请求必须带 User-Agent
import { config } from '../../config.js';

const FETCH_TIMEOUT_MS = 15000;
const KMH_TO_MPH = 0.621371;

async function nwsFetch(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': config.nws.userAgent, Accept: 'application/geo+json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`NWS ${url} HTTP ${res.status}`);
  return res.json();
}

function round(n, d = 0) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** NWS 时间(带本地偏移如 -04:00)→ 统一 UTC ISO8601("...Z",去掉毫秒) */
function toUtc(t) {
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 解析 NWS 风速字符串 "7 mph" / "10 to 15 mph" → { value, unit, raw } */
function parseWindSpeed(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.match(/(\d+)(?:\s*to\s*(\d+))?\s*([a-zA-Z/]+)/);
  if (!m) return { value: null, unit: null, raw: str };
  const hi = m[2] ? Number(m[2]) : Number(m[1]);
  return { value: hi, unit: m[3], raw: str };
}

/** ISO8601 duration(如 PT1H / P1DT14H)→ 毫秒 */
function durationToMs(dur) {
  const m = dur.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
  if (!m) return 0;
  const [, d, h, min] = m;
  return ((Number(d || 0) * 24 + Number(h || 0)) * 60 + Number(min || 0)) * 60 * 1000;
}

/** 从 gridData 时间序列里取“此刻生效”的值,取不到则取第一个 */
function pickCurrentValue(series) {
  const values = series?.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  const now = Date.now();
  for (const v of values) {
    const [startStr, durStr] = String(v.validTime).split('/');
    const start = Date.parse(startStr);
    const end = start + (durStr ? durationToMs(durStr) : 3600000);
    if (now >= start && now < end) return v.value;
  }
  return values[0].value;
}

const MARINE_EVENT_RE =
  /marine|small craft|hazardous seas|gale|storm warning|rip current|surf|beach|coastal/i;

export async function getNationalWeatherService(lat, lng) {
  const source = 'NWS';
  try {
    // NWS 坐标精度上限 4 位小数
    const rlat = round(lat, 4);
    const rlng = round(lng, 4);
    const points = await nwsFetch(`https://api.weather.gov/points/${rlat},${rlng}`);
    const p = points.properties;

    const result = {
      available: true,
      source,
      grid: { office: p.gridId, gridX: p.gridX, gridY: p.gridY },
      current: {
        windSpeed: null,
        windDirection: null,
        windGust: null,
        thunderstormProbability: null,
        shortForecast: null,
      },
      hourly: [],
      marineForecast: {
        available: !!p.forecastZone,
        zoneId: p.forecastZone ? p.forecastZone.split('/').pop() : null,
        text: null, // 分区文字预报需另拉产品，运行时可选补充
      },
      alerts: [],
    };

    // 逐小时（当前 + 未来若干条）
    try {
      const hourly = await nwsFetch(p.forecastHourly);
      const periods = hourly.properties?.periods || [];
      result.hourly = periods.slice(0, 12).map((it) => ({
        time: toUtc(it.startTime),
        temperature: { value: it.temperature, unit: it.temperatureUnit === 'F' ? 'degF' : 'degC' },
        windSpeed: parseWindSpeed(it.windSpeed),
        windDirection: { cardinal: it.windDirection },
        precipitationProbability: {
          value: it.probabilityOfPrecipitation?.value ?? null,
          unit: '%',
        },
        shortForecast: it.shortForecast,
      }));
      const first = periods[0];
      if (first) {
        result.current.windSpeed = parseWindSpeed(first.windSpeed);
        result.current.windDirection = { cardinal: first.windDirection };
        result.current.shortForecast = first.shortForecast;
      }
    } catch (err) {
      result.hourlyError = err.message;
    }

    // 阵风 + 雷暴概率（来自 gridData，km/h → mph）
    try {
      const grid = await nwsFetch(p.forecastGridData);
      const gp = grid.properties || {};
      const gustKmh = pickCurrentValue(gp.windGust);
      if (gustKmh != null) {
        result.current.windGust = { value: round(gustKmh * KMH_TO_MPH), unit: 'mph' };
      }
      const thunder = pickCurrentValue(gp.probabilityOfThunder);
      if (thunder != null) {
        result.current.thunderstormProbability = { value: thunder, unit: '%' };
      }
    } catch (err) {
      result.gridError = err.message;
    }

    // 警报（天气 + 海上）
    try {
      const alerts = await nwsFetch(
        `https://api.weather.gov/alerts/active?point=${rlat},${rlng}`
      );
      result.alerts = (alerts.features || []).map((f) => {
        const a = f.properties;
        const zones = (a.affectedZones || []).map((z) => z.split('/').pop());
        return {
          event: a.event,
          severity: a.severity,
          urgency: a.urgency,
          messageType: a.messageType,
          headline: a.headline,
          effective: toUtc(a.effective),
          expires: toUtc(a.expires),
          isMarine: MARINE_EVENT_RE.test(a.event || ''),
          zones,
        };
      });
    } catch (err) {
      result.alertsError = err.message;
    }

    return result;
  } catch (err) {
    return { available: false, source, reason: err.message };
  }
}

export default getNationalWeatherService;
