// Astronomy —— 日出/日落/月出/月落/月相/月照率
// getAstronomy(lat, lng) -> AstronomyObject
//
// 用 suncalc 本地计算(离线、免费、全球)。太阳精度已用 NWS 官方数据校验(差 1-2 分钟);
// 月亮是 NWS 拿不到的关键数据(solunar 钓鱼理论)。
// suncalc 返回 Date(UTC),toISOString() 天然是 "...Z",符合方案 A(数据层全 UTC)。
import * as SunCalcNS from 'suncalc';

const SunCalc = SunCalcNS.default ?? SunCalcNS;

/** Date → ISO8601 UTC("...Z",去毫秒);无效/缺失 → null */
function iso(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 月相值(0..1)→ 相名 */
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

export async function getAstronomy(lat, lng, { date = new Date() } = {}) {
  const source = 'suncalc';
  try {
    const sun = SunCalc.getTimes(date, lat, lng);
    const moon = SunCalc.getMoonTimes(date, lat, lng);
    const illum = SunCalc.getMoonIllumination(date);
    const name = moonPhaseName(illum.phase);

    return {
      available: true,
      source,
      sunrise: iso(sun.sunrise),
      sunset: iso(sun.sunset),
      moonrise: iso(moon.rise),
      moonset: iso(moon.set),
      moonPhase: { value: Number(illum.phase.toFixed(4)), name: name.en, nameZh: name.zh },
      moonIllumination: { value: Number((illum.fraction * 100).toFixed(1)), unit: '%' },
    };
  } catch (err) {
    return { available: false, source, reason: err.message };
  }
}

export default getAstronomy;
