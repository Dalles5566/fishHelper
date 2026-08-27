// Redis 客户端 —— 存 Stormglass 各 key 的每日配额状态
// ----------------------------------------------------------------------------
// 懒连接:首次 getRedis() 时才连,连不上直接抛错(按需求不做内存兜底)。
// 用途见 src/services/dataSource/stormglassKeys.js。
import { createClient } from 'redis';
import { config } from '../config.js';

let client = null;
let connecting = null;

async function connect() {
  const c = createClient({ url: config.redis.url });
  c.on('error', (err) => console.error('[redis] 客户端错误:', err?.message || err));
  await c.connect();
  console.log('[redis] 已连接');
  return c;
}

/** 获取已连接的 Redis 客户端(单例)。连不上会抛错。 */
export async function getRedis() {
  if (client?.isOpen) return client;
  if (!connecting) {
    connecting = connect()
      .then((c) => {
        client = c;
        return c;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

/** 优雅关闭(进程退出时调用) */
export async function closeRedis() {
  if (client?.isOpen) {
    await client.quit();
    client = null;
  }
}
