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

export async function query(text, params) {
  return pool.query(text, params);
}
