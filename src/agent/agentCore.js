// ============================================================================
// AgentCore —— OpenAI function-calling 主循环
// ----------------------------------------------------------------------------
// runAgent(userText, { history }) -> string
//   1. 带上 system prompt(钓鱼助手角色)+ 历史 + 本轮用户消息 + toolSchemas 调 OpenAI
//   2. 模型要调工具 → executeTool 执行 → 结果回填 → 再问,循环
//   3. 直到模型给出最终文本(或达到 MAX_ROUNDS 上限,防死循环)
//   4. 兜底保证回复带"大哥"(用户硬性要求)
// ============================================================================
import OpenAI from 'openai';
import { config } from '../config.js';
import { toolSchemas, executeTool } from './tools/registerTools.js';

const MAX_ROUNDS = 6; // 一次问答里最多几轮"模型↔工具",防止无限调用

const SYSTEM_PROMPT = `你是"钓鱼助手大哥",一个帮用户判断钓鱼时机的助手。用户在美国东部(RI/MA/NH 一带)。

【你的能力(通过工具)】
- getCoordinateByName:把钓点名解析成经纬度(还带备注 note)。用户提到钓点名时先调它。
- addCoordinate:保存/更新钓点坐标。
- getCurrentWeather:某坐标"现在"的实测海况(潮位/水温/气温/风/浪/天气 + 日月/水深)。
- getPredictWeather:某坐标"未来约24小时"的逐小时预测 + 高低潮(tideExtremes)+ 预警。

【选工具】问"现在怎么样"用 getCurrentWeather;问"今天/明天/等下、几点涨落潮、涨还是退"用 getPredictWeather。
用户给的是钓点名而非坐标时,先 getCoordinateByName 拿坐标,再把 name/note/坐标一起传给天气工具。

【判断鱼口】不要只报数字。综合潮汐窗口(涨落潮时段)、日月(日出日落/月相)、风、水温、水深,
给出"何时、好不好钓"的判断。潮汐转换前后、晨昏、日月同升落常是好窗口。

【回复规范】
- 用中文口语回复,简洁实用。
- 时间已是钓点当地时间(带时区偏移),直接说几点几分,不用再换算。
- 单位默认英制(ft/节/°F);用户要公制再说。
- 数据缺失(字段为 null 或 errors 里有记录)就如实说"这项拿不到",不要编。
- 每条回复都要带"大哥"称呼(开头或结尾)。`;

let clientSingleton = null;
function getClient() {
  if (!clientSingleton) {
    clientSingleton = new OpenAI({
      apiKey: config.openai.apiKey,
      baseURL: config.openai.baseURL, // 未配置则 undefined,用官方默认
    });
  }
  return clientSingleton;
}

/** 保证回复带"大哥"(用户硬性要求);模型漏了就补在开头 */
function ensureDage(text) {
  const t = (text || '').trim();
  if (!t) return '大哥,我这边没查到有用的信息。';
  return t.includes('大哥') ? t : `大哥,${t}`;
}

/**
 * 跑一轮完整问答。
 * @param {string} userText 用户输入
 * @param {Array} history 可选的历史消息(OpenAI messages 格式),默认空
 * @returns {Promise<string>} 最终回复文本(已保证带"大哥")
 */
export async function runAgent(userText, { history = [] } = {}) {
  const client = getClient();
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: String(userText ?? '').trim() },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const completion = await client.chat.completions.create({
      model: config.openai.model,
      messages,
      tools: toolSchemas,
      tool_choice: 'auto',
    });

    const msg = completion.choices?.[0]?.message;
    if (!msg) return '大哥,模型没有返回内容,稍后再试试。';

    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      // 没有工具调用 = 最终答案
      return ensureDage(msg.content);
    }

    // 把带 tool_calls 的 assistant 消息压回上下文,再逐个执行工具并回填
    messages.push(msg);
    for (const call of toolCalls) {
      const name = call.function?.name;
      let result;
      try {
        const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        result = await executeTool(name, args);
      } catch (err) {
        result = { error: true, tool: name, message: err.message };
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  // 轮数用尽仍未收敛:让模型基于已有工具结果做一次不带工具的总结
  const finalCompletion = await client.chat.completions.create({
    model: config.openai.model,
    messages: [...messages, { role: 'user', content: '请基于以上信息直接给出最终中文回复(不要再调用工具)。' }],
  });
  return ensureDage(finalCompletion.choices?.[0]?.message?.content);
}

export default runAgent;
