// ============================================================================
// NOAA NDBC 浮标观测数据源  (ndbc.noaa.gov)
// ----------------------------------------------------------------------------
// getNoaaNdbc(lat, lng, options) -> NoaaNdbcObject
//
// 【纯观测源】NDBC 是海上浮标的【实时观测】,没有未来预报。所以:
//   - mode='current'(默认):返回最近观测(浪高/浪周期/浪向/海温/能见度)
//   - mode='prediction':NDBC 无预报 → available:false,reason 说明
//
// 【数据格式】realtime2 是"列式文本"(不是 JSON),表头列固定:
//   #YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
//   时间为 GMT;缺测值为 "MM" → null。首行=最近观测,越往下越早。
//   某字段最新行缺测(MM)时,往下扫取"最近的有效值"。
//   涌浪(swell)不在 realtime2(在 .spec 文件)→ swellHeight 暂为 null。
//
// 【单位】realtime2 恒为公制(m / degC / nmi)。unitSystem 默认 'english':代码里换算
//   (m→ft、degC→degF);'metric' 则原样。返回对象带 units 说明。
//
// 【浮标】由编排层(spotConditions.js)用 stations.js 解析后传入 buoyStation。
// 【调试】子请求 try/catch,失败记入 errors[]。
// ============================================================================

const FETCH_TIMEOUT_MS = 15000;

// realtime2 表头列名(顺序固定)
const COLS = [
  'YY', 'MM', 'DD', 'hh', 'mm', 'WDIR', 'WSPD', 'GST', 'WVHT', 'DPD',
  'APD', 'MWD', 'PRES', 'ATMP', 'WTMP', 'DEWP', 'VIS', 'PTDY', 'TIDE',
];

const UNIT_MAP = {
  metric: { waveHeight: 'm', swellHeight: 'm', wavePeriod: 's', waveDirection: 'deg', seaSurfaceTemp: 'degC', visibility: 'nmi' },
  english: { waveHeight: 'ft', swellHeight: 'ft', wavePeriod: 's', waveDirection: 'deg', seaSurfaceTemp: 'degF', visibility: 'nmi' },
};

/** "MM"/空 → null;否则数字 */
function num(v) {
  if (v == null || v === 'MM' || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n, d = 2) {
  if (n == null) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

const mToFt = (v) => (v == null ? null : round(v * 3.28084, 2));
const cToF = (v) => (v == null ? null : round((v * 9) / 5 + 32, 1));

export async function getNoaaNdbc(lat, lng, { buoyStation, mode = 'current', unitSystem = 'english' } = {}) {
  const source = 'NOAA NDBC';
  const errors = [];

  // NDBC 无预报:预测模式直接说明
  if (mode === 'prediction') {
    return { available: false, source, mode, reason: 'NDBC 为浮标观测,无未来预报', errors };
  }

  try {
    if (!buoyStation || !buoyStation.station) {
      return { available: false, source, mode, reason: '附近无 NDBC 浮标', errors };
    }
    const units = UNIT_MAP[unitSystem] ? unitSystem : 'english';
    const toEnglish = units === 'english';

    const id = String(buoyStation.station.id).toUpperCase();
    const url = `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`;

    let text;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      errors.push({ step: 'realtime2', station: id, message: err.message });
      return { available: false, source, mode, reason: err.message, errors };
    }

    // 解析所有数据行(去掉 # 注释)
    const rows = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const parts = l.split(/\s+/);
        const row = {};
        COLS.forEach((c, i) => (row[c] = parts[i]));
        return row;
      });
    if (rows.length === 0) {
      errors.push({ step: 'parse', message: '无观测数据行' });
      return { available: false, source, mode, reason: '无观测数据', errors };
    }

    // 每字段取"最近的有效值"(从最新行往下扫,第一个非 MM)
    const latest = (col) => {
      for (const row of rows) {
        const v = num(row[col]);
        if (v != null) return v;
      }
      return null;
    };

    const top = rows[0];
    const observedAt = `${top.YY}-${top.MM}-${top.DD}T${top.hh}:${top.mm}:00Z`;

    // 原始公制值
    const waveHeightM = latest('WVHT');
    const wavePeriodS = latest('DPD') ?? latest('APD'); // 主周期缺则退回平均周期
    const waveDir = latest('MWD');
    const seaTempC = latest('WTMP');
    const visNmi = latest('VIS');

    return {
      available: true,
      source,
      mode,
      station: { id: buoyStation.station.id, name: buoyStation.station.name, distanceKm: buoyStation.distanceKm },
      observedAt,
      units: UNIT_MAP[units],
      // 扁平值;英制则换算
      waveHeight: toEnglish ? mToFt(waveHeightM) : waveHeightM,
      swellHeight: null, // realtime2 无涌浪列(.spec 才有)
      wavePeriod: wavePeriodS,
      waveDirection: waveDir,
      seaSurfaceTemp: toEnglish ? cToF(seaTempC) : seaTempC,
      visibility: visNmi,
      errors,
    };
  } catch (err) {
    errors.push({ step: 'fatal', message: err.message });
    return { available: false, source, mode, reason: err.message, errors };
  }
}

export default getNoaaNdbc;
