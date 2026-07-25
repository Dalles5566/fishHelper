// ============================================================================
// AgentCore —— OpenAI function-calling 主循环
// ----------------------------------------------------------------------------
// runAgent(userText, { history }) -> string
//   1. 带上 system prompt(钓鱼助手角色)+ 历史 + 本轮用户消息 + toolSchemas 调 OpenAI
//   2. 模型要调工具 → executeTool 执行 → 结果回填 → 再问,循环
//   3. 直到模型给出最终文本(或达到 MAX_ROUNDS 上限,防死循环)
//   4. 兜底保证回复带"大哥"(用户硬性要求)
// ============================================================================
import { config } from '../config.js';
import { getClient } from './openaiClient.js';
import { toolSchemasFor, executeTool } from './tools/registerTools.js';

const MAX_ROUNDS = 6; // 一次问答里最多几轮"模型↔工具",防止无限调用

// agentCore 只做"路由 + 转述";钓鱼判断的逻辑在 analyzeFishing 工具里。
const SYSTEM_PROMPT = `你是"钓鱼助手大哥"的调度器,用户在美国东部(RI/MA/NH 一带)。
你的职责:理解用户意图 → 调用合适的工具 → 把结果如实转达给用户。中文口语,回复务必带"大哥"。

【工具与选择】
- getCoordinateByName:把钓点名/备注(如"军校""基佬村"或名字的一部分)解析成坐标(+备注 note)。
  用户给的是名字而非经纬度时,先调它拿到 {name,latitude,longitude,note}。
- analyzeFishing:判断"适不适合钓鱼"。凡"适不适合钓/好不好钓/怎么样/什么时候去/现在还是等下/今天明天如何/涨还是退"
  这类需要判断的问题,都用它。调用时把 name/note/latitude/longitude 带上;
  问现在用 mode=current,问未来用 mode=prediction 并把相对日期换算成 date=YYYY-MM-DD。
  ★ 它返回的 analysis 已是给用户的最终措辞,请【原样呈现】,不要改写、增删或改动其中任何数值。
- getCurrentWeather / getPredictWeather:用户只想看"原始海况数据"、不要判断时才用。
- addCoordinate:保存/更新钓点(仅管理员;非管理员没有这个工具,别提它)。

【规范】时间已是钓点当地时间,直接用;任何数值只用工具返回的,绝不编造;缺失就说"无数据";回复带"大哥"。`;

/** 保证回复带"大哥"(用户硬性要求);模型漏了就补在开头 */
function ensureDage(text) {
  const t = (text || '').trim();
  if (!t) return '大哥,我这边没查到有用的信息。';
  return t.includes('大哥') ? t : `大哥,${t}`;
}

/** 会产出 spotConditions 的天气工具 */
const WEATHER_TOOLS = new Set(['getCurrentWeather', 'getPredictWeather']);

/** 生成安全文件名片段(保留中英文数字,其余转下划线)*/
function safeName(s) {
  return String(s || 'spot').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40);
}

/**
 * 组装输出为 { text, files }。
 *   - 每个天气结果(current 或 predict 一律)→ 完整 spotConditions JSON 做成 .txt 附件
 *   - text = agent 基于 result 分析出的【大哥的建议】(不再内联 JSON,企业微信收得快)
 * 没调天气工具(纯查/存坐标)→ 只回建议、无附件。
 * @returns {{ text: string, files: {filename:string, content:string}[] }}
 */
function buildOutput(finalText, weatherResults) {
  const suggestion = ensureDage(finalText);
  const files = weatherResults.map((r) => {
    const label = r.name || `${r.latitude},${r.longitude}`;
    const stamp = r.date || (r.currentTime ? r.currentTime.slice(0, 10) : '');
    return { filename: `海况_${safeName(label)}_${stamp}.txt`, content: JSON.stringify(r, null, 2) };
  });
  return { text: suggestion, files };
}

/**
 * 跑一轮完整问答。
 * @param {string} userText 用户输入
 * @param {Array} history 可选的历史消息(OpenAI messages 格式),默认空
 * @returns {Promise<{text:string, files:{filename:string,content:string}[]}>}
 *   text = 内联数据(现在)+【大哥的建议】;files = 预测的完整 JSON(.txt 附件)
 */
/** 当前"钓点所在时区(美东)"的日期时间,注入给模型解析"今天/明天"等相对日期 */
function nowContext() {
  const tz = 'America/New_York';
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  })
    .formatToParts(new Date())
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  const dateStr = `${p.year}-${p.month}-${p.day}`;
  return (
    `【当前时间】${dateStr}(${p.weekday}) ${p.hour}:${p.minute} 美东时间(${tz})。\n` +
    `用户说"今天/明天/后天/这周末"等相对日期时,先据此换算成绝对日期 YYYY-MM-DD,` +
    `再作为 date 参数传给 getPredictWeather。绝不要凭空猜日期。`
  );
}

export async function runAgent(userText, { history = [], isAdmin = false } = {}) {
  const client = getClient();
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: nowContext() },
    ...history,
    { role: 'user', content: String(userText ?? '').trim() },
  ];

  const toolSchemas = toolSchemasFor(isAdmin); // 非管理员看不到 adminOnly 工具
  const weatherResults = []; // 天气工具的原始 spotConditions,用于原样展示 JSON
  let finalText = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const completion = await client.chat.completions.create({
      model: config.openai.model,
      messages,
      tools: toolSchemas,
      tool_choice: 'auto',
    });

    const msg = completion.choices?.[0]?.message;
    if (!msg) {
      finalText = '模型没有返回内容,稍后再试试。';
      break;
    }

    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      finalText = msg.content; // 没有工具调用 = 最终答案
      break;
    }

    // 把带 tool_calls 的 assistant 消息压回上下文,再逐个执行工具并回填
    messages.push(msg);
    let fishingAnalysis = null; // analyzeFishing 的最终措辞(命中则短路,直接作为回复)
    for (const call of toolCalls) {
      const name = call.function?.name;
      let result;
      try {
        const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        result = await executeTool(name, args, { isAdmin });
      } catch (err) {
        result = { error: true, tool: name, message: err.message };
      }

      // 天气工具:原始 spotConditions 用于 .txt 附件
      if (WEATHER_TOOLS.has(name) && result && !result.error) weatherResults.push(result);

      // analyzeFishing:分析文字直接当最终回复;其 conditions 也做成 .txt 附件。
      // 不把庞大的 conditions 塞回模型上下文(短路后也用不到),只回一个精简结果。
      let toolContent = result;
      if (name === 'analyzeFishing' && result && !result.error && result.analysis) {
        fishingAnalysis = result.analysis;
        if (result.conditions) weatherResults.push(result.conditions);
        toolContent = { analysis: result.analysis };
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolContent) });
    }

    // analyzeFishing 已给出最终措辞 → 直接用它,省掉再让模型转述一遍(避免改写/多花一轮)
    if (fishingAnalysis) {
      finalText = fishingAnalysis;
      break;
    }
  }

  // 轮数用尽仍未收敛:让模型基于已有工具结果做一次不带工具的总结
  if (finalText === null) {
    const finalCompletion = await client.chat.completions.create({
      model: config.openai.model,
      messages: [...messages, { role: 'user', content: '请基于以上信息直接给出最终中文回复(不要再调用工具)。' }],
    });
    finalText = finalCompletion.choices?.[0]?.message?.content;
  }

  return buildOutput(finalText, weatherResults);
}

export default runAgent;
