// ============================================================================
// 工具注册表 —— agentCore 从这里拿"给 OpenAI 的 schema"和"名字→执行函数"映射。
//   新增工具:在此 import 并加进 tools 数组即可,agentCore 主循环不用改。
// ============================================================================
import queryCoords from './queryCoords.js';
import addCoord from './addCoord.js';
import queryCurrentWeather from './queryCurrentWeather.js';
import predictWeather from './predictWeather.js';

/** 所有工具(每个 = { name, description, parameters, execute }) */
export const tools = [queryCoords, addCoord, queryCurrentWeather, predictWeather];

/** OpenAI function-calling 需要的 tools 数组 */
export const toolSchemas = tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

/** name → 工具 的映射 */
const toolMap = new Map(tools.map((t) => [t.name, t]));

/**
 * 按名执行工具。args 为 OpenAI 传回的参数对象。
 * 未知工具抛错;工具内部异常向上抛,由 agentCore 捕获回填给模型。
 */
export async function executeTool(name, args = {}) {
  const tool = toolMap.get(name);
  if (!tool) throw new Error(`未知工具: ${name}`);
  return tool.execute(args);
}
