// ============================================================================
// tool: getPredictWeather —— 预测某坐标未来约 24 小时的海况时间线
//   回答"今天/明天/等下怎样、几点涨落潮、涨还是退":
//   逐小时(潮位/潮流/天气/风/浪)+ 高低潮 tideExtremes + 预警 + 常驻块。
// ============================================================================
import { getPredictConditions } from '../../services/spotConditions.js';

export default {
  name: 'getPredictWeather',
  description:
    '预测某坐标未来约 24 小时的海况:逐小时潮位/潮流/气温/风/浪/天气,加上高低潮时刻(tideExtremes)、' +
    '海上预警,以及日月/水深。用于回答"今天/明天/等下好不好钓、几点涨潮/落潮、现在涨还是退"这类预测问题。',
  parameters: {
    type: 'object',
    properties: {
      latitude: { type: 'number', description: '纬度,十进制度' },
      longitude: { type: 'number', description: '经度,十进制度' },
      name: { type: 'string', description: '钓点名(来自 queryCoords,可选)' },
      note: { type: 'string', description: '钓点备注(来自 queryCoords,可选)' },
      date: {
        type: 'string',
        description: '目标日期 YYYY-MM-DD;省略则为"从现在起未来约24小时"',
      },
      unitSystem: {
        type: 'string',
        enum: ['english', 'metric'],
        description: '单位制,默认 english(ft/knots/°F)',
      },
    },
    required: ['latitude', 'longitude'],
    additionalProperties: false,
  },
  async execute({ latitude, longitude, name, note, date, unitSystem } = {}) {
    return getPredictConditions(latitude, longitude, { name, note, date, unitSystem });
  },
};
