// ============================================================================
// tool: getCoordinateByName —— 查询已保存的钓点坐标
//   给 name → 按名精确查(忽略大小写);不给 name → 返回全部钓点列表。
//   典型用法:用户说"xxx 今天怎样",agent 先用本 tool 拿到 {name,lat,lng,note},
//   再把这些传给 getCurrentWeather / getPredictWeather。
// ============================================================================
import { listCoordinates, findCoordinateByName, searchCoordinates } from '../../db/coordinates.js';

export default {
  name: 'getCoordinateByName',
  description:
    '查询已保存的钓点坐标。传 name 时:先精确匹配,匹配不到再按名字/备注做模糊(部分)匹配 —— ' +
    '所以用户只说钓点名的一部分(如"ProvinceTown")或备注里的叫法(如"军校""基佬村")也能查到。' +
    '返回单个 {name,latitude,longitude,note},或多个候选 matches;不传 name 则返回全部钓点列表。' +
    '用于把钓点名解析成经纬度,再交给天气工具。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '钓点名或其一部分(也可用备注里的叫法)。省略则列出全部钓点。',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ name } = {}) {
    if (name && name.trim()) {
      const term = name.trim();
      // ① 精确匹配优先
      const exact = await findCoordinateByName(term);
      if (exact) return exact;
      // ② 模糊匹配(名字/备注部分匹配)
      const matches = await searchCoordinates(term);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        return { matches, message: `找到 ${matches.length} 个可能的钓点,请让用户确认是哪一个` };
      }
      return { found: false, name: term, message: `未找到与「${term}」相关的钓点` };
    }
    const all = await listCoordinates();
    return { count: all.length, coordinates: all };
  },
};
