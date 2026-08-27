import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

// 有 DATABASE_URL 用连接串，否则回落到 PG* 标准环境变量
export const pool = new Pool(
  config.db.connectionString
    ? { connectionString: config.db.connectionString }
    : {}
);

pool.on('error', (err) => {
  console.error('[db] 连接池空闲连接出错:', err.message);
});

// 慢查询阈值(ms):超过就打一条 warn，方便在日志平台排查
const SLOW_QUERY_MS = 500;

export async function query(text, params) {
  const startedAt = Date.now();
  // 只取 SQL 的第一个词(SELECT/INSERT/...)做标签，避免把完整语句/参数打进日志
  const op = String(text).trim().split(/\s+/)[0]?.toUpperCase() || 'SQL';
  try {
    const result = await pool.query(text, params);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= SLOW_QUERY_MS) {
      console.warn(`[db] 慢查询 ${op} 耗时 ${elapsedMs}ms，返回 ${result.rowCount ?? 0} 行`);
    }
    return result;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    console.error(`[db] 查询失败 ${op} (${elapsedMs}ms): ${err.message}`);
    throw err;
  }
}
