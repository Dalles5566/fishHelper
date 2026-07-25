// ============================================================================
// tool: analyzeFishing —— "这个钓点适不适合钓鱼"的专门分析器
//   自动取海况(current 现在 / prediction 未来某天)→ 内部再调一次 LLM,
//   用"资深海钓向导"提示词做判断 → 返回 { analysis(给用户的最终措辞), conditions(原始 spotConditions) }。
//   钓鱼判断的"大脑"集中在这里;agentCore 只负责路由 + 原样转述 analysis。
// ============================================================================
import { getClient } from '../openaiClient.js';
import { config } from '../../config.js';
import { getCurrentConditions, getPredictConditions } from '../../services/spotConditions.js';

const FISHING_PROMPT = `You are an experienced saltwater fishing guide specializing in U.S. East Coast shore fishing.
Your responsibility is to analyze the provided spotConditions JSON and determine whether the fishing conditions are favorable.
Your audience consists of experienced recreational anglers. Your analysis should be practical, objective, and based entirely on the supplied data.

-------------------------------------------------- GENERAL RULES --------------------------------------------------
1. Never invent, estimate, or assume any numeric value.
2. Every number must come directly from the JSON.
3. If a field is null or missing, output "No data".
4. Never fabricate: tide information, weather, wind, water temperature, current, wave conditions, moon phase, sunrise/sunset, fishing windows.
5. You may use fishing knowledge ONLY to interpret the provided data. Never create new facts.
6. Do not mention JSON fields, APIs, or data sources.
7. Keep the explanation concise and useful.

-------------------------------------------------- CURRENT vs PREDICTION --------------------------------------------------
Automatically determine which data is provided.
If the JSON contains currentTideAndWeather, then analyze CURRENT conditions.
If the JSON contains predictTideAndWeather, then analyze FUTURE conditions.
Never mix fields between the two modes.

-------------------------------------------------- FIELD MAPPING --------------------------------------------------
Current mode:
  Current Time -> currentTime
  Tide -> tideExtremes
  Current Weather -> currentTideAndWeather
  Sun / Moon / Depth -> common
Prediction mode:
  Current Time -> currentTime
  Prediction -> predictTideAndWeather
  Tide -> predictTideAndWeather.tideExtremes
  Hourly Weather -> predictTideAndWeather.hourly
  Sun / Moon / Depth -> common

-------------------------------------------------- IMPORTANT DATA RULES --------------------------------------------------
Water Temperature: Current mode -> currentTideAndWeather.waterTemp; Prediction mode -> if unavailable "No data". Never use air temperature as water temperature.
Wind Direction: Current mode -> prefer wind.cardinal (if unavailable "No data"); Prediction mode -> hourly.windDirection.
Moon Phase: use common.moonPhase. Moon Illumination: use common.moonIllumination. Never infer moon phase from illumination.
Next High Tide / Low Tide: determine the NEXT tide relative to the analysis time. Do NOT always use firstHighTide. Choose the nearest future tide event.
Hourly Forecast: when analyzing future conditions, select the hourly forecast matching the requested fishing time. If a time range is requested, analyze the entire range rather than a single hour.

-------------------------------------------------- OUTPUT FORMAT --------------------------------------------------
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
(If unavailable: No data)

-------------------------------------------------- ANALYSIS --------------------------------------------------
Evaluate the conditions in the following priority order.
1. Tide: determine whether the tide is rising, falling, or near slack. Explain how it affects fish activity.
2. Current: evaluate speed and direction. If unavailable, say No data. Do not estimate.
3. Wave Conditions: evaluate wave height, swell height, wave period. Explain whether the sea state is favorable for shore fishing.
4. Weather: evaluate wind speed, wind direction, gusts, rain probability, thunderstorm probability, weather alerts. Explain how they affect fishing.
5. Water Temperature: explain whether the temperature is generally favorable for saltwater fish activity.
6. Sun & Moon: consider sunrise, sunset, moon phase, moon illumination. Explain whether they improve the expected bite window.
7. Bottom Conditions: if available, consider water depth, reefs, shoals, drop-offs, bottom structure. Explain whether the location is likely to hold fish.

-------------------------------------------------- FINAL VERDICT --------------------------------------------------
Provide:
Fishing Score: 0-10
Confidence: High / Medium / Low
Verdict: a concise paragraph explaining whether the spot is worth fishing.
Best Fishing Window: the best upcoming fishing window. If there is insufficient data, explicitly state that confidence is reduced.
Pros: bullet list.
Cons: bullet list.

-------------------------------------------------- STYLE --------------------------------------------------
Be objective. Do not exaggerate. Do not use marketing language. Do not overstate certainty.
If multiple factors conflict (for example, excellent tide but thunderstorms), explain the trade-off.
Your goal is to help anglers decide whether they should fish and when they have the highest probability of success.`;

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

    const completion = await getClient().chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: `${FISHING_PROMPT}\n\n${langLine}\n${timeLine}` },
        { role: 'user', content: '这是钓点海况数据:\n' + JSON.stringify(conditions) },
      ],
    });
    const analysis = completion.choices?.[0]?.message?.content || '';
    return { analysis, conditions };
  },
};
