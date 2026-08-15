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

-- 迁移：已存在的表补新列（幂等，CREATE TABLE IF NOT EXISTS 对旧表是 no-op）
ALTER TABLE coordinates ADD COLUMN IF NOT EXISTS state    TEXT;
ALTER TABLE coordinates ADD COLUMN IF NOT EXISTS distance DOUBLE PRECISION;

-- 名称唯一，避免重复添加同一钓点
CREATE UNIQUE INDEX IF NOT EXISTS coordinates_name_uidx
  ON coordinates (lower(name));

-- 预置固定钓点（幂等：ON CONFLICT DO NOTHING，重复 db:init 不会重复插入）
-- ⚠️ distance 是「从 HOME_COORDINATES 开车的里程」，与部署时的 .env 家坐标绑定。
--    换家坐标后这些种子值不再准确，需要重算（addCoordinate 会自动算新钓点，旧的要手动更新）。
INSERT INTO coordinates (name, latitude, longitude, note, state, distance) VALUES
  ('ProvinceTown fishing point', 42.05049745584154, -70.18090963671806, '基佬村钓鱼点', 'MA', 111.8),
  ('Fort Adams State Park', 41.479523389015256, -71.33548619254672, '倒数第二次去钓鱿鱼那', 'RI', 71.0),
  ('Massachusetts Maritime Academy', 41.74006918866203, -70.62137421028096, '军校', 'MA', 54.5),
  ('East Canal Lot Mainland Side', 41.77990024888963, -70.4891138957591, 'Canal 灯塔那里', 'MA', 51.6),
  ('Fishermen''s View Seafood Market & Restaurant', 41.772620636132665, -70.50446956734339, 'Canal对面', 'MA', 53.0),
  ('Church Woods Hole', 41.51560726125236, -70.65535288844315, '第一次钓鱼的地方', 'MA', 71.3),
  ('Nantasket Beach Resort', 42.2785546, -70.8646471, '抓蟹', 'MA', 13.8),
  ('Rocky Point State Park', 41.6885902, -71.3643383, '阿妈发我的位置', 'RI', 59.4),
  ('铁路', 41.6388759, -71.2142439, NULL, 'RI', 54.5),
  ('Sachuest Point National Wildlife Refuge', 41.4769192, -71.2397108, 'Rhode Island 公园', 'RI', 68.4)
ON CONFLICT (lower(name)) DO NOTHING;
