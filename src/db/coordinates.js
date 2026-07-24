// 坐标数据访问层（被 tools 调用）
import { query } from './pool.js';

export async function listCoordinates() {
  const { rows } = await query(
    'SELECT id, name, latitude, longitude, note, created_at FROM coordinates ORDER BY id'
  );
  return rows;
}

export async function findCoordinateByName(name) {
  const { rows } = await query(
    'SELECT id, name, latitude, longitude, note, created_at FROM coordinates WHERE lower(name) = lower($1) LIMIT 1',
    [name]
  );
  return rows[0] || null;
}

// 模糊搜索:名字或备注部分匹配(忽略大小写)。用于用户只说了钓点名的一部分,
// 或用备注里的叫法(如"基佬村"、"军校")来指代钓点。
export async function searchCoordinates(term) {
  // 转义 LIKE 通配符,避免用户输入里的 % _ 影响匹配
  const escaped = String(term).replace(/([%_\\])/g, '\\$1');
  const { rows } = await query(
    `SELECT id, name, latitude, longitude, note, created_at
       FROM coordinates
      WHERE name ILIKE '%' || $1 || '%' ESCAPE '\\'
         OR note ILIKE '%' || $1 || '%' ESCAPE '\\'
      ORDER BY id`,
    [escaped]
  );
  return rows;
}

export async function addCoordinate({ name, latitude, longitude, note }) {
  const { rows } = await query(
    `INSERT INTO coordinates (name, latitude, longitude, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (lower(name)) DO UPDATE
       SET latitude = EXCLUDED.latitude,
           longitude = EXCLUDED.longitude,
           note = EXCLUDED.note
     RETURNING id, name, latitude, longitude, note, created_at`,
    [name, latitude, longitude, note || null]
  );
  return rows[0];
}
