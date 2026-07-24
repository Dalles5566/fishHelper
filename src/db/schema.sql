-- 钓点坐标表
CREATE TABLE IF NOT EXISTS coordinates (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 名称唯一，避免重复添加同一钓点
CREATE UNIQUE INDEX IF NOT EXISTS coordinates_name_uidx
  ON coordinates (lower(name));
