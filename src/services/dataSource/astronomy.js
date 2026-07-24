// ============================================================================
// Astronomy 日月数据源  (suncalc 本地计算)
// ----------------------------------------------------------------------------
// getAstronomy(lat, lng, options) -> AstronomyObject
//
// 【纯计算源】用 suncalc 离线算,不联网、免费、全球。任意时间(过去/现在/未来)都能算,
//   所以没有"观测 vs 预测"之分,不需要 mode。太阳精度已用 NWS 官方值校验(差 1-2 分钟);
//   月亮(月出/月落/月相/月照率)是 NWS 拿不到、但钓鱼(solunar 理论)很看重的数据。
//
// 【时间】suncalc 返回 UTC Date,toISOString() 天然是 "...Z"(符合方案 A)。
// 【单位】仅 moonIllumination 有单位(%),放 units;其余是时间或相名,无单位制之分,
//   所以不需要 unitSystem。
// 【调试】三次 suncalc 调用各自 try/catch,失败记入 errors[]。
//
// 字段:sunrise / sunset / moonrise / moonset(ISO UTC,月出月落当天无则 null)
//       moonPhase { value(0..1), name(英), nameZh(中) } / moonIllumination(%,数字)
// ============================================================================
import * as SunCalcNS from 'suncalc';

// suncalc 是 CommonJS:ESM 里默认导出可能在 .default 上,做个兼容
const SunCalc = SunCalcNS.default ?? SunCalcNS;

/** Date → ISO8601 UTC("...Z",去毫秒);无效/缺失(如当天无月出)→ null */
function iso(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 目标日期 → "yyyy-MM-dd"(UTC) */
function fmtDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 月相值(0..1)→ 相名。
 * 0/1=新月, 0.25=上弦, 0.5=满月, 0.75=下弦;各留 ±1/16 的区间给"整相"。
 */
function moonPhaseName(phase) {
  if (phase < 0.0625 || phase >= 0.9375) return { en: 'New Moon', zh: '新月' };
  if (phase < 0.1875) return { en: 'Waxing Crescent', zh: '娥眉月' };
  if (phase < 0.3125) return { en: 'First Quarter', zh: '上弦月' };
  if (phase < 0.4375) return { en: 'Waxing Gibbous', zh: '盈凸月' };
  if (phase < 0.5625) return { en: 'Full Moon', zh: '满月' };
  if (phase < 0.6875) return { en: 'Waning Gibbous', zh: '亏凸月' };
  if (phase < 0.8125) return { en: 'Last Quarter', zh: '下弦月' };
  return { en: 'Waning Crescent', zh: '残月' };
}

export async function getAstronomy(lat, lng, { date } = {}) {
  const source = 'suncalc';
  const errors = [];

  // 目标日期(默认现在);非法输入回退现在
  const target = date ? new Date(date) : new Date();
  const when = Number.isNaN(target.getTime()) ? new Date() : target;

  const result = {
    available: true,
    source,
    date: fmtDay(when),
    units: { moonIllumination: '%' },
    sunrise: null,
    sunset: null,
    moonrise: null,
    moonset: null,
    moonPhase: null,
    moonIllumination: null,
    errors,
  };

  // ① 太阳:日出/日落
  try {
    const sun = SunCalc.getTimes(when, lat, lng);
    result.sunrise = iso(sun.sunrise);
    result.sunset = iso(sun.sunset);
  } catch (err) {
    errors.push({ step: 'sunTimes', message: err.message });
  }

  // ② 月亮:月出/月落(当天可能无月出或无月落 → null)
  try {
    const moon = SunCalc.getMoonTimes(when, lat, lng);
    result.moonrise = iso(moon.rise);
    result.moonset = iso(moon.set);
  } catch (err) {
    errors.push({ step: 'moonTimes', message: err.message });
  }

  // ③ 月相 + 月照率
  try {
    const illum = SunCalc.getMoonIllumination(when);
    const name = moonPhaseName(illum.phase);
    result.moonPhase = { value: Number(illum.phase.toFixed(4)), name: name.en, nameZh: name.zh };
    result.moonIllumination = Number((illum.fraction * 100).toFixed(1)); // 扁平数字,单位见 units
  } catch (err) {
    errors.push({ step: 'moonIllumination', message: err.message });
  }

  return result;
}

export default getAstronomy;
