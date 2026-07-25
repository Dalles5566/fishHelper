// ============================================================================
// 工具注册表 —— agentCore 从这里拿"给 OpenAI 的 schema"和"名字→执行函数"映射。
//   新增工具:在此 import 并加进 tools 数组即可,agentCore 主循环不用改。
//   约定:tool 的 name === 文件名(如 getCurrentWeather → getCurrentWeather.js)。
// ============================================================================
import getCoordinateByName from './getCoordinateByName.js';
import addCoordinate from './addCoordinate.js';
import getCurrentWeather from './getCurrentWeather.js';
import getPredictWeather from './getPredictWeather.js';

/** 所有工具(每个 = { name, description, parameters, execute, adminOnly? }) */
export const tools = [getCoordinateByName, addCoordinate, getCurrentWeather, getPredictWeather];

const toSchema = (t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
});

/** 给定 isAdmin,返回可见的 OpenAI tools 数组(非管理员隐藏 adminOnly 工具) */
export function toolSchemasFor(isAdmin) {
  return tools.filter((t) => isAdmin || !t.adminOnly).map(toSchema);
}

/** 全量 schema(兼容旧用法) */
export const toolSchemas = tools.map(toSchema);

/** name → 工具 的映射 */
const toolMap = new Map(tools.map((t) => [t.name, t]));

/**
 * 按名执行工具。args 为 OpenAI 传回的参数对象;context 里带 isAdmin 等调用上下文。
 * adminOnly 工具在非管理员时拒绝(双保险,即使模型硬调也拦得住)。
 * 未知工具抛错;工具内部异常向上抛,由 agentCore 捕获回填给模型。
 */
export async function executeTool(name, args = {}, context = {}) {
  const tool = toolMap.get(name);
  if (!tool) throw new Error(`未知工具: ${name}`);
  if (tool.adminOnly && !context.isAdmin) {
    return { error: true, tool: name, message: '仅管理员可添加/修改钓点,普通用户无此权限' };
  }
  return tool.execute(args);
}
