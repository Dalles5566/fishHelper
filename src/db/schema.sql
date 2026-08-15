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
INSERT INTO coordinates (name, latitude, longitude, note, state, distance) VALUES
  ('ProvinceTown fishing point', 42.05049745584154, -70.18090963671806, '基佬村钓鱼点', 'MA', 111.7),
  ('Fort Adams State Park', 41.479523389015256, -71.33548619254672, '倒数第二次去钓鱿鱼那', 'RI', 69.4),
  ('Massachusetts Maritime Academy', 41.74006918866203, -70.62137421028096, '军校', 'MA', 54.8),
  ('East Canal Lot Mainland Side', 41.77990024888963, -70.4891138957591, 'Canal 灯塔那里', 'MA', 51.4),
  ('Fishermen''s View Seafood Market & Restaurant', 41.772620636132665, -70.50446956734339, 'Canal对面', 'MA', 52.8),
  ('Church Woods Hole', 41.51560726125236, -70.65535288844315, '第一次钓鱼的地方', 'MA', 71.0),
  ('Nantasket Beach Resort', 42.2785546, -70.8646471, '抓蟹', 'MA', 12.9),
  ('Rocky Point State Park', 41.6885902, -71.3643383, '阿妈发我的位置', 'RI', 57.0),
  ('铁路', 41.6388759, -71.2142439, NULL, 'RI', 52.3),
  ('Sachuest Point National Wildlife Refuge', 41.4769192, -71.2397108, 'Rhode Island 公园', 'RI', 65.3)
ON CONFLICT (lower(name)) DO NOTHING;
