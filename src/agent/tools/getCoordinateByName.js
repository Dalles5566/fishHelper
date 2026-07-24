// ============================================================================
// tool: getCoordinateByName —— 查询已保存的钓点坐标
//   给 name → 按名精确查(忽略大小写);不给 name → 返回全部钓点列表。
//   典型用法:用户说"xxx 今天怎样",agent 先用本 tool 拿到 {name,lat,lng,note},
//   再把这些传给 getCurrentWeather / getPredictWeather。
// ============================================================================
import { listCoordinates, findCoordinateByName } from '../../db/coordinates.js';

export default {
  name: 'getCoordinateByName',
  description:
    '查询已保存的钓点坐标。传 name 按名精确查询(忽略大小写),返回该点 {name,latitude,longitude,note};' +
    '不传 name 则返回全部已保存钓点列表。用于把钓点名解析成经纬度,再交给天气工具。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '钓点名。省略则列出全部钓点。',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ name } = {}) {
    if (name && name.trim()) {
      const found = await findCoordinateByName(name.trim());
      return found || { found: false, name, message: `未找到名为「${name}」的钓点` };
    }
    const all = await listCoordinates();
    return { count: all.length, coordinates: all };
  },
};
