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

-- 预置固定钓点（幂等：ON CONFLICT DO NOTHING，重复 db:init 不会重复插入）
-- ⚠️ distance 是「从 HOME_COORDINATES 开车的里程」，与部署时的 .env 家坐标绑定。
--    换家坐标后这些种子值不再准确，需要重算（addCoordinate 会自动算新钓点，旧的要手动更新）。
INSERT INTO coordinates (name, latitude, longitude, note, state, distance) VALUES
  ('Fort Adams State Park', 41.479523389015256, -71.33548619254672, '倒数第二次去钓鱿鱼那', 'RI', 71.0),
  ('Massachusetts Maritime Academy', 41.74006918866203, -70.62137421028096, '军校', 'MA', 54.5),
  ('East Canal Lot Mainland Side', 41.77990024888963, -70.4891138957591, 'Canal 灯塔那里', 'MA', 51.6),
  ('Church Woods Hole', 41.51560726125236, -70.65535288844315, '第一次钓鱼的地方', 'MA', 71.3),
  ('Sachuest Point National Wildlife Refuge', 41.4769192, -71.2397108, 'Rhode Island 公园', 'RI', 68.4),
  ('铁轨', 41.6383896, -71.2176507, NULL, 'RI', 55.7),
  ('抓Green Crab', 42.1601912, -70.7325608, NULL, 'MA', 27.6),
  ('抓小螃蟹', 42.267414, -70.850157, NULL, 'MA', 13.3)
ON CONFLICT (lower(name)) DO NOTHING;
