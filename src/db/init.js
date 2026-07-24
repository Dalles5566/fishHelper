// 初始化数据库表结构：npm run db:init
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[db] 表结构初始化完成');
  await pool.end();
}

main().catch((err) => {
  console.error('[db] 初始化失败:', err.message);
  process.exit(1);
});
