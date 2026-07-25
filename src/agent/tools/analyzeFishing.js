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
Current Mode: Current Time -> currentTime; Tide -> tideExtremes; Weather -> currentTideAndWeather; Sun/Moon/Water Depth -> common.
Prediction Mode: Current Time -> currentTime; Prediction -> predictTideAndWeather; Tide -> predictTideAndWeather.tideExtremes; Hourly Forecast -> predictTideAndWeather.hourly; Sun/Moon/Water Depth -> common.

================== SPECIAL RULES ==================
Water Temperature: Current Mode -> currentTideAndWeather.waterTemp; Prediction Mode -> if unavailable output "No data". Never use air temperature as water temperature.
Wind Direction: Current Mode -> prefer wind.cardinal (if unavailable "No data"); Prediction Mode -> hourly.windDirection.
Moon: use common.moonPhase. Moon Illumination: use common.moonIllumination. Never infer moon phase from illumination.
Next High/Low Tide: tideExtremes is a CHRONOLOGICAL list of tide events, each { type: "High" | "Low", time, height }, sorted by time. The Next High Tide = the FIRST event with type "High" whose time is after Current Time; the Next Low Tide = the first "Low" event after Current Time. Only output "No data" if the list is empty or contains no such future event.
Prediction Hour Selection: use the hourly forecast matching the requested fishing time. If a time range is requested, evaluate the entire range.

================== OUTPUT FORMAT ==================
Current Time:
Sunrise / Sunset:
Moon Phase:
Moon Illumination:
Next High Tide:
Next Low Tide:
Water Temperature:
Wind:
Air Temperature:
Weather:
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
      'PART 1 (before ===FULL===) = a SHORT summary, one item per line, in this exact order: ' +
      'Current Time; Sunrise / Sunset; Next High Tide; Next Low Tide; Water Temperature; Wind; Air Temperature; Weather; ' +
      'then each target species with its star rating (one line each); then Best Fishing Window. Put NOTHING else in PART 1.\n' +
      "PART 2 (after ===FULL===) = the COMPLETE report exactly as specified above (all OUTPUT FORMAT fields, full ANALYSIS, " +
      "per-species ratings with one-line reasons, FINAL VERDICT, and Today's Best Targets).";

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
