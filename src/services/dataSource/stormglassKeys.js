// Stormglass Key 配额状态管理(基于 Redis)
// ----------------------------------------------------------------------------
// 需求:
//   - 顺序耗尽:Key #1 用满(used>=limit)或收到 402 前,不用 Key #2。
//   - 状态存 Redis:进程重启后仍知道哪个 key 用到哪。
//   - 每天美东(America/New_York)午夜 00:00 自动重置(用 Redis TTL 到点过期)。
//   - 可用判定:available = 未 402 耗尽 AND used < limit。收到 402 即使 used 很小也不可用。
//   - Redis 连不上 → 抛错,不做内存兜底(按用户要求)。
//
// Redis 结构(每个 key 一个 hash,不存真实 key 值,只用编号):
//   stormglass:key:1 → { used: "7", exhausted: "0" }
//   TTL = 到下一个纽约午夜的秒数;key 过期消失 = 全新一天。
import { getRedis } from '../../db/redis.js';
import { config } from '../../config.js';

const PREFIX = 'stormglass:key:';
const TZ = 'America/New_York';

/** 计算从现在到"下一个纽约午夜 00:00"的秒数,作为 Redis TTL。 */
export function secondsUntilNextMidnightNY(now = new Date()) {
  // 取当前的纽约本地日期
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
    .formatToParts(now)
    .reduce((a, p) => ((a[p.type] = p.value), a), {});
  // 当前纽约"墙上时间"当成 UTC 来算与真实 UTC 的偏移
  const wallAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = wallAsUtc - now.getTime();
  // 下一个纽约午夜的"墙上时间" = 明天 00:00:00(纽约),换算回真实 UTC 时间戳
  const nextMidnightWallUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day + 1, 0, 0, 0);
  const nextMidnightRealUtc = nextMidnightWallUtc - offsetMs;
  const seconds = Math.ceil((nextMidnightRealUtc - now.getTime()) / 1000);
  return Math.max(60, seconds); // 至少 60s,避免边界 0
}

function keyName(index) {
  return `${PREFIX}${index + 1}`; // 展示用 1-based
}

/** 读某个 key 的状态。不存在则视为全新(used=0, exhausted=0)。 */
async function readState(redis, index) {
  const data = await redis.hGetAll(keyName(index));
  const used = Number(data.used || 0);
  const exhausted = data.exhausted === '1';
  return { used, exhausted };
}

function isAvailable(state, limit) {
  return !state.exhausted && state.used < limit;
}

/**
 * 顺序选出第一个可用 key 的索引(0-based)。全不可用返回 null。
 * 同时返回该 key 当前状态,供日志展示。
 */
export async function selectAvailableKey() {
  const keys = config.stormglass.apiKeys;
  const limit = config.stormglass.dailyLimit;
  const redis = await getRedis();
  for (let i = 0; i < keys.length; i++) {
    const state = await readState(redis, i);
    if (isAvailable(state, limit)) {
      return { index: i, used: state.used, limit };
    }
  }
  return null;
}

/** 请求成功后:used +1(并保证 key 带 TTL,到纽约午夜过期)。返回新的 used。 */
export async function recordSuccess(index) {
  const redis = await getRedis();
  const name = keyName(index);
  const used = await redis.hIncrBy(name, 'used', 1);
  // 达到上限时顺手标记(展示更直观;判定本身也会因 used>=limit 而不可用)
  if (used >= config.stormglass.dailyLimit) {
    await redis.hSet(name, 'exhausted', '0'); // 用满不是 402,exhausted 保持 0,靠 used 判定
  }
  await ensureExpiry(redis, name);
  return used;
}

/** 收到 402:标记该 key 今日耗尽(即使 used 很小也不可用)。 */
export async function markExhausted(index) {
  const redis = await getRedis();
  const name = keyName(index);
  await redis.hSet(name, 'exhausted', '1');
  await ensureExpiry(redis, name);
}

/** 保证 key 设置了"到纽约午夜过期"的 TTL(只在没 TTL 时设,避免每次刷新)。 */
async function ensureExpiry(redis, name) {
  const ttl = await redis.ttl(name);
  if (ttl < 0) {
    // -1=无过期时间, -2=不存在(理论上刚写过不会是 -2)
    await redis.expire(name, secondsUntilNextMidnightNY());
  }
}

/** dump 所有 key 状态,像数据库一样列出。用于日志/排查。 */
export async function dumpKeyStates() {
  const keys = config.stormglass.apiKeys;
  const limit = config.stormglass.dailyLimit;
  const redis = await getRedis();
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const state = await readState(redis, i);
    const available = isAvailable(state, limit);
    let reason = '';
    if (!available) reason = state.exhausted ? ' (402 耗尽)' : ' (配额用满)';
    out.push(`Key #${i + 1}: ${state.used}/${limit} ${available ? 'available' : 'not available'}${reason}`);
  }
  return out;
}
