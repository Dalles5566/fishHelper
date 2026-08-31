-- 钓点坐标表
CREATE TABLE IF NOT EXISTS coordinates (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  note        TEXT,
  state       TEXT,
  distance    DOUBLE PRECISION,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 名称唯一，避免重复添加同一钓点
CREATE UNIQUE INDEX IF NOT EXISTS coordinates_name_uidx
  ON coordinates (lower(name));

-- 钓点由 bot(addCoordinate)在运行时写入数据库,不再预置种子。
