// USGS Water Data (waterservices.usgs.gov) —— 河流流量 / 水位 / 水温
// getUsgsWaterData(lat, lng) -> UsgsWaterDataObject
//
// 与 coops/ndbc 不同:USGS 没有固定站点列表可缓存,用 bbox 直接查附近站的即时值(iv),
// 再用 haversine 在返回结果里挑最近的站。参数码:
//   00060 河流流量(ft3/s)  00065 水位(ft)  00010 水温(degC)
// 缺测哨兵 -999999 → null;时间(带本地偏移)统一转 UTC(方案 A)。
import { haversineKm } from '../stations.js';

const FETCH_TIMEOUT_MS = 15000;
const BBOX_DELTA = 0.2; // 约 ±20km 的搜索框

const PARAM = { DISCHARGE: '00060', GAGE_HEIGHT: '00065', WATER_TEMP: '00010' };
const UNIT = { '00060': 'ft3/s', '00065': 'ft', '00010': 'degC' };

/** "-999999"/空 → null;否则数字 */
function num(v) {
  if (v == null || v === '' || v === '-999999') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 带偏移的时间 → UTC ISO8601(去毫秒);无效 → null */
function toUtc(t) {
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function getUsgsWaterData(lat, lng) {
  const source = 'USGS Water Data';
  try {
    const bbox = [lng - BBOX_DELTA, lat - BBOX_DELTA, lng + BBOX_DELTA, lat + BBOX_DELTA]
      .map((n) => n.toFixed(4))
      .join(',');
    const url =
      `https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=${bbox}` +
      `&parameterCd=${PARAM.DISCHARGE},${PARAM.GAGE_HEIGHT},${PARAM.WATER_TEMP}&siteStatus=active`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
    const data = await res.json();

    const series = data?.value?.timeSeries || [];
    if (series.length === 0) {
      return { available: false, source, reason: '附近无 USGS 监测站' };
    }

    // 按站聚合,并算距离,挑最近站
    const sites = new Map(); // siteId -> { id, name, lat, lng, dist, params:{code:{value,time}} }
    for (const s of series) {
      const info = s.sourceInfo;
      const id = info?.siteCode?.[0]?.value;
      if (!id) continue;
      const geo = info?.geoLocation?.geogLocation || {};
      const sLat = Number(geo.latitude);
      const sLng = Number(geo.longitude);
      const code = s.variable?.variableCode?.[0]?.value;
      const latest = s.values?.[0]?.value?.[0];
      if (!sites.has(id)) {
        sites.set(id, {
          id,
          name: info.siteName,
          lat: sLat,
          lng: sLng,
          dist: Number.isFinite(sLat) ? haversineKm(lat, lng, sLat, sLng) : Infinity,
          params: {},
        });
      }
      if (code && latest) {
        sites.get(id).params[code] = { value: num(latest.value), time: toUtc(latest.dateTime) };
      }
    }

    const nearest = [...sites.values()].sort((a, b) => a.dist - b.dist)[0];
    if (!nearest) return { available: false, source, reason: '附近无 USGS 监测站' };

    const pick = (code) => {
      const p = nearest.params[code];
      return { value: p ? p.value : null, unit: UNIT[code], time: p ? p.time : null };
    };

    return {
      available: true,
      source,
      station: {
        id: nearest.id,
        name: nearest.name,
        distanceKm: Number.isFinite(nearest.dist) ? Math.round(nearest.dist * 10) / 10 : null,
      },
      riverDischarge: pick(PARAM.DISCHARGE),
      gaugeHeight: pick(PARAM.GAGE_HEIGHT),
      waterTemperature: pick(PARAM.WATER_TEMP),
    };
  } catch (err) {
    return { available: false, source, reason: err.message };
  }
}

export default getUsgsWaterData;
