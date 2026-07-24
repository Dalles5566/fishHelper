// NOAA CO-OPS (api.tidesandcurrents.noaa.gov) —— 高低潮 / 实时水位 / 潮流
// getNoaaCoops(lat, lng) -> NoaaCoopsObject
//
// 站点由编排层(spotConditions.js)统一用 stations.js 解析后传入，本 service 不自己找站。
// 入参 stations = { tideStation, currentStation }，每个形如
//   { station:{id,name,lat,lng}, distanceKm } 或 null。
//
// 流程:
//   ① 用传入的潮汐站 → 拉高低潮(predictions/hilo)+ 实时水位(water_level)
//   ② 用传入的潮流站 → 拉潮流预测(currents_predictions)；
//      潮流预测仅部分站点(PCT 类)提供,观测站(ACT)会返回 error → tidalCurrent.available:false
//
// 字段映射(真实验证):
//   predictions/hilo 每项 { t:"2026-07-23 03:30", v:"0.836", type:"H"|"L" }
//   water_level      每项 { t, v }
//   currents_predictions.cp 每项 { Type:"slack"|"flood"|"ebb", Time, Velocity_Major, meanFloodDir, meanEbbDir }
//   时间统一 UTC:请求用 time_zone=gmt,输出 ISO8601 UTC("YYYY-MM-DDTHH:MM:00Z")
//   (方案 A:数据层全 UTC,展示时由 agent 按钓点时区本地化)

const BASE = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const FETCH_TIMEOUT_MS = 15000;

async function coopsFetch(params) {
  const url = `${BASE}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CO-OPS HTTP ${res.status}`);
  return res.json();
}

/** "2026-07-23 07:30"(GMT,因请求用 time_zone=gmt) → "2026-07-23T07:30:00Z" */
function toIsoUtc(t) {
  if (!t || typeof t !== 'string') return null;
  return t.replace(' ', 'T') + (t.length === 16 ? ':00Z' : 'Z');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function getNoaaCoops(lat, lng, { tideStation, currentStation } = {}) {
  const source = 'NOAA CO-OPS';
  try {
    if (!tideStation || !tideStation.station) {
      return { available: false, source, reason: '附近无 CO-OPS 潮汐站' };
    }

    const result = {
      available: true,
      source,
      station: {
        id: tideStation.station.id,
        name: tideStation.station.name,
        distanceKm: tideStation.distanceKm,
      },
      tideExtremes: [],
      currentWaterLevel: null,
      tidalCurrent: { available: false, reason: '未查询' },
    };

    // ① 高低潮(未来 48h)
    try {
      const hilo = await coopsFetch({
        date: 'today',
        range: '48',
        product: 'predictions',
        interval: 'hilo',
        datum: 'MLLW',
        station: result.station.id,
        time_zone: 'gmt',
        units: 'metric',
        format: 'json',
      });
      result.tideExtremes = (hilo.predictions || []).map((p) => ({
        type: p.type === 'H' ? 'high' : 'low',
        time: toIsoUtc(p.t),
        height: { value: num(p.v), unit: 'm' },
      }));
    } catch (err) {
      result.tideError = err.message;
    }

    // ① 实时水位
    try {
      const wl = await coopsFetch({
        date: 'latest',
        product: 'water_level',
        datum: 'MLLW',
        station: result.station.id,
        time_zone: 'gmt',
        units: 'metric',
        format: 'json',
      });
      const d = wl.data && wl.data[0];
      if (d) {
        result.currentWaterLevel = { value: num(d.v), unit: 'm', time: toIsoUtc(d.t) };
      }
    } catch (err) {
      result.waterLevelError = err.message;
    }

    // ② 潮流(用传入的潮流站,可能不提供预测)
    try {
      if (!currentStation || !currentStation.station) {
        result.tidalCurrent = { available: false, reason: '附近无 CO-OPS 潮流站' };
      } else {
        const station = {
          id: currentStation.station.id,
          name: currentStation.station.name,
          distanceKm: currentStation.distanceKm,
        };
        const cp = await coopsFetch({
          date: 'today',
          product: 'currents_predictions',
          station: station.id,
          time_zone: 'gmt',
          units: 'metric',
          interval: 'MAX_SLACK',
          format: 'json',
          bin: '1',
        });
        const arr = cp.current_predictions && cp.current_predictions.cp;
        if (Array.isArray(arr) && arr.length) {
          result.tidalCurrent = {
            available: true,
            station,
            meanFloodDir: { value: num(arr[0].meanFloodDir), unit: 'deg' },
            meanEbbDir: { value: num(arr[0].meanEbbDir), unit: 'deg' },
            events: arr.slice(0, 6).map((e) => ({
              type: e.Type, // slack / flood / ebb
              time: toIsoUtc(e.Time),
              velocity: { value: num(e.Velocity_Major), unit: 'cm/s' },
            })),
          };
        } else {
          result.tidalCurrent = {
            available: false,
            station,
            reason: (cp.error && cp.error.message) || '该站不提供潮流预测',
          };
        }
      }
    } catch (err) {
      result.tidalCurrent = { available: false, reason: err.message };
    }

    return result;
  } catch (err) {
    return { available: false, source, reason: err.message };
  }
}

export default getNoaaCoops;
