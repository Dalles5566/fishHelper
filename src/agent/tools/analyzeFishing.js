// ============================================================================
// tool: analyzeFishing —— "这个钓点适不适合钓鱼"的专门分析器
//   自动取海况(current 现在 / prediction 未来某天)→ 内部再调一次 LLM,
//   用"资深海钓向导"提示词做判断,产出两段 → 返回 { summary(精简摘要,发聊天), full(完整报告,拼进附件), conditions }。
//   钓鱼判断的"大脑"集中在这里;agentCore 用 summary 作聊天正文,把 full 拼在 JSON 附件后面。
// ============================================================================
import { getClient } from '../openaiClient.js';
import { config } from '../../config.js';
import { getCurrentConditions, getPredictConditions } from '../../services/spotConditions.js';
import { findCoordinateByName, searchCoordinates } from '../../db/coordinates.js';

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
1. Tide: rising / falling / near slack. Explain how it affects fish activity.
2. Tidal Current: speed, direction. If unavailable output No data. Do not estimate.
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
Fishing Score: 0-10
Confidence: High / Medium / Low
Verdict: one concise paragraph explaining the overall fishing conditions.
Best Fishing Window: recommend the best upcoming fishing window. If confidence is reduced due to missing data, explicitly state that.
Pros: bullet list.
Cons: bullet list.
Today's Best Targets: 🥇 best species / 🥈 second / 🥉 third (from the target list).

================== STYLE ==================
Write like an experienced fishing guide. Avoid repeating raw weather data. Focus on helping anglers decide: should they fish? when should they fish? which species are most likely to bite? Prefer practical fishing advice over weather reporting. Do not overstate certainty. If multiple factors conflict (e.g. excellent tide but thunderstorms), explain the trade-off.`;

export default {
  name: 'analyzeFishing',
  description:
    'Judge whether a spot is good for fishing: auto-fetches conditions and returns a structured report ' +
    '(conditions summary + tide/current/wave/weather/water-temp/sun-moon/bottom analysis + fishing score, confidence, verdict, best window, pros/cons). ' +
    'Use this tool for ANY judgment question (is it good to fish / how is it / when should I go / now or later / ' +
    'how about today/tomorrow / rising or falling), NOT getCurrentWeather/getPredictWeather (those return raw data only). ' +
    'Pass the saved-spot `name` directly and it resolves the coordinates itself -- you do NOT need to call getCoordinateByName first. ' +
    'Only pass latitude/longitude when the user gives a raw coordinate (no saved name).',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Saved fishing-spot name or keyword (a note nickname like "军校"/"基佬村" also works). ' +
          'If given, coordinates are resolved from the database automatically -- omit latitude/longitude.',
      },
      latitude: { type: 'number', description: 'Latitude (only for a raw coordinate; omit if name is given)' },
      longitude: { type: 'number', description: 'Longitude (only for a raw coordinate; omit if name is given)' },
      note: { type: 'string', description: 'Spot note (optional; auto-filled when resolved by name)' },
      mode: {
        type: 'string',
        enum: ['current', 'prediction'],
        description: 'now (current) or future forecast (prediction); default current',
      },
      date: { type: 'string', description: 'Target date YYYY-MM-DD (when mode=prediction; omit = from now)' },
      unitSystem: { type: 'string', enum: ['english', 'metric'], description: 'default english' },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ latitude, longitude, name, note, mode, date, unitSystem } = {}, context = {}) {
    // 只给了钓点名(没给坐标)→ 内部查库解析,省掉 agent 先单独调 getCoordinateByName 的那一轮
    if ((latitude == null || longitude == null) && name && name.trim()) {
      const term = name.trim();
      let spot = await findCoordinateByName(term); // ① 精确
      if (!spot) {
        const matches = await searchCoordinates(term); // ② 模糊(名字/备注)
        if (matches.length === 1) spot = matches[0];
        else if (matches.length > 1) {
          return {
            error: true,
            tool: 'analyzeFishing',
            message: `找到 ${matches.length} 个可能的钓点(${matches.map((m) => m.name).join('、')}),请让用户确认是哪一个`,
          };
        } else {
          return { error: true, tool: 'analyzeFishing', message: `未找到与「${term}」相关的钓点` };
        }
      }
      latitude = spot.latitude;
      longitude = spot.longitude;
      name = spot.name;
      note = spot.note ?? note;
    }
    if (latitude == null || longitude == null) {
      return { error: true, tool: 'analyzeFishing', message: '缺少坐标,也没有可识别的钓点名' };
    }

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

    // 两段输出:PART 1 = 精简摘要(发聊天),PART 2 = 完整报告(拼进 .txt 附件)
    const splitLine =
      'Output in TWO parts separated by a line containing only "===FULL===".\n' +
      'PART 1 (before ===FULL===) = a SHORT summary. Put items on their own lines, in this EXACT order:\n' +
      '1) Current Time (label + value on one line).\n' +
      '2) Sunrise / Sunset (label + value on one line).\n' +
      '3) A label line "Tides:" ALONE, then the tide info from the mode-aware tide rule with EACH event on its OWN line below it ' +
      '(CURRENT mode: Next High / Next Low / then each following event, one per line; PREDICTION mode: every event in time order, one per line, e.g. "04:24 Low 0.843 ft"). Do NOT use arrows.\n' +
      '4) Water Temperature (label + value on one line).\n' +
      '5) Wind, then Air Temperature, then Weather:\n' +
      '   - CURRENT mode: label + the single current value on one line each.\n' +
      '   - PREDICTION mode: the JSON has a precomputed "hourlyBlocks" array, already grouped into fixed 3-hour clock blocks in order. ' +
      'Print the label ALONE, then ONE line per block. Under Wind: "<range> <block.wind>"; under Air Temperature: "<range> <block.airTemp>"; under Weather: "<range> <block.weather>" ' +
      '(use each block\'s range field, e.g. "00:00-02:59"). Use hourlyBlocks EXACTLY as given — do NOT invent times, do NOT sample individual hours, do NOT merge blocks. Skip a field only if it is null.\n' +
      '6) One line for precipitation and thunderstorm probability (e.g. "Precip 0%, Thunderstorm 0%"; PREDICTION mode: use the day\'s highest).\n' +
      '7) An "Alerts:" label, then each active alert on its own line (event name; add the headline if concise). If the alerts array is empty, write "No active alerts" on the same line as the label.\n' +
      '8) Each target species with its star rating, one line each.\n' +
      '9) Best Fishing Window (label + value).\n' +
      'Put NOTHING else in PART 1.\n' +
      "PART 2 (after ===FULL===) = the COMPLETE report exactly as specified above (all OUTPUT FORMAT fields, full ANALYSIS, " +
      "per-species ratings with one-line reasons, FINAL VERDICT, and Today's Best Targets).";

    // 预测模式:代码里预先把逐小时算成固定 3 小时时段块(风/气温/天气),摘要照着渲染,避免模型自行采样出错
    if (predict) {
      conditions.hourlyBlocks = computeHourlyBlocks(conditions.predictTideAndWeather?.hourly, unitSystem || 'english');
    }

    // 目标鱼种随 JSON 一起给模型(提示词从 JSON 的 targetSpecies 读取并逐种评级)
    const payload = { ...conditions, targetSpecies: TARGET_SPECIES };

    const completion = await getClient().chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: `${FISHING_PROMPT}\n\n${langLine}\n${timeLine}\n\n${splitLine}` },
        { role: 'user', content: 'spotConditions JSON:\n' + JSON.stringify(payload) },
      ],
    });

    // 切成摘要 / 完整两段;没有切分标记则两者都用整段兜底
    const raw = completion.choices?.[0]?.message?.content || '';
    const marker = '===FULL===';
    const i = raw.indexOf(marker);
    const summary = (i >= 0 ? raw.slice(0, i) : raw).trim();
    const full = (i >= 0 ? raw.slice(i + marker.length) : raw).trim();
    return { summary, full, conditions };
  },
};
