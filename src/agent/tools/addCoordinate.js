// ============================================================================
// tool: addCoordinate —— 新增/更新一个钓点坐标
//   按名唯一(忽略大小写);重名则更新其经纬度与备注(upsert)。
// ============================================================================
import { addCoordinate } from '../../db/coordinates.js';

export default {
  name: 'addCoordinate',
  adminOnly: true, // 仅管理员可添加/更新钓点(非管理员时此工具对模型隐藏 + 执行层拦截)
  description:
    'Save (or update) a fishing-spot coordinate in the database. Unique by name; if the name already exists, ' +
    'its coordinates and note are updated. Use when the user asks to save/remember a spot.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Spot name (unique key, case-insensitive)' },
      latitude: { type: 'number', description: 'Latitude, decimal degrees (e.g. 41.4800)' },
      longitude: { type: 'number', description: 'Longitude, decimal degrees (e.g. -71.3355)' },
      note: { type: 'string', description: 'Optional note (e.g. "best 1h before high tide")' },
    },
    required: ['name', 'latitude', 'longitude'],
    additionalProperties: false,
  },
  async execute({ name, latitude, longitude, note } = {}) {
    const saved = await addCoordinate({ name, latitude, longitude, note });
    return { saved: true, coordinate: saved };
  },
};
