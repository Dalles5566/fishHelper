// NOAA NDBC (ndbc.noaa.gov) —— 浪高 / 浪周期 / 浪向 / 海表温度 / 能见度
// getNoaaNdbc(lat, lng, { buoyStation }) -> NoaaNdbcObject
//
// 浮标由编排层(spotConditions.js)用 stations.js 解析后传入。
// 数据是 realtime2 的“列式文本”(不是 JSON),需自己解析。首行数据 = 最近一次观测。
//
// realtime2 表头(列顺序固定):
// #YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
//   时间为 GMT;缺测值为 "MM" → null
//   涌浪(swell)不在 realtime2(在 .spec 文件),此处 swellHeight 置 null

const FETCH_TIMEOUT_MS = 15000;

// 列名 → 索引(与 realtime2 表头一致)
const COLS = [
  'YY', 'MM', 'DD', 'hh', 'mm', 'WDIR', 'WSPD', 'GST', 'WVHT', 'DPD',
  'APD', 'MWD', 'PRES', 'ATMP', 'WTMP', 'DEWP', 'VIS', 'PTDY', 'TIDE',
];

/** "MM" / 空 → null；否则转数字 */
function num(v) {
  if (v == null || v === 'MM' || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function getNoaaNdbc(lat, lng, { buoyStation } = {}) {
  const source = 'NOAA NDBC';
  try {
    if (!buoyStation || !buoyStation.station) {
      return { available: false, source, reason: '附近无 NDBC 浮标' };
    }
    const id = String(buoyStation.station.id).toUpperCase();
    const url = `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`NDBC HTTP ${res.status}`);
    const text = await res.text();

    // 解析所有数据行(去掉 # 注释)。首行 = 最近观测,越往下越早。
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
    if (rows.length === 0) throw new Error('无观测数据');

    // 某字段取“最近的有效值”(从最新行往下扫,遇到第一个非 MM 就用)
    const latest = (col) => {
      for (const row of rows) {
        const v = num(row[col]);
        if (v != null) return v;
      }
      return null;
    };

    // 观测时间取最新行(GMT → ISO8601 UTC)
    const top = rows[0];
    const observedAt = `${top.YY}-${top.MM}-${top.DD}T${top.hh}:${top.mm}:00Z`;

    return {
      available: true,
      source,
      station: {
        id: buoyStation.station.id,
        name: buoyStation.station.name,
        distanceKm: buoyStation.distanceKm,
      },
      observedAt,
      waveHeight: { value: latest('WVHT'), unit: 'm' },
      wavePeriod: { value: latest('DPD') ?? latest('APD'), unit: 's' }, // 主周期缺则退回平均周期
      waveDirection: { value: latest('MWD'), unit: 'deg' },
      seaSurfaceTemp: { value: latest('WTMP'), unit: 'degC' },
      visibility: { value: latest('VIS'), unit: 'nmi' },
      swellHeight: { value: null, unit: 'm', note: '涌浪需 NDBC .spec 文件，realtime2 无此列' },
    };
  } catch (err) {
    return { available: false, source, reason: err.message };
  }
}

export default getNoaaNdbc;
