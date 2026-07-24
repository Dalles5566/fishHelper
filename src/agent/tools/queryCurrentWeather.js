// ============================================================================
// tool: queryCurrentWeather —— 查某坐标"现在"的实测海况快照
//   回答"现在这里怎么样":实测潮位/水温/气温/风/浪/天气 + 常驻块(日月/水深/河流)。
//   name/note 若已知(来自 queryCoords)一并传入,会原样带在结果顶部。
// ============================================================================
import { getCurrentConditions } from '../../services/spotConditions.js';

export default {
  name: 'queryCurrentWeather',
  description:
    '查询某坐标"现在"的实测海况:当前潮位、水温、气温、气压、风(速/向/阵风)、浪、天气描述、' +
    '预警,以及日月(日出日落/月相)、水深。用于回答"现在这里怎么样"这类当下问题。',
  parameters: {
    type: 'object',
    properties: {
      latitude: { type: 'number', description: '纬度,十进制度' },
      longitude: { type: 'number', description: '经度,十进制度' },
      name: { type: 'string', description: '钓点名(来自 queryCoords,可选)' },
      note: { type: 'string', description: '钓点备注(来自 queryCoords,可选)' },
      unitSystem: {
        type: 'string',
        enum: ['english', 'metric'],
        description: '单位制,默认 english(ft/knots/°F)',
      },
    },
    required: ['latitude', 'longitude'],
    additionalProperties: false,
  },
  async execute({ latitude, longitude, name, note, unitSystem } = {}) {
    return getCurrentConditions(latitude, longitude, { name, note, unitSystem });
  },
};
