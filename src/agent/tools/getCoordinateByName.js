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
    'Look up saved fishing-spot coordinates. With name: try exact match first, then fuzzy (partial) match on ' +
    'name OR note -- so part of a name (e.g. "ProvinceTown") or a note nickname (e.g. "军校"/"基佬村") also works. ' +
    'Returns a single {name,latitude,longitude,note}, or multiple candidate matches; without name, returns all spots. ' +
    'Use it to resolve a spot name into coordinates before calling the weather/fishing tools.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Spot name or part of it (a note nickname also works). Omit to list all spots.',
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
