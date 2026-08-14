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
  'Squid',
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
 * @returns [{ range, wind, airTemp, weather, waveHeight, wavePeriod }]
 */
function computeHourlyBlocks(hourly, _unitSystem) {
  const order = [];
  const groups = new Map();
  for (const h of hourly || []) {
    const t = typeof h.time === 'string' ? h.time : null;
    if (!t) continue;
    const hh = Number(t.slice(11, 13));
    if (Number.isNaN(hh)) continue;
    const start = Math.floor(hh / 3) * 3;
    const label = `${String(start).padStart(2, '0')}:00-${String(start + 2).padStart(2, '0')}:59`;
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label).push(h);
  }
  return order.map((label) => {
    const es = groups.get(label);
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
    return { range: label, wind, airTemp, weather, waveHeight, wavePeriod };
  });
}

/** 标签(中/英) */
const L = {
  zh: {
    currentTime: '当前时间', sunrise: '日出 / 日落', tides: '潮汐',
    waterTemp: '水温', wind: '风速', airTemp: '气温', weather: '天气',
    precip: '降水/雷暴', alerts: '警报', waveHeight: '浪高', wavePeriod: '浪周期',
    noData: '无数据', noAlerts: '无活动警报', nextHigh: '下一次高潮', nextLow: '下一次低潮',
  },
  en: {
    currentTime: 'Current Time', sunrise: 'Sunrise / Sunset', tides: 'Tides',
    waterTemp: 'Water Temperature', wind: 'Wind Speed', airTemp: 'Air Temperature', weather: 'Weather',
    precip: 'Precip / Thunderstorm', alerts: 'Alerts', waveHeight: 'Wave Height', wavePeriod: 'Wave Period',
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
      // current: Next High / Next Low + rest
      const now = ct ? new Date(ct).getTime() : Date.now();
      const nextHigh = tides.find((t) => t.type === 'High' && new Date(t.time).getTime() > now);
      const nextLow = tides.find((t) => t.type === 'Low' && new Date(t.time).getTime() > now);
      if (nextHigh) lines.push(`  ${l.nextHigh} ${fmtTime(nextHigh.time)} ${nextHigh.height} ft`);
      if (nextLow) lines.push(`  ${l.nextLow} ${fmtTime(nextLow.time)} ${nextLow.height} ft`);
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

  // Water Temperature
  const wt = isCurrent ? conditions.currentTideAndWeather?.waterTemp : null;

  // Wind / Air Temp / Weather / Water Temp / Wave Height / Wave Period
  if (isCurrent) {
    const cw = conditions.currentTideAndWeather || {};
    const wind = cw.wind || {};
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
    // 天气(含降水/雷暴概率)
    const hourly = conditions.predictTideAndWeather?.hourly || [];
    lines.push(`${l.weather}:`);
    for (const b of hourlyBlocks) {
      if (b.weather) {
        const blockHour = Number(b.range.slice(0, 2));
        const blockEntries = hourly.filter((h) => {
          const hh = Number((h.time || '').slice(11, 13));
          return hh >= blockHour && hh <= blockHour + 2;
        });
        const pp = Math.max(0, ...blockEntries.map((h) => h.precipitationProbability ?? 0));
        const tp = Math.max(0, ...blockEntries.map((h) => h.thunderstormProbability ?? 0));
        const precip = pp || tp ? `, Precip ${pp}%, Thunder ${tp}%` : '';
        lines.push(`  ${b.range} | ${b.weather}${precip}`);
      }
    }
    if (!hourlyBlocks.some((b) => b.weather)) lines.push(`  ${nd}`);
    renderBlocks(l.wind, 'wind');
    lines.push(`${l.waterTemp}: ${nd}`); // prediction 模式无水温
    renderBlocks(l.waveHeight, 'waveHeight');
    renderBlocks(l.wavePeriod, 'wavePeriod');
    // 降水/雷暴已合并进天气块,不再单独输出
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
const FISHING_PROMPT = `You are an experienced saltwater fishing guide specializing in U.S. East Coast shore fishing.
You will receive a spotConditions JSON. Your job is ONLY to provide the ANALYSIS — species ratings and best fishing window.
The factual data display (time, tides, wind, weather, etc.) is already handled separately. Do NOT repeat or reformat any raw data fields.

RULES:
1. Never invent, estimate, or assume any numeric value. Every number must come from the JSON.
2. If a value is null or missing, say "No data" for that factor. Do NOT force analysis around missing data.
3. Be objective. Do not exaggerate certainty.
4. Keep explanations concise and practical.
5. Write like an experienced fishing guide helping anglers decide: should they fish? when? which species?

TARGET SPECIES:
Evaluate EVERY species in the targetSpecies list. Do NOT add, remove, or reorder.
Assign each a star rating (use EXACTLY 5 characters: filled ★ plus empty ☆):
★★★★★ Excellent / ★★★★☆ Very Good / ★★★☆☆ Fair / ★★☆☆☆ Poor / ★☆☆☆☆ Very Poor
Consider: tide, tidal current, water temperature, wind, weather, waves, time of day, sun/moon, water depth.
Different species should usually get different ratings. One concise sentence per species explaining why.

BEST FISHING WINDOW:
Recommend the best upcoming fishing window with a brief explanation (tide + weather + species reasoning).

OUTPUT FORMAT (exactly this, nothing else):
<one line per species: "SpeciesName: ★★★★☆ - reason">
<blank line>
Best Fishing Window: <time range> - <brief reason>`;

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
      unitSystem: { type: 'string', enum: ['english', 'metric'], description: 'default english' },
    },
    required: ['latitude', 'longitude'],
    additionalProperties: false,
  },
  async execute({ latitude, longitude, name, note, mode, date, unitSystem } = {}, context = {}) {
    const predict = mode === 'prediction' || !!date;
    const conditions = predict
      ? await getPredictConditions(latitude, longitude, { name, note, date, unitSystem })
      : await getCurrentConditions(latitude, longitude, { name, note, unitSystem });

    // 代码渲染固定字段摘要(确定性,不过 AI)
    const hourlyBlocks = predict
      ? computeHourlyBlocks(conditions.predictTideAndWeather?.hourly, unitSystem || 'english')
      : null;
    const lang = context.lang || 'zh';
    const dataSummary = buildSummary(conditions, hourlyBlocks, lang);

    // AI 只做主观分析:鱼种打分 + 最佳窗口
    const langLine = lang === 'en'
      ? '[Language] Reply ENTIRELY in English.'
      : '[Language] Reply ENTIRELY in Chinese (中文).';

    const payload = { ...conditions, targetSpecies: TARGET_SPECIES };
    if (hourlyBlocks) payload.hourlyBlocks = hourlyBlocks;

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
    // full = 完整版(放附件):跟 summary 一样(AI 不再生成冗长的独立完整报告)
    const full = summary;

    return { summary, full, conditions };
  },
};
