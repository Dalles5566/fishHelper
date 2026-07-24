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
