// ============================================================================
// SpotConditions 编排层 —— 把 6 个数据源合成一个钓点综合状况对象
// ----------------------------------------------------------------------------
// getSpotConditions(lat, lng, options) -> SpotConditions
//
// options:
//   - mode: 'current'(默认,现在实测)| 'prediction'(未来某天预测)
//   - date: 目标日期(prediction 用;current 默认现在)
//   - unitSystem: 'english'(默认)| 'metric'
//
// 【编排流程】
//   ① 解析 CO-OPS 潮汐站/潮流站(并行;这两个由编排层统一解析后传给 noaaCoops 复用)
//   ② 并发调"常备源":noaaCoops / nationalWeatherService / astronomy / noaaBathymetry
//      (以及 usgsWaterData;海钓价值低,但请求便宜、如实返回)
//   ③ NDBC 兜底:仅 current 模式且 CO-OPS current 缺数据时,才解析浮标并调 noaaNdbc
//      (平时不发 NDBC 请求;prediction 模式 NDBC 无预报,不调)
//   ④ 合成:顶层带 timezone(取自 NWS,供 agent 把 UTC 本地化展示)
//
// 【各源与 mode 的关系】
//   coops / nws:真双模式(current 与 prediction 都有真实数据)
//   astronomy:计算源,任意时间都能算(current 今日日月 / prediction 未来日月)
//   bathymetry:静态(水深与时间无关,两种模式同值)
//   ndbc / usgs:纯观测,prediction 模式返回 available:false(无预报)
//
// 【时间/单位】各源内部已统一 UTC + 可选单位;本层只做编排与合成。
// ============================================================================
import {
  nearestCoopsTideStation,
  nearestCoopsCurrentStation,
  nearestNdbcStation,
} from './stations.js';
import { getNoaaCoops } from './dataSource/noaaCoops.js';
import { getNationalWeatherService } from './dataSource/nationalWeatherService.js';
import { getNoaaNdbc } from './dataSource/noaaNdbc.js';
import { getAstronomy } from './dataSource/astronomy.js';
import { getUsgsWaterData } from './dataSource/usgsWaterData.js';
import { getNoaaBathymetry } from './dataSource/noaaBathymetry.js';

/** 安全执行:任何未预期的抛错都收进 errors,返回兜底对象而非崩溃 */
async function settle(label, promise, errors) {
  try {
    return await promise;
  } catch (err) {
    errors.push({ source: label, message: err.message });
    return { available: false, source: label, reason: err.message };
  }
}

/** 判断 CO-OPS current 是否"缺数据"(据此决定是否触发 NDBC 兜底) */
function coopsCurrentMissing(coops) {
  if (!coops || !coops.available) return true;
  const c = coops.current;
  // current 模式下 current 应有值;水温缺失视为需要兜底(NDBC 能补水温/浪)
  return !c || (c.waterTemp == null && c.waterLevel == null);
}

export async function getSpotConditions(lat, lng, { mode = 'current', date, unitSystem = 'english' } = {}) {
  const errors = [];
  const opts = { mode, date, unitSystem };

  // ① 解析 CO-OPS 潮汐站 / 潮流站(并行)
  const [tideStation, currentStation] = await Promise.all([
    settle('stations:coopsTide', nearestCoopsTideStation(lat, lng), errors),
    settle('stations:coopsCurrent', nearestCoopsCurrentStation(lat, lng), errors),
  ]);

  // ② 并发调常备源
  const [noaaCoops, nationalWeatherService, astronomy, noaaBathymetry, usgsWaterData] = await Promise.all([
    settle('noaaCoops', getNoaaCoops(lat, lng, { tideStation, currentStation, ...opts }), errors),
    settle('nationalWeatherService', getNationalWeatherService(lat, lng, opts), errors),
    settle('astronomy', getAstronomy(lat, lng, { date }), errors),
    settle('noaaBathymetry', getNoaaBathymetry(lat, lng, { unitSystem }), errors),
    settle('usgsWaterData', getUsgsWaterData(lat, lng, opts), errors),
  ]);

  // ③ NDBC 兜底:仅 current 模式 + CO-OPS current 缺数据时
  let noaaNdbc;
  if (mode === 'current' && coopsCurrentMissing(noaaCoops)) {
    const buoyStation = await settle('stations:ndbc', nearestNdbcStation(lat, lng), errors);
    noaaNdbc = await settle('noaaNdbc', getNoaaNdbc(lat, lng, { buoyStation, mode, unitSystem }), errors);
  } else {
    noaaNdbc = {
      available: false,
      source: 'NOAA NDBC',
      reason:
        mode === 'prediction'
          ? 'NDBC 无预报,prediction 模式不调用'
          : '未触发兜底(CO-OPS current 已有数据)',
    };
  }

  // ④ 合成
  return {
    latitude: lat,
    longitude: lng,
    mode,
    date: noaaCoops?.date || astronomy?.date || null,
    // 时区取自 NWS(供 agent 把 UTC 换算成钓点本地时展示)
    timezone: nationalWeatherService?.timezone || null,
    unitSystem,
    sources: {
      noaaCoops,
      nationalWeatherService,
      astronomy,
      noaaBathymetry,
      usgsWaterData,
      noaaNdbc,
    },
    errors,
  };
}

export default getSpotConditions;
