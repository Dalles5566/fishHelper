// ============================================================================
// AgentCore —— 两步式:意图提取(轻) → 固定管道 / function-calling 兜底
// ----------------------------------------------------------------------------
// runAgent(userText, { history, isAdmin }) -> { text, files }
//
// 【为什么两步?】省 token + 更可预测。90%+ 的问题都是同一个模式
//   "某地点 + 时间 → 判断好不好钓"。与其让 LLM 反复"选工具→回填→再选"(每轮重发
//   系统提示 + 全部工具 schema),不如:
//     第 1 步  轻量 LLM 只提取【意图】{ type, spot, lat/lng, mode, date }(不带工具 schema)
//     第 2 步  代码按固定管道跑:查坐标 → 取海况 → analyzeFishing 出报告(analyze 才有第 2 次 LLM)
//   非判断类(列钓点 / 加钓点 / 闲聊 / 只要原始数据)或快捷管道未命中(没解析到坐标 /
//   多个同名候选 / 出错)→ 落回原来的 function-calling 循环(runToolLoop),保持灵活、可扩展。
//
//   analyze 路径:2 次 LLM(提取 + 分析);其它:1 次提取 + function-calling。
// ============================================================================
import { config } from '../config.js';
import { getClient } from './openaiClient.js';
import { toolSchemasFor, executeTool } from './tools/registerTools.js';
import analyzeFishing from './tools/analyzeFishing.js';
import { findCoordinateByName, searchCoordinates } from '../db/coordinates.js';

const MAX_ROUNDS = 6; // function-calling 兜底里最多几轮"模型↔工具",防止无限调用

// ---------------------------------------------------------------------------
// 时间 / 语言 小工具
// ---------------------------------------------------------------------------
/** 当前美东时间(用于解析 today/tomorrow 等相对日期)。返回 { dateStr, time, weekday, tz } */
function etNow() {
  const tz = 'America/New_York';
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  })
    .formatToParts(new Date())
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  return { dateStr: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday, tz };
}

/** 含中文字符→zh,否则 en */
function detectLang(text) {
  return /[\u4e00-\u9fff]/.test(String(text ?? '')) ? 'zh' : 'en';
}

/** 尝试把值转成有限数字,失败返回 null */
function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// "现在 vs 今天 vs 明天 → mode + date" 的判定规则。【唯一判定处】= 意图提取(intentPrompt)。
// 兜底 function-calling 不再重复推导:直接用 intent 已决定的 mode/date(见 intentNote)。
const MODE_DATE_RULES = `- "now / right now / 现在 / 当前 / 目前" -> mode=current, no date.
- "today / 今天 / tonight / 今晚" -> mode=prediction, date=<today>.  ("today/今天" is NOT "now" -- it means the whole day.)
- "tomorrow / 明天 / 后天 / this weekend / 周末 / a specific day" -> mode=prediction, date=<that day>.
- Resolve relative dates to an absolute YYYY-MM-DD; never guess.`;

// ---------------------------------------------------------------------------
// 输出组装
// ---------------------------------------------------------------------------
/** 最终文本兜底:空则按语言给个提示 */
function finalizeText(text, lang = 'zh') {
  const t = (text || '').trim();
  if (t) return t;
  return lang === 'en' ? "Sorry, I couldn't find any useful info." : '抱歉,没查到有用的信息。';
}

/** 生成安全文件名片段(保留中英文数字,其余转下划线)*/
function safeName(s) {
  return String(s || 'spot').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40);
}

/** 由 spotConditions 生成附件文件名:钓点名(或坐标)_日期.txt */
function spotFileName(c) {
  const label = c?.name || `${c?.latitude},${c?.longitude}`;
  const stamp = c?.date || (c?.currentTime ? c.currentTime.slice(0, 10) : '');
  return `${safeName(label)}_${stamp}.txt`;
}

/** text = 聊天正文(摘要);files = 附件 */
function buildOutput(finalText, files, lang = 'zh') {
  return { text: finalizeText(finalText, lang), files };
}

/** analyzeFishing 结果 → { text, files }:summary 作正文,原始 JSON + 完整分析拼进 .txt 附件 */
function analyzeResultToOutput(result, lang) {
  const c = result.conditions || {};
  const files = [
    {
      filename: spotFileName(c),
      content: JSON.stringify(c, null, 2) + '\n\n===== Fishing Analysis =====\n' + (result.full || ''),
    },
  ];
  return buildOutput(result.summary, files, lang);
}

// ---------------------------------------------------------------------------
// 第 1 步:意图提取(轻量 LLM,不带工具 schema)
// ---------------------------------------------------------------------------
function intentPrompt(todayStr) {
  return `You parse a fishing-assistant user message into JSON. Output ONLY a JSON object, no prose.
Today (US Eastern) is ${todayStr}.

Schema:
{
  "type": "analyze" | "other",
  "spot": string | null,
  "latitude": number | null,
  "longitude": number | null,
  "mode": "current" | "prediction",
  "date": "YYYY-MM-DD" | null
}

Rules:
- type = "analyze" for ANY fishing-judgment question about a place (is it good to fish / how is it /
  when to go / now or later / how about today/tomorrow / rising or falling). Everything else
  (list my spots, add/edit a spot, chit-chat, "just give me the raw tide/weather data") = "other".
- mode + date (date is null when mode=current or no date):
${MODE_DATE_RULES}
- spot = the place name exactly as the user wrote it (keep Chinese as-is, e.g. 基佬村/军校). null if the user gave only coordinates or no place.
- latitude/longitude = only when the user typed raw numeric coordinates; otherwise null.`;
}

async function extractIntent(userText) {
  const { dateStr } = etNow();
  const completion = await getClient().chat.completions.create({
    model: config.openai.model,
    messages: [
      { role: 'system', content: intentPrompt(dateStr) },
      { role: 'user', content: userText },
    ],
    response_format: { type: 'json_object' },
  });
  const raw = completion.choices?.[0]?.message?.content || '{}';
  return JSON.parse(raw);
}

/** 把已提取的意图作为"已决定、勿重复分析"的上下文,注入 function-calling 兜底 */
function intentNote(intent) {
  if (!intent) return null;
  const parts = [`type=${intent.type || 'other'}`];
  if (intent.mode) parts.push(`mode=${intent.mode}`);
  if (intent.date) parts.push(`date=${intent.date}`);
  if (intent.spot) parts.push(`spot="${intent.spot}"`);
  const lat = toNum(intent.latitude);
  const lng = toNum(intent.longitude);
  if (lat != null && lng != null) parts.push(`coord=${lat},${lng}`);
  return (
    `[Intent] Parsed from the user's message upstream (already decided -- do NOT re-analyze mode/date): ` +
    `${parts.join('; ')}. When calling analyzeFishing / getPredictWeather, pass this mode/date as-is.`
  );
}

// ---------------------------------------------------------------------------
// 第 2 步(analyze 快捷管道):查坐标 → analyzeFishing(内部取海况 + 出报告)
//   返回 { text, files } 命中;返回 null 表示"未命中,请走 function-calling 兜底"
// ---------------------------------------------------------------------------
async function runAnalyzeFast(intent, lang) {
  let latitude = toNum(intent.latitude);
  let longitude = toNum(intent.longitude);
  let name = null;
  let note = null;

  // 没给坐标 → 用钓点名查库(精确 → 模糊)。0 个或多个候选 → 交回退让 LLM 处理/澄清
  if (latitude == null || longitude == null) {
    const term = intent.spot ? String(intent.spot).trim() : '';
    if (!term) return null;
    let spot = await findCoordinateByName(term);
    if (!spot) {
      const matches = await searchCoordinates(term);
      if (matches.length === 1) spot = matches[0];
      else return null; // 0 或多个 → function-calling 兜底(找不到/让用户确认是哪一个)
    }
    latitude = spot.latitude;
    longitude = spot.longitude;
    name = spot.name;
    note = spot.note ?? null;
  }
  if (latitude == null || longitude == null) return null;

  const mode = intent.mode === 'prediction' ? 'prediction' : 'current';
  const date = mode === 'prediction' ? intent.date || null : null;

  // analyzeFishing 内部:取海况(current/prediction)→ 调一次 LLM 出报告(第 2 次 LLM)
  const result = await analyzeFishing.execute({ latitude, longitude, name, note, mode, date }, { lang });
  if (!result || result.error || !result.summary) return null; // 出错 → 兜底
  return analyzeResultToOutput(result, lang);
}

// ---------------------------------------------------------------------------
// 兜底:原 function-calling 循环(其它操作 / 快捷管道未命中)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are the dispatcher for a fishing assistant. The user is on the US East Coast (RI/MA/NH area).
Your job: understand the user's intent -> call the right tool(s) -> relay the result faithfully.
[Language] Reply in the SAME language as the user's message (Chinese -> Chinese, English -> English).

[Tools]
- getCoordinateByName: resolve a saved spot name (or part of it, or its note like "军校"/"基佬村") into coordinates (+ note).
  If the user gives a name instead of lat/lng, call this FIRST to get {name, latitude, longitude, note}.
- analyzeFishing: judge whether a spot is good for fishing. Use it for ANY judgment question
  ("is it good to fish / how is it / when should I go / now or later / how about today/tomorrow / rising or falling").
  Pass name/note/latitude/longitude, and the mode + date from the [Intent] note (already decided upstream -- pass them through unchanged, do NOT re-derive them).
  Its returned "analysis" is already the final wording for the user -> relay it VERBATIM; do not rewrite, add, or change any number.
- getCurrentWeather / getPredictWeather: only when the user just wants the raw conditions data, no judgment.
- addCoordinate: save/update a spot (admins only; non-admins don't have this tool -- don't mention it).

[Rules] Times are already local -- use as-is; use only numbers returned by tools, never invent; if a value is missing, say "no data".`;

/** Current date/time in US Eastern, injected so the model can resolve relative dates. English only. */
function nowContext() {
  const { dateStr, time, weekday, tz } = etNow();
  return `[Current time] ${dateStr} (${weekday}) ${time} US Eastern (${tz}). Times returned by tools are already local.`;
}

/** 会产出 spotConditions 的天气工具 */
const WEATHER_TOOLS = new Set(['getCurrentWeather', 'getPredictWeather']);

async function runToolLoop(userText, { history = [], isAdmin = false, lang = 'zh', intent = null } = {}) {
  const client = getClient();
  const note = intentNote(intent); // 把上游已决定的 mode/date/spot 带进来,兜底不再重复推导
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: nowContext() },
    ...(note ? [{ role: 'system', content: note }] : []),
    ...history,
    { role: 'user', content: userText },
  ];

  const toolSchemas = toolSchemasFor(isAdmin); // 非管理员看不到 adminOnly 工具
  const files = []; // 要发送的 .txt 附件
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

      // analyzeFishing:摘要短路作正文;附件 = 原始 JSON + 完整分析。不把庞大内容塞回模型上下文。
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

    // analyzeFishing 已给出最终措辞 → 直接用它,省掉再让模型转述一遍
    if (fishingAnalysis) {
      finalText = fishingAnalysis;
      break;
    }
  }

  // 轮数用尽仍未收敛:让模型基于已有工具结果做一次不带工具的总结(语言跟随用户)
  if (finalText === null) {
    const summaryAsk = 'Based on the above, give the final reply directly (do not call any more tools).';
    const finalCompletion = await client.chat.completions.create({
      model: config.openai.model,
      messages: [...messages, { role: 'user', content: summaryAsk }],
    });
    finalText = finalCompletion.choices?.[0]?.message?.content;
  }

  return buildOutput(finalText, files, lang);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
/**
 * 跑一轮完整问答。
 * @param {string} userText 用户输入
 * @param {{history?:Array, isAdmin?:boolean}} opts
 * @returns {Promise<{text:string, files:{filename:string,content:string}[]}>}
 */
export async function runAgent(userText, { history = [], isAdmin = false } = {}) {
  const text = String(userText ?? '').trim();
  const lang = detectLang(text);

  // 第 1 步:轻量意图提取(不带工具 schema、极短 prompt)。失败则直接走兜底
  let intent;
  try {
    intent = await extractIntent(text);
  } catch {
    intent = null;
  }

  // 快捷管道:钓鱼判断类(最常见)→ 代码固定跑 查坐标 → 取海况 → 分析,不再回 LLM 选工具
  if (intent && intent.type === 'analyze') {
    const fast = await runAnalyzeFast(intent, lang);
    if (fast) return fast;
    // 未命中(没解析到坐标 / 多个同名候选 / 出错)→ 落到下面的 function-calling 兜底
  }

  // 兜底:其它操作(列钓点 / 加钓点 / 闲聊 / 只要原始数据)或快捷管道未命中 → 原 function-calling 循环
  // 把 intent(已含 mode/date/spot)传进去,兜底直接用,不再重复推导 mode
  return runToolLoop(text, { history, isAdmin, lang, intent });
}

export default runAgent;
