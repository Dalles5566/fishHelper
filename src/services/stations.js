// 地理距离工具。
// 原来还负责 CO-OPS/NDBC 站点解析,但那些数据源已被 WorldTides + Stormglass 取代;
// 现仅保留 haversineKm 供 usgsWaterData.js 在 bbox 结果里挑最近的河流站。

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
