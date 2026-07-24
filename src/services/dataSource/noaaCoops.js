// ============================================================================
// NOAA CO-OPS 潮汐数据源  (api.tidesandcurrents.noaa.gov)
// ----------------------------------------------------------------------------
// getNoaaCoops(lat, lng, options) -> NoaaCoopsObject
//
// 【两种模式,二选一】options.mode:
//   - 'prediction'(默认):查未来/指定某天的【天文预测】
//        → prediction 有值(高低潮 + 逐小时潮位/潮流),current = null
//   - 'current':查【现在】的真实【观测】
//        → current 有值(实测水位/水温/气温/风/气压),prediction = null
//
// 【为什么分两种?】未来只有"预测"(水还没测);现在既有预测也有传感器"实测"。
//   "明天几点涨潮"用预测;"现在这里怎么样"用实测(信息更多、更贴近当下)。
//
// 【单位】options.unitSystem: 'english'(默认,英尺/节/°F,美国常用)| 'metric'(米/cm·s⁻¹/°C)。
//   透传给 CO-OPS 的 units 参数,返回对象的 units 字段会同步说明。
//
// 【时间】统一 UTC(方案 A):请求 time_zone=gmt,输出 "YYYY-MM-DDTHH:MM:00Z"。
//
// 【调试】每个子请求都单独 try/catch,出错记进返回对象的 errors 数组(不整体崩溃)。
//
// 【站点】由编排层(spotConditions.js)用 stations.js 解析后传入:
//   tideStation(潮位/高低潮)、currentStation(潮流;仅谐波站 PCT 有逐小时预测)。
// ============================================================================

const BASE = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const FETCH_TIMEOUT_MS = 15000;
const DEFAULT_HOURS = 24; // 逐小时预测取多少小时(默认一整天)

// 单位说明表(值本身用扁平数字,单位集中在这,既精简又自解释)
const UNIT_MAP = {
  metric: {
    waterLevel: 'm', height: 'm', speed: 'cm/s', direction: 'deg',
    waterTemp: 'degC', airTemp: 'degC', windSpeed: 'm/s', windGust: 'm/s', airPressure: 'hPa',
  },
  english: {
    waterLevel: 'ft', height: 'ft', speed: 'knots', direction: 'deg',
    waterTemp: 'degF', airTemp: 'degF', windSpeed: 'knots', windGust: 'knots', airPressure: 'hPa',
  },
};

/** 统一的 CO-OPS 请求:拼 URL、带超时、返回解析后的 JSON */
async function coopsFetch(params) {
  const url = `${BASE}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 带标签的安全请求:出错不抛,记进 errors 数组,返回 null。
 * 方便 debug —— 结果里能看到"哪一步、什么参数、什么错误"。
 */
async function safeFetch(label, params, errors) {
  try {
    return await coopsFetch(params);
  } catch (err) {
    errors.push({ step: label, product: params.product, message: err.message });
    return null;
  }
}

/** CO-OPS 时间 "2026-07-25 09:32"(GMT)→ ISO8601 UTC "2026-07-25T09:32:00Z" */
function toIsoUtc(t) {
  if (!t || typeof t !== 'string') return null;
  return t.replace(' ', 'T') + (t.length === 16 ? ':00Z' : 'Z');
}

/** 字符串数字 → number;非法/缺失 → null */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Date → CO-OPS begin_date 需要的 "yyyyMMdd" 和展示用 "yyyy-MM-dd"(按 UTC) */
function fmtDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const mo = p(d.getUTCMonth() + 1);
  const da = p(d.getUTCDate());
  return { day: `${y}${mo}${da}`, dayStr: `${y}-${mo}-${da}` };
}

// ----------------------------------------------------------------------------
// 分支①:预测模式 —— 高低潮 + 逐小时潮位(合并逐小时潮流)
// ----------------------------------------------------------------------------
async function buildPrediction(tideStationId, currentStation, day, hours, unitSystem, errors) {
  const prediction = {
    firstHighTide: null,
    firstLowTide: null,
    secondHighTide: null,
    secondLowTide: null,
    hourly: [], // [{ time, waterLevel, speed, direction }]
  };

  // (1) 当天高低潮:interval=hilo → 拆成 first/second 的 high/low
  const hilo = await safeFetch('hilo', {
    begin_date: day, range: '24', product: 'predictions', interval: 'hilo',
    datum: 'MLLW', station: tideStationId, time_zone: 'gmt', units: unitSystem, format: 'json',
  }, errors);
  if (hilo) {
    const ex = (hilo.predictions || []).map((p) => ({ time: toIsoUtc(p.t), height: num(p.v), type: p.type }));
    const highs = ex.filter((e) => e.type === 'H');
    const lows = ex.filter((e) => e.type === 'L');
    const pick = (e) => (e ? { time: e.time, height: e.height } : null);
    prediction.firstHighTide = pick(highs[0]);
    prediction.secondHighTide = pick(highs[1]);
    prediction.firstLowTide = pick(lows[0]);
    prediction.secondLowTide = pick(lows[1]);
  }

  // (2) 逐小时潮流:interval=60 → 建 时间->{speed,direction} 映射
  //     仅"谐波潮流站(PCT)"有整点数据;观测站(ACT)只给转流事件 → 匹配不到 → null
  const currentByTime = new Map();
  if (currentStation && currentStation.station) {
    const cp = await safeFetch('currents', {
      begin_date: `${day} 00:00`, range: String(hours), product: 'currents_predictions',
      station: currentStation.station.id, time_zone: 'gmt', units: unitSystem,
      interval: '60', format: 'json', bin: '1',
    }, errors);
    const arr = cp && cp.current_predictions && cp.current_predictions.cp;
    for (const e of arr || []) {
      const t = toIsoUtc(e.Time);
      if (!t || !t.endsWith(':00Z')) continue; // 只要整点
      const vel = num(e.Velocity_Major); // 正=涨流,负=退流
      const dir = vel == null ? null : vel >= 0 ? num(e.meanFloodDir) : num(e.meanEbbDir);
      currentByTime.set(t, { speed: vel == null ? null : Math.abs(vel), direction: dir });
    }
  }

  // (3) 逐小时潮位:interval=h → 合并潮流 → hourly[]
  const hourly = await safeFetch('hourly', {
    begin_date: `${day} 00:00`, range: String(hours), product: 'predictions', interval: 'h',
    datum: 'MLLW', station: tideStationId, time_zone: 'gmt', units: unitSystem, format: 'json',
  }, errors);
  if (hourly) {
    prediction.hourly = (hourly.predictions || []).map((p) => {
      const time = toIsoUtc(p.t);
      const cur = currentByTime.get(time) || { speed: null, direction: null };
      return { time, waterLevel: num(p.v), speed: cur.speed, direction: cur.direction };
    });
  }

  return prediction;
}

// ----------------------------------------------------------------------------
// 分支②:现在模式 —— 站点此刻的真实观测(并发拉多个产品,缺传感器则该项 null)
// ----------------------------------------------------------------------------
async function buildCurrent(tideStationId, unitSystem, errors) {
  const common = { date: 'latest', station: tideStationId, time_zone: 'gmt', units: unitSystem, format: 'json' };
  const first = (data) => (data && data.data && data.data[0]) || null;

  // 5 个产品并发拉;water_level 需要 datum
  const [wl, wt, at, wind, ap] = await Promise.all([
    safeFetch('water_level', { ...common, product: 'water_level', datum: 'MLLW' }, errors),
    safeFetch('water_temperature', { ...common, product: 'water_temperature' }, errors),
    safeFetch('air_temperature', { ...common, product: 'air_temperature' }, errors),
    safeFetch('wind', { ...common, product: 'wind' }, errors),
    safeFetch('air_pressure', { ...common, product: 'air_pressure' }, errors),
  ]);
  const wlD = first(wl), wtD = first(wt), atD = first(at), windD = first(wind), apD = first(ap);

  return {
    time: toIsoUtc((wlD || wtD || atD || windD || apD || {}).t),
    waterLevel: num(wlD && wlD.v), // 实测水位(含气象余差,比预测更真)
    waterTemp: num(wtD && wtD.v),
    airTemp: num(atD && atD.v),
    wind: windD
      ? { speed: num(windD.s), direction: num(windD.d), cardinal: windD.dr || null, gust: num(windD.g) }
      : null,
    airPressure: num(apD && apD.v),
  };
}

// ----------------------------------------------------------------------------
// 主入口
// ----------------------------------------------------------------------------
export async function getNoaaCoops(
  lat,
  lng,
  { tideStation, currentStation, date, hours = DEFAULT_HOURS, mode = 'prediction', unitSystem = 'english' } = {}
) {
  const source = 'NOAA CO-OPS';
  const errors = []; // 收集子请求错误,方便 debug

  try {
    // 没有潮汐站 = 这个点没覆盖 → 整体不可用
    if (!tideStation || !tideStation.station) {
      return { available: false, source, reason: '附近无 CO-OPS 潮汐站', errors };
    }
    const units = UNIT_MAP[unitSystem] ? unitSystem : 'english';

    // 目标日期(默认现在);非法输入回退到现在
    const target = date ? new Date(date) : new Date();
    const when = Number.isNaN(target.getTime()) ? new Date() : target;
    const { day, dayStr } = fmtDay(when);
    const tideStationId = tideStation.station.id;

    const result = {
      available: true,
      source,
      mode,
      station: {
        tide: { id: tideStationId, name: tideStation.station.name, distanceKm: tideStation.distanceKm },
        // 潮流站(洋流)。命名 tidalCurrent 以免和顶层 current(现在)混淆
        tidalCurrent:
          currentStation && currentStation.station
            ? { id: currentStation.station.id, name: currentStation.station.name, distanceKm: currentStation.distanceKm }
            : { available: false, reason: '附近无 CO-OPS 潮流站' },
      },
      date: dayStr,
      units: UNIT_MAP[units],
      prediction: null, // 预测模式填
      current: null, // 现在模式填
      errors, // 子请求错误(正常为空数组)
    };

    if (mode === 'current') {
      result.current = await buildCurrent(tideStationId, units, errors);
    } else {
      result.prediction = await buildPrediction(tideStationId, currentStation, day, hours, units, errors);
    }

    return result;
  } catch (err) {
    // 兜底:非预期的整体错误
    errors.push({ step: 'fatal', message: err.message });
    return { available: false, source, reason: err.message, errors };
  }
}

export default getNoaaCoops;
