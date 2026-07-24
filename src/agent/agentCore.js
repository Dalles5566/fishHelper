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
用户给的是钓点名而非坐标时,先 getCoordinateByName 拿到 {name,latitude,longitude,note},
调天气工具时**务必把 name、note、latitude、longitude 四个都带上**(别只传坐标),这样结果里能显示钓点名和你的备注。

【判断鱼口】不要只报数字。综合潮汐窗口(涨落潮时段)、日月(日出日落/月相)、风、水温、水深,
给出"何时、好不好钓"的判断。潮汐转换前后、晨昏、日月同升落常是好窗口。

【⚠️ 数据纪律(最重要,违反即错误)】
- 你回复里的每一个数值(时间、潮高、水位、温度、风速、日出日落等)**必须逐字来自工具返回的 JSON**,
  严禁自己编造、估算或凭记忆填写。
- 日出/日落/月相 → 用 common 里的值;高低潮几点 → 用 predictTideAndWeather.tideExtremes 里的值;
  逐小时 → 用 hourly。报时间就从对应字段的本地时间字符串里取"几点几分"(如 "...T20:09:46-04:00" → 20:09)。
- 若某个数在工具结果里是 null 或根本不存在,就明说"这项没有数据",**绝不猜一个**。
- 拿不准就再调一次工具,不要靠想象。

【回复规范】
- 用中文口语回复,简洁实用。
- 时间已是钓点当地时间(带时区偏移),直接说几点几分,不用再换算。
- 单位默认英制(ft/节/°F);用户要公制再说。
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

/** 会产出 spotConditions 的天气工具 */
const WEATHER_TOOLS = new Set(['getCurrentWeather', 'getPredictWeather']);

/** 生成安全文件名片段(保留中英文数字,其余转下划线)*/
function safeName(s) {
  return String(s || 'spot').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40);
}

/**
 * 组装输出为 { text, files }:
 *   - 预测(predictTideAndWeather,逐小时很长)→ 完整 JSON 作为 .txt 附件
 *   - 现在(currentTideAndWeather,较短)→ JSON 内联在文本里
 *   - 末尾接【大哥的建议】(模型综合判断)
 * 没调天气工具(纯查/存坐标)→ 只回建议、无附件。
 * @returns {{ text: string, files: {filename:string, content:string}[] }}
 */
function buildOutput(finalText, weatherResults) {
  const suggestion = ensureDage(finalText);
  const files = [];
  const parts = [];

  for (const r of weatherResults) {
    const json = JSON.stringify(r, null, 2);
    if (r.predictTideAndWeather) {
      // 预测:长,做成 txt 附件(名字缺失时用坐标兜底)
      const label = r.name || `${r.latitude},${r.longitude}`;
      files.push({ filename: `预测_${safeName(label)}_${r.date || ''}.txt`, content: json });
    } else {
      // 现在:短,内联
      parts.push(`【海况数据 spotConditions】\n${json}`);
    }
  }
  if (files.length) {
    parts.push(`📎 完整逐小时预测数据见附件:${files.map((f) => f.filename).join('、')}`);
  }
  parts.push(`【大哥的建议】\n${suggestion}`);

  return { text: parts.join('\n\n'), files };
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

export async function runAgent(userText, { history = [] } = {}) {
  const client = getClient();
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: nowContext() },
    ...history,
    { role: 'user', content: String(userText ?? '').trim() },
  ];

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
    for (const call of toolCalls) {
      const name = call.function?.name;
      let result;
      try {
        const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        result = await executeTool(name, args);
      } catch (err) {
        result = { error: true, tool: name, message: err.message };
      }
      // 记录天气工具的原始结果(供最终回复原样展示 JSON)
      if (WEATHER_TOOLS.has(name) && result && !result.error) weatherResults.push(result);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
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
