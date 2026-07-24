import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// 轻量 .env 加载：仅在变量未被真实环境覆盖时填充，不引第三方依赖
function loadDotEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function required(key) {
  const v = process.env[key];
  if (!v) throw new Error(`缺少必需的环境变量: ${key}（参考 .env.example）`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),

  wecom: {
    botId: process.env.WECOM_BOT_ID || '',
    botSecret: process.env.WECOM_BOT_SECRET || '',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  },

  stormglass: {
    apiKey: process.env.STORMGLASS_API_KEY || '',
  },

  db: {
    connectionString: process.env.DATABASE_URL || undefined,
    // 未给 DATABASE_URL 时，pg 会自动读 PGHOST/PGUSER 等标准变量
  },

  rootDir,
};

// 启动时做一次基础校验，缺关键项时早失败、给清晰提示
export function assertConfig() {
  required('WECOM_BOT_ID');
  required('WECOM_BOT_SECRET');
  required('OPENAI_API_KEY');
  if (!config.db.connectionString && !process.env.PGHOST) {
    throw new Error('缺少数据库配置：请设置 DATABASE_URL 或 PG* 系列变量');
  }
}
