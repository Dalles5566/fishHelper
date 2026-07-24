// ============================================================================
// USGS Water Data 数据源  (waterservices.usgs.gov)  ⚠️ 仅美国河流/水体
// ----------------------------------------------------------------------------
// getUsgsWaterData(lat, lng, options) -> UsgsWaterDataObject
//
// 【纯观测源】USGS 是河流/水体监测站的【即时观测】(iv),没有未来预报。所以:
//   - mode='current'(默认):返回最近观测(河流流量/水位/水温)
//   - mode='prediction':USGS 无预报 → available:false
//
// 【找站方式】USGS 没有可缓存的固定站列表,用 bbox 直接查附近站的即时值,
//   再用 haversine 在返回结果里挑最近的站(不经 stations.js)。
//   参数码:00060 河流流量、00065 水位、00010 水温(USGS 原始:流量 ft³/s、水位 ft、水温 degC)。
//
// 【单位】unitSystem 默认 'english'(ft³/s、ft、degF)| 'metric'(m³/s、m、degC)。
//   USGS 原生流量/水位是英制、水温是摄氏 → 按需换算。
//
// 【缺测】USGS 哨兵值 -999999 → null。【时间】统一 UTC。【调试】try/catch → errors[]。
// ============================================================================
import { haversineKm } from '../stations.js';

const FETCH_TIMEOUT_MS = 15000;
const BBOX_DELTA = 0.2; // 约 ±20km 的搜索框

const PARAM = { DISCHARGE: '00060', GAGE_HEIGHT: '00065', WATER_TEMP: '00010' };

const UNIT_MAP = {
  english: { riverDischarge: 'ft3/s', gaugeHeight: 'ft', waterTemperature: 'degF' },
  metric: { riverDischarge: 'm3/s', gaugeHeight: 'm', waterTemperature: 'degC' },
};

const FT3S_TO_M3S = 0.0283168;
const FT_TO_M = 0.3048;

/** "-999999"/空 → null;否则数字 */
function num(v) {
  if (v == null || v === '' || v === '-999999') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n, d = 2) {
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

const cToF = (v) => (v == null ? null : round((v * 9) / 5 + 32, 1));

export async function getUsgsWaterData(lat, lng, { mode = 'current', unitSystem = 'english' } = {}) {
  const source = 'USGS Water Data';
  const errors = [];

  // USGS 无预报:预测模式直接说明
  if (mode === 'prediction') {
    return { available: false, source, mode, reason: 'USGS 为河流观测,无未来预报', errors };
  }

  const units = UNIT_MAP[unitSystem] ? unitSystem : 'english';
  const isEnglish = units === 'english';

  try {
    // bbox 查附近站的即时值(iv)
    const bbox = [lng - BBOX_DELTA, lat - BBOX_DELTA, lng + BBOX_DELTA, lat + BBOX_DELTA]
      .map((n) => n.toFixed(4))
      .join(',');
    const url =
      `https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=${bbox}` +
      `&parameterCd=${PARAM.DISCHARGE},${PARAM.GAGE_HEIGHT},${PARAM.WATER_TEMP}&siteStatus=active`;

    let data;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      errors.push({ step: 'iv', message: err.message });
      return { available: false, source, mode, reason: err.message, errors };
    }

    const series = data?.value?.timeSeries || [];
    if (series.length === 0) {
      return { available: false, source, mode, reason: '附近无 USGS 监测站', errors };
    }

    // 按站聚合并算距离(bbox 可能返回多个站),挑最近的
    let nearest = null;
    try {
      const sites = new Map(); // siteId -> { id, name, dist, params:{code:{value,time}} }
      for (const s of series) {
        const info = s.sourceInfo;
        const id = info?.siteCode?.[0]?.value;
        if (!id) continue;
        const geo = info?.geoLocation?.geogLocation || {};
        const sLat = Number(geo.latitude);
        const sLng = Number(geo.longitude);
        if (!sites.has(id)) {
          sites.set(id, {
            id,
            name: info.siteName,
            dist: Number.isFinite(sLat) ? haversineKm(lat, lng, sLat, sLng) : Infinity,
            params: {},
          });
        }
        const code = s.variable?.variableCode?.[0]?.value;
        const latest = s.values?.[0]?.value?.[0];
        if (code && latest) {
          sites.get(id).params[code] = { value: num(latest.value), time: toUtc(latest.dateTime) };
        }
      }
      nearest = [...sites.values()].sort((a, b) => a.dist - b.dist)[0] || null;
    } catch (err) {
      errors.push({ step: 'parse', message: err.message });
      return { available: false, source, mode, reason: `解析失败: ${err.message}`, errors };
    }
    if (!nearest) return { available: false, source, mode, reason: '附近无 USGS 监测站', errors };

    // 取某参数码的值(原始:流量 ft³/s、水位 ft、水温 degC),并按单位制换算
    const rawVal = (code) => nearest.params[code]?.value ?? null;
    const anyTime = nearest.params[PARAM.GAGE_HEIGHT]?.time
      || nearest.params[PARAM.DISCHARGE]?.time
      || nearest.params[PARAM.WATER_TEMP]?.time
      || null;

    const dischargeRaw = rawVal(PARAM.DISCHARGE); // ft³/s
    const gageRaw = rawVal(PARAM.GAGE_HEIGHT); // ft
    const tempC = rawVal(PARAM.WATER_TEMP); // degC

    return {
      available: true,
      source,
      mode,
      station: {
        id: nearest.id,
        name: nearest.name,
        distanceKm: Number.isFinite(nearest.dist) ? Math.round(nearest.dist * 10) / 10 : null,
      },
      observedAt: anyTime,
      units: UNIT_MAP[units],
      // 扁平值;英制保留原始英制,公制换算
      riverDischarge: isEnglish ? dischargeRaw : round(dischargeRaw == null ? null : dischargeRaw * FT3S_TO_M3S, 3),
      gaugeHeight: isEnglish ? gageRaw : round(gageRaw == null ? null : gageRaw * FT_TO_M, 2),
      waterTemperature: isEnglish ? cToF(tempC) : tempC, // 原始就是 degC
      errors,
    };
  } catch (err) {
    errors.push({ step: 'fatal', message: err.message });
    return { available: false, source, mode, reason: err.message, errors };
  }
}

export default getUsgsWaterData;
