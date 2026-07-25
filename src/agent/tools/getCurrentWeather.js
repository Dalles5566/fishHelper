// ============================================================================
// tool: getCurrentWeather —— 查某坐标"现在"的实测海况快照
//   回答"现在这里怎么样":实测潮位/水温/气温/风/浪/天气 + 常驻块(日月/水深/河流)。
//   name/note 若已知(来自 getCoordinateByName)一并传入,会原样带在结果顶部。
// ============================================================================
import { getCurrentConditions } from '../../services/spotConditions.js';

export default {
  name: 'getCurrentWeather',
  description:
    "Get a spot's CURRENT observed conditions: water level, water/air temp, pressure, wind (speed/dir/gust), " +
    'waves, weather, alerts, plus sun & moon (sunrise/sunset/phase), depth, and next high/low tide. ' +
    'For "how is it here right now" (raw data, no judgment).',
  parameters: {
    type: 'object',
    properties: {
      latitude: { type: 'number', description: 'Latitude, decimal degrees' },
      longitude: { type: 'number', description: 'Longitude, decimal degrees' },
      name: { type: 'string', description: 'Spot name (from getCoordinateByName, optional)' },
      note: { type: 'string', description: 'Spot note (from getCoordinateByName, optional)' },
      unitSystem: {
        type: 'string',
        enum: ['english', 'metric'],
        description: 'unit system, default english (ft/knots/degF)',
      },
    },
    required: ['latitude', 'longitude'],
    additionalProperties: false,
  },
  async execute({ latitude, longitude, name, note, unitSystem } = {}) {
    return getCurrentConditions(latitude, longitude, { name, note, unitSystem });
  },
};
