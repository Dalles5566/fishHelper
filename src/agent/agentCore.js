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

// agentCore is only a router/relayer; the fishing judgment lives in the analyzeFishing tool.
const SYSTEM_PROMPT = `You are the dispatcher for a fishing assistant. The user is on the US East Coast (RI/MA/NH area).
Your job: understand the user's intent -> call the right tool(s) -> relay the result faithfully.
[Language] Reply in the SAME language as the user's message (Chinese -> Chinese, English -> English).

[Tools]
- getCoordinateByName: resolve a saved spot name (or part of it, or its note like "军校"/"基佬村") into coordinates (+ note).
  If the user gives a name instead of lat/lng, call this FIRST to get {name, latitude, longitude, note}.
- analyzeFishing: judge whether a spot is good for fishing. Use it for ANY judgment question
  ("is it good to fish / how is it / when should I go / now or later / how about today/tomorrow / rising or falling").
  Pass name/note/latitude/longitude. Use mode=current for now; mode=prediction for the future
  (convert relative dates like today/tomorrow to date=YYYY-MM-DD).
  * Its returned "analysis" is already the final wording for the user -> relay it VERBATIM; do not rewrite, add, or change any number.
- getCurrentWeather / getPredictWeather: only when the user just wants the raw conditions data, no judgment.
- addCoordinate: save/update a spot (admins only; non-admins don't have this tool -- don't mention it).

[Rules] Times are already local -- use as-is; use only numbers returned by tools, never invent; if a value is missing, say "no data".`;

/** 最终文本兜底:空则按语言给个提示 */
function finalizeText(text, lang = 'zh') {
  const t = (text || '').trim();
  if (t) return t;
  return lang === 'en' ? "Sorry, I couldn't find any useful info." : '抱歉,没查到有用的信息。';
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
/** 由 spotConditions 生成附件文件名:钓点名(或坐标)_日期.txt */
function spotFileName(c) {
  const label = c?.name || `${c?.latitude},${c?.longitude}`;
  const stamp = c?.date || (c?.currentTime ? c.currentTime.slice(0, 10) : '');
  return `${safeName(label)}_${stamp}.txt`;
}

/** text = 聊天正文(摘要);files = 已在主循环里组装好的附件 */
function buildOutput(finalText, files, lang = 'zh') {
  return { text: finalizeText(finalText, lang), files };
}

/**
 * 跑一轮完整问答。
 * @param {string} userText 用户输入
 * @param {Array} history 可选的历史消息(OpenAI messages 格式),默认空
 * @returns {Promise<{text:string, files:{filename:string,content:string}[]}>}
 *   text = 内联数据(现在)+【大哥的建议】;files = 预测的完整 JSON(.txt 附件)
 */
/** Current date/time in the spot's timezone (US Eastern), injected so the model can resolve
 *  relative dates like today/tomorrow. Instruction to the model -> English only. */
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
    `[Current time] ${dateStr} (${p.weekday}) ${p.hour}:${p.minute} US Eastern (${tz}).\n` +
    `When the user says today/tomorrow/this weekend etc., convert it to an absolute date ` +
    `YYYY-MM-DD and pass it as the date param to analyzeFishing/getPredictWeather. Never guess the date.`
  );
}

export async function runAgent(userText, { history = [], isAdmin = false } = {}) {
  const client = getClient();
  // 检测提问语言(含中文字符→zh,否则 en):贯穿 prompt、兜底文案、工具回复语言
  const lang = /[\u4e00-\u9fff]/.test(String(userText ?? '')) ? 'zh' : 'en';
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: nowContext() },
    ...history,
    { role: 'user', content: String(userText ?? '').trim() },
  ];

  const toolSchemas = toolSchemasFor(isAdmin); // 非管理员看不到 adminOnly 工具
  const files = []; // 要发送的 .txt 附件(天气原始 JSON / analyzeFishing 的 JSON+完整分析)
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
      finalText = lang === 'en' ? 'The model returned nothing, please try again later.' : '模型没有返回内容,稍后再试试。';
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
        result = await executeTool(name, args, { isAdmin, lang });
      } catch (err) {
        result = { error: true, tool: name, message: err.message };
      }

      // 天气工具:原始 spotConditions → 纯 JSON 附件
      if (WEATHER_TOOLS.has(name) && result && !result.error) {
        files.push({ filename: spotFileName(result), content: JSON.stringify(result, null, 2) });
      }

      // analyzeFishing:摘要(summary)当聊天正文短路;附件 = 原始 JSON + 完整分析(full)。
      // 不把庞大内容塞回模型上下文(短路后用不到),只回一个精简标记。
      let toolContent = result;
      if (name === 'analyzeFishing' && result && !result.error && result.summary) {
        fishingAnalysis = result.summary;
        const c = result.conditions || {};
        files.push({
          filename: spotFileName(c),
          content: JSON.stringify(c, null, 2) + '\n\n===== Fishing Analysis =====\n' + (result.full || ''),
        });
        toolContent = { summary: result.summary };
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolContent) });
    }

    // analyzeFishing 已给出最终措辞 → 直接用它,省掉再让模型转述一遍(避免改写/多花一轮)
    if (fishingAnalysis) {
      finalText = fishingAnalysis;
      break;
    }
  }

  // 轮数用尽仍未收敛:让模型基于已有工具结果做一次不带工具的总结(语言跟随用户)
  if (finalText === null) {
    // 指令给模型;输出语言由 SYSTEM_PROMPT 的"跟随用户语言"决定
    const summaryAsk = 'Based on the above, give the final reply directly (do not call any more tools).';
    const finalCompletion = await client.chat.completions.create({
      model: config.openai.model,
      messages: [...messages, { role: 'user', content: summaryAsk }],
    });
    finalText = finalCompletion.choices?.[0]?.message?.content;
  }

  return buildOutput(finalText, files, lang);
}

export default runAgent;
