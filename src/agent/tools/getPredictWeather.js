// ============================================================================
// tool: getPredictWeather —— 预测某坐标未来约 24 小时的海况时间线
//   回答"今天/明天/等下怎样、几点涨落潮、涨还是退":
//   逐小时(潮位/潮流/天气/风/浪)+ 高低潮 tideExtremes + 预警 + 常驻块。
// ============================================================================
import { getPredictConditions } from '../../services/spotConditions.js';

export default {
  name: 'getPredictWeather',
  description:
    "Forecast a spot's conditions ~next 24h: hourly water level/tidal current/air temp/wind/waves/weather, " +
    'plus high/low tide times (tideExtremes), marine alerts, and sun & moon / depth. ' +
    'For "how about today/tomorrow/later, when is high/low tide, rising or falling" (raw data, no judgment).',
  parameters: {
    type: 'object',
    properties: {
      latitude: { type: 'number', description: 'Latitude, decimal degrees' },
      longitude: { type: 'number', description: 'Longitude, decimal degrees' },
      name: { type: 'string', description: 'Spot name (from getCoordinateByName, optional)' },
      note: { type: 'string', description: 'Spot note (from getCoordinateByName, optional)' },
      date: {
        type: 'string',
        description: 'Target date YYYY-MM-DD; omit = "next ~24h from now"',
      },
      unitSystem: {
        type: 'string',
        enum: ['english', 'metric'],
        description: 'unit system, default english (ft/knots/degF)',
      },
    },
    required: ['latitude', 'longitude'],
    additionalProperties: false,
  },
  async execute({ latitude, longitude, name, note, date, unitSystem } = {}) {
    return getPredictConditions(latitude, longitude, { name, note, date, unitSystem });
  },
};
