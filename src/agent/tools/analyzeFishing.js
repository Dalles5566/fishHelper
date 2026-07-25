// ============================================================================
// tool: analyzeFishing —— "这个钓点适不适合钓鱼"的专门分析器
//   自动取海况(current 现在 / prediction 未来某天)→ 内部再调一次 LLM,
//   用"资深海钓向导"提示词做判断 → 返回 { analysis(给用户的最终措辞), conditions(原始 spotConditions) }。
//   钓鱼判断的"大脑"集中在这里;agentCore 只负责路由 + 原样转述 analysis。
// ============================================================================
import { getClient } from '../openaiClient.js';
import { config } from '../../config.js';
import { getCurrentConditions, getPredictConditions } from '../../services/spotConditions.js';

const FISHING_PROMPT = `你是资深海钓向导"大哥"。根据给你的 spotConditions JSON,判断这个钓点适不适合钓鱼。

【必须先按顺序列出这几个重点,每项一行】
1. 日出 / 日落
2. 下一次涨潮:时间 + 潮位
3. 水温
4. 风速 + 风向
5. 气温
6. 天气
写完这 6 条,再另起一段给判断:综合潮汐窗口(涨落潮/平潮)、日月(晨昏、月相大潮)、风力、水温、水深,
说明"适不适合钓、什么时候是最佳窗口"。潮汐转换前后、晨昏、大潮期通常更好;大风/雷暴则差。

【数据纪律(严格)】所有数值必须逐字来自 JSON,严禁编造/估算:
- 日出日落/月相 → common;水温 → currentTideAndWeather.waterTemp(预测无 → 写"无数据");
- 下一次高低潮 → tideExtremes(现在在顶层,预测在 predictTideAndWeather.tideExtremes);
- 风/气温/天气 → currentTideAndWeather(现在)或 hourly(预测)。
- 某项是 null 或没有,就写"无数据",绝不猜。
时间已是钓点当地时间(带偏移),直接说几点几分。单位英制(ft/节/°F)。中文口语、简洁。回复务必带"大哥"。`;

export default {
  name: 'analyzeFishing',
  description:
    '判断某坐标适不适合钓鱼:自动获取海况并给出"6 项重点 + 是否适合 + 最佳时段"。' +
    '凡是"适不适合钓/好不好钓/怎么样/什么时候去/现在还是等下/今天明天如何、涨还是退"这类需要判断的问题,' +
    '都用这个工具(而不是 getCurrentWeather/getPredictWeather —— 那两个只给原始数据、不做判断)。',
  parameters: {
    type: 'object',
    properties: {
      latitude: { type: 'number', description: '纬度' },
      longitude: { type: 'number', description: '经度' },
      name: { type: 'string', description: '钓点名(来自 getCoordinateByName,可选)' },
      note: { type: 'string', description: '钓点备注(可选)' },
      mode: {
        type: 'string',
        enum: ['current', 'prediction'],
        description: '现在(current)还是未来预测(prediction);默认 current',
      },
      date: { type: 'string', description: '预测目标日期 YYYY-MM-DD(mode=prediction 时;省略=从现在起)' },
      unitSystem: { type: 'string', enum: ['english', 'metric'], description: '默认 english' },
    },
    required: ['latitude', 'longitude'],
    additionalProperties: false,
  },
  async execute({ latitude, longitude, name, note, mode, date, unitSystem } = {}) {
    const predict = mode === 'prediction' || !!date;
    const conditions = predict
      ? await getPredictConditions(latitude, longitude, { name, note, date, unitSystem })
      : await getCurrentConditions(latitude, longitude, { name, note, unitSystem });

    const completion = await getClient().chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: FISHING_PROMPT },
        { role: 'user', content: '这是钓点海况数据:\n' + JSON.stringify(conditions) },
      ],
    });
    const analysis = completion.choices?.[0]?.message?.content || '';
    return { analysis, conditions };
  },
};
