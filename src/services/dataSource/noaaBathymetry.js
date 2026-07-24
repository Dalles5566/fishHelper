// ============================================================================
// NOAA Bathymetry 水深数据源  (NCEI DEM global mosaic, ArcGIS ImageServer)
// ----------------------------------------------------------------------------
// getNoaaBathymetry(lat, lng, options) -> NoaaBathymetryObject
//
// 【静态源】水深是海底地形,不随时间变 → 没有 mode、没有时间字段,按坐标直查。
//   identify 接口返回该点【高程】(米):负值=海平面以下=水深(取绝对值);
//   正值=陆地/水面以上高程(说明该点不在水里)。
//
// 【单位】unitSystem 默认 'english'(ft)| 'metric'(m)。DEM 原始是米,英制换算 m→ft。
// 【调试】fetch 与解析各自 try/catch,失败记入 errors[]。
// ============================================================================

const FETCH_TIMEOUT_MS = 15000;
const M_TO_FT = 3.28084;
const IDENTIFY_URL =
  'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/identify';

const UNIT_MAP = { metric: { depth: 'm', elevation: 'm' }, english: { depth: 'ft', elevation: 'ft' } };

function round(n, d = 2) {
  if (n == null) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export async function getNoaaBathymetry(lat, lng, { unitSystem = 'english' } = {}) {
  const source = 'NOAA NCEI DEM (global mosaic)';
  const errors = [];
  const units = UNIT_MAP[unitSystem] ? unitSystem : 'english';
  const isEnglish = units === 'english';
  const conv = (meters) => (meters == null ? null : isEnglish ? round(meters * M_TO_FT, 2) : round(meters, 2));

  try {
    // ---- 请求 identify(单独 try/catch)----
    let data;
    try {
      const geometry = encodeURIComponent(JSON.stringify({ x: lng, y: lat }));
      const url =
        `${IDENTIFY_URL}?geometry=${geometry}&geometryType=esriGeometryPoint` +
        `&returnGeometry=false&returnCatalogItems=false&f=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      errors.push({ step: 'identify', message: err.message });
      return { available: false, source, reason: err.message, errors };
    }

    // ---- 解析高程值 ----
    const elevation = Number(data.value); // DEM 高程,米(负=水下)
    if (!Number.isFinite(elevation)) {
      errors.push({ step: 'parse', message: `无效 value=${data.value}` });
      return { available: false, source, reason: `无水深数据(value=${data.value})`, errors };
    }

    if (elevation > 0) {
      // 正高程 = 陆地/水面以上,不在水里
      return {
        available: true,
        source,
        units: UNIT_MAP[units],
        depth: 0,
        elevation: conv(elevation),
        note: '该点高程为正(陆地/水面以上),非水下',
        errors,
      };
    }

    // 负高程取绝对值 = 水深
    return {
      available: true,
      source,
      units: UNIT_MAP[units],
      depth: conv(-elevation),
      errors,
    };
  } catch (err) {
    errors.push({ step: 'fatal', message: err.message });
    return { available: false, source, reason: err.message, errors };
  }
}

export default getNoaaBathymetry;
