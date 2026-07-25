// ============================================================================
// tool: analyzeFishing —— "这个钓点适不适合钓鱼"的专门分析器
//   自动取海况(current 现在 / prediction 未来某天)→ 内部再调一次 LLM,
//   用"资深海钓向导"提示词做判断 → 返回 { analysis(给用户的最终措辞), conditions(原始 spotConditions) }。
//   钓鱼判断的"大脑"集中在这里;agentCore 只负责路由 + 原样转述 analysis。
// ============================================================================
import { getClient } from '../openaiClient.js';
import { config } from '../../config.js';
import { getCurrentConditions, getPredictConditions } from '../../services/spotConditions.js';

const FISHING_PROMPT = `You are an experienced saltwater fishing guide. Based on the given spotConditions JSON, judge whether this spot is good for fishing.

[First list these highlights, one per line]
1. Sunrise / Sunset
2. Next high tide: time + height
3. Water temperature
4. Wind: speed + direction
5. Air temperature
6. Weather
Then, in a new paragraph, give the verdict: weigh the tide window (rising/falling/slack), sun & moon (dawn/dusk, moon phase / spring tide), wind, water temp, and depth; say whether it's good to fish and when the best window is. Tide turns, dawn/dusk, and spring tides are usually better; strong wind or thunderstorms are bad.

[Data discipline - strict] Every number must come VERBATIM from the JSON; never invent/estimate:
- sunrise/sunset/moon -> common; water temp -> currentTideAndWeather.waterTemp (prediction has none -> "no data");
- next high/low tide -> tideExtremes (current: top-level; prediction: predictTideAndWeather.tideExtremes);
- wind/air temp/weather -> currentTideAndWeather (now) or hourly (prediction).
- If a value is null or absent, write "no data" - never guess.
Times are already local: state ONLY the clock time like 05:34 or 18:19 (NOT the full ISO timestamp). Units: english (ft/knots/degF). Conversational, concise.`;

export default {
  name: 'analyzeFishing',
  description:
    'Judge whether a spot is good for fishing: auto-fetches conditions and returns "6 highlights + verdict + best window". ' +
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

    // 回复语言跟随用户提问(由 agentCore 检测后透传)
    const langLine =
      context.lang === 'en'
        ? '【Language】Reply ENTIRELY in English, including the 6 highlight labels.'
        : '【语言】整段回复(含 6 项小标题)一律用中文。';

    const completion = await getClient().chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: `${FISHING_PROMPT}\n${langLine}` },
        { role: 'user', content: '这是钓点海况数据:\n' + JSON.stringify(conditions) },
      ],
    });
    const analysis = completion.choices?.[0]?.message?.content || '';
    return { analysis, conditions };
  },
};
