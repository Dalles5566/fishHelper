// 就近找站的通用工具。
// CO-OPS(潮汐/潮流)、NDBC(浮标) 不能直接用坐标查，必须先找到最近的站/浮标，
// 再用站号去查。本模块提供：
//   - haversineKm：两坐标间距离（km）
//   - nearest：在一批站点里找离目标坐标最近的
//   - 带缓存的站点列表加载器（CO-OPS 潮汐站 / CO-OPS 潮流站 / NDBC 浮标）
// 站点列表体量大且很少变，按进程缓存（默认 24h），避免每次查询都重新下载。

const STATION_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

// key -> { at:number, promise:Promise<Station[]> }
const listCache = new Map();

/** 记忆化加载：同一 key 在 TTL 内复用同一个 Promise；失败则清除以便重试 */
function memoList(key, loader) {
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < STATION_LIST_TTL_MS) return hit.promise;
  const promise = Promise.resolve()
    .then(loader)
    .catch((err) => {
      listCache.delete(key);
      throw err;
    });
  listCache.set(key, { at: Date.now(), promise });
  return promise;
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...options });
}

function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * 两坐标间大圆距离（km）。
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * 在站点数组里找离 (lat,lng) 最近的一个。
 * @param {number} lat
 * @param {number} lng
 * @param {Array<{lat:number,lng:number}>} stations
 * @returns {{ station:object, distanceKm:number } | null}
 */
export function nearest(lat, lng, stations) {
  let best = null;
  let bestDist = Infinity;
  for (const s of stations) {
    const sLat = Number(s.lat);
    const sLng = Number(s.lng);
    if (!Number.isFinite(sLat) || !Number.isFinite(sLng)) continue;
    const d = haversineKm(lat, lng, sLat, sLng);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best ? { station: best, distanceKm: round(bestDist) } : null;
}

// CO-OPS 站点类型（用常量避免魔法字符串散落）
export const COOPS_STATION_TYPE = {
  TIDE: 'tidepredictions',
  CURRENT: 'currentpredictions',
};

/**
 * 加载 CO-OPS 站点列表（带缓存）。type 必传，二选一。
 * @param {'tidepredictions'|'currentpredictions'} type
 * @returns {Promise<Array<{id:string,name:string,lat:number,lng:number}>>}
 */
export function getCoopsStations(type) {
  if (type !== COOPS_STATION_TYPE.TIDE && type !== COOPS_STATION_TYPE.CURRENT) {
    throw new Error(`getCoopsStations: 无效的 type "${type}"，应为 tidepredictions 或 currentpredictions`);
  }
  return memoList(`coops:${type}`, async () => {
    const url = `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=${type}&units=metric`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`CO-OPS 站点列表(${type}) HTTP ${res.status}`);
    const data = await res.json();
    return (data.stations || [])
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ id: s.id, name: s.name, lat: Number(s.lat), lng: Number(s.lng) }));
  });
}

/**
 * 加载 NDBC 活跃浮标列表（带缓存）。activestations.xml 为 XML，无三方库时用正则解析。
 * 统一成与 CO-OPS 一致的形状：{ id, name, lat, lng }。
 * @returns {Promise<Array<{id:string,name:string,lat:number,lng:number}>>}
 */
export function getNdbcStations() {
  return memoList('ndbc', async () => {
    const res = await fetchWithTimeout('https://www.ndbc.noaa.gov/activestations.xml');
    if (!res.ok) throw new Error(`NDBC 站点列表 HTTP ${res.status}`);
    const xml = await res.text();
    const out = [];
    // <station id="44013" lat="42.346" lon="-70.651" name="..." type="buoy" .../>
    const re = /<station\s+id="([^"]+)"\s+lat="(-?[0-9.]+)"\s+lon="(-?[0-9.]+)"([^>]*)/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const rest = m[4] || '';
      const nameM = /name="([^"]*)"/.exec(rest);
      out.push({
        id: m[1],
        name: nameM ? nameM[1] : '',
        lat: Number(m[2]),
        lng: Number(m[3]),
      });
    }
    return out;
  });
}

/** 找最近的 CO-OPS 潮汐预测站 */
export async function nearestCoopsTideStation(lat, lng) {
  return nearest(lat, lng, await getCoopsStations(COOPS_STATION_TYPE.TIDE));
}

/** 找最近的 CO-OPS 潮流预测站 */
export async function nearestCoopsCurrentStation(lat, lng) {
  return nearest(lat, lng, await getCoopsStations(COOPS_STATION_TYPE.CURRENT));
}

/** 找最近的 NDBC 浮标 */
export async function nearestNdbcStation(lat, lng) {
  return nearest(lat, lng, await getNdbcStations());
}
