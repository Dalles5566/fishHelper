// NOAA Bathymetry (NCEI DEM global mosaic) —— 点水深
// getNoaaBathymetry(lat, lng) -> NoaaBathymetryObject
//
// 按坐标直查(不用站、无时间字段)。ArcGIS ImageServer identify 返回的 value 是该点高程(米):
//   负值 = 海平面以下 = 水深(取绝对值);正值 = 陆地/水面以上高程。
const FETCH_TIMEOUT_MS = 15000;
const IDENTIFY_URL =
  'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/identify';

export async function getNoaaBathymetry(lat, lng) {
  const source = 'NOAA NCEI DEM (global mosaic)';
  try {
    const geometry = encodeURIComponent(JSON.stringify({ x: lng, y: lat }));
    const url =
      `${IDENTIFY_URL}?geometry=${geometry}&geometryType=esriGeometryPoint` +
      `&returnGeometry=false&returnCatalogItems=false&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`NCEI DEM HTTP ${res.status}`);
    const data = await res.json();

    const elevation = Number(data.value);
    if (!Number.isFinite(elevation)) {
      return { available: false, source, reason: `无水深数据(value=${data.value})` };
    }

    if (elevation > 0) {
      // 正高程 = 陆地/水面以上,不是水下
      return {
        available: true,
        source,
        depth: { value: 0, unit: 'm' },
        elevation: { value: Math.round(elevation * 100) / 100, unit: 'm' },
        note: '该点高程为正(陆地/水面以上),非水下',
      };
    }

    return {
      available: true,
      source,
      depth: { value: Math.round(-elevation * 100) / 100, unit: 'm' }, // 负高程取绝对值
    };
  } catch (err) {
    return { available: false, source, reason: err.message };
  }
}

export default getNoaaBathymetry;
