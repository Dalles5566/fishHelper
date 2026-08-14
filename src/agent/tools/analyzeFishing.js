// ============================================================================
// tool: analyzeFishing —— "这个钓点适不适合钓鱼"的专门分析器
//   自动取海况(current 现在 / prediction 未来某天)→ 代码渲染固定字段摘要 →
//   再调一次 LLM 只做主观分析(鱼种打分+最佳窗口)→ 拼起来返回。
//   代码负责"确定性数据展示",AI 只负责"判断性分析"。
// ============================================================================
import { getClient } from '../openaiClient.js';
import { config } from '../../config.js';
import { getCurrentConditions, getPredictConditions } from '../../services/spotConditions.js';

// 钓手固定的目标鱼种(美东)。改这里即可调整。
const TARGET_SPECIES = [
  'Striped Bass',
  'Bluefish',
  'Scup',
  'Black Sea Bass',
  'Tautog',
  'Fluke',
  'Weakfish',
];

// ============================================================================
// 代码渲染:从 conditions 数据直接生成聊天摘要(固定格式,零 AI,100% 稳定)
// ============================================================================

/** min-max 数字范围字符串;相等则单值。dp=小数位 */
function fmtRange(min, max, dp = 0) {
  if (min == null || max == null) return null;
  const r = (n) => (dp ? Math.round(n * 10 ** dp) / 10 ** dp : Math.round(n));
  return min === max ? String(r(min)) : `${r(min)}-${r(max)}`;
}

/** ISO 本地时间 → HH:MM */
function fmtTime(iso) {
  if (!iso || typeof iso !== 'string') return null;
  return iso.slice(11, 16); // "2026-07-26T18:01:00-04:00" → "18:01"
}

/** ISO 本地时间 → MM-DD HH:MM */
function fmtDateTime(iso) {
  if (!iso || typeof iso !== 'string') return null;
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`; // "07-26 18:01"
}

/**
 * 把预测逐小时按固定 3 小时钟点时段分块。
 * 分组键 = 本地日期 + 时段(不能只用小时:"今天"是"从现在起 24h"的滚动窗口,会跨午夜,
 * 只按小时分组会把今天 14:00 和明天 13:00 混进同一个 12:00-14:59 块)。
 * 降水/雷暴概率也在这里一并算好(同一批 entries,不再二次按小时扫描)。
 * @returns [{ range, wind, airTemp, weather, waveHeight, wavePeriod, precipProb, thunderProb }]
 */
function computeHourlyBlocks(hourly) {
  const order = [];
  const groups = new Map();
  for (const h of hourly || []) {
    const t = typeof h.time === 'string' ? h.time : null;
    if (!t) continue;
    const hh = Number(t.slice(11, 13));
    if (Number.isNaN(hh)) continue;
    const start = Math.floor(hh / 3) * 3;
    const label = `${String(start).padStart(2, '0')}:00-${String(start + 2).padStart(2, '0')}:59`;
    const key = `${t.slice(0, 10)} ${label}`; // 日期 + 时段,避免跨天混合
    if (!groups.has(key)) {
      groups.set(key, { label, entries: [] });
      order.push(key);
    }
    groups.get(key).entries.push(h);
  }
  return order.map((key) => {
    const { label, entries: es } = groups.get(key);
    const speeds = es.map((e) => e.windSpeed).filter((v) => v != null);
    const temps = es.map((e) => e.temperature).filter((v) => v != null);
    const dirs = [...new Set(es.map((e) => e.windDirection).filter(Boolean))];
    const waves = es.map((e) => e.waveHeight).filter((v) => v != null);
    const periods = es.map((e) => e.wavePeriod).filter((v) => v != null);
    const freq = new Map();
    for (const e of es) if (e.shortForecast) freq.set(e.shortForecast, (freq.get(e.shortForecast) || 0) + 1);
    const weather = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const spd = speeds.length ? fmtRange(Math.min(...speeds), Math.max(...speeds), 1) : null;
    const spdMph = speeds.length ? fmtRange(ktToMph(Math.min(...speeds)), ktToMph(Math.max(...speeds))) : null;
    const wind = spd ? `${spd} kt (${spdMph} mph)${dirs.length ? ' ' + dirs.join('/') : ''}` : dirs.join('/') || null;
    const airTemp = temps.length
      ? `${fmtRange(Math.min(...temps), Math.max(...temps))}°F (${fmtRange(fToC(Math.min(...temps)), fToC(Math.max(...temps)))}°C)`
      : null;
    const waveHeight = waves.length ? `${fmtRange(Math.min(...waves), Math.max(...waves), 1)} ft` : null;
    const wavePeriod = periods.length ? `${fmtRange(Math.min(...periods), Math.max(...periods))} s` : null;
    // 该时段内的最大降水/雷暴概率(同一批 entries,天然按日期隔离)
    const precipProb = Math.max(0, ...es.map((e) => e.precipitationProbability ?? 0));
    const thunderProb = Math.max(0, ...es.map((e) => e.thunderstormProbability ?? 0));
    return { range: label, wind, airTemp, weather, waveHeight, wavePeriod, precipProb, thunderProb };
  });
}

/** 标签(中/英) */
const L = {
  zh: {
    currentTime: '当前时间', sunrise: '日出 / 日落', tides: '潮汐',
    waterTemp: '水温', wind: '风速', airTemp: '气温', weather: '天气',
    alerts: '警报', waveHeight: '浪高', wavePeriod: '浪周期',
    noData: '无数据', noAlerts: '无活动警报', nextHigh: '下一次高潮', nextLow: '下一次低潮',
  },
  en: {
    currentTime: 'Current Time', sunrise: 'Sunrise / Sunset', tides: 'Tides',
    waterTemp: 'Water Temperature', wind: 'Wind Speed', airTemp: 'Air Temperature', weather: 'Weather',
    alerts: 'Alerts', waveHeight: 'Wave Height', wavePeriod: 'Wave Period',
    noData: 'No data', noAlerts: 'No active alerts', nextHigh: 'Next High', nextLow: 'Next Low',
  },
};

/** kt → mph */
function ktToMph(kt) {
  if (kt == null) return null;
  return Math.round(kt * 1.15078);
}

/** °F → °C */
function fToC(f) {
  if (f == null) return null;
  return Math.round((f - 32) * 5 / 9);
}

/** 格式化风速: "5.2 kt (6 mph) NW" */
function fmtWind(speed, gust, cardinal) {
  if (speed == null) return null;
  let s = `${speed} kt (${ktToMph(speed)} mph)`;
  if (cardinal) s = `${cardinal} ${s}`;
  if (gust != null) s += `, gust ${gust} kt (${ktToMph(gust)} mph)`;
  return s;
}

/** 格式化气温: "78°F (25°C)" */
function fmtTemp(f) {
  if (f == null) return null;
  return `${f}°F (${fToC(f)}°C)`;
}

/**
 * 纯代码从 conditions 渲染聊天摘要的"硬性数据"部分。
 * 不调 AI,100% 确定性,格式永远一致。
 */
function buildSummary(conditions, hourlyBlocks, lang = 'zh') {
  const l = L[lang] || L.zh;
  const nd = l.noData;
  const lines = [];
  const isCurrent = !!conditions.currentTideAndWeather;

  // Current Time
  const ct = conditions.currentTime;
  lines.push(`${l.currentTime}: ${isCurrent ? fmtTime(ct) || nd : fmtDateTime(ct) || nd}`);

  // Sunrise / Sunset
  const c = conditions.common || {};
  const sr = fmtTime(c.sunrise);
  const ss = fmtTime(c.sunset);
  lines.push(`${l.sunrise}: ${sr && ss ? `${sr} / ${ss}` : nd}`);

  // Tides
  const tides = isCurrent ? conditions.tideExtremes : conditions.predictTideAndWeather?.tideExtremes;
  lines.push(`${l.tides}:`);
  if (Array.isArray(tides) && tides.length) {
    if (isCurrent) {
      // current: Next tide events (按时间顺序,哪个先来就先显示)
      const now = ct ? new Date(ct).getTime() : Date.now();
      const future = tides.filter((t) => new Date(t.time).getTime() > now);
      const nextHigh = future.find((t) => t.type === 'High');
      const nextLow = future.find((t) => t.type === 'Low');
      // 按时间排序输出 next high/low
      const nexts = [nextHigh, nextLow].filter(Boolean).sort((a, b) => new Date(a.time) - new Date(b.time));
      for (const t of nexts) {
        const label = t.type === 'High' ? l.nextHigh : l.nextLow;
        lines.push(`  ${label} ${fmtTime(t.time)} ${t.height} ft`);
      }
      // 其余事件
      for (const t of tides) {
        if (t === nextHigh || t === nextLow) continue;
        const typeLabel = t.type === 'High' ? (lang === 'zh' ? '高潮' : 'High') : (lang === 'zh' ? '低潮' : 'Low');
        lines.push(`  ${fmtTime(t.time)} ${typeLabel} ${t.height} ft`);
      }
    } else {
      // prediction: all events in order
      for (const t of tides) {
        const typeLabel = t.type === 'High' ? (lang === 'zh' ? '高潮' : 'High') : (lang === 'zh' ? '低潮' : 'Low');
        lines.push(`  ${fmtTime(t.time)} ${typeLabel} ${t.height} ft`);
      }
    }
  } else {
    lines.push(`  ${nd}`);
  }

  // Wind / Air Temp / Weather / Water Temp / Wave Height / Wave Period
  if (isCurrent) {
    const cw = conditions.currentTideAndWeather || {};
    const wind = cw.wind || {};
    const wt = cw.waterTemp;
    // 顺序: 气温 → 天气 → 风速 → 水温 → 浪高 → 浪周期
    lines.push(`${l.airTemp}: ${cw.airTemp != null ? fmtTemp(cw.airTemp) : nd}`);
    lines.push(`${l.weather}: ${cw.shortForecast || nd}${cw.precipitationProbability || cw.thunderstormProbability ? `, Precip ${cw.precipitationProbability ?? 0}%, Thunder ${cw.thunderstormProbability ?? 0}%` : ''}`);
    const ws = wind.speed != null ? fmtWind(wind.speed, wind.gust, wind.cardinal) : nd;
    lines.push(`${l.wind}: ${ws}`);
    lines.push(`${l.waterTemp}: ${wt != null ? `${wt}°F` : nd}`);
    lines.push(`${l.waveHeight}: ${cw.waveHeight != null ? `${cw.waveHeight} ft` : nd}`);
    lines.push(`${l.wavePeriod}: ${cw.wavePeriod != null ? `${cw.wavePeriod} s` : nd}`);
  } else if (Array.isArray(hourlyBlocks) && hourlyBlocks.length) {
    // Prediction: 3h blocks with pipe separator
    // 顺序: 气温 → 天气(含降水/雷暴) → 风速 → 水温 → 浪高 → 浪周期
    const renderBlocks = (label, field) => {
      lines.push(`${label}:`);
      for (const b of hourlyBlocks) {
        if (b[field]) lines.push(`  ${b.range} | ${b[field]}`);
      }
      if (!hourlyBlocks.some((b) => b[field])) lines.push(`  ${nd}`);
    };
    renderBlocks(l.airTemp, 'airTemp');
    // 天气(含降水/雷暴概率,已在 computeHourlyBlocks 里按日期+时段算好)
    lines.push(`${l.weather}:`);
    for (const b of hourlyBlocks) {
      if (b.weather) {
        const precip = b.precipProb || b.thunderProb
          ? `, Precip ${b.precipProb}%, Thunder ${b.thunderProb}%`
          : '';
        lines.push(`  ${b.range} | ${b.weather}${precip}`);
      }
    }
    if (!hourlyBlocks.some((b) => b.weather)) lines.push(`  ${nd}`);
    renderBlocks(l.wind, 'wind');
    lines.push(`${l.waterTemp}: ${nd}`); // prediction 模式不取实测水温
    renderBlocks(l.waveHeight, 'waveHeight');
    renderBlocks(l.wavePeriod, 'wavePeriod');
  } else {
    // prediction 但逐小时为空(如 NWS 失败 / 交集为空)→ 明确打印"无数据",避免看起来像报告被截断
    for (const label of [l.airTemp, l.weather, l.wind, l.waterTemp, l.waveHeight, l.wavePeriod]) {
      lines.push(`${label}: ${nd}`);
    }
  }

  // Alerts
  const alerts = isCurrent
    ? conditions.currentTideAndWeather?.alerts
    : conditions.predictTideAndWeather?.alerts;
  if (Array.isArray(alerts) && alerts.length) {
    lines.push(`${l.alerts}:`);
    for (const a of alerts) lines.push(`  ${a.event}${a.headline ? ' - ' + a.headline : ''}`);
  } else {
    lines.push(`${l.alerts}: ${l.noAlerts}`);
  }

  return lines.join('\n');
}

// ============================================================================
// AI 分析提示词(精简版:只做主观判断,不再输出任何"固定格式字段")
// ============================================================================
const FISHING_PROMPT = `You are an experienced saltwater fishing guide specializing in U.S. East Coast shore fishing, especially Massachusetts, Rhode Island, Cape Cod, and nearby New England waters.

You will receive a spotConditions JSON containing environmental conditions and a targetSpecies list.

Your job is ONLY to provide:
1. Species-specific fishing ratings.
2. The single best upcoming fishing window.

The application already displays the raw environmental data separately. Do NOT repeat, summarize, or reformat the raw weather, tide, wind, wave, sun, moon, or depth data.

CORE PRINCIPLE
Do not simply rate whether the weather is pleasant.
Judge whether the conditions are biologically and behaviorally favorable for EACH target species from a shore angler's perspective.
Use established saltwater fishing knowledge to interpret the supplied environmental data.

You MAY use general fishing knowledge about species behavior, including:
* typical feeding periods
* preference for moving water
* tendency to feed near dawn/dusk
* preference for structure, rocky bottom, sand, channels, or deeper water
* seasonal behavior
* typical response to water temperature
* typical response to wind and waves
* whether the species commonly moves within shore-casting range

However, NEVER invent environmental conditions that are not present in the JSON.

DATA DISCIPLINE
1. Every numeric environmental value mentioned in the response MUST come directly from the JSON.
2. Never invent, estimate, interpolate, or assume a missing numeric value.
3. If an important factor is missing, simply exclude that factor from the rating and reduce confidence appropriately.
4. Do NOT write "No data" unless the missing information materially affects the explanation.
5. Do not assume tidal current speed from tide height.
6. You MAY determine whether the tide is generally rising or falling by comparing the requested time against the supplied high/low tide sequence.
7. High tide and low tide are NOT automatically the best fishing times.
8. Do NOT assume exact slack-current time from a high or low tide unless tidal-current data is supplied.
9. Do not treat moon phase as a dominant factor. It should normally be a secondary factor unless there is a strong reason otherwise.
10. Safety overrides fishing quality. Thunderstorms, dangerous surf, strong wind, or active marine hazards must substantially reduce the recommendation even if the tide is favorable.

TIME-OF-DAY LOGIC
Time of day matters independently from tide. Generally consider:
* Dawn and the period shortly after sunrise as potentially favorable.
* Dusk and the period around sunset as potentially favorable.
* Midday as potentially less favorable for species that prefer lower light, especially during warm summer conditions.
* Night as potentially favorable for nocturnal or low-light feeders such as Striped Bass, but potentially less favorable for primarily daytime visual feeders.
Do NOT mechanically give dawn or dusk a high rating.
Combine time of day with tide, wind, waves, temperature, structure, and species behavior.

TIDE LOGIC
Treat tide as a dynamic feeding factor rather than simply rewarding high tide. Consider:
* Rising tide
* Falling tide
* Approaching high tide
* Approaching low tide
* Tide turn
* Amount of water covering nearshore structure
* Whether moving water is likely to concentrate bait
Moving water is often more important than the exact high/low tide time.
Do NOT automatically rate high tide higher than a strong incoming or outgoing tide.
When current-speed data is unavailable, do not claim that current is strong, weak, or slack.

WIND AND WAVE LOGIC
Evaluate wind and waves from TWO perspectives:
1. Fish activity.
2. Shore-fishing practicality and safety.
Moderate wave action can sometimes improve feeding conditions by disturbing bait and reducing visibility.
Excessive wind or surf can make casting, bite detection, bottom fishing, float fishing, or safe shoreline access difficult.
Do not automatically treat perfectly calm conditions as the best fishing conditions.

WATER TEMPERATURE
If water temperature is available, compare it with the general seasonal preference of each species.
If water temperature is unavailable, do NOT substitute air temperature.
Do not heavily penalize a species merely because water-temperature data is missing.

DEPTH AND STRUCTURE
If depth or bottom structure information is supplied, use it.
Consider whether the species is likely to be accessible from shore under the supplied tide and depth conditions.
Do not invent bottom structure that is not supplied.

SPECIES RATINGS
Evaluate EVERY species in targetSpecies.
Do NOT add, remove, reorder, or translate species names.
Always reproduce the English species name EXACTLY as provided in targetSpecies.

Assign exactly one of these ratings:
★★★★★ Excellent
★★★★☆ Very Good
★★★☆☆ Fair
★★☆☆☆ Poor
★☆☆☆☆ Very Poor

The rating MUST be species-specific.
Do not deliberately make ratings different merely for variety.
If multiple species genuinely deserve the same rating, give them the same rating.
For each species, consider the factors that actually matter to THAT species.

STAR RATING MEANING
★★★★★ Conditions strongly align for this species AND it is reasonably accessible to a shore angler.
★★★★☆ Several important factors are favorable, with only minor limitations.
★★★☆☆ Fishable conditions with meaningful positives and negatives.
★★☆☆☆ Possible, but multiple important factors are unfavorable or the species is unlikely to be accessible from shore.
★☆☆☆☆ Very poor conditions, strongly out of season, highly unfavorable environmental conditions, or very low practical shore-fishing opportunity.

BEST FISHING WINDOW
Evaluate the ENTIRE available forecast period rather than simply selecting the next high tide.
Compare candidate windows throughout the day.
Pay particular attention to combinations such as:
* dawn + moving tide
* dusk + moving tide
* favorable tide + manageable wind
* favorable tide + manageable waves
* favorable species behavior + shore accessibility
A strong combination of several factors should beat a single favorable factor.
Prefer a focused fishing window, normally around 2-4 hours, rather than recommending an unnecessarily broad portion of the day.
The recommended window should represent the best practical time to ARRIVE AND FISH, not merely the exact timestamp of a tide extreme.
If two periods are very close in quality, choose the safer and more practical shore-fishing period.

FINAL REASONING PRIORITY
When choosing the best fishing window, generally prioritize:
1. Safety
2. Species-specific seasonal availability
3. Moving tide/current
4. Dawn/dusk and feeding behavior
5. Water temperature
6. Wind and wave fishability
7. Depth/structure and shore accessibility
8. Moon conditions
These priorities are guidelines, not rigid mathematical weights. Species biology should determine how much each factor matters.

RESPONSE STYLE
Be concise. Do not provide generic fishing education.
Do not repeat raw environmental data already displayed by the application.
Explain only the factors that materially affected each rating.
Avoid unsupported certainty. Use practical shore-fishing language.

OUTPUT FORMAT
Return EXACTLY:
SpeciesName: ★★★★☆ - concise species-specific reason
SpeciesName: ★★★☆☆ - concise species-specific reason
...

Best Fishing Window: HH:MM-HH:MM - concise explanation

Nothing before or after this format.`;

// ============================================================================
// Tool 定义 + execute
// ============================================================================
export default {
  name: 'analyzeFishing',
  description:
    'Judge whether a spot is good for fishing: auto-fetches conditions and returns a structured report ' +
    '(conditions summary + species ratings + best window). ' +
    'Use this tool for ANY judgment question (is it good to fish / how is it / when should I go / now or later / ' +
    'how about today/tomorrow / rising or falling), NOT getCurrentWeather/getPredictWeather (those return raw data only).',
  parameters: {
    type: 'object',
    properties: {
      latitude: { type: 'number', description: 'Latitude' },
      longitude: { type: 'number', description: 'Longitude' },
      name: { type: 'string', description: 'Spot name (from getCoordinateByName, optional)' },
      note: { type: 'string', description: 'Spot note (optional)' },
      mode: {
        type: 'string',
        enum: ['current', 'prediction'],
        description: 'now (current) or future forecast (prediction); default current',
      },
      date: { type: 'string', description: 'Target date YYYY-MM-DD (when mode=prediction; omit = from now)' },
    },
    required: ['latitude', 'longitude'],
    additionalProperties: false,
  },
  async execute({ latitude, longitude, name, note, mode, date } = {}, context = {}) {
    const predict = mode === 'prediction' || !!date;
    // 单位固定英制(摘要渲染器只输出 ft/kt/°F,并附 mph/°C 换算)
    const unitSystem = 'english';
    const conditions = predict
      ? await getPredictConditions(latitude, longitude, { name, note, date, unitSystem })
      : await getCurrentConditions(latitude, longitude, { name, note, unitSystem });

    // 代码渲染固定字段摘要(确定性,不过 AI)
    const hourlyBlocks = predict ? computeHourlyBlocks(conditions.predictTideAndWeather?.hourly) : null;
    const lang = context.lang || 'zh';
    const dataSummary = buildSummary(conditions, hourlyBlocks, lang);

    // AI 只做主观分析:鱼种打分 + 最佳窗口
    const langLine = lang === 'en'
      ? '[Language] Reply ENTIRELY in English.'
      : '[Language] Reply ENTIRELY in Chinese (中文).';

    // payload 只给原始 conditions + 鱼种;hourlyBlocks 是给摘要渲染用的,提示词不引用它,不必重复发
    const payload = { ...conditions, targetSpecies: TARGET_SPECIES };

    const completion = await getClient().chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: `${FISHING_PROMPT}\n\n${langLine}` },
        { role: 'user', content: 'spotConditions JSON:\n' + JSON.stringify(payload) },
      ],
    });

    const analysis = (completion.choices?.[0]?.message?.content || '').trim();

    // 拼接:代码渲染的数据摘要 + AI 的分析 = 聊天正文
    const summary = `${dataSummary}\n\n${analysis}`;

    return { summary, conditions };
  },
};
