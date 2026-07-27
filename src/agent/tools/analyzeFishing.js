// ============================================================================
// tool: analyzeFishing —— "这个钓点适不适合钓鱼"的专门分析器
//   自动取海况(current 现在 / prediction 未来某天)→ 内部再调一次 LLM,
//   用"资深海钓向导"提示词做判断,产出两段 → 返回 { summary(精简摘要,发聊天), full(完整报告,拼进附件), conditions }。
//   钓鱼判断的"大脑"集中在这里;agentCore 用 summary 作聊天正文,把 full 拼在 JSON 附件后面。
// ============================================================================
import { getClient } from '../openaiClient.js';
import { config } from '../../config.js';
import { getCurrentConditions, getPredictConditions } from '../../services/spotConditions.js';

// 钓手固定的目标鱼种(美东)。改这里即可调整;注入到评分提示词里。
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

/** min-max 数字范围字符串;相等则单值。dp=小数位 */
function fmtRange(min, max, dp = 0) {
  if (min == null || max == null) return null;
  const r = (n) => (dp ? Math.round(n * 10 ** dp) / 10 ** dp : Math.round(n));
  return min === max ? String(r(min)) : `${r(min)}-${r(max)}`;
}

/**
 * 把预测逐小时按【固定 3 小时钟点时段】分块(00:00-02:59, 03:00-05:59, ...),
 * 每块给风(速度范围+方位)、气温(范围)、天气(最主要状况)。
 * 保留出现顺序(滚动窗口可能从 12:00-14:59 开始并跨午夜),供摘要逐行渲染。
 * @returns [{ range, wind, airTemp, weather }]
 */
function computeHourlyBlocks(hourly, unitSystem) {
  const windUnit = unitSystem === 'metric' ? 'm/s' : 'kt';
  const tempUnit = unitSystem === 'metric' ? '°C' : '°F';
  const order = [];
  const groups = new Map();
  for (const h of hourly || []) {
    const t = typeof h.time === 'string' ? h.time : null;
    if (!t) continue;
    const hh = Number(t.slice(11, 13)); // 本地小时(time 带本地偏移)
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
    const freq = new Map();
    for (const e of es) if (e.shortForecast) freq.set(e.shortForecast, (freq.get(e.shortForecast) || 0) + 1);
    const weather = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const spd = speeds.length ? fmtRange(Math.min(...speeds), Math.max(...speeds), 1) : null;
    const wind = spd ? `${spd} ${windUnit}${dirs.length ? ' ' + dirs.join('/') : ''}` : dirs.join('/') || null;
    const airTemp = temps.length ? `${fmtRange(Math.min(...temps), Math.max(...temps))}${tempUnit}` : null;
    return { range: label, wind, airTemp, weather };
  });
}

// ---------------------------------------------------------------------------
// extractSummary: 从完整报告里用行匹配提取聊天框需要的固定几项(代码决定摘要格式,不靠 LLM)
// ---------------------------------------------------------------------------
// 聊天框要的行(按顺序):
//   Current Time / Sunrise·Sunset / Tides(多行) / Water Temperature /
//   Wind(可能多行 block) / Air Temperature(同) / Weather(同) /
//   降水·雷暴概率 / Alerts / 每个鱼种星级(不要理由) / Best Fishing Window
// ---------------------------------------------------------------------------

/** 从 full report 的标题行(冒号前)判断该行属于哪个 section */

// 中英文都可能出现的 label(模型按 langLine 输出中文标题)
// 每个 entry: { re: 匹配行首的正则, multi: 是否有多行续行(如潮汐列表、wind blocks) }
const CHAT_FIELDS = [
  { re: /^(Current Time|当前时间)\s*[：:]/i, multi: true },
  { re: /^(Sunrise\s*\/\s*Sunset|日出\s*[/／]\s*日落)\s*[：:]/i, multi: true },
  { re: /^(Tides|潮汐)\s*[：:]/i, multi: true },
  { re: /^(Water Temperature|水温)\s*[：:]/i, multi: true },
  { re: /^(Wind|风)\s*[：:]/i, multi: true },
  { re: /^(Air Temperature|气温)\s*[：:]/i, multi: true },
  { re: /^(Weather|天气)\s*[：:]/i, multi: true },
  { re: /^(Precip|降水|雷暴概率|Thunderstorm)/i, multi: false },
  { re: /^(Alerts|警报|预警)\s*[：:]/i, multi: true },
  { re: /^(Best Fishing Window|最佳.*窗口|最佳.*时段)\s*[：:]/i, multi: true },
];

// 鱼种星级行:含 ★ 或 "X星" 的行(不管中英文)
const SPECIES_LINE_RE = /[★☆]|[1-5]星/;

// 新 section 开头(用来截断 multi-line 的连续抓取)
const SECTION_HEADER_RE = /^(={3,}|-{3,}|Analysis|Target Species|Final Verdict|Style|情况分析|目标鱼种|最终结论|Moon Phase|月相|Moon Illumination|月照|Wave Height|浪高|Wave Period|浪周期|Current Speed|流速|Current Direction|流向|Water Depth|水深|Best Fishing Window|最佳.*窗口|最佳.*时段)/i;

/**
 * 从完整报告文本里提取聊天框摘要行。
 *   - 只抓 CHAT_FIELDS 里定义的 label 行(及其续行,如潮汐/wind blocks)
 *   - 含星级的行抓取(去掉理由)
 *   - 分析性散文/ANALYSIS 大段文字一概跳过
 */
function extractSummary(fullText) {
  const lines = (fullText || '').split('\n');
  const out = [];
  let curField = null; // 当前正在抓取的 field(null = 不在抓取状态)

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) { curField = null; continue; }

    // 检查是否命中某个 CHAT_FIELD label
    const matched = CHAT_FIELDS.find((f) => f.re.test(trimmed));
    if (matched) {
      out.push(trimmed);
      curField = matched.multi ? matched : null;
      continue;
    }

    // 鱼种星级行 → 取鱼种+星级(截掉理由部分)
    if (SPECIES_LINE_RE.test(trimmed) && !/^(Analysis|Target|情况分析|目标鱼种)/i.test(trimmed)) {
      // 去掉 "- " 前缀 + 理由(" - xxx" / " — xxx" / 换行后的理由在前面已 curField=null 不会被抓)
      const clean = trimmed.replace(/^[-•]\s*/, '').replace(/\s*[-—–]\s+.+$/, '').trim();
      if (clean) out.push(clean);
      curField = null;
      continue;
    }

    // 续行:如果当前 field 是 multi,且行不像新 section → 继续抓
    if (curField) {
      // 新 section header / 另一个 CHAT_FIELD label → 停止
      if (SECTION_HEADER_RE.test(trimmed) || CHAT_FIELDS.some((f) => f.re.test(trimmed))) {
        curField = null;
        i--; // re-process this line
        continue;
      }
      out.push(trimmed);
      continue;
    }
  }

  return out.join('\n');
}

const FISHING_PROMPT = `You are an experienced saltwater fishing guide specializing in U.S. East Coast shore fishing.
Your job is to analyze the provided spotConditions JSON and determine whether the fishing conditions are favorable.
Always base your analysis ONLY on the supplied JSON. Use your fishing knowledge only to interpret the provided data, never to invent missing information.

================== GENERAL RULES ==================
1. Never invent, estimate, interpolate, or assume any numeric value.
2. Every number must come directly from the JSON.
3. If a value is null or missing, output "No data".
4. Never fabricate: tide, weather, wind, water temperature, tidal current, wave conditions, moon phase, sunrise, sunset, fishing windows.
5. Never mention JSON fields, APIs, or data sources.
6. Be objective.
7. Do not exaggerate certainty.
8. Keep explanations concise and practical.

================== CURRENT vs PREDICTION ==================
Automatically determine which mode is provided.
If the JSON contains currentTideAndWeather -> analyze CURRENT conditions.
If the JSON contains predictTideAndWeather -> analyze FUTURE conditions.
Never mix fields between the two modes.

================== FIELD MAPPING ==================
Current Mode: Current Time -> currentTime; Tide -> tideExtremes; Weather -> currentTideAndWeather; Alerts -> currentTideAndWeather.alerts; Sun/Moon/Water Depth -> common.
Prediction Mode: Current Time -> currentTime; Prediction -> predictTideAndWeather; Tide -> predictTideAndWeather.tideExtremes; Hourly Forecast -> predictTideAndWeather.hourly; Alerts -> predictTideAndWeather.alerts; Sun/Moon/Water Depth -> common.

================== SPECIAL RULES ==================
Water Temperature: Current Mode -> currentTideAndWeather.waterTemp; Prediction Mode -> if unavailable output "No data". Never use air temperature as water temperature.
Wind Direction: Current Mode -> prefer wind.cardinal (if unavailable "No data"); Prediction Mode -> hourly.windDirection.
Moon: use common.moonPhase. Moon Illumination: use common.moonIllumination. Never infer moon phase from illumination.
Tides (mode-aware): tideExtremes is a CHRONOLOGICAL list of tide events, each { type: "High" | "Low", time, height }, already sorted by time (it naturally alternates high/low). It already contains exactly the right window for the request, so just present it as-is.
- CURRENT mode (currentTideAndWeather present): report the NEXT High Tide and the NEXT Low Tide (the first future event of each type after Current Time), then the following upcoming events in time order, e.g. "Next High 18:01 (3.19 ft); Next Low 00:20 (0.74 ft); then 06:19 High 2.68 ft".
- PREDICTION mode (predictTideAndWeather present): list ALL events in tideExtremes in time order, e.g. "00:20 Low 0.74 ft -> 06:19 High 2.68 ft -> 11:45 Low 0.61 ft -> 18:47 High 3.29 ft". Do NOT collapse it into a single next-high/next-low.
If the list is empty, output "No data".
Prediction Hour Selection: use the hourly forecast matching the requested fishing time. If a time range is requested, evaluate the entire range.
Alerts: the alerts array holds active NWS advisories/warnings, each { event, headline, severity, isMarine, effective, expires }. Report each one (prefer marine-related alerts, isMarine=true). If the array is empty, there are no active alerts.
Wind / Air Temperature / Weather in Prediction Mode: if the JSON contains an "hourlyBlocks" array, use it to present Wind, Air Temperature, and Weather as fixed 3-hour clock blocks (one line per block, e.g. "00:00-02:59 4.3-5.2 kt NE"). Use hourlyBlocks EXACTLY as given — do NOT list individual hours or invent different groupings.

================== OUTPUT FORMAT ==================
Current Time:
Sunrise / Sunset:
Moon Phase:
Moon Illumination:
Tides:
Water Temperature:
Wind:
Air Temperature:
Weather:
Alerts:
Wave Height:
Wave Period:
Current Speed:
Current Direction:
Water Depth:

================== ANALYSIS ==================
Evaluate the fishing conditions in the following priority order.
For EACH point below, if its underlying data is missing/null (No data), simply output "No data" for that point -- do NOT force an analysis out of missing data, do NOT guess or reason around it.
1. Tide: rising / falling / near slack. Explain how it affects fish activity.
2. Tidal Current: speed, direction.
3. Wave Conditions: wave height, swell height, wave period. Explain whether the sea state is favorable and safe for shore fishing.
4. Weather: wind speed, wind direction, wind gust, rain probability, thunderstorm probability, marine alerts. Explain how weather may influence fishing.
5. Water Temperature: whether it is generally favorable for fish activity.
6. Sun & Moon: sunrise, sunset, moon phase, moon illumination. Explain whether they improve the expected bite window.
7. Bottom Conditions: if available, water depth, reef, shoal, drop-off, bottom structure. Explain whether the location is likely to hold fish.

================== TARGET SPECIES ==================
If the JSON contains targetSpecies, evaluate EVERY species in the list. Do NOT add, remove, or reorder species.
Assign each species a star rating: 5 stars Excellent / 4 stars Very Good / 3 stars Fair / 2 stars Poor / 1 star Very Poor.
Each rating should consider the overall conditions (tide, tidal current, water temperature, wind, weather, wave conditions, time of day, sunrise/sunset, moon phase, moon illumination, water depth, bottom structure).
Different species should usually receive different ratings; do not give every species the same score.
Provide one concise sentence explaining each rating.

================== FINAL VERDICT ==================
Best Fishing Window: recommend the best upcoming fishing window, briefly explaining why (tide/current/weather/species reasoning).

================== STYLE ==================
Write like an experienced fishing guide. Avoid repeating raw weather data. Focus on helping anglers decide: should they fish? when should they fish? which species are most likely to bite? Prefer practical fishing advice over weather reporting. Do not overstate certainty. If multiple factors conflict (e.g. excellent tide but thunderstorms), explain the trade-off.`;

export default {
  name: 'analyzeFishing',
  description:
    'Judge whether a spot is good for fishing: auto-fetches conditions and returns a structured report ' +
    '(conditions summary + tide/current/wave/weather/water-temp/sun-moon/bottom analysis + fishing score, confidence, verdict, best window, pros/cons). ' +
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
    // 现在=current;今天/未来某天=prediction(窗口差异由 getPredictConditions 内部按日期处理)
    const predict = mode === 'prediction' || !!date;
    const conditions = predict
      ? await getPredictConditions(latitude, longitude, { name, note, date, unitSystem })
      : await getCurrentConditions(latitude, longitude, { name, note, unitSystem });

    // ↓ 运行时追加(FISHING_PROMPT 之外的运行规则):语言 + 时间格式
    // 回复语言跟随用户提问(由 agentCore 检测后透传),含所有字段标题/小标题
    const langLine =
      context.lang === 'en'
        ? '[Language] Reply ENTIRELY in English, including all field labels and section headers.'
        : '[Language] Reply ENTIRELY in Chinese (中文), translating all field labels and section headers.';
    // 时间只显示本地 HH:MM(current time 可带日期),不要输出完整 ISO 时间戳
    const timeLine =
      '[Time format] Show local clock time as HH:MM (e.g. 05:34); Current Time may include the date. Never output the full ISO timestamp.';

    // 预测模式:代码里预先把逐小时算成固定 3 小时时段块(风/气温/天气),摘要照着渲染,避免模型自行采样出错
    if (predict) {
      conditions.hourlyBlocks = computeHourlyBlocks(conditions.predictTideAndWeather?.hourly, unitSystem || 'english');
    }

    // 目标鱼种随 JSON 一起给模型(提示词从 JSON 的 targetSpecies 读取并逐种评级)
    const payload = { ...conditions, targetSpecies: TARGET_SPECIES };

    const completion = await getClient().chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: `${FISHING_PROMPT}\n\n${langLine}\n${timeLine}` },
        { role: 'user', content: 'spotConditions JSON:\n' + JSON.stringify(payload) },
      ],
    });

    // LLM 只出一段完整报告;代码从里面提取聊天框摘要
    const full = (completion.choices?.[0]?.message?.content || '').trim();
    const summary = extractSummary(full);
    return { summary, full, conditions };
  },
};
