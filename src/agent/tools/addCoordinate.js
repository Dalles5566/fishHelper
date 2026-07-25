// ============================================================================
// tool: addCoordinate —— 新增/更新一个钓点坐标
//   按名唯一(忽略大小写);重名则更新其经纬度与备注(upsert)。
// ============================================================================
import { addCoordinate } from '../../db/coordinates.js';

export default {
  name: 'addCoordinate',
  adminOnly: true, // 仅管理员可添加/更新钓点(非管理员时此工具对模型隐藏 + 执行层拦截)
  description:
    '保存(或更新)一个钓点坐标到数据库。按名称唯一,若已存在同名钓点则更新其坐标与备注。' +
    '当用户要求"把某个点存起来/记一下"时使用。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '钓点名(唯一标识,忽略大小写)' },
      latitude: { type: 'number', description: '纬度,十进制度(如 41.4800)' },
      longitude: { type: 'number', description: '经度,十进制度(如 -71.3355)' },
      note: { type: 'string', description: '可选备注(如"涨潮前1小时最好")' },
    },
    required: ['name', 'latitude', 'longitude'],
    additionalProperties: false,
  },
  async execute({ name, latitude, longitude, note } = {}) {
    const saved = await addCoordinate({ name, latitude, longitude, note });
    return { saved: true, coordinate: saved };
  },
};
